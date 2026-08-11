import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { createInMemoryPool, createTestApp, createTestUser } from './helpers/in-memory-db.js';
import { tokenAccountRoutes } from '../src/routes/token-account.js';
import { authRoutes } from '../src/routes/auth.js';
import { adminRoutes } from '../src/routes/admin.js';
import { awardLoginStreakReward } from '../src/services/token-account.js';
import { signToken } from '../src/auth/jwt.js';

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

  it('rewards the first successful login, not registration itself', async () => {
    const app = await buildApp(pool);

    const registerResponse = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { username: 'new_gift_user', password: 'secret123' },
    });

    expect(registerResponse.statusCode).toBe(201);

    const registered = JSON.parse(registerResponse.body) as { user: { id: string } };
    const beforeLogin = await pool.query<{ gift_tokens: number }>(
      'SELECT gift_tokens FROM token_accounts WHERE user_id = $1',
      [registered.user.id]
    );
    expect(beforeLogin.rows[0].gift_tokens).toBe(0);

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
      login_streak_days: number;
    };
    expect(account.gift_tokens).toBe(50000);
    expect(account.recharge_tokens).toBe(0);
    expect(account.login_streak_days).toBe(1);
    expect('total_tokens' in account).toBe(false);

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
    expect(ledger[0].entry_type).toBe('login_streak_gift');
    expect(ledger[0].bucket).toBe('gift');
    expect(ledger[0].delta_tokens).toBe(50000);
  });

  it('does not double grant a streak reward on the same login day', async () => {
    const app = await buildApp(pool);
    await createTestUser(pool, 'same_day_user');

    await login(app, 'same_day_user', 'secret123');
    const token = await login(app, 'same_day_user', 'secret123');

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
    expect(ledger.filter((e) => e.entry_type === 'login_streak_gift')).toHaveLength(1);
  });

  it('increases consecutive rewards and resets after a missed day', async () => {
    const userId = await createTestUser(pool, 'streak_user');
    const dayOne = new Date('2026-01-10T12:00:00.000Z');
    const dayTwo = new Date('2026-01-11T12:00:00.000Z');
    const dayThree = new Date('2026-01-12T12:00:00.000Z');
    const dayFive = new Date('2026-01-14T12:00:00.000Z');

    expect((await awardLoginStreakReward(pool, userId, dayOne)).granted_tokens).toBe(50000);
    expect((await awardLoginStreakReward(pool, userId, dayTwo)).granted_tokens).toBe(100000);
    const third = await awardLoginStreakReward(pool, userId, dayThree);
    expect(third.streak_days).toBe(3);
    expect(third.granted_tokens).toBe(150000);
    const reset = await awardLoginStreakReward(pool, userId, dayFive);
    expect(reset.streak_days).toBe(1);
    expect(reset.granted_tokens).toBe(50000);

    const account = await pool.query<{ gift_tokens: number; login_streak_days: number }>(
      'SELECT gift_tokens, login_streak_days FROM token_accounts WHERE user_id = $1',
      [userId]
    );
    expect(account.rows[0]).toEqual({ gift_tokens: 350000, login_streak_days: 1 });
  });

  it('caps streak rewards at one million and adds rewards to a negative gift balance', async () => {
    const userId = await createTestUser(pool, 'streak_cap_user');
    await pool.query(
      "UPDATE token_accounts SET gift_tokens = 950000, login_streak_days = 3, last_login_reward_date = DATE '2026-01-10' WHERE user_id = $1",
      [userId]
    );
    const capped = await awardLoginStreakReward(pool, userId, new Date('2026-01-11T12:00:00.000Z'));
    expect(capped.reward_tokens).toBe(200000);
    expect(capped.granted_tokens).toBe(50000);
    expect(capped.account.gift_tokens).toBe(1000000);

    await pool.query(
      "UPDATE token_accounts SET gift_tokens = -2000, login_streak_days = 1, last_login_reward_date = DATE '2026-01-11' WHERE user_id = $1",
      [userId]
    );
    const negative = await awardLoginStreakReward(pool, userId, new Date('2026-01-12T12:00:00.000Z'));
    expect(negative.granted_tokens).toBe(100000);
    expect(negative.account.gift_tokens).toBe(98000);
  });

  it('does not grant rewards when an account is merely read or listed by an admin', async () => {
    const app = await buildApp(pool);
    const adminId = await createTestUser(pool, 'test_admin', 'admin');
    const userId = await createTestUser(pool, 'read_only_user');
    const adminToken = signToken({ id: adminId, username: 'test_admin', role: 'admin' });
    const userToken = signToken({ id: userId, username: 'read_only_user', role: 'user' });

    const accountResponse = await app.inject({
      method: 'GET',
      url: '/api/token-account',
      headers: { Authorization: `Bearer ${userToken}` },
    });
    expect(accountResponse.statusCode).toBe(200);
    expect((JSON.parse(accountResponse.body) as { gift_tokens: number }).gift_tokens).toBe(0);

    const usersResponse = await app.inject({
      method: 'GET',
      url: '/api/admin/users',
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(usersResponse.statusCode).toBe(200);
    const target = (JSON.parse(usersResponse.body) as Array<{ id: string; gift_tokens: number }>).find((user) => user.id === userId);
    expect(target?.gift_tokens).toBe(0);
  });

  it('counts an authenticated remembered session only through the explicit daily login endpoint', async () => {
    const app = await buildApp(pool);
    const userId = await createTestUser(pool, 'remembered_session_user');
    const token = signToken({ id: userId, username: 'remembered_session_user', role: 'user' });

    const rewardResponse = await app.inject({
      method: 'POST',
      url: '/api/auth/login-reward',
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(rewardResponse.statusCode).toBe(200);
    expect((JSON.parse(rewardResponse.body) as { login_reward: { granted_tokens: number } }).login_reward.granted_tokens).toBe(50000);

    const repeatedResponse = await app.inject({
      method: 'POST',
      url: '/api/auth/login-reward',
      headers: { Authorization: `Bearer ${token}` },
    });
    expect((JSON.parse(repeatedResponse.body) as { login_reward: { granted_tokens: number } }).login_reward.granted_tokens).toBe(0);
  });

  it('deducts all usage from gift tokens when gift is positive and allows gift to go negative', async () => {
    const userId = await createTestUser(pool, 'deduct_user');
    const appId = await createTestApp(pool);

    // 规则案例 1：gift=1000, recharge=8000, usage=3000 -> gift=-2000, recharge=8000
    await pool.query(
      'UPDATE token_accounts SET gift_tokens = 1000, recharge_tokens = 8000, last_gift_date = CURRENT_DATE WHERE user_id = $1',
      [userId]
    );

    const { deductForUsage } = await import('../src/services/token-account.js');

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const usageResult = await client.query<{ id: string }>(
        "INSERT INTO yiai_usage_records (user_id, app_id, conversation_id, message_id, task_id, total_tokens) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id",
        [userId, appId, 'conv-id', 'msg-1', 'task-1', 3000]
      );
      await deductForUsage(client, userId, 3000, usageResult.rows[0].id, '测试消耗');
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }

    const result = await pool.query<{ gift_tokens: number; recharge_tokens: number }>('SELECT gift_tokens, recharge_tokens FROM token_accounts WHERE user_id = $1', [userId]);
    expect(result.rows[0].gift_tokens).toBe(-2000);
    expect(result.rows[0].recharge_tokens).toBe(8000);

    const ledger = await pool.query<{ bucket: string; delta_tokens: number }>(
      'SELECT bucket, delta_tokens FROM token_ledger_entries WHERE user_id = $1 ORDER BY created_at',
      [userId]
    );
    expect(ledger.rows).toHaveLength(1);
    expect(ledger.rows[0].bucket).toBe('gift');
    expect(ledger.rows[0].delta_tokens).toBe(-3000);
  });

  it('deducts all usage from recharge tokens when gift is not positive and allows recharge to go negative', async () => {
    const userId = await createTestUser(pool, 'negative_user');
    const appId = await createTestApp(pool);

    // 规则案例 2：gift=-2000, recharge=1000, usage=3000 -> gift=-2000, recharge=-2000
    await pool.query(
      'UPDATE token_accounts SET gift_tokens = -2000, recharge_tokens = 1000, last_gift_date = CURRENT_DATE WHERE user_id = $1',
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
    expect(result.rows[0].gift_tokens).toBe(-2000);
    expect(result.rows[0].recharge_tokens).toBe(-2000);

    const ledger = await pool.query<{ bucket: string; delta_tokens: number }>(
      'SELECT bucket, delta_tokens FROM token_ledger_entries WHERE user_id = $1 ORDER BY created_at',
      [userId]
    );
    expect(ledger.rows).toHaveLength(1);
    expect(ledger.rows[0].bucket).toBe('recharge');
    expect(ledger.rows[0].delta_tokens).toBe(-3000);
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
    expect(account.gift_tokens).toBe(50000); // 登录时已领取首日连续登录奖励

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
