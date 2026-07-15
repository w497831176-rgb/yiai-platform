import { describe, it, expect, beforeEach } from 'vitest';
import Fastify from 'fastify';
import { authRoutes } from '../src/routes/auth.js';
import { hashPassword } from '../src/auth/password.js';
import type { Pool, QueryResult } from 'pg';
import type { SafeUser, AuthResponse } from '@yiai/shared';

interface UserRow {
  id: string;
  username: string;
  password_hash: string;
  role: 'user' | 'admin';
  created_at: Date;
  updated_at: Date;
}

function createMockPool(initial: UserRow[] = []): Pool {
  const store = [...initial];

  const query = (sql: string, params?: unknown[]): Promise<QueryResult<UserRow>> => {
    const lower = sql.toLowerCase();

    if (lower.includes('select') && lower.includes('from users') && lower.includes('where username')) {
      const user = store.find((u) => u.username === params?.[0]);
      return Promise.resolve({ rows: user ? [user] : [], rowCount: user ? 1 : 0 } as QueryResult<UserRow>);
    }

    if (lower.includes('select') && lower.includes('from users') && lower.includes('where id')) {
      const user = store.find((u) => u.id === params?.[0]);
      return Promise.resolve({ rows: user ? [user] : [], rowCount: user ? 1 : 0 } as QueryResult<UserRow>);
    }

    if (lower.includes('insert into users')) {
      const newUser: UserRow = {
        id: crypto.randomUUID(),
        username: params?.[0] as string,
        password_hash: params?.[1] as string,
        role: 'user',
        created_at: new Date(),
        updated_at: new Date(),
      };
      store.push(newUser);
      return Promise.resolve({ rows: [newUser], rowCount: 1 } as QueryResult<UserRow>);
    }

    if (lower.includes('update users')) {
      const id = params?.[1] as string;
      const user = store.find((u) => u.id === id);
      if (user) {
        user.password_hash = params?.[0] as string;
        user.updated_at = new Date();
      }
      return Promise.resolve({ rows: [], rowCount: user ? 1 : 0 } as QueryResult<UserRow>);
    }

    return Promise.resolve({ rows: [], rowCount: 0 } as QueryResult<UserRow>);
  };

  return { query } as unknown as Pool;
}

async function buildTestApp(pool: Pool) {
  const app = Fastify({ logger: false });
  await app.register(authRoutes, { prefix: '/api/auth', pool });
  return app;
}

describe('Authentication', () => {
  let pool: Pool;

  beforeEach(() => {
    pool = createMockPool();
  });

  it('registers a new user successfully', async () => {
    const app = await buildTestApp(pool);
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { username: 'test_user', password: '123456' },
    });

    expect(response.statusCode).toBe(201);
    const body = JSON.parse(response.body) as SafeUser;
    expect(body.username).toBe('test_user');
    expect(body.role).toBe('user');
    expect(body.password_hash).toBeUndefined();
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
    const passwordHash = await hashPassword('123456');
    pool = createMockPool([
      {
        id: 'user-1',
        username: 'test_user',
        password_hash: passwordHash,
        role: 'user',
        created_at: new Date(),
        updated_at: new Date(),
      },
    ]);
    const app = await buildTestApp(pool);

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
    const passwordHash = await hashPassword('123456');
    pool = createMockPool([
      {
        id: 'user-1',
        username: 'test_user',
        password_hash: passwordHash,
        role: 'user',
        created_at: new Date(),
        updated_at: new Date(),
      },
    ]);
    const app = await buildTestApp(pool);

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
    const passwordHash = await hashPassword('123456');
    pool = createMockPool([
      {
        id: 'user-1',
        username: 'test_user',
        password_hash: passwordHash,
        role: 'user',
        created_at: new Date(),
        updated_at: new Date(),
      },
    ]);
    const app = await buildTestApp(pool);

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
    const passwordHash = await hashPassword('123456');
    pool = createMockPool([
      {
        id: 'user-1',
        username: 'test_user',
        password_hash: passwordHash,
        role: 'user',
        created_at: new Date(),
        updated_at: new Date(),
      },
    ]);
    const app = await buildTestApp(pool);

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
    const body = JSON.parse(response.body) as SafeUser;
    expect(body.role).toBe('user');
  });
});
