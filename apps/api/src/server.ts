import Fastify, { type FastifyInstance } from 'fastify';
import { pathToFileURL } from 'node:url';
import { env } from './env.js';
import { pool, checkDatabaseConnection } from './db.js';
import { healthRoutes } from './routes/health.js';
import { authRoutes } from './routes/auth.js';
import { appRoutes } from './routes/apps.js';
import { tokenAccountRoutes } from './routes/token-account.js';
import { adminRoutes } from './routes/admin.js';

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: true,
  });

  app.get('/', () => {
    return { status: 'ok', service: 'yiai-platform-api' };
  });

  app.register(healthRoutes, { dependencies: { checkDatabaseConnection } });
  app.register(authRoutes, { prefix: '/api/auth', pool });
  app.register(appRoutes, { prefix: '/api/apps', pool });
  app.register(tokenAccountRoutes, { prefix: '/api', pool });
  app.register(adminRoutes, { prefix: '/api', pool });

  return app;
}

export async function startServer(): Promise<void> {
  const app = await buildApp();
  const address = await app.listen({ port: env.PORT, host: '0.0.0.0' });
  app.log.info(`Server listening at ${address}`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  startServer().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
