import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import type { QueryResult } from 'pg';
import { appRoutes } from '../src/routes/apps.js';
import { authRoutes } from '../src/routes/auth.js';
import type { Pool } from 'pg';
import type { YiaiApp, AuthResponse, AppBootstrap, YiaiConversation, YiaiMessage } from '@yiai/shared';

vi.mock('../src/auth/password.js', () => ({
  hashPassword: vi.fn((password: string) => `hashed-${password}`),
  verifyPassword: vi.fn(() => true),
}));

interface UserRow {
  id: string;
  username: string;
  password_hash: string;
  role: 'user' | 'admin';
  created_at: Date;
  updated_at: Date;
}

interface AppRow extends YiaiApp {
  api_base_url: string;
  api_key: string;
  enabled: boolean;
}

interface UsageRecord {
  id: string;
  user_id: string;
  app_id: string;
  conversation_id: string | null;
  message_id: string | null;
  task_id: string | null;
  total_tokens: number;
  created_at: Date;
}

function createMockPool(initialUsers: UserRow[] = [], initialApps: AppRow[] = []): Pool {
  const users = [...initialUsers];
  const apps = [...initialApps];
  const usageRecords: UsageRecord[] = [];

  const query = <T>(sql: string, params?: unknown[]): Promise<QueryResult<T>> => {
    const lower = sql.toLowerCase();

    if (lower.includes('from users') && lower.includes('where username')) {
      const user = users.find((u) => u.username === params?.[0]);
      return Promise.resolve({ rows: user ? [user as T] : [], rowCount: user ? 1 : 0 } as QueryResult<T>);
    }

    if (lower.includes('from users') && lower.includes('where id')) {
      const user = users.find((u) => u.id === params?.[0]);
      return Promise.resolve({ rows: user ? [user as T] : [], rowCount: user ? 1 : 0 } as QueryResult<T>);
    }

    if (lower.includes('from yiai_apps') && lower.includes('where slug') && lower.includes('enabled')) {
      const app = apps.find((a) => a.slug === params?.[0] && a.enabled);
      return Promise.resolve({ rows: app ? [app as T] : [], rowCount: app ? 1 : 0 } as QueryResult<T>);
    }

    if (lower.includes('from yiai_apps') && lower.includes('enabled = true')) {
      const safeApps = apps
        .filter((a) => a.enabled)
        .sort((a, b) => a.sort_order - b.sort_order)
        .map((a) => ({
          id: a.id,
          slug: a.slug,
          name: a.name,
          description: a.description,
          icon: a.icon,
          sort_order: a.sort_order,
          requires_new_conversation_inputs: a.requires_new_conversation_inputs,
          created_at: a.created_at,
          updated_at: a.updated_at,
        }));
      return Promise.resolve({ rows: safeApps as T[], rowCount: safeApps.length } as QueryResult<T>);
    }

    if (lower.includes('from yiai_apps') && lower.includes('where slug = $1') && !lower.includes('enabled')) {
      const app = apps.find((a) => a.slug === params?.[0]);
      return Promise.resolve({ rows: app ? [app as T] : [], rowCount: app ? 1 : 0 } as QueryResult<T>);
    }

    if (lower.includes('insert into yiai_usage_records')) {
      usageRecords.push({
        id: crypto.randomUUID(),
        user_id: params?.[0] as string,
        app_id: params?.[1] as string,
        conversation_id: params?.[2] as string | null,
        message_id: params?.[3] as string | null,
        task_id: params?.[4] as string | null,
        total_tokens: params?.[5] as number,
        created_at: new Date(),
      });
      return Promise.resolve({ rows: [], rowCount: 1 } as QueryResult<T>);
    }

    return Promise.resolve({ rows: [], rowCount: 0 } as QueryResult<T>);
  };

  return {
    query,
    _usageRecords: usageRecords,
  } as unknown as Pool;
}

