require('dotenv').config();
const express=require('express'),http=require('http'),{Server}=require('socket.io'),Database=require('./config/database'),bcrypt=require('bcryptjs'),jwt=require('jsonwebtoken');
const SECRET=process.env.JWT_SECRET||'dev-secret';
const ADMIN_USERNAME=process.env.ADMIN_USERNAME,ADMIN_PASSWORD=process.env.ADMIN_PASSWORD;
if(process.env.NODE_ENV==='production'&&SECRET==='dev-secret'){console.error('Set JWT_SECRET');process.exit(1)}
if(!ADMIN_USERNAME||!ADMIN_PASSWORD){console.error('Set ADMIN_USERNAME and ADMIN_PASSWORD');process.exit(1)}
const QR=require('qrcode');
const db=new Database(process.env.DATABASE_URL);
db.exec(`
CREATE TABLE IF NOT EXISTS users(id SERIAL PRIMARY KEY,name TEXT,email TEXT UNIQUE,password_hash TEXT,role TEXT DEFAULT 'admin');
CREATE TABLE IF NOT EXISTS quizzes(id SERIAL PRIMARY KEY,title TEXT NOT NULL,join_code TEXT UNIQUE,status TEXT DEFAULT 'draft',created_by INTEGER,created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS questions(id SERIAL PRIMARY KEY,quiz_id INTEGER REFERENCES quizzes(id) ON DELETE CASCADE,question_text TEXT NOT NULL,time_limit INTEGER DEFAULT 20,marks INTEGER DEFAULT 10,order_number INTEGER);
CREATE TABLE IF NOT EXISTS options(id SERIAL PRIMARY KEY,question_id INTEGER REFERENCES questions(id) ON DELETE CASCADE,option_text TEXT NOT NULL,is_correct INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS participants(id SERIAL PRIMARY KEY,quiz_id INTEGER REFERENCES quizzes(id) ON DELETE CASCADE,name TEXT,team_name TEXT,device_id TEXT,joined_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,UNIQUE(quiz_id,device_id));
CREATE TABLE IF NOT EXISTS responses(id SERIAL PRIMARY KEY,question_id INTEGER REFERENCES questions(id) ON DELETE CASCADE,participant_id INTEGER REFERENCES participants(id) ON DELETE CASCADE,selected_option_id INTEGER,is_correct INTEGER,response_time REAL,score INTEGER,submitted_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,UNIQUE(question_id,participant_id));`);
if(!db.prepare("SELECT 1 FROM information_schema.columns WHERE table_name='questions' AND column_name='category'").get())db.exec("ALTER TABLE questions ADD COLUMN category TEXT DEFAULT 'General'");
db.exec('CREATE INDEX IF NOT EXISTS idx_resp_q ON responses(question_id);CREATE INDEX IF NOT EXISTS idx_q_quiz ON questions(quiz_id,order_number)');
function addQ(qid,t,opts,c,lim=20,marks=10,cat='General'){const n=+db.prepare('SELECT COUNT(*) c FROM questions WHERE quiz_id=?').get(qid).c;
 const id=db.prepare('INSERT INTO questions(quiz_id,question_text,time_limit,marks,order_number,category) VALUES(?,?,?,?,?,?) RETURNING id').run(qid,t,lim,marks,n+1,cat).lastInsertRowid;
 opts.forEach((o,i)=>db.prepare('INSERT INTO options(question_id,option_text,is_correct) VALUES(?,?,?)').run(id,o,i===c?1:0));return id}
const fs=require('fs'),path=require('path'),crypto=require('crypto'),ADMIN={username:ADMIN_USERNAME,password:ADMIN_PASSWORD};
const CODE='ABCDEFGHJKLMNPQRSTUVWXYZ23456789',newCode=()=>Array.from({length:5},()=>CODE[crypto.randomInt(CODE.length)]).join('');
const addCol=(t,c,d)=>{if(!db.prepare("SELECT 1 FROM information_schema.columns WHERE table_name=? AND column_name=?").get(t,c))db.exec(`ALTER TABLE ${t} ADD COLUMN ${c} ${d}`)};
const BONUS_WINDOW=+process.env.BONUS_WINDOW_SEC||30,UP=path.resolve(process.env.UPLOAD_DIR||'uploads'),QDIR=path.join(UP,'questions');
// ---- users: roles ADMIN|USER, normalized unique username, revocable tokens
addCol('users','username','TEXT');addCol('users','username_normalized','TEXT');addCol('users','status',"TEXT DEFAULT 'active'");addCol('users','token_version','INTEGER DEFAULT 0');
addCol('quizzes','question_started_at','BIGINT');addCol('questions','image_url','TEXT');addCol('responses','submission_id','TEXT');addCol('participants','user_id','INTEGER');
const norm=v=>String(v??'').normalize('NFKC').trim().replace(/\s+/g,' ').toLowerCase();
db.exec("UPDATE users SET role=upper(role) WHERE role IS NOT NULL AND role<>upper(role)");
for(const u of db.prepare('SELECT id,name,email FROM users WHERE username IS NULL').all()){let un=(u.name||(u.email||'user'+u.id).split('@')[0]).trim()||'user'+u.id;if(db.prepare('SELECT 1 FROM users WHERE username_normalized=?').get(norm(un)))un+=' '+u.id;db.prepare('UPDATE users SET username=?,username_normalized=? WHERE id=?').run(un,norm(un),u.id)}
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS uq_user_norm ON users(username_normalized);CREATE UNIQUE INDEX IF NOT EXISTS uq_user_email ON users(lower(email))');
if(!db.prepare('SELECT 1 FROM users').get()){ // first run: seed admin + sample quiz. Admin accounts are never created through public registration.
 const un=ADMIN.username,u=db.prepare("INSERT INTO users(name,password_hash,role,username,username_normalized) VALUES(?,?,'ADMIN',?,?) RETURNING id").run(un,bcrypt.hashSync(ADMIN.password,10),un,norm(un)).lastInsertRowid;
 const q=db.prepare("INSERT INTO quizzes(title,join_code,created_by) VALUES('Sample General Knowledge','DEMO01',?) RETURNING id").run(u).lastInsertRowid;
 addQ(q,'Capital of France?',['Berlin','Paris','Rome','Madrid'],1);addQ(q,'Which planet is the Red Planet?',['Venus','Jupiter','Mars','Mercury'],2);addQ(q,'2 + 2 × 3 = ?',['8','10','12','6'],0,15,20)}
{ // keep the primary ADMIN account in sync with environment variables (old sessions are revoked)
 const a=db.prepare("SELECT id,username,password_hash FROM users WHERE role='ADMIN' ORDER BY id LIMIT 1").get();
 if(a&&(norm(a.username)!==norm(ADMIN.username)||!bcrypt.compareSync(ADMIN.password,a.password_hash))){
  if(db.prepare('SELECT 1 FROM users WHERE username_normalized=? AND id<>?').get(norm(ADMIN.username),a.id))console.warn('Admin username is used by another account; admin credentials NOT updated');
  else{db.prepare('UPDATE users SET name=?,username=?,username_normalized=?,password_hash=?,email=NULL,token_version=token_version+1 WHERE id=?').run(ADMIN.username,ADMIN.username,norm(ADMIN.username),bcrypt.hashSync(ADMIN.password,10),a.id);console.log('Admin credentials updated from environment variables')}}}
