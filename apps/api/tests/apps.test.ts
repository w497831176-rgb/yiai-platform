import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { appRoutes } from '../src/routes/apps.js';
import { authRoutes } from '../src/routes/auth.js';
import { tokenAccountRoutes } from '../src/routes/token-account.js';
import { createInMemoryPool, createTestApp, createTestUser } from './helpers/in-memory-db.js';
import type { YiaiApp, AuthResponse, AppBootstrap, YiaiConversation, YiaiMessage } from '@yiai/shared';

vi.mock('../src/auth/password.js', () => ({
  hashPassword: vi.fn((password: string) => `hashed-${password}`),
  verifyPassword: vi.fn((plain: string, hash: string) => hash === `hashed-${plain}`),
}));

async function buildTestApp(pool: Pool): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(authRoutes, { prefix: '/api/auth', pool });
  await app.register(appRoutes, { prefix: '/api/apps', pool });
  await app.register(tokenAccountRoutes, { prefix: '/api', pool });
  return app;
}

async function loginUser(app: FastifyInstance, username: string, password: string): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username, password },
  });
  const body = JSON.parse(response.body) as AuthResponse;
  return body.token;
}

describe('App Routes', () => {
  let pool: Pool;
  const fetchMock = vi.fn<typeof fetch>();

  vi.stubGlobal('fetch', fetchMock);

  beforeEach(async () => {
    fetchMock.mockReset();
    pool = await createInMemoryPool();
    await createTestUser(pool, 'test_user', 'user', 'testpass');
    await createTestApp(pool, {
      slug: 'zhouyi-divination',
      name: '周易占卦',
      description: '数据库描述',
      icon: '🔮',
      sort_order: 1,
      requires_new_conversation_inputs: false,
    });
    await createTestApp(pool, {
      slug: 'dunjiazi',
      name: '遁甲子',
      description: null,
      icon: null,
      sort_order: 2,
      requires_new_conversation_inputs: false,
    });
    await createTestApp(pool, {
      slug: 'shouyi-tcm-dual-ai',
      name: '守一中医双AI',
      description: null,
      icon: null,
      sort_order: 3,
      requires_new_conversation_inputs: true,
    });
  });

  it('rejects unauthenticated access to apps endpoints', async () => {
    const app = await buildTestApp(pool);
    const endpoints = [
      { method: 'GET' as const, url: '/api/apps' },
      { method: 'GET' as const, url: '/api/apps/zhouyi-divination/bootstrap' },
      { method: 'GET' as const, url: '/api/apps/zhouyi-divination/conversations' },
      { method: 'GET' as const, url: '/api/apps/zhouyi-divination/conversations/conv-1/messages' },
      { method: 'POST' as const, url: '/api/apps/zhouyi-divination/chat', payload: { query: 'hi' } },
    ];

    for (const endpoint of endpoints) {
      const response = await app.inject(endpoint);
      expect(response.statusCode).toBe(401);
    }
  });

  it('returns enabled apps without api_key', async () => {
    const app = await buildTestApp(pool);
    const token = await loginUser(app, 'test_user', 'testpass');

    const response = await app.inject({
      method: 'GET',
      url: '/api/apps',
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as YiaiApp[];
    expect(body).toHaveLength(3);
    expect(body[0].slug).toBe('zhouyi-divination');
    expect(body[1].slug).toBe('dunjiazi');
    expect(body[2].slug).toBe('shouyi-tcm-dual-ai');
    for (const item of body) {
      expect(item).not.toHaveProperty('api_key');
      expect(item).not.toHaveProperty('api_base_url');
    }
  });

  it('returns bootstrap without api_key', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ name: 'Upstream Name', description: 'Upstream desc' })))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ opening_statement: '欢迎使用', suggested_questions: ['q1'], user_input_form: [{ type: 'text-input', label: 'Name', variable: 'name', required: true }] }))
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ title: 'Site Title' })));

    const app = await buildTestApp(pool);
    const token = await loginUser(app, 'test_user', 'testpass');

    const response = await app.inject({
      method: 'GET',
      url: '/api/apps/shouyi-tcm-dual-ai/bootstrap',
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as AppBootstrap;
    expect(body.app.requires_new_conversation_inputs).toBe(true);
    expect(body.opening_statement).toBe('欢迎使用');
    expect(body.suggested_questions).toEqual(['q1']);
    expect(body).not.toHaveProperty('api_key');
    expect(body.app).not.toHaveProperty('api_key');
  });

  it('returns conversations sorted by -updated_at', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          data: [
            { id: 'conv-2', name: 'Second', inputs: {}, status: 'normal', updated_at: 200, created_at: 200 },
            { id: 'conv-1', name: 'First', inputs: {}, status: 'normal', updated_at: 100, created_at: 100 },
          ],
        })
      )
    );

    const app = await buildTestApp(pool);
    const token = await loginUser(app, 'test_user', 'testpass');

    const response = await app.inject({
      method: 'GET',
      url: '/api/apps/zhouyi-divination/conversations',
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as YiaiConversation[];
    expect(body[0].id).toBe('conv-2');
    expect(body[1].id).toBe('conv-1');
  });

  it('returns messages in chronological order', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          data: [
            { id: 'msg-2', conversation_id: 'conv-1', query: 'q2', answer: 'a2', created_at: 200 },
            { id: 'msg-1', conversation_id: 'conv-1', query: 'q1', answer: 'a1', created_at: 100 },
          ],
        })
      )
    );

    const app = await buildTestApp(pool);
    const token = await loginUser(app, 'test_user', 'testpass');

    const response = await app.inject({
      method: 'GET',
      url: '/api/apps/zhouyi-divination/conversations/conv-1/messages',
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as YiaiMessage[];
    expect(body[0].id).toBe('msg-1');
    expect(body[1].id).toBe('msg-2');
  });

  it('proxies chat with correct upstream body and deducts tokens', async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            'data: {"event":"message","answer":"Hello"}\n\ndata: {"event":"message_end","conversation_id":"conv-new","message_id":"msg-1","task_id":"task-1","metadata":{"usage":{"total_tokens":15}}}\n\n'
          )
        );
        controller.close();
      },
    });

    fetchMock.mockResolvedValueOnce(new Response(stream));

    const app = await buildTestApp(pool);
    const token = await loginUser(app, 'test_user', 'testpass');

    const response = await app.inject({
      method: 'POST',
      url: '/api/apps/zhouyi-divination/chat',
      headers: { Authorization: `Bearer ${token}` },
      payload: { query: 'hi', conversation_id: 'conv-1', inputs: { foo: 'bar' } },
    });

    expect(response.statusCode).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const call = fetchMock.mock.calls[0];
    const init = call[1] as { method: string; body: string } | undefined;
    expect(init?.method).toBe('POST');
    const upstreamBody = JSON.parse(init?.body ?? '{}') as {
      query: string;
      response_mode: string;
      user: string;
      conversation_id: string;
      inputs: Record<string, unknown>;
    };
    expect(upstreamBody.query).toBe('hi');
    expect(upstreamBody.response_mode).toBe('streaming');
    expect(upstreamBody.user.startsWith('yiai-platform-')).toBe(true);
    expect(upstreamBody.conversation_id).toBe('conv-1');
    expect(upstreamBody.inputs).toEqual({ foo: 'bar' });

    expect(response.body).toContain('message');
    expect(response.body).toContain('message_end');

    const usageResult = await pool.query<{ total_tokens: number }>('SELECT * FROM yiai_usage_records');
    expect(usageResult.rows).toHaveLength(1);
    expect(usageResult.rows[0].total_tokens).toBe(15);

    const ledgerResult = await pool.query<{ bucket: string; delta_tokens: number }>("SELECT * FROM token_ledger_entries WHERE entry_type = 'usage'");
    expect(ledgerResult.rows).toHaveLength(1);
    expect(ledgerResult.rows[0].bucket).toBe('gift');
    expect(ledgerResult.rows[0].delta_tokens).toBe(-15);
  });

  it('rejects chat when user has no token balance', async () => {
    const app = await buildTestApp(pool);
    const userId = await createTestUser(pool, 'broke_user', 'user', 'testpass');
    await pool.query(
      'UPDATE token_accounts SET gift_tokens = 0, recharge_tokens = 0, last_gift_date = CURRENT_DATE WHERE user_id = $1',
      [userId]
    );

    const token = await loginUser(app, 'broke_user', 'testpass');

    const response = await app.inject({
      method: 'POST',
      url: '/api/apps/zhouyi-divination/chat',
      headers: { Authorization: `Bearer ${token}` },
      payload: { query: 'hi' },
    });

    expect(response.statusCode).toBe(402);
    expect(fetchMock).not.toHaveBeenCalled();
    const usageResult = await pool.query('SELECT * FROM yiai_usage_records');
    expect(usageResult.rows).toHaveLength(0);
  });

  it('does not double deduct when duplicate message_end events arrive', async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            'data: {"event":"message_end","conversation_id":"conv-new","message_id":"dup-msg","task_id":"task-1","metadata":{"usage":{"total_tokens":10}}}\n\ndata: {"event":"message_end","conversation_id":"conv-new","message_id":"dup-msg","task_id":"task-1","metadata":{"usage":{"total_tokens":10}}}\n\n'
          )
        );
        controller.close();
      },
    });

    fetchMock.mockResolvedValueOnce(new Response(stream));

    const app = await buildTestApp(pool);
    const token = await loginUser(app, 'test_user', 'testpass');

    const response = await app.inject({
      method: 'POST',
      url: '/api/apps/zhouyi-divination/chat',
      headers: { Authorization: `Bearer ${token}` },
      payload: { query: 'hi' },
    });

    expect(response.statusCode).toBe(200);

    const usageResult = await pool.query('SELECT * FROM yiai_usage_records');
    expect(usageResult.rows).toHaveLength(1);

    const ledgerResult = await pool.query<{ delta_tokens: number }>("SELECT * FROM token_ledger_entries WHERE entry_type = 'usage'");
    expect(ledgerResult.rows).toHaveLength(1);
    expect(ledgerResult.rows[0].delta_tokens).toBe(-10);
  });

  it('ignores unknown workflow events without error', async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            'data: {"event":"workflow_started"}\n\ndata: {"event":"node_started"}\n\ndata: {"event":"message","answer":"Hi"}\n\ndata: {"event":"workflow_finished"}\n\ndata: {"event":"message_end","metadata":{"usage":{"total_tokens":5}}}\n\n'
          )
        );
        controller.close();
      },
    });

    fetchMock.mockResolvedValueOnce(new Response(stream));

    const app = await buildTestApp(pool);
    const token = await loginUser(app, 'test_user', 'testpass');

    const response = await app.inject({
      method: 'POST',
      url: '/api/apps/zhouyi-divination/chat',
      headers: { Authorization: `Bearer ${token}` },
      payload: { query: 'hi' },
    });

    expect(response.statusCode).toBe(200);
  });

  it('requires required user_input_form fields for shouyi app and normalizes string[] options', async () => {
    const infoResponse = () =>
      Promise.resolve(new Response(JSON.stringify({ name: 'Info', description: '' })));
    const parametersResponse = () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            opening_statement: '请填写信息',
            suggested_questions: [],
            user_input_form: [
              {
                type: 'text-input',
                label: '姓名',
                variable: 'name',
                required: true,
              },
              {
                type: 'select',
                label: '性别',
                variable: 'gender',
                required: true,
                options: ['男', '女'],
              },
            ],
          })
        )
      );
    const siteResponse = () => Promise.resolve(new Response(JSON.stringify({ title: 'Site' })));

    fetchMock
      .mockImplementationOnce(infoResponse)
      .mockImplementationOnce(parametersResponse)
      .mockImplementationOnce(siteResponse)
      .mockImplementationOnce(infoResponse)
      .mockImplementationOnce(parametersResponse)
      .mockImplementationOnce(siteResponse);

    const app = await buildTestApp(pool);
    const token = await loginUser(app, 'test_user', 'testpass');

    const bootstrapResponse = await app.inject({
      method: 'GET',
      url: '/api/apps/shouyi-tcm-dual-ai/bootstrap',
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(bootstrapResponse.statusCode).toBe(200);
    const bootstrap = JSON.parse(bootstrapResponse.body) as AppBootstrap;
    expect(bootstrap.user_input_form?.some((f) => f.variable === 'gender' && f.options?.some((o) => o.value === '男'))).toBe(true);

    const chatResponse = await app.inject({
      method: 'POST',
      url: '/api/apps/shouyi-tcm-dual-ai/chat',
      headers: { Authorization: `Bearer ${token}` },
      payload: { query: 'hello' },
    });

    expect(chatResponse.statusCode).toBe(400);
    const chatBody = JSON.parse(chatResponse.body) as { error: string };
    expect(chatBody.error).toContain('姓名');
  });
});
