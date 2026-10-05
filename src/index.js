import { Container, getContainer } from '@cloudflare/containers';
import { env as workerEnv } from 'cloudflare:workers';

// One stateful instance is intentional: Socket.IO rooms, timers and selections live in memory.
export class ChallengeArena extends Container {
  defaultPort = 3000;
  sleepAfter = '30m';
  envVars = {
    NODE_ENV: 'production',
    PORT: '3000',
    JWT_SECRET: workerEnv.JWT_SECRET,
    ADMIN_USERNAME: workerEnv.ADMIN_USERNAME,
    ADMIN_PASSWORD: workerEnv.ADMIN_PASSWORD,
    DATABASE_URL: workerEnv.DATABASE_URL,
  };
}

export default {
  fetch(request, env) {
    // Container.fetch forwards HTTP and WebSocket upgrade requests unchanged.
    return getContainer(env.CHALLENGE_ARENA).fetch(request);
  },
};