const app=express();app.use(express.json({limit:'200kb'}));
app.use('/uploads',express.static(UP,{index:false,dotfiles:'deny',setHeaders:r=>{r.setHeader('X-Content-Type-Options','nosniff');r.setHeader('Content-Security-Policy',"default-src 'none'")}}));
app.use(express.static('public'));
// ---- validation + auth middleware (authentication, role and object-level authorization are separate)
const str=(v,max=200)=>typeof v==='string'&&v.trim()&&v.length<=max;
const uid=v=>/^\d{1,9}$/.test(String(v))?+v:null,bad=(res,m,c=422)=>res.status(c).json({error:m}),publicUser=u=>({id:u.id,username:u.username,role:u.role});
const verify=tok=>{try{const p=jwt.verify(tok,SECRET,{issuer:'challengearena'});const u=db.prepare('SELECT * FROM users WHERE id=?').get(p.id);return u&&u.status==='active'&&u.token_version===p.tv?u:null}catch{return null}};
const requireAuth=(req,res,next)=>{const u=verify((req.headers.authorization||'').slice(7));if(!u)return res.status(401).json({error:'Authentication required'});req.user=u;next()};
const requireRole=r=>(req,res,next)=>req.user.role===r?next():res.status(403).json({error:'Forbidden'});
const requireQuizAdminAccess=(req,res,next)=>{const id=uid(req.params.id),q=id&&db.prepare('SELECT * FROM quizzes WHERE id=?').get(id);if(!q||q.created_by!==req.user.id)return res.status(404).json({error:'Not found'});req.quiz=q;next()};
const requireQuestionAccess=(req,res,next)=>{const id=uid(req.params.id),q=id&&db.prepare('SELECT * FROM questions WHERE id=?').get(id),z=q&&db.prepare('SELECT * FROM quizzes WHERE id=?').get(q.quiz_id);if(!z||z.created_by!==req.user.id)return res.status(404).json({error:'Not found'});req.question=q;req.quiz=z;next()};
const adminAuth=[requireAuth,requireRole('ADMIN')],ownQuiz=[...adminAuth,requireQuizAdminAccess],ownQuestion=[...adminAuth,requireQuestionAccess];
const rmImg=u=>{if(u&&u.startsWith('/uploads/questions/'))fs.rmSync(path.join(QDIR,path.basename(u)),{force:true})};
const rl={},limited=k=>{const n=Date.now();return(rl[k]=(rl[k]||[]).filter(t=>n-t<9e5)).length>=10};
app.post('/api/auth/register',(req,res)=>{const b=req.body||{},un=typeof b.username==='string'?b.username.trim().replace(/\s+/g,' '):''; // role in body is ignored: public signup is always USER
 if(!/^[A-Za-z0-9_][A-Za-z0-9_ .-]{1,28}[A-Za-z0-9_]$/.test(un))return bad(res,'Username must be 3-30 characters (letters, numbers, space . _ -)');
 if(typeof b.password!=='string'||b.password.length<8||b.password.length>72||!/[A-Za-z]/.test(b.password)||!/\d/.test(b.password))return bad(res,'Password must be 8-72 characters with a letter and a number');
 if(b.password!==b.confirm_password)return bad(res,'Passwords do not match');
 if(db.prepare('SELECT 1 FROM teams WHERE team_name_normalized=?').get(norm(un)))return bad(res,'That name is already taken',409);
 try{const id=db.prepare("INSERT INTO users(name,password_hash,role,username,username_normalized) VALUES(?,?,'USER',?,?) RETURNING id").run(un,bcrypt.hashSync(b.password,10),un,norm(un)).lastInsertRowid;res.status(201).json({user:{id,username:un,role:'USER'}})}
 catch{bad(res,'Username already taken',409)}});
app.post('/api/auth/login',(req,res)=>{const b=req.body||{},id=norm(b.login??b.email??b.username),k=req.ip+'|'+id;if(limited(k))return res.status(429).json({error:'Too many attempts, try later'});
 const u=typeof b.password==='string'&&id&&db.prepare('SELECT * FROM users WHERE username_normalized=? OR lower(email)=?').get(id,id);
 if(!u||u.status!=='active'||!bcrypt.compareSync(b.password,u.password_hash)){(rl[k]=rl[k]||[]).push(Date.now());return res.status(401).json({error:'Invalid credentials'})}
 res.json({user:publicUser(u),token:jwt.sign({id:u.id,role:u.role,tv:u.token_version},SECRET,{expiresIn:'12h',issuer:'challengearena'})})});
