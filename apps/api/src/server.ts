import Fastify, { type FastifyInstance } from 'fastify';
import { env } from './env.js';
import { pool, checkDatabaseConnection } from './db.js';
import { healthRoutes } from './routes/health.js';

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: true,
  });

  await app.register(healthRoutes, { dependencies: { checkDatabaseConnection } });

  return app;
}

async function start(): Promise<void> {
  const app = await buildApp();

  try {
    await app.listen({ port: env.PORT, host: '0.0.0.0' });
  } catch (error) {
    app.log.error(error);
    await pool.end();
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await start();
}
