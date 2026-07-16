import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify from 'fastify';
import { authRoutes } from '../src/routes/auth.js';
import type { Pool } from 'pg';
import type { SafeUser, AuthResponse } from '@yiai/shared';
import { createInMemoryPool, createTestUser } from './helpers/in-memory-db.js';

vi.mock('../src/auth/password.js', () => ({
  hashPassword: vi.fn((password: string) => `hashed-${password}`),
  verifyPassword: vi.fn((plain: string, hash: string) => hash === `hashed-${plain}`),
}));

async function buildTestApp(pool: Pool) {
  const app = Fastify({ logger: false });
  await app.register(authRoutes, { prefix: '/api/auth', pool });
  return app;
}

describe('Authentication', () => {
  let pool: Pool;

  beforeEach(async () => {
    pool = await createInMemoryPool();
  });

  it('registers a new user successfully', async () => {
    const app = await buildTestApp(pool);
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { username: 'test_user', password: '123456' },
    });

    expect(response.statusCode).toBe(201);
    const body = JSON.parse(response.body) as AuthResponse;
    expect(body.user.username).toBe('test_user');
    expect(body.user.role).toBe('user');
    expect((body.user as unknown as Record<string, unknown>).password_hash).toBeUndefined();
    expect(body.token).toBeDefined();

    const account = await pool.query<{ gift_tokens: number }>('SELECT gift_tokens FROM token_accounts WHERE user_id = $1', [body.user.id]);
    expect(account.rows[0].gift_tokens).toBe(50000);
  });

  it('rejects duplicate username with 409', async () => {
    const app = await buildTestApp(pool);
    await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { username: 'test_user', password: '123456' },
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { username: 'test_user', password: '654321' },
    });

    expect(response.statusCode).toBe(409);
  });

  it('logs in with correct password', async () => {
    const app = await buildTestApp(pool);
    await createTestUser(pool, 'test_user', 'user', '123456');

    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'test_user', password: '123456' },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as AuthResponse;
    expect(body.token).toBeDefined();
    expect(body.user.username).toBe('test_user');
  });

  it('rejects login with wrong password', async () => {
    const app = await buildTestApp(pool);
    await createTestUser(pool, 'test_user', 'user', '123456');

    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'test_user', password: 'wrongpass' },
    });

    expect(response.statusCode).toBe(401);
  });

  it('rejects /me without token', async () => {
    const app = await buildTestApp(pool);
    const response = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
    });

    expect(response.statusCode).toBe(401);
  });

  it('returns current user when logged in', async () => {
    const app = await buildTestApp(pool);
    await createTestUser(pool, 'test_user', 'user', '123456');

    const loginResponse = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'test_user', password: '123456' },
    });
    const { token } = JSON.parse(loginResponse.body) as AuthResponse;

    const meResponse = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(meResponse.statusCode).toBe(200);
    const body = JSON.parse(meResponse.body) as SafeUser;
    expect(body.username).toBe('test_user');
  });

  it('allows password change and rejects old password', async () => {
    const app = await buildTestApp(pool);
    await createTestUser(pool, 'test_user', 'user', '123456');

    const loginResponse = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'test_user', password: '123456' },
    });
    const { token } = JSON.parse(loginResponse.body) as AuthResponse;

    const changeResponse = await app.inject({
      method: 'POST',
      url: '/api/auth/change-password',
      headers: { Authorization: `Bearer ${token}` },
      payload: { currentPassword: '123456', newPassword: '654321' },
    });

    expect(changeResponse.statusCode).toBe(200);

    const oldLoginResponse = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'test_user', password: '123456' },
    });
    expect(oldLoginResponse.statusCode).toBe(401);

    const newLoginResponse = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'test_user', password: '654321' },
    });
    expect(newLoginResponse.statusCode).toBe(200);
  });

  it('does not allow registering admin through register endpoint', async () => {
    const app = await buildTestApp(pool);
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { username: 'admin_user', password: '123456' },
    });

    expect(response.statusCode).toBe(201);
    const body = JSON.parse(response.body) as AuthResponse;
    expect(body.user.role).toBe('user');
  });
});