app.post('/api/auth/logout',requireAuth,(req,res)=>{db.prepare('UPDATE users SET token_version=token_version+1 WHERE id=?').run(req.user.id);res.json({ok:true})}); // revokes every token of this user
app.get('/api/me',requireAuth,(req,res)=>res.json({user:publicUser(req.user)}));
app.get('/api/join/:code',(req,res)=>{const q=db.prepare('SELECT title,status,participation_mode,allowed_team_sizes FROM quizzes WHERE join_code=?').get(String(req.params.code).toUpperCase());q?res.json(q):res.sendStatus(404)});
app.get('/healthz',(q,r)=>r.send('ok'));
// ---- admin API: every route = authenticated ADMIN + ownership of the quiz/question
app.get('/api/quizzes',...adminAuth,(req,res)=>res.json(db.prepare('SELECT * FROM quizzes WHERE created_by=? ORDER BY id DESC').all(req.user.id)));
app.post('/api/quizzes',...adminAuth,(req,res)=>{if(!str(req.body?.title,120))return bad(res,'title required');const c=cfg(req.body);if(!c)return bad(res,'Invalid settings');
 const code=newCode()+newCode().slice(0,1),dc=newCode(),id=db.prepare('INSERT INTO quizzes(title,join_code,created_by,participation_mode,team_min,team_max,display_mode,allowed_team_sizes,display_code) VALUES(?,?,?,?,?,?,?,?,?) RETURNING id').run(req.body.title.trim(),code,req.user.id,c.pm,c.mn,c.mx,c.dm,c.sizes,dc).lastInsertRowid;res.json({id,join_code:code,display_code:dc})});
app.get('/api/quizzes/:id',...ownQuiz,(req,res)=>{const qz={...req.quiz};qz.questions=db.prepare('SELECT * FROM questions WHERE quiz_id=? ORDER BY order_number').all(qz.id).map(q=>({...q,options:db.prepare('SELECT * FROM options WHERE question_id=?').all(q.id)}));res.json(qz)});
const parseQ=b=>{const{question_text,options,correct,time_limit,marks,category}=b||{};
 if(!str(question_text,500)||!Array.isArray(options)||options.length<2||options.length>6||!options.every(o=>str(o,200))||!Number.isInteger(correct)||correct<0||correct>=options.length)return null;
 return{category:str(category,40)?category.trim():'General',question_text:question_text.trim(),options:options.map(o=>o.trim()),correct,time_limit:Math.min(Math.max(+time_limit||20,5),3600),marks:Math.min(Math.max(+marks||10,1),1000)}};
app.post('/api/quizzes/:id/questions',...ownQuiz,(req,res)=>{const p=parseQ(req.body);if(!p)return bad(res,'Invalid question');res.json({id:addQ(req.quiz.id,p.question_text,p.options,p.correct,p.time_limit,p.marks,p.category)})});
app.post('/api/quizzes/:id/import',...ownQuiz,(req,res)=>{const lines=String(req.body?.text||'').split('\n').map(l=>l.trim()).filter(Boolean).slice(0,300);let added=0,skipped=0;
 db.transaction(()=>lines.forEach(l=>{const[c,q,...o]=l.split('|').map(x=>x.trim());const p=parseQ({category:c,question_text:q,options:o,correct:0,time_limit:req.body.time_limit,marks:req.body.marks});if(!p){skipped++;return}addQ(req.quiz.id,p.question_text,p.options,0,p.time_limit,p.marks,p.category);added++}))();res.json({added,skipped})});
app.put('/api/questions/:id',...ownQuestion,(req,res)=>{const p=parseQ(req.body);if(!p)return bad(res,'Invalid question');
 db.transaction(()=>{db.prepare('UPDATE questions SET question_text=?,time_limit=?,marks=?,category=? WHERE id=?').run(p.question_text,p.time_limit,p.marks,p.category,req.question.id);db.prepare('DELETE FROM options WHERE question_id=?').run(req.question.id);
  p.options.forEach((o,i)=>db.prepare('INSERT INTO options(question_id,option_text,is_correct) VALUES(?,?,?)').run(req.question.id,o,i===p.correct?1:0))})();res.json({ok:true})});
app.delete('/api/questions/:id',...ownQuestion,(req,res)=>{db.transaction(()=>{db.prepare('DELETE FROM shuffles WHERE question_id=?').run(req.question.id);db.prepare('DELETE FROM questions WHERE id=?').run(req.question.id)})();rmImg(req.question.image_url);res.json({ok:true})});
app.post('/api/quizzes/:id/reorder',...ownQuiz,(req,res)=>{const ids=req.body?.ids,cur_=db.prepare('SELECT id FROM questions WHERE quiz_id=?').all(req.quiz.id).map(r=>r.id);
 if(!Array.isArray(ids)||ids.length!==cur_.length||new Set(ids).size!==ids.length||!ids.every(i=>cur_.includes(i)))return bad(res,'ids must list every question once');
 db.transaction(()=>ids.forEach((id,i)=>db.prepare('UPDATE questions SET order_number=? WHERE id=?').run(i+1,id)))();res.json({ok:true})});
app.get('/api/quizzes/:id/responses',...ownQuiz,(req,res)=>res.json(db.prepare(`SELECT COALESCE(t.team_name,p.name) name,q.order_number q,q.question_text,o.option_text answer,r.is_correct,r.score,ROUND(r.response_time,1) seconds FROM responses r LEFT JOIN participants p ON p.id=r.participant_id LEFT JOIN teams t ON t.id=r.team_id JOIN questions q ON q.id=r.question_id LEFT JOIN options o ON o.id=r.selected_option_id WHERE q.quiz_id=? ORDER BY q.order_number,r.submitted_at`).all(req.quiz.id)));
app.get('/api/quizzes/:id/categories',...ownQuiz,(req,res)=>res.json(db.prepare(`SELECT COALESCE(t.team_name,p.name) name,q.category,SUM(r.score) score FROM responses r LEFT JOIN participants p ON p.id=r.participant_id LEFT JOIN teams t ON t.id=r.team_id JOIN questions q ON q.id=r.question_id WHERE q.quiz_id=? GROUP BY COALESCE(r.team_id*-1,r.participant_id),q.category`).all(req.quiz.id)));
app.get('/api/quizzes/:id/qr',...ownQuiz,async(req,res)=>{const base=typeof req.query.base==='string'?req.query.base:'';res.json({dataUrl:await QR.toDataURL(`${base}/#/play/${req.quiz.join_code}`,{margin:1,width:240})})});
// ---- question images: raw upload, type decided by magic bytes (never filename/MIME alone), random filename, stored on disk, only the URL in the DB
const sniff=b=>b.length>24&&b[0]===0x89&&b.slice(1,4).toString()==='PNG'?'png':b[0]===0xff&&b[1]===0xd8&&b[2]===0xff?'jpg':b.slice(0,4).toString()==='RIFF'&&b.slice(8,12).toString()==='WEBP'?'webp':null;
app.post('/api/questions/:id/image',...ownQuestion,express.raw({type:['image/png','image/jpeg','image/webp'],limit:'2mb'}),(req,res)=>{const b=req.body,ext=Buffer.isBuffer(b)&&sniff(b),mime={'image/png':'png','image/jpeg':'jpg','image/webp':'webp'}[req.headers['content-type']];
 if(!ext||ext!==mime)return bad(res,'Upload a PNG, JPEG or WEBP image (max 2 MB)');if(ext==='png'&&(b.readUInt32BE(16)>4096||b.readUInt32BE(20)>4096))return bad(res,'Image too large (max 4096x4096)');
 fs.mkdirSync(QDIR,{recursive:true});const name=crypto.randomUUID()+'.'+ext;fs.writeFileSync(path.join(QDIR,name),b,{flag:'wx'});rmImg(req.question.image_url);
 const url='/uploads/questions/'+name;db.prepare('UPDATE questions SET image_url=? WHERE id=?').run(url,req.question.id);res.json({image_url:url})});
