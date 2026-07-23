import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { appRoutes } from '../src/routes/apps.js';
import { authRoutes } from '../src/routes/auth.js';
import { tokenAccountRoutes } from '../src/routes/token-account.js';
import { createInMemoryPool, createTestApp, createTestUser } from './helpers/in-memory-db.js';
import type { YiaiApp, AuthResponse, AppBootstrap, YiaiConversation, YiaiMessage, UploadedFile } from '@yiai/shared';

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

function buildMultipartBody(
  parts: Array<{ name: string; filename?: string; contentType: string; data: Buffer | string }>,
  boundary: string
): Buffer {
  let body = Buffer.alloc(0);
  for (const part of parts) {
    let header = `--${boundary}\r\nContent-Disposition: form-data; name="${part.name}"`;
    if (part.filename) {
      header += `; filename="${part.filename}"`;
    }
    header += `\r\nContent-Type: ${part.contentType}\r\n\r\n`;
    const data = Buffer.isBuffer(part.data) ? part.data : Buffer.from(part.data);
    body = Buffer.concat([body, Buffer.from(header), data, Buffer.from('\r\n')]);
  }
  body = Buffer.concat([body, Buffer.from(`--${boundary}--\r\n`)]);
  return body;
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
      tags: ['国学'],
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
      { method: 'DELETE' as const, url: '/api/apps/zhouyi-divination/conversations/conv-1' },
      { method: 'GET' as const, url: '/api/apps/zhouyi-divination/conversations/conv-1/messages' },
      { method: 'POST' as const, url: '/api/apps/zhouyi-divination/files' },
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

  it('returns real name/description/icon from database in apps list', async () => {
    const app = await buildTestApp(pool);
    const token = await loginUser(app, 'test_user', 'testpass');

    const response = await app.inject({
      method: 'GET',
      url: '/api/apps',
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as YiaiApp[];
    const zhouyi = body.find((a) => a.slug === 'zhouyi-divination');
    expect(zhouyi).toBeDefined();
    expect(zhouyi?.name).toBe('周易占卦');
    expect(zhouyi?.description).toBe('数据库描述');
    expect(zhouyi?.icon).toBe('🔮');
    expect(zhouyi?.icon_type).toBe('emoji');
    expect(zhouyi?.icon_url).toBeNull();
    expect(zhouyi?.tags).toEqual(['国学']);

    const dunjiazi = body.find((a) => a.slug === 'dunjiazi');
    expect(dunjiazi?.name).toBe('遁甲子');
    expect(dunjiazi?.description).toBeNull();
    expect(dunjiazi?.icon).toBeNull();
    expect(dunjiazi?.icon_type).toBeNull();
  });

  it('returns local icon_url for cached image-type apps without calling upstream', async () => {
    const app = await buildTestApp(pool);
    const token = await loginUser(app, 'test_user', 'testpass');

    const cachedAt = new Date('2026-01-01T00:00:00.000Z');
    await createTestApp(pool, {
      slug: 'image-app',
      name: 'Image App',
      icon: '07e890ea-6d8a-4f87-ae17-25ccf4b62d3b',
      icon_type: 'image',
      sort_order: 4,
      icon_cache_filename: 'image-app',
      icon_cache_content_type: 'image/png',
      icon_cached_at: cachedAt,
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/apps',
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as YiaiApp[];
    const imageApp = body.find((a) => a.slug === 'image-app');
    expect(imageApp).toBeDefined();
    expect(imageApp?.icon_type).toBe('image');
    expect(imageApp?.icon).toBeNull();
    expect(imageApp?.icon_url).toBe(`/api/app-icons/image-app?v=${String(cachedAt.getTime())}`);
    expect(imageApp).not.toHaveProperty('api_key');
    expect(imageApp).not.toHaveProperty('api_base_url');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns bootstrap without api_key and only calls upstream parameters', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          opening_statement: '欢迎使用',
          suggested_questions: ['q1'],
          user_input_form: [{ type: 'text-input', label: 'Name', variable: 'name', required: true }],
        })
      )
    );

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

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe('https://yiai.example.com/v1/parameters');
  });

  it('uses the platform Agent form when upstream parameters have no form', async () => {
    await createTestApp(pool, {
      slug: 'agent-charting',
      app_type: 'agent',
      agent_input_form: [{ type: 'text-input', label: 'Birth date', variable: 'birth_date', required: true }],
      requires_new_conversation_inputs: true,
    });
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ user_input_form: [] })));
    const app = await buildTestApp(pool);
    const token = await loginUser(app, 'test_user', 'testpass');

    const response = await app.inject({
      method: 'GET',
      url: '/api/apps/agent-charting/bootstrap',
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as AppBootstrap;
    expect(body.app.app_type).toBe('agent');
    expect(body.user_input_form).toEqual([
      { type: 'text-input', label: 'Birth date', variable: 'birth_date', required: true },
    ]);
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

  it('proxies chat with files in upstream body', async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            'data: {"event":"message","answer":"Hello"}\n\ndata: {"event":"message_end","message_id":"msg-files","metadata":{"usage":{"total_tokens":5}}}\n\n'
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
      payload: {
        query: 'describe image',
        files: [{ type: 'image', transfer_method: 'local_file', upload_file_id: 'file-1' }],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = fetchMock.mock.calls[0][1] as { method: string; body: string } | undefined;
    const upstreamBody = JSON.parse(init?.body ?? '{}') as { files: unknown[] };
    expect(upstreamBody.files).toEqual([
      { type: 'image', transfer_method: 'local_file', upload_file_id: 'file-1' },
    ]);
  });

  it('rejects chat when both gift and recharge balances are not positive', async () => {
    const app = await buildTestApp(pool);
    const userId = await createTestUser(pool, 'broke_user', 'user', 'testpass');
    await pool.query(
      'UPDATE token_accounts SET gift_tokens = -1, recharge_tokens = -1, last_gift_date = CURRENT_DATE WHERE user_id = $1',
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
    const body = JSON.parse(response.body) as { error: string };
    expect(body.error).toBe('余额不足，请等待每日赠送或联系管理员充值');
    expect(fetchMock).not.toHaveBeenCalled();
    const usageResult = await pool.query('SELECT * FROM yiai_usage_records');
    expect(usageResult.rows).toHaveLength(0);
  });

  it('allows chat when gift balance is positive even if recharge is negative', async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            'data: {"event":"message","answer":"hello"}\n\ndata: {"event":"message_end","conversation_id":"conv-gift","message_id":"msg-gift","task_id":"task-gift","metadata":{"usage":{"total_tokens":10}}}\n\n'
          )
        );
        controller.close();
      },
    });
    fetchMock.mockResolvedValueOnce(new Response(stream));

    const app = await buildTestApp(pool);
    const userId = await createTestUser(pool, 'gift_positive_user', 'user', 'testpass');
    await pool.query(
      'UPDATE token_accounts SET gift_tokens = 1000, recharge_tokens = -2000, last_gift_date = CURRENT_DATE WHERE user_id = $1',
      [userId]
    );

    const token = await loginUser(app, 'gift_positive_user', 'testpass');

    const response = await app.inject({
      method: 'POST',
      url: '/api/apps/zhouyi-divination/chat',
      headers: { Authorization: `Bearer ${token}` },
      payload: { query: 'hi' },
    });

    expect(response.statusCode).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const account = await pool.query<{ gift_tokens: number; recharge_tokens: number }>(
      'SELECT gift_tokens, recharge_tokens FROM token_accounts WHERE user_id = $1',
      [userId]
    );
    expect(account.rows[0].gift_tokens).toBe(990);
    expect(account.rows[0].recharge_tokens).toBe(-2000);
  });

  it('allows chat and deducts from recharge when gift balance is not positive', async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            'data: {"event":"message","answer":"hello"}\n\ndata: {"event":"message_end","conversation_id":"conv-recharge","message_id":"msg-recharge","task_id":"task-recharge","metadata":{"usage":{"total_tokens":10}}}\n\n'
          )
        );
        controller.close();
      },
    });
    fetchMock.mockResolvedValueOnce(new Response(stream));

    const app = await buildTestApp(pool);
    const userId = await createTestUser(pool, 'recharge_positive_user', 'user', 'testpass');
    await pool.query(
      'UPDATE token_accounts SET gift_tokens = -2000, recharge_tokens = 1000, last_gift_date = CURRENT_DATE WHERE user_id = $1',
      [userId]
    );

    const token = await loginUser(app, 'recharge_positive_user', 'testpass');

    const response = await app.inject({
      method: 'POST',
      url: '/api/apps/zhouyi-divination/chat',
      headers: { Authorization: `Bearer ${token}` },
      payload: { query: 'hi' },
    });

    expect(response.statusCode).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const account = await pool.query<{ gift_tokens: number; recharge_tokens: number }>(
      'SELECT gift_tokens, recharge_tokens FROM token_accounts WHERE user_id = $1',
      [userId]
    );
    expect(account.rows[0].gift_tokens).toBe(-2000);
    expect(account.rows[0].recharge_tokens).toBe(990);
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

    fetchMock.mockImplementationOnce(parametersResponse).mockImplementationOnce(parametersResponse);

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

  it('rejects non-image file uploads', async () => {
    const app = await buildTestApp(pool);
    const token = await loginUser(app, 'test_user', 'testpass');
    const boundary = '----FormBoundary';
    const body = buildMultipartBody(
      [{ name: 'file', filename: 'doc.pdf', contentType: 'application/pdf', data: Buffer.from('%PDF') }],
      boundary
    );

    const response = await app.inject({
      method: 'POST',
      url: '/api/apps/zhouyi-divination/files',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
      },
      payload: body,
    });

    expect(response.statusCode).toBe(400);
    const result = JSON.parse(response.body) as { error: string };
    expect(result.error).toBe('仅支持图片文件');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects oversized image uploads', async () => {
    const app = await buildTestApp(pool);
    const token = await loginUser(app, 'test_user', 'testpass');
    const boundary = '----FormBoundary';
    const body = buildMultipartBody(
      [{ name: 'file', filename: 'big.png', contentType: 'image/png', data: Buffer.alloc(10 * 1024 * 1024 + 1) }],
      boundary
    );

    const response = await app.inject({
      method: 'POST',
      url: '/api/apps/zhouyi-divination/files',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
      },
      payload: body,
    });

    expect(response.statusCode).toBe(400);
    const result = JSON.parse(response.body) as { error: string };
    expect(result.error).toBe('图片大小超过 10MB');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('uploads image to upstream and returns safe file object', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ id: 'file-upstream-1', url: 'https://cdn.example.com/file.png', name: 'file.png' }))
    );

    const app = await buildTestApp(pool);
    const token = await loginUser(app, 'test_user', 'testpass');
    const boundary = '----FormBoundary';
    const body = buildMultipartBody(
      [{ name: 'file', filename: 'avatar.png', contentType: 'image/png', data: Buffer.from('fake-image') }],
      boundary
    );

    const response = await app.inject({
      method: 'POST',
      url: '/api/apps/zhouyi-divination/files',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
      },
      payload: body,
    });

    expect(response.statusCode).toBe(200);
    const result = JSON.parse(response.body) as UploadedFile & { name?: string };
    expect(result.id).toBe('file-upstream-1');
    expect(result.type).toBe('image');
    expect(result.url).toBe('https://cdn.example.com/file.png');
    expect(result.name).toBe('file.png');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('/files?user=yiai-platform-');
    expect((init as { method: string }).method).toBe('POST');
    expect((init as { headers: Record<string, string> }).headers.Authorization).toBe('Bearer test-key');
  });

  it('deletes conversation by forwarding DELETE to upstream', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));

    const app = await buildTestApp(pool);
    const token = await loginUser(app, 'test_user', 'testpass');

    const response = await app.inject({
      method: 'DELETE',
      url: '/api/apps/zhouyi-divination/conversations/conv-1',
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(204);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toMatch(/^https:\/\/yiai\.example\.com\/v1\/conversations\/conv-1\?user=yiai-platform-[\w-]+$/);
    expect((init as { method: string }).method).toBe('DELETE');
    expect((init as { headers: Record<string, string> }).headers.Authorization).toBe('Bearer test-key');
  });

  it('rejects deleting conversation belonging to another user', async () => {
    const app = await buildTestApp(pool);
    const otherUserId = await createTestUser(pool, 'other_user', 'user', 'testpass');

    fetchMock.mockImplementation((url) => {
      if (typeof url === 'string' && url.includes(`yiai-platform-${otherUserId}`)) {
        // 模拟上游根据 user 参数区分所有权：other_user 无权删除 test_user 的会话
        return Promise.resolve(new Response(null, { status: 404 }));
      }
      return Promise.resolve(new Response(null, { status: 204 }));
    });

    const otherToken = await loginUser(app, 'other_user', 'testpass');

    const response = await app.inject({
      method: 'DELETE',
      url: '/api/apps/zhouyi-divination/conversations/conv-owned-by-test-user',
      headers: { Authorization: `Bearer ${otherToken}` },
    });

    expect(response.statusCode).toBe(502);
    const result = JSON.parse(response.body) as { error: string };
    expect(result.error).toContain('删除会话失败');

    // 确保删除操作确实被转发到上游，而不是在本地被静默拒绝
    const forwardedCalls = fetchMock.mock.calls.filter((call) => {
      const callUrl = call[0] as string;
      return callUrl.includes('yiai-platform-');
    });
    expect(forwardedCalls).toHaveLength(1);
    const otherUserUrl = `yiai-platform-${otherUserId}`;
    expect((forwardedCalls[0][0] as string).includes(otherUserUrl)).toBe(true);
  });
});
