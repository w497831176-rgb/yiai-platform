import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { createInMemoryPool, createTestApp, createTestUser } from './helpers/in-memory-db.js';
import { authRoutes } from '../src/routes/auth.js';
import { adminRoutes } from '../src/routes/admin.js';

vi.mock('../src/auth/password.js', () => ({
  hashPassword: vi.fn((password: string) => `hashed-${password}`),
  verifyPassword: vi.fn((plain: string, hash: string) => hash === `hashed-${plain}`),
}));

async function buildApp(pool: Pool): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(authRoutes, { prefix: '/api/auth', pool });
  await app.register(adminRoutes, { prefix: '/api', pool });
  return app;
}

async function login(app: FastifyInstance, username: string, password: string): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username, password },
  });
  const body = JSON.parse(response.body) as { token: string };
  return body.token;
}

describe('Admin Routes', () => {
  let pool: Pool;

  beforeEach(async () => {
    pool = await createInMemoryPool();
  });

  it('does not expose api_key in admin app list', async () => {
    const app = await buildApp(pool);
    await createTestUser(pool, 'admin_user', 'admin', 'testpass');
    await createTestApp(pool, { slug: 'test-app', name: 'Test App', api_key: 'secret-key' });

    const token = await login(app, 'admin_user', 'testpass');

    const response = await app.inject({
      method: 'GET',
      url: '/api/admin/apps',
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as Array<Record<string, unknown>>;
    expect(body).toHaveLength(1);
    expect(body[0]).not.toHaveProperty('api_key');
    expect(body[0].api_key_configured).toBe(true);
  });

  it('allows admin to create and update apps', async () => {
    const app = await buildApp(pool);
    await createTestUser(pool, 'admin_user', 'admin', 'testpass');

    const token = await login(app, 'admin_user', 'testpass');

    const createResponse = await app.inject({
      method: 'POST',
      url: '/api/admin/apps',
      headers: { Authorization: `Bearer ${token}` },
      payload: {
        slug: 'new-app',
        name: 'New App',
        api_base_url: 'https://yiai.example.com/v1',
        api_key: 'initial-key',
        sort_order: 1,
      },
    });

    expect(createResponse.statusCode).toBe(201);

    const listResponse = await app.inject({
      method: 'GET',
      url: '/api/admin/apps',
      headers: { Authorization: `Bearer ${token}` },
    });
    const apps = JSON.parse(listResponse.body) as Array<{ id: string; api_key_configured: boolean; name: string }>;
    expect(apps[0].api_key_configured).toBe(true);

    const updateResponse = await app.inject({
      method: 'PATCH',
      url: `/api/admin/apps/${apps[0].id}`,
      headers: { Authorization: `Bearer ${token}` },
      payload: { name: 'Updated App', api_key: 'new-key' },
    });

    expect(updateResponse.statusCode).toBe(200);
    const updated = JSON.parse(updateResponse.body) as { name: string };
    expect(updated.name).toBe('Updated App');

    // Verify api_key was actually updated
    const dbResult = await pool.query<{ api_key: string }>('SELECT api_key FROM yiai_apps WHERE slug = $1', ['new-app']);
    expect(dbResult.rows[0].api_key).toBe('new-key');
  });

  it('does not update api_key when empty string is provided', async () => {
    const app = await buildApp(pool);
    await createTestUser(pool, 'admin_user', 'admin', 'testpass');
    await createTestApp(pool, { slug: 'edit-app', name: 'Edit App', api_key: 'old-key' });

    const token = await login(app, 'admin_user', 'testpass');

    const listResponse = await app.inject({
      method: 'GET',
      url: '/api/admin/apps',
      headers: { Authorization: `Bearer ${token}` },
    });
    const apps = JSON.parse(listResponse.body) as Array<{ id: string }>;

    const updateResponse = await app.inject({
      method: 'PATCH',
      url: `/api/admin/apps/${apps[0].id}`,
      headers: { Authorization: `Bearer ${token}` },
      payload: { name: 'Renamed App', api_key: '' },
    });

    expect(updateResponse.statusCode).toBe(200);

    const dbResult = await pool.query<{ api_key: string }>('SELECT api_key FROM yiai_apps WHERE slug = $1', ['edit-app']);
    expect(dbResult.rows[0].api_key).toBe('old-key');
  });

  it('prevents duplicate slug when creating apps', async () => {
    const app = await buildApp(pool);
    await createTestUser(pool, 'admin_user', 'admin', 'testpass');
    await createTestApp(pool, { slug: 'dup-app', name: 'Dup App' });

    const token = await login(app, 'admin_user', 'testpass');

    const response = await app.inject({
      method: 'POST',
      url: '/api/admin/apps',
      headers: { Authorization: `Bearer ${token}` },
      payload: { slug: 'dup-app', name: 'Another', api_base_url: 'https://yiai.example.com/v1' },
    });

    expect(response.statusCode).toBe(409);
  });
});