app.delete('/api/questions/:id/image',...ownQuestion,(req,res)=>{rmImg(req.question.image_url);db.prepare('UPDATE questions SET image_url=NULL WHERE id=?').run(req.question.id);res.json({ok:true})});
addCol('quizzes','participation_mode',"TEXT DEFAULT 'individual'");addCol('quizzes','team_min','INTEGER DEFAULT 2');addCol('quizzes','team_max','INTEGER DEFAULT 4');addCol('quizzes','display_mode',"TEXT DEFAULT 'full'");addCol('responses','team_id','INTEGER');
addCol('quizzes','allowed_team_sizes','TEXT');addCol('quizzes','display_code','TEXT');addCol('quizzes','current_index','INTEGER DEFAULT -1');addCol('quizzes','question_status',"TEXT DEFAULT 'ready'");
db.exec(`CREATE TABLE IF NOT EXISTS teams(id SERIAL PRIMARY KEY,quiz_id INTEGER REFERENCES quizzes(id) ON DELETE CASCADE,team_name TEXT NOT NULL,team_code TEXT NOT NULL,leader_id INTEGER,status TEXT DEFAULT 'forming',created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,UNIQUE(quiz_id,team_code),UNIQUE(quiz_id,team_name));
CREATE TABLE IF NOT EXISTS team_members(id SERIAL PRIMARY KEY,team_id INTEGER REFERENCES teams(id) ON DELETE CASCADE,participant_id INTEGER UNIQUE REFERENCES participants(id) ON DELETE CASCADE,member_name TEXT,joined_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP);
CREATE UNIQUE INDEX IF NOT EXISTS uq_resp_team ON responses(question_id,team_id) WHERE team_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS shuffles(question_id INTEGER,owner TEXT,order_json TEXT,PRIMARY KEY(question_id,owner));`);
for(const r of db.prepare('SELECT id,participation_mode m,team_min a,team_max b FROM quizzes WHERE allowed_team_sizes IS NULL OR display_code IS NULL').all())
 db.prepare('UPDATE quizzes SET allowed_team_sizes=COALESCE(allowed_team_sizes,?),display_code=COALESCE(display_code,?) WHERE id=?').run(r.m==='team'?Array.from({length:r.b-r.a+1},(_,k)=>r.a+k).join(','):'1',newCode(),r.id);
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS uq_display ON quizzes(display_code)');
addCol('teams','team_name_normalized','TEXT');db.exec('UPDATE teams SET team_name_normalized=lower(trim(team_name)) WHERE team_name_normalized IS NULL');
try{db.exec('CREATE UNIQUE INDEX IF NOT EXISTS uq_team_norm ON teams(quiz_id,team_name_normalized)')}catch(e){console.warn('uq_team_norm not created (duplicate legacy team names):',e.message)}
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS uq_part_user ON participants(quiz_id,user_id) WHERE user_id IS NOT NULL;CREATE UNIQUE INDEX IF NOT EXISTS uq_resp_sub ON responses(question_id,submission_id) WHERE submission_id IS NOT NULL');
// allowed_team_sizes: subset of [1,2,3,4]; [1] = pure individual mode. (legacy participation_mode/team_min/team_max still accepted)
const cfg=b=>{b=b||{};let sz=b.allowed_team_sizes;
 if(sz===undefined){const pm=b.participation_mode??'individual',mn=+(b.team_min??2),mx=+(b.team_max??4);if(!['individual','team'].includes(pm)||!Number.isInteger(mn)||!Number.isInteger(mx)||mn<2||mx>4||mn>mx)return null;sz=pm==='individual'?[1]:Array.from({length:mx-mn+1},(_,k)=>mn+k)}
 const dm=b.display_mode??'big_only';if(!Array.isArray(sz)||!sz.length||!sz.every(n=>[1,2,3,4].includes(n))||!['full','big_only'].includes(dm))return null;sz=[...new Set(sz)].sort();
 return{sizes:sz.join(','),pm:sz.length===1&&sz[0]===1?'individual':'team',mn:Math.max(2,Math.min(...sz)),mx:Math.max(2,Math.max(...sz)),dm}};
const sizesOf=q=>String(q.allowed_team_sizes||'1').split(',').map(Number);
app.put('/api/quizzes/:id/settings',...ownQuiz,(req,res)=>{const qz=req.quiz;
 if(qz.status!=='draft')return res.status(409).json({error:'Settings are locked once the quiz has started'});const c=cfg(req.body);if(!c)return res.status(400).json({error:'Invalid settings'});
 db.prepare('UPDATE quizzes SET participation_mode=?,team_min=?,team_max=?,display_mode=?,allowed_team_sizes=? WHERE id=?').run(c.pm,c.mn,c.mx,c.dm,c.sizes,req.params.id);res.json({ok:true})});