async function buildTestApp(pool: Pool): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(authRoutes, { prefix: '/api/auth', pool });
  await app.register(appRoutes, { prefix: '/api/apps', pool });
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

  beforeEach(() => {
    fetchMock.mockReset();
    pool = createMockPool(
      [
        {
          id: 'user-1',
          username: 'test_user',
          password_hash: 'hash',
          role: 'user',
          created_at: new Date(),
          updated_at: new Date(),
        },
      ],
      [
        {
          id: 'app-zhouyi',
          slug: 'zhouyi-divination',
          name: '周易占卦',
          description: '数据库描述',
          icon: '🔮',
          api_base_url: 'https://yiai.example.com/v1',
          api_key: 'key-zhouyi',
          enabled: true,
          sort_order: 1,
          requires_new_conversation_inputs: false,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
        {
          id: 'app-dunjiazi',
          slug: 'dunjiazi',
          name: '遁甲子',
          description: null,
          icon: null,
          api_base_url: 'https://yiai.example.com/v1',
          api_key: 'key-dunjiazi',
          enabled: true,
          sort_order: 2,
          requires_new_conversation_inputs: false,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
        {
          id: 'app-shouyi',
          slug: 'shouyi-tcm-dual-ai',
          name: '守一中医双AI',
          description: null,
          icon: null,
          api_base_url: 'https://yiai.example.com/v1',
          api_key: 'key-shouyi',
          enabled: true,
          sort_order: 3,
          requires_new_conversation_inputs: true,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
      ]
    );
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
    const token = await loginUser(app, 'test_user', 'any');

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
    const token = await loginUser(app, 'test_user', 'any');

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
    const token = await loginUser(app, 'test_user', 'any');

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
    const token = await loginUser(app, 'test_user', 'any');

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

  it('proxies chat with correct upstream body', async () => {
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
    const token = await loginUser(app, 'test_user', 'any');

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
    expect(upstreamBody.user).toBe('yiai-platform-user-1');
    expect(upstreamBody.conversation_id).toBe('conv-1');
    expect(upstreamBody.inputs).toEqual({ foo: 'bar' });

    expect(response.body).toContain('message');
    expect(response.body).toContain('message_end');

    const mockPool = pool as unknown as { _usageRecords: UsageRecord[] };
    expect(mockPool._usageRecords).toHaveLength(1);
    expect(mockPool._usageRecords[0].total_tokens).toBe(15);
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
    const token = await loginUser(app, 'test_user', 'any');

    const response = await app.inject({
      method: 'POST',
      url: '/api/apps/zhouyi-divination/chat',
      headers: { Authorization: `Bearer ${token}` },
      payload: { query: 'hi' },
    });

    expect(response.statusCode).toBe(200);
  });

  it('requires required user_input_form fields for shouyi app and normalizes string[] options', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ name: '守一中医双AI', description: 'Upstream desc' })))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            opening_statement: '你好',
            suggested_questions: [],
            user_input_form: [
              { type: 'text-input', label: '姓名', variable: 'name', required: true },
              { type: 'paragraph', label: '备注', variable: 'note', required: false },
              { type: 'select', label: '性别', variable: 'gender', required: true, options: ['男', '女'] },
            ],
          })
        )
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ title: 'Site Title' })));

    const app = await buildTestApp(pool);
    const token = await loginUser(app, 'test_user', 'any');

    const response = await app.inject({
      method: 'GET',
      url: '/api/apps/shouyi-tcm-dual-ai/bootstrap',
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as AppBootstrap;
    expect(body.app.requires_new_conversation_inputs).toBe(true);
    expect(body.app.name).toBe('守一中医双AI');
    expect(body.user_input_form?.some((field) => field.variable === 'name' && field.required)).toBe(true);
    expect(body.user_input_form?.some((field) => field.variable === 'gender' && field.required)).toBe(true);

    const genderField = body.user_input_form?.find((field) => field.variable === 'gender');
    expect(genderField?.options).toEqual([
      { label: '男', value: '男' },
      { label: '女', value: '女' },
    ]);
  });

  it('keeps database app config over upstream info/site', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ name: 'Upstream Name', description: 'Upstream desc', icon: '🔥' })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ opening_statement: 'Hello', suggested_questions: [] })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ title: 'Site Title', icon: '🌟' })));

    const app = await buildTestApp(pool);
    const token = await loginUser(app, 'test_user', 'any');

    const response = await app.inject({
      method: 'GET',
      url: '/api/apps/zhouyi-divination/bootstrap',
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as AppBootstrap;
    expect(body.app.name).toBe('周易占卦');
    expect(body.app.description).toBe('数据库描述');
    expect(body.app.icon).toBe('🔮');
  });

  it('returns 502 on upstream error without exposing api_key', async () => {
    fetchMock.mockRejectedValueOnce(new Error('network error'));

    const app = await buildTestApp(pool);
    const token = await loginUser(app, 'test_user', 'any');

    const response = await app.inject({
      method: 'GET',
      url: '/api/apps/zhouyi-divination/bootstrap',
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(502);
    expect(response.body).not.toContain('key-zhouyi');
    expect(response.body).not.toContain('api_key');
  });
});
