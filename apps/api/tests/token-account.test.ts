import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { createInMemoryPool, createTestApp, createTestUser } from './helpers/in-memory-db.js';
import { tokenAccountRoutes } from '../src/routes/token-account.js';
import { authRoutes } from '../src/routes/auth.js';
import { adminRoutes } from '../src/routes/admin.js';

vi.mock('../src/auth/password.js', () => ({
  hashPassword: vi.fn((password: string) => `hashed-${password}`),
  verifyPassword: vi.fn((plain: string, hash: string) => hash === `hashed-${plain}`),
}));

async function buildApp(pool: Pool): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(authRoutes, { prefix: '/api/auth', pool });
  await app.register(tokenAccountRoutes, { prefix: '/api', pool });
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

describe('Token Account Service', () => {
  let pool: Pool;

  beforeEach(async () => {
    pool = await createInMemoryPool();
  });

  it('newly registered user receives 50,000 daily gift tokens and a ledger entry', async () => {
    const app = await buildApp(pool);

    const registerResponse = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { username: 'new_gift_user', password: 'secret123' },
    });

    expect(registerResponse.statusCode).toBe(201);

    const token = await login(app, 'new_gift_user', 'secret123');

    const accountResponse = await app.inject({
      method: 'GET',
      url: '/api/token-account',
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(accountResponse.statusCode).toBe(200);
    const account = JSON.parse(accountResponse.body) as {
      gift_tokens: number;
      recharge_tokens: number;
      total_tokens: number;
    };
    expect(account.gift_tokens).toBe(50000);
    expect(account.recharge_tokens).toBe(0);
    expect(account.total_tokens).toBe(50000);

    const ledgerResponse = await app.inject({
      method: 'GET',
      url: '/api/token-account/ledger',
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(ledgerResponse.statusCode).toBe(200);
    const ledger = JSON.parse(ledgerResponse.body) as Array<{
      entry_type: string;
      bucket: string;
      delta_tokens: number;
    }>;
    expect(ledger).toHaveLength(1);
    expect(ledger[0].entry_type).toBe('daily_gift');
    expect(ledger[0].bucket).toBe('gift');
    expect(ledger[0].delta_tokens).toBe(50000);
  });

  it('does not double grant daily gift on the same day', async () => {
    const app = await buildApp(pool);
    const userId = await createTestUser(pool, 'same_day_user');

    // Simulate yesterday's gift to ensure token_account exists and then grant today's
    await pool.query("UPDATE token_accounts SET gift_tokens = 0, last_gift_date = CURRENT_DATE - INTERVAL '1 day' WHERE user_id = $1", [userId]);

    const token = await login(app, 'same_day_user', 'secret123');

    // First read
    await app.inject({
      method: 'GET',
      url: '/api/token-account',
      headers: { Authorization: `Bearer ${token}` },
    });

    // Second read
    const accountResponse = await app.inject({
      method: 'GET',
      url: '/api/token-account',
      headers: { Authorization: `Bearer ${token}` },
    });

    const account = JSON.parse(accountResponse.body) as { gift_tokens: number };
    expect(account.gift_tokens).toBe(50000);

    const ledgerResponse = await app.inject({
      method: 'GET',
      url: '/api/token-account/ledger',
      headers: { Authorization: `Bearer ${token}` },
    });
    const ledger = JSON.parse(ledgerResponse.body) as Array<{ entry_type: string }>;
    expect(ledger.filter((e) => e.entry_type === 'daily_gift')).toHaveLength(1);
  });

  it('grants daily gift across days without exceeding 100,000 cap', async () => {
    const app = await buildApp(pool);
    const userId = await createTestUser(pool, 'cross_day_user');

    // Start with 40,000 gift and last gift 3 days ago
    await pool.query(
      "UPDATE token_accounts SET gift_tokens = 40000, last_gift_date = CURRENT_DATE - INTERVAL '3 days' WHERE user_id = $1",
      [userId]
    );

    const token = await login(app, 'cross_day_user', 'secret123');

    const accountResponse = await app.inject({
      method: 'GET',
      url: '/api/token-account',
      headers: { Authorization: `Bearer ${token}` },
    });

    const account = JSON.parse(accountResponse.body) as { gift_tokens: number };
    // 3 days * 50,000 = 150,000 possible, capped at 100,000
    expect(account.gift_tokens).toBe(100000);

    const ledgerResponse = await app.inject({
      method: 'GET',
      url: '/api/token-account/ledger',
      headers: { Authorization: `Bearer ${token}` },
    });
    const ledger = JSON.parse(ledgerResponse.body) as Array<{ entry_type: string; delta_tokens: number }>;
    const gifts = ledger.filter((e) => e.entry_type === 'daily_gift');
    expect(gifts.reduce((sum, e) => sum + e.delta_tokens, 0)).toBe(60000);
  });

  it('deducts usage from gift tokens first then recharge tokens', async () => {
    const userId = await createTestUser(pool, 'deduct_user');
    const appId = await createTestApp(pool);

    // Gift 4,000, recharge 5,000
    await pool.query(
      'UPDATE token_accounts SET gift_tokens = 4000, recharge_tokens = 5000, last_gift_date = CURRENT_DATE WHERE user_id = $1',
      [userId]
    );

    const { deductForUsage } = await import('../src/services/token-account.js');

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const usageResult = await client.query<{ id: string }>(
        "INSERT INTO yiai_usage_records (user_id, app_id, conversation_id, message_id, task_id, total_tokens) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id",
        [userId, appId, 'conv-id', 'msg-1', 'task-1', 6000]
      );
      await deductForUsage(client, userId, 6000, usageResult.rows[0].id, '测试消耗');
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }

    const result = await pool.query<{ gift_tokens: number; recharge_tokens: number }>('SELECT gift_tokens, recharge_tokens FROM token_accounts WHERE user_id = $1', [userId]);
    expect(result.rows[0].gift_tokens).toBe(0);
    expect(result.rows[0].recharge_tokens).toBe(3000);

    const ledger = await pool.query<{ bucket: string; delta_tokens: number }>(
      'SELECT bucket, delta_tokens FROM token_ledger_entries WHERE user_id = $1 ORDER BY created_at',
      [userId]
    );
    expect(ledger.rows).toHaveLength(2);
    expect(ledger.rows[0].bucket).toBe('gift');
    expect(ledger.rows[0].delta_tokens).toBe(-4000);
    expect(ledger.rows[1].bucket).toBe('recharge');
    expect(ledger.rows[1].delta_tokens).toBe(-2000);
  });

  it('allows recharge_tokens to go negative when usage exceeds total balance', async () => {
    const userId = await createTestUser(pool, 'negative_user');
    const appId = await createTestApp(pool);
    await pool.query(
      'UPDATE token_accounts SET gift_tokens = 1000, recharge_tokens = 500, last_gift_date = CURRENT_DATE WHERE user_id = $1',
      [userId]
    );

    const { deductForUsage } = await import('../src/services/token-account.js');

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const usageResult = await client.query<{ id: string }>(
        "INSERT INTO yiai_usage_records (user_id, app_id, conversation_id, message_id, task_id, total_tokens) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id",
        [userId, appId, 'conv-id', 'msg-2', 'task-2', 3000]
      );
      await deductForUsage(client, userId, 3000, usageResult.rows[0].id);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }

    const result = await pool.query<{ gift_tokens: number; recharge_tokens: number }>('SELECT gift_tokens, recharge_tokens FROM token_accounts WHERE user_id = $1', [userId]);
    expect(result.rows[0].gift_tokens).toBe(0);
    expect(result.rows[0].recharge_tokens).toBe(-1500);
  });

  it('admin recharge increases recharge_tokens and writes admin_recharge ledger', async () => {
    const app = await buildApp(pool);
    await createTestUser(pool, 'test_admin', 'admin');
    const userId = await createTestUser(pool, 'recharge_target');

    const adminToken = await login(app, 'test_admin', 'secret123');
    const userToken = await login(app, 'recharge_target', 'secret123');

    const rechargeResponse = await app.inject({
      method: 'POST',
      url: `/api/admin/users/${userId}/recharge`,
      headers: { Authorization: `Bearer ${adminToken}` },
      payload: { amount: 10000, note: '测试充值' },
    });

    expect(rechargeResponse.statusCode).toBe(200);

    const accountResponse = await app.inject({
      method: 'GET',
      url: '/api/token-account',
      headers: { Authorization: `Bearer ${userToken}` },
    });
    const account = JSON.parse(accountResponse.body) as { recharge_tokens: number; gift_tokens: number };
    expect(account.recharge_tokens).toBe(10000);
    expect(account.gift_tokens).toBe(50000); // daily gift also applied on first read

    const ledgerResponse = await app.inject({
      method: 'GET',
      url: '/api/token-account/ledger',
      headers: { Authorization: `Bearer ${userToken}` },
    });
    const ledger = JSON.parse(ledgerResponse.body) as Array<{ entry_type: string; bucket: string; delta_tokens: number }>;
    const rechargeEntry = ledger.find((e) => e.entry_type === 'admin_recharge');
    expect(rechargeEntry).toBeDefined();
    expect(rechargeEntry?.bucket).toBe('recharge');
    expect(rechargeEntry?.delta_tokens).toBe(10000);
  });

  it('handles PostgreSQL BIGINT string and caps daily gift at 100000 across two days', async () => {
    const app = await buildApp(pool);
    const userId = await createTestUser(pool, 'bigint_user');

    // 模拟 PostgreSQL BIGINT 以字符串形式返回，且上次赠送为两天前
    await pool.query(
      "UPDATE token_accounts SET gift_tokens = $1, last_gift_date = CURRENT_DATE - INTERVAL '2 days' WHERE user_id = $2",
      ['25000', userId]
    );

    const token = await login(app, 'bigint_user', 'secret123');

    const accountResponse = await app.inject({
      method: 'GET',
      url: '/api/token-account',
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(accountResponse.statusCode).toBe(200);
    const account = JSON.parse(accountResponse.body) as { gift_tokens: number };
    expect(account.gift_tokens).toBe(100000);

    const ledger = await pool.query<{ entry_type: string; delta_tokens: number }>(
      'SELECT entry_type, delta_tokens FROM token_ledger_entries WHERE user_id = $1 ORDER BY created_at ASC',
      [userId]
    );
    const gifts = ledger.rows.filter((e) => e.entry_type === 'daily_gift');
    expect(gifts).toHaveLength(2);
    expect(gifts[0].delta_tokens).toBe(50000);
    expect(gifts[1].delta_tokens).toBe(25000);
  });

  it('triggers daily gift make-up when admin lists users', async () => {
    const app = await buildApp(pool);
    await createTestUser(pool, 'test_admin', 'admin');
    const userId = await createTestUser(pool, 'gift_target');
    await pool.query(
      "UPDATE token_accounts SET gift_tokens = 0, last_gift_date = CURRENT_DATE - INTERVAL '1 day' WHERE user_id = $1",
      [userId]
    );

    const adminToken = await login(app, 'test_admin', 'secret123');

    const usersResponse = await app.inject({
      method: 'GET',
      url: '/api/admin/users',
      headers: { Authorization: `Bearer ${adminToken}` },
    });

    expect(usersResponse.statusCode).toBe(200);
    const users = JSON.parse(usersResponse.body) as Array<{ id: string; gift_tokens: number }>;
    const target = users.find((u) => u.id === userId);
    expect(target).toBeDefined();
    expect(target?.gift_tokens).toBe(50000);
  });

  it('prevents non-admin users from accessing admin endpoints', async () => {
    const app = await buildApp(pool);
    const userId = await createTestUser(pool, 'normal_user');
    const appId = await createTestApp(pool, { slug: 'admin-test-app', api_key: 'key' });
    const token = await login(app, 'normal_user', 'secret123');

    const endpoints = [
      { method: 'GET' as const, url: '/api/admin/users' },
      { method: 'GET' as const, url: `/api/admin/users/${userId}/ledger` },
      { method: 'POST' as const, url: `/api/admin/users/${userId}/recharge`, payload: { amount: 100 } },
      { method: 'GET' as const, url: '/api/admin/apps' },
      { method: 'POST' as const, url: '/api/admin/apps', payload: { slug: 'x', api_base_url: 'https://x', api_key: 'k' } },
      { method: 'PATCH' as const, url: `/api/admin/apps/${appId}`, payload: { name: 'x' } },
      { method: 'POST' as const, url: `/api/admin/apps/${appId}/sync` },
    ];

    for (const endpoint of endpoints) {
      const response = await app.inject({
        ...endpoint,
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(response.statusCode).toBe(403);
    }
  });
});
