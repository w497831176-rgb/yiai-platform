import type { FastifyInstance } from 'fastify';
import type { HealthStatus } from '@yiai/shared';
import { env } from '../env.js';

export interface HealthDependencies {
  checkDatabaseConnection: () => Promise<boolean>;
}

export function healthRoutes(
  fastify: FastifyInstance,
  options: { dependencies: HealthDependencies }
): void {
  fastify.get('/api/health', async (_request, reply) => {
    const isConnected = await options.dependencies.checkDatabaseConnection();

    const payload: HealthStatus = {
      status: isConnected ? 'ok' : 'error',
      service: 'yiai-platform-api',
      environment: env.NODE_ENV,
      database: isConnected ? 'connected' : 'disconnected',
    };

    if (!isConnected) {
      return reply.status(503).send(payload);
    }

    return reply.status(200).send(payload);
  });
}