const server=http.createServer(app),io=new Server(server,{maxHttpBufferSize:1e5});
io.use((s,next)=>{s.data.user=verify(s.handshake.auth?.token)||null;next()}); // identity comes only from the verified token, never from event payloads
const pend={};const sendBoard=quiz=>{if(pend[quiz.id])return;pend[quiz.id]=setTimeout(()=>{delete pend[quiz.id];io.to(quiz.join_code+':staff').emit('SCOREBOARD_UPDATED',board(quiz.id))},300)};
const live={}; // per-quiz transient: team selections + question start time. Lifecycle state itself lives in the DB (current_index, question_status).
const quizOf=c=>db.prepare('SELECT * FROM quizzes WHERE join_code=?').get(String(c).toUpperCase());
const qs=id=>db.prepare('SELECT * FROM questions WHERE quiz_id=? ORDER BY order_number').all(id);
const pub=(q,idx,total)=>({id:q.id,image_url:q.image_url||null,category:q.category,text:q.question_text,marks:q.marks,index:idx,total,options:db.prepare('SELECT id,option_text text FROM options WHERE question_id=?').all(q.id)});
const cur=quiz=>{const q=quiz.current_index>=0?qs(quiz.id)[quiz.current_index]:null;return{q,idx:quiz.current_index,active:!!q&&quiz.status==='live'&&quiz.question_status==='active',st:quiz.question_status}};
const orderFor=(q,owner)=>{const r=db.prepare('SELECT order_json j FROM shuffles WHERE question_id=? AND owner=?').get(q.id,owner);if(r)return JSON.parse(r.j);
 const ids=db.prepare('SELECT id FROM options WHERE question_id=? ORDER BY id').all(q.id).map(o=>o.id);for(let i=ids.length-1;i>0;i--){const j=crypto.randomInt(i+1);[ids[i],ids[j]]=[ids[j],ids[i]]}
 db.prepare('INSERT OR IGNORE INTO shuffles VALUES(?,?,?)').run(q.id,owner,JSON.stringify(ids));return JSON.parse(db.prepare('SELECT order_json j FROM shuffles WHERE question_id=? AND owner=?').get(q.id,owner).j)};
const ownerOf=s=>s.data.teamId?'t'+s.data.teamId:'p'+s.data.pid;
const playerQ=(quiz,c,owner)=>{const q=c.q,txt=Object.fromEntries(db.prepare('SELECT id,option_text t FROM options WHERE question_id=?').all(q.id).map(o=>[o.id,o.t]));
 const o={index:c.idx,total:qs(quiz.id).length,category:q.category,marks:q.marks,options:orderFor(q,owner).map((id,i)=>({id:i+1,text:txt[id]}))};
 if(quiz.display_mode!=='big_only'){o.id=q.id;o.text=q.question_text;o.image_url=q.image_url||null}return o};
const displayQ=(quiz,c)=>{const q=c.q,txt=Object.fromEntries(db.prepare('SELECT id,option_text t FROM options WHERE question_id=?').all(q.id).map(o=>[o.id,o.t]));
 return{image_url:q.image_url||null,category:q.category,text:q.question_text,marks:q.marks,index:c.idx,total:qs(quiz.id).length,options:orderFor(q,'d'+quiz.id).map((id,i)=>({id:i+1,text:txt[id]}))}}; // stored per question => stable across rerenders/reconnects; ids are display positions, not option ids
const board=id=>{const qz=db.prepare('SELECT participation_mode m FROM quizzes WHERE id=?').get(id);
 if(qz?.m==='team')return db.prepare(`SELECT t.id,t.team_name name,NULL team,(SELECT group_concat(member_name,', ') FROM team_members WHERE team_id=t.id) members,COALESCE(SUM(r.score),0) score,COALESCE(SUM(r.is_correct),0) correct,COUNT(r.id) answered,ROUND(AVG(r.response_time),1) avg FROM teams t LEFT JOIN responses r ON r.team_id=t.id WHERE t.quiz_id=? GROUP BY t.id ORDER BY score DESC,AVG(r.response_time),t.team_name`).all(id).map((r,i)=>({...r,rank:i+1}));
 return db.prepare(`SELECT p.id,p.name,p.team_name team,COALESCE(SUM(r.score),0) score,COALESCE(SUM(r.is_correct),0) correct,COUNT(r.id) answered FROM participants p LEFT JOIN responses r ON r.participant_id=p.id WHERE p.quiz_id=? GROUP BY p.id ORDER BY score DESC,p.name`).all(id).map((r,i)=>({...r,rank:i+1}))};
const teamOf=id=>db.prepare('SELECT * FROM teams WHERE id=?').get(id);
const nMembers=id=>db.prepare('SELECT COUNT(*) c FROM team_members WHERE team_id=?').get(id).c;
const counts=(quiz,q)=>({received:q?db.prepare('SELECT COUNT(*) c FROM responses WHERE question_id=?').get(q.id).c:0,
 eligible:quiz.participation_mode==='team'?db.prepare('SELECT id FROM teams WHERE quiz_id=?').all(quiz.id).filter(t=>sizesOf(quiz).includes(nMembers(t.id))).length:db.prepare('SELECT COUNT(*) c FROM participants WHERE quiz_id=?').get(quiz.id).c});
const teamView=(quiz,t,L)=>{const m=db.prepare('SELECT participant_id pid,member_name name FROM team_members WHERE team_id=? ORDER BY id').all(t.id),sel=L?.sel?.[t.id]||{},sz=sizesOf(quiz),c=cur(quiz);
 return{id:t.id,name:t.team_name,code:t.team_code,min:Math.min(...sz),max:Math.max(...sz),sizes:sz,eligible:sz.includes(m.length),
  members:m.map(x=>({name:x.name,leader:x.pid===t.leader_id})),locked:Object.keys(sel).length,total:m.length,finalized:!!(c.q&&db.prepare('SELECT 1 FROM responses WHERE question_id=? AND team_id=?').get(c.q.id,t.id))}};
const pushTeam=(quiz,t,ev)=>{const v=teamView(quiz,t,live[quiz.join_code]);io.to(`${quiz.join_code}:team${t.id}`).emit(ev,v);return v};
const mineOf=(c,s)=>{if(!c.q||!s.data.pid)return null;const r=s.data.teamId?db.prepare('SELECT selected_option_id o,is_correct k FROM responses WHERE question_id=? AND team_id=?').get(c.q.id,s.data.teamId):db.prepare('SELECT selected_option_id o,is_correct k FROM responses WHERE question_id=? AND participant_id=?').get(c.q.id,s.data.pid);
 return r?{pos:orderFor(c.q,ownerOf(s)).indexOf(r.o)+1,...(c.st==='finished'?{correct:!!r.k}:{})}:null}; // correctness is revealed only once the admin finishes the question
