import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import { healthRoutes, type HealthDependencies } from '../src/routes/health.js';
import type { HealthStatus } from '@yiai/shared';

async function buildTestApp(deps: HealthDependencies) {
  const app = Fastify({ logger: false });
  app.register(healthRoutes, { dependencies: deps });
  return app;
}

describe('GET /api/health', () => {
  it('returns 200 and ok status when database is connected', async () => {
    const app = await buildTestApp({
      checkDatabaseConnection: () => Promise.resolve(true),
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/health',
    });

    expect(response.statusCode).toBe(200);

    const body = JSON.parse(response.body) as HealthStatus;
    expect(body.status).toBe('ok');
    expect(body.service).toBe('yiai-platform-api');
    expect(body.database).toBe('connected');
  });

  it('returns non-200 status when database is disconnected', async () => {
    const app = await buildTestApp({
      checkDatabaseConnection: () => Promise.resolve(false),
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/health',
    });

    expect(response.statusCode).not.toBe(200);
    expect(response.statusCode).toBe(503);

    const body = JSON.parse(response.body) as HealthStatus;
    expect(body.status).toBe('error');
    expect(body.database).toBe('disconnected');
  });
});
