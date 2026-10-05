// Synchronous compatibility layer for the application code, backed by PostgreSQL or embedded PGlite.
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
const path = require('path');
const fs = require('fs');

if (isMainThread) {
  // Shared memory buffer: 8MB for queries & result sets
  const SAB_SIZE = 8 * 1024 * 1024;
  const sab = new SharedArrayBuffer(SAB_SIZE);
  const int32 = new Int32Array(sab);

  // Int32 layout:
  // [0]: status (0: pending, 1: success, 2: error)
  // [1]: length of JSON payload
  const DATA_OFFSET = 8;

  let worker = null;

  function initWorker(dbUrl) {
    if (!worker) {
      worker = new Worker(__filename, {
        workerData: { sab, dbUrl }
      });
      // Wait for worker initialization
      Atomics.wait(int32, 0, 0);
      const status = Atomics.load(int32, 0);
      if (status === 2) {
        const len = int32[1];
        const errJson = Buffer.from(sab, DATA_OFFSET, len).toString('utf8');
        console.warn('Database worker init warning:', JSON.parse(errJson).error);
      }
    }
  }

  function execSync(action, sql, params = []) {
    const payload = JSON.stringify({ action, sql, params });
    const buf = Buffer.from(payload, 'utf8');
    if (buf.length > SAB_SIZE - DATA_OFFSET) {
      throw new Error('Query payload exceeds SharedArrayBuffer capacity');
    }

    int32[1] = buf.length;
    Buffer.from(sab, DATA_OFFSET, buf.length).write(payload, 'utf8');

    Atomics.store(int32, 0, 0);
    worker.postMessage('run');

    Atomics.wait(int32, 0, 0);

    const status = Atomics.load(int32, 0);
    const len = int32[1];
    const resStr = Buffer.from(sab, DATA_OFFSET, len).toString('utf8');
    const result = JSON.parse(resStr);

    if (status === 2) {
      const err = new Error(result.error || 'Database operation failed');
      if (result.code) err.code = result.code;
      throw err;
    }
    return result;
  }

  const placeholders = sql => {
    let i = 0;
    return sql.replace(/\?/g, () => `$${++i}`);
  };

  const normalize = sql => placeholders(sql)
    .replace(/INSERT OR IGNORE INTO shuffles VALUES\(([^)]*)\)/i, 'INSERT INTO shuffles VALUES($1) ON CONFLICT DO NOTHING')
    .replace(/INSERT OR IGNORE INTO participants\(([^)]*)\) VALUES\(([^)]*)\)/i, 'INSERT INTO participants($1) VALUES($2) ON CONFLICT DO NOTHING')
    .replace(/group_concat\(([^,]+),\s*'([^']*)'\)/gi, "string_agg($1, '$2')")
    .replace(/ROUND\s*\(\s*(AVG\([^)]+\)|r\.response_time)\s*,\s*(\d+)\s*\)/gi, 'ROUND(($1)::numeric, $2)');

  class Statement {
    constructor(sql) {
      this.sql = normalize(sql);
    }
    get(...values) {
      const rows = execSync('query', this.sql, values.flat());
      return rows && rows.length > 0 ? rows[0] : undefined;
    }
    all(...values) {
      return execSync('query', this.sql, values.flat()) || [];
    }
    run(...values) {
      const res = execSync('run', this.sql, values.flat());
      return { lastInsertRowid: res.lastInsertRowid, changes: res.changes };
    }
  }

  module.exports = class Database {
    constructor(dbUrl) {
      initWorker(dbUrl);
    }
    prepare(sql) {
      return new Statement(sql);
    }
    exec(sql) {
      execSync('exec', normalize(sql), []);
    }
    transaction(fn) {
      return (...args) => {
        execSync('exec', 'BEGIN', []);
        try {
          const value = fn(...args);
          execSync('exec', 'COMMIT', []);
          return value;
        } catch (error) {
          execSync('exec', 'ROLLBACK', []);
          throw error;
        }
      };
    }
  };

} else {
  // Worker Thread
  const { sab, dbUrl } = workerData;
  const int32 = new Int32Array(sab);
  const DATA_OFFSET = 8;

  let queryFunc = null; // (sql, params) => Promise<{ rows, rowCount }>
  let execFunc = null;  // (sql) => Promise<any>

  async function setupEngine() {
    if (dbUrl && (dbUrl.startsWith('postgres://') || dbUrl.startsWith('postgresql://'))) {
      try {
        const { Client } = require('pg');
        const client = new Client({ connectionString: dbUrl });
        await client.connect();
        queryFunc = async (sql, params) => {
          const res = await client.query(sql, params);
          return { rows: res.rows, rowCount: res.rowCount };
        };
        execFunc = async (sql) => {
          await client.query(sql);
        };
        return;
      } catch (err) {
        console.warn(`Could not connect to external PostgreSQL (${err.message}). Using embedded PGlite.`);
      }
    }

    // Embedded PGlite engine
    const { PGlite } = require('@electric-sql/pglite');
    const isTest = process.env.NODE_ENV === 'test' || Boolean(process.env.TEST_DATABASE_URL);
    const dbPath = isTest ? undefined : path.resolve(process.env.UPLOAD_DIR || '.', 'data', 'pgdata');
    if (dbPath && !fs.existsSync(dbPath)) {
      fs.mkdirSync(dbPath, { recursive: true });
    }
    const pglite = new PGlite(dbPath);
    await pglite.waitReady;
    queryFunc = async (sql, params) => {
      const res = await pglite.query(sql, params);
      return { rows: res.rows, rowCount: res.affectedRows ?? res.rows?.length ?? 0 };
    };
    execFunc = async (sql) => {
      await pglite.exec(sql);
    };
  }

  setupEngine().then(() => {
    Atomics.store(int32, 0, 1);
    Atomics.notify(int32, 0);
  }).catch(err => {
    const outBuf = Buffer.from(JSON.stringify({ error: err.message }), 'utf8');
    int32[1] = outBuf.length;
    Buffer.from(sab, DATA_OFFSET, outBuf.length).write(outBuf.toString('utf8'), 'utf8');
    Atomics.store(int32, 0, 2);
    Atomics.notify(int32, 0);
  });

  parentPort.on('message', async () => {
    const len = int32[1];
    const reqStr = Buffer.from(sab, DATA_OFFSET, len).toString('utf8');
    const { action, sql, params } = JSON.parse(reqStr);

    try {
      if (action === 'exec') {
        await execFunc(sql);
        const outBuf = Buffer.from(JSON.stringify({ ok: true }), 'utf8');
        int32[1] = outBuf.length;
        Buffer.from(sab, DATA_OFFSET, outBuf.length).write(outBuf.toString('utf8'), 'utf8');
        Atomics.store(int32, 0, 1);
      } else if (action === 'run') {
        const res = await queryFunc(sql, params);
        let lastId = res.rows && res.rows[0] && res.rows[0].id !== undefined ? res.rows[0].id : undefined;
        const outBuf = Buffer.from(JSON.stringify({ lastInsertRowid: lastId, changes: res.rowCount }), 'utf8');
        int32[1] = outBuf.length;
        Buffer.from(sab, DATA_OFFSET, outBuf.length).write(outBuf.toString('utf8'), 'utf8');
        Atomics.store(int32, 0, 1);
      } else {
        const res = await queryFunc(sql, params);
        const outBuf = Buffer.from(JSON.stringify(res.rows), 'utf8');
        int32[1] = outBuf.length;
        Buffer.from(sab, DATA_OFFSET, outBuf.length).write(outBuf.toString('utf8'), 'utf8');
        Atomics.store(int32, 0, 1);
      }
    } catch (err) {
      const outBuf = Buffer.from(JSON.stringify({ error: err.message, code: err.code }), 'utf8');
      int32[1] = outBuf.length;
      Buffer.from(sab, DATA_OFFSET, outBuf.length).write(outBuf.toString('utf8'), 'utf8');
      Atomics.store(int32, 0, 2);
    } finally {
      Atomics.notify(int32, 0);
    }
  });
}