function snap(quiz,s){const c=cur(quiz),staff=s.data.staff;
 const o={title:quiz.title,status:quiz.status,qstatus:quiz.status==='finished'?'finished':c.st,open:c.active,total:qs(quiz.id).length,board:board(quiz.id),
  question:c.q?(staff?(s.data.display?displayQ(quiz,c):pub(c.q,c.idx,qs(quiz.id).length)):playerQ(quiz,c,ownerOf(s))):null,config:{participation_mode:quiz.participation_mode,allowed_team_sizes:quiz.allowed_team_sizes,display_mode:quiz.display_mode}};
 if(staff)Object.assign(o,counts(quiz,c.q));else{o.mine=mineOf(c,s);o.answered=!!o.mine}return o}
async function publish(quiz){const c=cur(quiz),total=qs(quiz.id).length;
 for(const sk of await io.in(quiz.join_code).fetchSockets()){if(sk.data.staff)sk.emit('quiz:question_started',{...(sk.data.display?displayQ(quiz,c):pub(c.q,c.idx,total)),...counts(quiz,c.q)});else if(sk.data.pid)sk.emit('quiz:question_started',playerQ(quiz,c,ownerOf(sk)))}}
// SCORING (server only): correct => marks + round(marks * 0.5 * max(0, 1 - t/BONUS_WINDOW)); wrong/none => 0.
// t = server receive time - server question start time (seconds). BONUS_WINDOW_SEC (default 30) is not shown to players. Client timestamps/scores are never read.
const record=(quiz,q,who,o,sid)=>{const t=Math.max(0,(Date.now()-(quiz.question_started_at||Date.now()))/1000),ok=o.is_correct?1:0,score=ok?q.marks+Math.round(q.marks*0.5*Math.max(0,1-t/BONUS_WINDOW)):0;
 try{db.prepare('INSERT INTO responses(question_id,participant_id,team_id,selected_option_id,is_correct,response_time,score,submission_id) VALUES(?,?,?,?,?,?,?,?)').run(q.id,who.pid??null,who.teamId??null,o.id,ok,t,score,sid);return{ok:!!ok,score}}catch{return null}};
const noteResponse=(quiz,q)=>{const n=counts(quiz,q);io.to(quiz.join_code+':staff').emit('quiz:response_received',n);if(n.eligible>0&&n.received>=n.eligible)io.to(quiz.join_code+':staff').emit('quiz:all_responses_received',n);sendBoard(quiz)};
const upsertP=(quiz,u)=>{db.prepare('INSERT OR IGNORE INTO participants(quiz_id,name,device_id,user_id) VALUES(?,?,?,?)').run(quiz.id,u.username,'u'+u.id,u.id);return db.prepare('SELECT id FROM participants WHERE quiz_id=? AND user_id=?').get(quiz.id,u.id)};
const memberOf=(quiz,userId)=>db.prepare('SELECT tm.team_id FROM team_members tm JOIN participants p ON p.id=tm.participant_id WHERE p.quiz_id=? AND p.user_id=?').get(quiz.id,userId);
const maxSize=quiz=>Math.max(...sizesOf(quiz)),clean=v=>typeof v==='string'?v.trim().replace(/\s+/g,' '):'';
io.on('connection',s=>{
 // authorization is re-checked against the DB on every privileged event: ADMIN role + active account + current token version + quiz ownership
 const guard=()=>{const u=s.data.user,quiz=s.data.admin&&quizOf(s.data.quiz),d=u&&db.prepare('SELECT role,status,token_version FROM users WHERE id=?').get(u.id);return quiz&&d&&d.role==='ADMIN'&&d.status==='active'&&d.token_version===u.token_version&&quiz.created_by===u.id?quiz.join_code:null};
 const err=m=>s.emit('admin:error',m),deny=(ack,m)=>{s.emit('submit_error',m);typeof ack==='function'&&ack({ok:false,error:m});return null};
 const player=()=>{const u=s.data.user;if(!u||u.role!=='USER'){s.emit('error_msg','Sign in with a participant account to play');return null}return u};
 function enter(quiz,p,t){Object.assign(s.data,{pid:p.id,quiz:quiz.join_code,teamId:t?.id,admin:false,staff:false});s.join(quiz.join_code);if(t)s.join(`${quiz.join_code}:team${t.id}`);
  const st=snap(quiz,s);if(t){st.team=teamView(quiz,t,live[quiz.join_code]);st.mySel=live[quiz.join_code]?.sel?.[t.id]?.[p.id]??null}s.emit('state',st);if(t)pushTeam(quiz,t,'team:member_joined');
  io.to(quiz.join_code+':staff').emit('quiz:response_received',counts(quiz,cur(quiz).q));sendBoard(quiz)}
 function makeTeam(quiz,u,name,solo){if(quiz.participation_mode!=='team')return s.emit('error_msg','Teams are not enabled for this quiz');if(quiz.status==='finished')return s.emit('error_msg','Quiz finished');
  if(memberOf(quiz,u.id))return s.emit('error_msg','You are already in a team');name=clean(name);
  if(!solo){if(!/^[A-Za-z0-9][A-Za-z0-9 _.'-]{1,38}[A-Za-z0-9]$/.test(name))return s.emit('error_msg','Team name must be 3-40 letters/numbers');if(db.prepare('SELECT 1 FROM users WHERE username_normalized=?').get(norm(name)))return s.emit('error_msg','That name is already taken')}
  let t;for(let k=0;k<5&&!t;k++){try{db.transaction(()=>{const p=upsertP(quiz,u),id=db.prepare('INSERT INTO teams(quiz_id,team_name,team_name_normalized,team_code,leader_id) VALUES(?,?,?,?,?) RETURNING id').run(quiz.id,name,norm(name),newCode(),p.id).lastInsertRowid;
    db.prepare('INSERT INTO team_members(team_id,participant_id,member_name) VALUES(?,?,?)').run(id,p.id,u.username);t=teamOf(id)})()}catch(e){if(/team_name|uq_team/i.test(e.message))return s.emit('error_msg','Team name already taken')}}
  if(!t)return s.emit('error_msg','Could not create team');s.emit('team_created',{teamId:t.id,teamCode:t.team_code,name:t.team_name});enter(quiz,upsertP(quiz,u),t)}
 s.on('join_admin',({code}={})=>{const u=s.data.user,quiz=quizOf(code);if(!u||u.role!=='ADMIN'||!quiz||quiz.created_by!==u.id)return s.emit('error_msg','Forbidden');
  Object.assign(s.data,{admin:true,staff:true,quiz:quiz.join_code});s.join([quiz.join_code,quiz.join_code+':staff']);s.emit('state',snap(quiz,s))});
 // display: authenticated only by its display code; read-only (admin:false), so every admin:* event is rejected
 s.on('display:connect',({displayCode}={})=>{const quiz=db.prepare('SELECT * FROM quizzes WHERE display_code=?').get(String(displayCode||'').trim().toUpperCase());if(!quiz)return s.emit('display:error','Invalid display code');
  Object.assign(s.data,{staff:true,display:true,admin:false,quiz:quiz.join_code});s.join([quiz.join_code,quiz.join_code+':staff']);s.emit('display:connected',{title:quiz.title});s.emit('state',snap(quiz,s))});
 s.on('join_player',({code}={})=>{const u=player();if(!u)return;const quiz=quizOf(code);if(!quiz)return s.emit('error_msg','Quiz not found');
  const m=memberOf(quiz,u.id);if(m)return enter(quiz,upsertP(quiz,u),teamOf(m.team_id));if(quiz.status==='finished')return s.emit('error_msg','Quiz finished');
  if(quiz.participation_mode==='individual')return enter(quiz,upsertP(quiz,u),null);
  if(!sizesOf(quiz).includes(1))return s.emit('error_msg','This quiz requires a team: create or join one');makeTeam(quiz,u,'Solo · '+u.username,true)});
 s.on('create_team',({code,team}={})=>{const u=player(),quiz=u&&quizOf(code);if(!u)return;if(!quiz)return s.emit('error_msg','Quiz not found');makeTeam(quiz,u,team,false)});
 s.on('join_team',({code,teamCode}={})=>{const u=player();if(!u)return;const quiz=quizOf(code);if(!quiz||quiz.participation_mode!=='team'||!str(teamCode,10))return s.emit('error_msg','Invalid join');
  const t=db.prepare('SELECT * FROM teams WHERE quiz_id=? AND team_code=?').get(quiz.id,teamCode.trim().toUpperCase());if(!t)return s.emit('error_msg','Invalid team code');
  const m=memberOf(quiz,u.id);if(m)return m.team_id===t.id?enter(quiz,upsertP(quiz,u),t):s.emit('error_msg','You are already in another team');
  if(quiz.status==='finished')return s.emit('error_msg','Quiz finished');let full=false;
  db.transaction(()=>{if(nMembers(t.id)>=maxSize(quiz)){full=true;return}const p=upsertP(quiz,u);db.prepare('INSERT INTO team_members(team_id,participant_id,member_name) VALUES(?,?,?)').run(t.id,p.id,u.username)})();
  if(full)return s.emit('error_msg','Team is full');enter(quiz,upsertP(quiz,u),t)});
 s.on('disconnect',()=>{if(s.data.teamId&&s.data.quiz)io.to(`${s.data.quiz}:team${s.data.teamId}`).emit('team:member_disconnected',{pid:s.data.pid})});
 // ---- lifecycle: READY -> START -> ACTIVE -> FINISH -> FINISHED -> START NEXT ... -> FINISH QUIZ. No pause, no timer.
 s.on('admin:start_question',async()=>{if(!guard())return err('Unauthorized');const quiz=quizOf(s.data.quiz);
  if(quiz.status==='finished')return err('Quiz is finished');if(quiz.question_status==='active')return err('A question is already active');
  const idx=quiz.current_index+1;if(!qs(quiz.id)[idx])return err('No more questions');
  db.prepare("UPDATE quizzes SET status='live',current_index=?,question_status='active',question_started_at=? WHERE id=?").run(idx,Date.now(),quiz.id);live[quiz.join_code]={sel:{},t0:Date.now()};await publish(quizOf(quiz.join_code))});
 s.on('admin:finish_question',async()=>{if(!guard())return err('Unauthorized');const quiz=quizOf(s.data.quiz);if(quiz.status!=='live'||quiz.question_status!=='active')return err('No active question');
  db.prepare("UPDATE quizzes SET question_status='finished' WHERE id=?").run(quiz.id);const nq=quizOf(quiz.join_code),c=cur(nq),b=board(nq.id),cn=counts(nq,c.q),total=qs(nq.id).length;
  for(const sk of await io.in(nq.join_code).fetchSockets()){const d=sk.data;let me=null;if(!d.staff&&d.pid){const r=b.find(x=>x.id===(d.teamId||d.pid));me={total:r?.score||0,rank:r?.rank}}
   sk.emit('quiz:question_finished',{index:c.idx,total,me,...(d.staff?{board:b,...cn}:{mine:mineOf(c,sk)})})}});
 s.on('admin:finish_quiz',()=>{if(!guard())return err('Unauthorized');const quiz=quizOf(s.data.quiz);if(quiz.status==='finished')return err('Quiz is finished');
  db.prepare("UPDATE quizzes SET status='finished',question_status='finished' WHERE id=?").run(quiz.id);io.to(quiz.join_code).emit('quiz:finished',board(quiz.id))});
 // ---- answers. Players send a DISPLAY POSITION; the server maps it to the real option. One answer, no changes.
 const existing=(q,who)=>who.teamId?db.prepare('SELECT submission_id sid,is_correct k,selected_option_id o FROM responses WHERE question_id=? AND team_id=?').get(q.id,who.teamId):db.prepare('SELECT submission_id sid,is_correct k,selected_option_id o FROM responses WHERE question_id=? AND participant_id=?').get(q.id,who.pid);
 // Idempotent submit: client sends {pos, sid}. Same sid again => same stored result (safe retry); a different sid after an answer exists => rejected.
 function submit(ack,sid,who,pos,room){const reply=r=>{if(!r.ok)s.emit('submit_error',r.error);typeof ack==='function'&&ack(r);return r},to=room?io.to(room):s;
  const quiz=quizOf(s.data.quiz),c=cur(quiz);if(!c.q)return reply({ok:false,error:'Question is not active'});if(!str(sid,64))return reply({ok:false,error:'Invalid request'});
  const owner=who.teamId?'t'+who.teamId:'p'+who.pid,ex=existing(c.q,who);
  if(ex){if(ex.sid!==sid)return reply({ok:false,error:'Already answered'});const p=orderFor(c.q,owner).indexOf(ex.o)+1;const rv=c.st==='finished'?{correct:!!ex.k}:{};s.emit('participant:answer_result',{pos:p,...rv});return reply({ok:true,pos:p,...rv,duplicate:true})}
  if(!c.active)return reply({ok:false,error:'Question is not active'});
  const oid=Number.isInteger(pos)?orderFor(c.q,owner)[pos-1]:null,o=oid&&db.prepare('SELECT * FROM options WHERE id=? AND question_id=?').get(oid,c.q.id);if(!o)return reply({ok:false,error:'Invalid option'});
  const r=record(quiz,c.q,who,o,sid);if(!r)return reply({ok:false,error:'Already answered'});
  to.emit('participant:answer_locked',{pos});to.emit('participant:answer_result',{pos});noteResponse(quiz,c.q);return reply({ok:true,pos})}
 // who = {pid} / {teamId} come ONLY from server state set in enter(); payload ids are ignored.
 s.on('participant:submit_answer',({pos,sid}={},ack)=>{const u=s.data.user,pid=s.data.pid;if(!u||u.role!=='USER'||!pid||!s.data.quiz)return deny(ack,'Not joined');if(s.data.teamId)return deny(ack,'Use your team controls');submit(ack,sid,{pid},pos)});
 const tctx=ack=>{const quiz=quizOf(s.data.quiz),c=cur(quiz),t=s.data.teamId&&teamOf(s.data.teamId);
  if(!t||t.quiz_id!==quiz.id||!db.prepare('SELECT 1 FROM team_members WHERE team_id=? AND participant_id=?').get(t.id,s.data.pid)){deny(ack,'Not in a team');return null}
  if(!c.active){deny(ack,'Question is not active');return null}const v=teamView(quiz,t,live[quiz.join_code]);
  if(!v.eligible){deny(ack,'Team needs more members');return null}if(v.finalized){deny(ack,'Answer already finalized');return null}
  return{L:live[quiz.join_code]||(live[quiz.join_code]={sel:{},t0:Date.now()}),quiz,c,t}};
 // A member's pick is private and locks immediately: it goes back ONLY to that member's socket. The team room only learns how many members have locked.
 s.on('team:select_answer',({pos}={})=>{const x=tctx();if(!x)return;if(!Number.isInteger(pos)||pos<1||pos>orderFor(x.c.q,'t'+x.t.id).length)return s.emit('submit_error','Invalid option');
  const m=x.L.sel[x.t.id]||(x.L.sel[x.t.id]={});if(m[s.data.pid])return s.emit('submit_error','Selection already locked');m[s.data.pid]=pos;s.emit('team:my_selection',{pos});pushTeam(x.quiz,x.t,'team:answer_updated')});
 s.on('team:finalize',({sid}={},ack)=>{const u=s.data.user,pid=s.data.pid,tid=s.data.teamId;if(!u||u.role!=='USER'||!pid||!tid)return deny(ack,'Not in a team');
  const quiz=quizOf(s.data.quiz),c=cur(quiz),t=teamOf(tid);if(!t||t.quiz_id!==quiz.id||t.leader_id!==pid||!db.prepare('SELECT 1 FROM team_members WHERE team_id=? AND participant_id=?').get(tid,pid))return deny(ack,'Only the team leader can finalize');
  if(!(c.q&&existing(c.q,{teamId:tid}))){const x=tctx(ack);if(!x)return;if(!x.L.sel[tid]?.[pid])return deny(ack,'Select an answer first')}
  const r=submit(ack,sid,{teamId:tid},live[quiz.join_code]?.sel?.[tid]?.[pid],`${quiz.join_code}:team${tid}`);if(r.ok)pushTeam(quiz,t,'team:answer_finalized')});
});
// ---- restart / delete (REST: authenticated ADMIN + ownership; ids come from the URL param validated against the DB, never from the body)
app.post('/api/quizzes/:id/restart',...ownQuiz,(req,res)=>{const q=req.quiz;db.transaction(()=>{
  db.prepare('DELETE FROM responses WHERE question_id IN (SELECT id FROM questions WHERE quiz_id=?)').run(q.id);db.prepare('DELETE FROM shuffles WHERE question_id IN (SELECT id FROM questions WHERE quiz_id=?)').run(q.id);
  db.prepare("UPDATE quizzes SET status='draft',current_index=-1,question_status='ready',question_started_at=NULL WHERE id=?").run(q.id)})();
 delete live[q.join_code];io.to(q.join_code).emit('quiz:restarted');res.json({ok:true})}); // keeps quiz, questions, participants, teams
app.delete('/api/quizzes/:id',...ownQuiz,(req,res)=>{const q=req.quiz;if(String(req.body?.confirm||'').trim().toUpperCase()!==q.join_code)return bad(res,'Type the quiz code to confirm');
 const imgs=db.prepare('SELECT image_url FROM questions WHERE quiz_id=? AND image_url IS NOT NULL').all(q.id);
 db.transaction(()=>{db.prepare('DELETE FROM shuffles WHERE question_id IN (SELECT id FROM questions WHERE quiz_id=?)').run(q.id);db.prepare('DELETE FROM quizzes WHERE id=?').run(q.id)})(); // FK cascades: questions, options, responses, participants, teams, team_members
 imgs.forEach(i=>rmImg(i.image_url));io.to(q.join_code).emit('quiz:deleted');io.in(q.join_code).disconnectSockets(true);delete live[q.join_code];res.json({ok:true})});
module.exports={app,server,db,io};
if(require.main===module)server.listen(process.env.PORT||3000,()=>console.log('http://localhost:'+(process.env.PORT||3000)));
