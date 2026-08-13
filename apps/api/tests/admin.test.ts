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

function mockUpstreamMetadata(
  fetchMock: ReturnType<typeof vi.fn<typeof fetch>>,
  overrides: {
    info?: Record<string, unknown>;
    site?: Record<string, unknown>;
    parameters?: Record<string, unknown>;
  } = {}
) {
  const info = overrides.info ?? { name: 'Upstream Name', description: 'Upstream desc' };
  const site = overrides.site ?? { title: 'Site Title', icon: '🤖' };
  const parameters = overrides.parameters ?? {
    opening_statement: '欢迎使用',
    suggested_questions: ['q1'],
    user_input_form: [{ type: 'text-input', label: 'Name', variable: 'name', required: true }],
  };

  fetchMock
    .mockResolvedValueOnce(new Response(JSON.stringify(info)))
    .mockResolvedValueOnce(new Response(JSON.stringify(site)))
    .mockResolvedValueOnce(new Response(JSON.stringify(parameters)))
    .mockResolvedValueOnce(new Response(JSON.stringify(site)));
}

describe('Admin Routes', () => {
  let pool: Pool;
  const fetchMock = vi.fn<typeof fetch>();

  vi.stubGlobal('fetch', fetchMock);

  beforeEach(async () => {
    fetchMock.mockReset();
    pool = await createInMemoryPool();
  });

  it('does not expose api_key in admin app list and includes icon fields', async () => {
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
    expect(body[0].api_key_preview).toBe('sec…ey');
    expect(body[0]).toHaveProperty('icon_type');
    expect(body[0]).toHaveProperty('icon_url');
    expect(body[0]).toHaveProperty('icon_background');
  });

  it('sorts admin apps by tag pinyin then app name, with untagged apps last', async () => {
    const app = await buildApp(pool);
    await createTestUser(pool, 'admin_user', 'admin', 'testpass');
    await createTestApp(pool, { slug: 'no-tag', name: 'No Tag', tags: [] });
    await createTestApp(pool, { slug: 'medical', name: '慢诊', tags: ['医学'] });
    await createTestApp(pool, { slug: 'guoxue-yi', name: '易经', tags: ['国学'] });
    await createTestApp(pool, { slug: 'guoxue-jia', name: '甲骨', tags: ['国学'] });

    const token = await login(app, 'admin_user', 'testpass');
    const response = await app.inject({
      method: 'GET',
      url: '/api/admin/apps',
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as Array<{ slug: string }>;
    expect(body.map((item) => item.slug)).toEqual(['guoxue-jia', 'guoxue-yi', 'medical', 'no-tag']);
  });

  it('creates Chatflow app after fetching upstream metadata and hides api_key', async () => {
    const app = await buildApp(pool);
    await createTestUser(pool, 'admin_user', 'admin', 'testpass');

    mockUpstreamMetadata(fetchMock);

    const token = await login(app, 'admin_user', 'testpass');

    const createResponse = await app.inject({
      method: 'POST',
      url: '/api/admin/apps',
      headers: { Authorization: `Bearer ${token}` },
      payload: {
        slug: 'new-app',
        api_base_url: 'https://yiai.example.com/v1',
        api_key: 'initial-key',
      },
    });

    expect(createResponse.statusCode).toBe(201);
    const created = JSON.parse(createResponse.body) as Record<string, unknown>;
    expect(created).not.toHaveProperty('api_key');
    expect(created.api_key_configured).toBe(true);
    expect(created.name).toBe('Site Title');
    expect(created.description).toBe('Upstream desc');
    expect(created.icon).toBe('🤖');
    expect(created.requires_new_conversation_inputs).toBe(true);
    expect(created.supports_images).toBe(false);

    // Verify upstream endpoints were called (metadata + icon refresh /site)
    expect(fetchMock).toHaveBeenCalledTimes(4);
    const [infoCall, siteCall, parametersCall, iconSiteCall] = fetchMock.mock.calls;
    expect(infoCall[0]).toBe('https://yiai.example.com/v1/info');
    expect(siteCall[0]).toBe('https://yiai.example.com/v1/site');
    expect(parametersCall[0]).toBe('https://yiai.example.com/v1/parameters');
    expect(iconSiteCall[0]).toBe('https://yiai.example.com/v1/site');
  });

  it('auto detects requires_new_conversation_inputs when not provided', async () => {
    const app = await buildApp(pool);
    await createTestUser(pool, 'admin_user', 'admin', 'testpass');

    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ name: 'No Form' })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ title: 'No Form Site' })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ user_input_form: [] })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ title: 'No Form Site' })));

    const token = await login(app, 'admin_user', 'testpass');

    const createResponse = await app.inject({
      method: 'POST',
      url: '/api/admin/apps',
      headers: { Authorization: `Bearer ${token}` },
      payload: {
        slug: 'no-form-app',
        api_base_url: 'https://yiai.example.com/v2',
        api_key: 'key',
      },
    });

    expect(createResponse.statusCode).toBe(201);
    const created = JSON.parse(createResponse.body) as Record<string, unknown>;
    expect(created.requires_new_conversation_inputs).toBe(false);
  });

  it('creates an Agent with a platform-owned first-conversation form', async () => {
    const app = await buildApp(pool);
    await createTestUser(pool, 'admin_user', 'admin', 'testpass');
    mockUpstreamMetadata(fetchMock, { parameters: { user_input_form: [] } });
    const token = await login(app, 'admin_user', 'testpass');

    const response = await app.inject({
      method: 'POST',
      url: '/api/admin/apps',
      headers: { Authorization: `Bearer ${token}` },
      payload: {
        slug: 'charting-agent',
        app_type: 'agent',
        api_base_url: 'https://yiai.example.com/v1',
        api_key: 'agent-key',
        agent_input_form: [{ type: 'text-input', label: 'Birth date', variable: 'birth_date', required: true }],
      },
    });

    expect(response.statusCode).toBe(201);
    const created = JSON.parse(response.body) as Record<string, unknown>;
    expect(created.app_type).toBe('agent');
    expect(created.requires_new_conversation_inputs).toBe(true);
    expect(created.agent_input_form).toEqual([
      { type: 'text-input', label: 'Birth date', variable: 'birth_date', required: true },
    ]);
    expect(created).not.toHaveProperty('api_key');
  });

  it('keeps the Agent form when YIAI metadata is synchronized', async () => {
    const app = await buildApp(pool);
    await createTestUser(pool, 'admin_user', 'admin', 'testpass');
    const appId = await createTestApp(pool, {
      slug: 'sync-agent',
      app_type: 'agent',
      agent_input_form: [{ type: 'text-input', label: 'Birth date', variable: 'birth_date', required: true }],
      requires_new_conversation_inputs: true,
    });
    mockUpstreamMetadata(fetchMock, { parameters: { user_input_form: [] } });
    const token = await login(app, 'admin_user', 'testpass');

    const response = await app.inject({
      method: 'POST',
      url: `/api/admin/apps/${appId}/sync`,
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(200);
    const synced = JSON.parse(response.body) as Record<string, unknown>;
    expect(synced.requires_new_conversation_inputs).toBe(true);
    expect(synced.agent_input_form).toEqual([
      { type: 'text-input', label: 'Birth date', variable: 'birth_date', required: true },
    ]);
  });

  it('returns 400 when upstream metadata sync fails', async () => {
    const app = await buildApp(pool);
    await createTestUser(pool, 'admin_user', 'admin', 'testpass');

    fetchMock.mockRejectedValueOnce(new Error('network error'));

    const token = await login(app, 'admin_user', 'testpass');

    const createResponse = await app.inject({
      method: 'POST',
      url: '/api/admin/apps',
      headers: { Authorization: `Bearer ${token}` },
      payload: {
        slug: 'bad-app',
        api_base_url: 'https://yiai.example.com/v1',
        api_key: 'key',
      },
    });

    expect(createResponse.statusCode).toBe(400);
    const body = JSON.parse(createResponse.body) as { error: string };
    expect(body.error).toContain('YIAI 连接验证失败');

    const dbResult = await pool.query('SELECT * FROM yiai_apps WHERE slug = $1', ['bad-app']);
    expect(dbResult.rows).toHaveLength(0);
  });

  it('updates platform-managed fields through the settings endpoint', async () => {
    const app = await buildApp(pool);
    await createTestUser(pool, 'admin_user', 'admin', 'testpass');
    const appId = await createTestApp(pool, {
      slug: 'settings-app',
      name: 'Upstream Name',
      api_key: 'initial-key',
      enabled: true,
    });
    const token = await login(app, 'admin_user', 'testpass');

    const updateResponse = await app.inject({
      method: 'PATCH',
      url: `/api/admin/apps/${appId}`,
      headers: { Authorization: `Bearer ${token}` },
      payload: {
        enabled: false,
        supports_images: true,
        name: 'Platform Name',
        description: 'Platform description',
        icon: '🧠',
        tags: ['哲学', '国学'],
      },
    });

    expect(updateResponse.statusCode).toBe(200);
    const dbResult = await pool.query<{
      name: string;
      description: string;
      icon: string;
      icon_type: string;
      tags: string[];
      icon_source: string;
      api_key: string;
      enabled: boolean;
      supports_images: boolean;
    }>(
      'SELECT name, description, icon, icon_type, tags, icon_source, api_key, enabled, supports_images FROM yiai_apps WHERE id = $1',
      [appId]
    );
    expect(dbResult.rows[0]).toMatchObject({
      name: 'Platform Name',
      description: 'Platform description',
      icon: '🧠',
      icon_type: 'emoji',
      tags: ['哲学', '国学'],
      icon_source: 'platform',
      api_key: 'initial-key',
      enabled: false,
      supports_images: true,
    });
  });

  it('deletes an app only for an admin', async () => {
    const app = await buildApp(pool);
    await createTestUser(pool, 'admin_user', 'admin', 'testpass');
    const appId = await createTestApp(pool, { slug: 'delete-app', name: 'Delete App' });
    const token = await login(app, 'admin_user', 'testpass');

    const response = await app.inject({
      method: 'DELETE',
      url: `/api/admin/apps/${appId}`,
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toMatchObject({ id: appId, slug: 'delete-app', deleted: true });
    const remaining = await pool.query('SELECT id FROM yiai_apps WHERE id = $1', [appId]);
    expect(remaining.rows).toHaveLength(0);
  });

  it('updates a connection only after upstream verification and syncs its metadata', async () => {
    const app = await buildApp(pool);
    await createTestUser(pool, 'admin_user', 'admin', 'testpass');
    const appId = await createTestApp(pool, { slug: 'connection-app', name: 'Old Name', api_key: 'old-key' });
    mockUpstreamMetadata(fetchMock, {
      site: { title: 'Verified Name', description: 'Verified Description', icon: '🧭' },
      parameters: { user_input_form: [] },
    });

    const token = await login(app, 'admin_user', 'testpass');

    const updateResponse = await app.inject({
      method: 'PUT',
      url: `/api/admin/apps/${appId}/connection`,
      headers: { Authorization: `Bearer ${token}` },
      payload: { api_base_url: 'https://verified.example.com/v1/', api_key: 'new-key' },
    });

    expect(updateResponse.statusCode).toBe(200);
    const dbResult = await pool.query<{ api_base_url: string; api_key: string; name: string; description: string | null }>(
      'SELECT api_base_url, api_key, name, description FROM yiai_apps WHERE id = $1',
      [appId]
    );
    expect(dbResult.rows[0]).toMatchObject({
      api_base_url: 'https://verified.example.com/v1',
      api_key: 'new-key',
      name: 'Verified Name',
      description: 'Verified Description',
    });
  });

  it('rejects a duplicate YIAI connection without exposing its API key', async () => {
    const app = await buildApp(pool);
    await createTestUser(pool, 'admin_user', 'admin', 'testpass');
    await createTestApp(pool, { slug: 'bound-app', api_base_url: 'https://yiai.example.com/v1', api_key: 'same-key' });
    const token = await login(app, 'admin_user', 'testpass');

    const response = await app.inject({
      method: 'POST',
      url: '/api/admin/apps',
      headers: { Authorization: `Bearer ${token}` },
      payload: { slug: 'duplicate-app', api_base_url: 'https://yiai.example.com/v1/', api_key: 'same-key' },
    });

    expect(response.statusCode).toBe(409);
    expect(response.body).toContain('bound-app');
    expect(response.body).not.toContain('same-key');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('syncs existing app metadata without exposing api_key', async () => {
    const app = await buildApp(pool);
    await createTestUser(pool, 'admin_user', 'admin', 'testpass');
    const appId = await createTestApp(pool, {
      slug: 'sync-app',
      name: 'Old Name',
      api_key: 'secret-key',
      supports_images: true,
    });

    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ name: 'Synced Name', tags: ['医学', '养生'] })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ site_info: { title: 'Synced Site', description: 'Synced desc', icon: '🔄' } })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ user_input_form: [] })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ site_info: { title: 'Synced Site', description: 'Synced desc', icon: '🔄' } })));

    const token = await login(app, 'admin_user', 'testpass');

    const syncResponse = await app.inject({
      method: 'POST',
      url: `/api/admin/apps/${appId}/sync`,
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(syncResponse.statusCode).toBe(200);
    const synced = JSON.parse(syncResponse.body) as Record<string, unknown>;
    expect(synced).not.toHaveProperty('api_key');
    expect(synced.api_key_configured).toBe(true);
    expect(synced.name).toBe('Synced Site');
    expect(synced.description).toBe('Synced desc');
    expect(synced.icon).toBe('🔄');
    expect(synced.tags).toEqual(['医学', '养生']);
    expect(synced.supports_images).toBe(true);

    const dbResult = await pool.query<{ supports_images: boolean }>(
      'SELECT supports_images FROM yiai_apps WHERE id = $1',
      [appId]
    );
    expect(dbResult.rows[0].supports_images).toBe(true);
  });

  it('sync updates requires_new_conversation_inputs from false to true', async () => {
    const app = await buildApp(pool);
    await createTestUser(pool, 'admin_user', 'admin', 'testpass');
    const appId = await createTestApp(pool, {
      slug: 'sync-false-to-true',
      name: 'Flag App',
      requires_new_conversation_inputs: false,
      api_key: 'key',
    });

    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ name: 'Flag Name' })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ title: 'Flag Site' })))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            user_input_form: [{ type: 'text-input', label: 'Name', variable: 'name', required: true }],
          })
        )
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ title: 'Flag Site' })));

    const token = await login(app, 'admin_user', 'testpass');

    const syncResponse = await app.inject({
      method: 'POST',
      url: `/api/admin/apps/${appId}/sync`,
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(syncResponse.statusCode).toBe(200);
    const synced = JSON.parse(syncResponse.body) as Record<string, unknown>;
    expect(synced.requires_new_conversation_inputs).toBe(true);

    const dbResult = await pool.query<{ requires_new_conversation_inputs: boolean }>(
      'SELECT requires_new_conversation_inputs FROM yiai_apps WHERE id = $1',
      [appId]
    );
    expect(dbResult.rows[0].requires_new_conversation_inputs).toBe(true);
  });

  it('sync updates requires_new_conversation_inputs from true to false', async () => {
    const app = await buildApp(pool);
    await createTestUser(pool, 'admin_user', 'admin', 'testpass');
    const appId = await createTestApp(pool, {
      slug: 'sync-true-to-false',
      name: 'Flag App',
      requires_new_conversation_inputs: true,
      api_key: 'key',
    });

    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ name: 'Flag Name' })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ title: 'Flag Site' })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ user_input_form: [] })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ title: 'Flag Site' })));

    const token = await login(app, 'admin_user', 'testpass');

    const syncResponse = await app.inject({
      method: 'POST',
      url: `/api/admin/apps/${appId}/sync`,
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(syncResponse.statusCode).toBe(200);
    const synced = JSON.parse(syncResponse.body) as Record<string, unknown>;
    expect(synced.requires_new_conversation_inputs).toBe(false);

    const dbResult = await pool.query<{ requires_new_conversation_inputs: boolean }>(
      'SELECT requires_new_conversation_inputs FROM yiai_apps WHERE id = $1',
      [appId]
    );
    expect(dbResult.rows[0].requires_new_conversation_inputs).toBe(false);
  });

  it('syncs image icon_url from upstream site and caches locally', async () => {
    const app = await buildApp(pool);
    await createTestUser(pool, 'admin_user', 'admin', 'testpass');
    const appId = await createTestApp(pool, {
      slug: 'image-icon-app',
      name: 'Image App',
      api_key: 'key',
      icon_type: 'image',
      icon: 'app-icon-uuid',
    });

    const siteResponse = {
      title: 'Image App',
      icon_type: 'image',
      icon: 'app-icon-uuid',
      icon_url: 'https://cdn.example.com/app-icon.png',
      icon_background: '#FFFFFF',
    };

    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ name: 'Image App' })))
      .mockResolvedValueOnce(new Response(JSON.stringify(siteResponse)))
      .mockResolvedValueOnce(new Response(JSON.stringify({ user_input_form: [] })))
      .mockResolvedValueOnce(new Response(JSON.stringify(siteResponse)))
      .mockResolvedValueOnce(
        new Response(Buffer.from('fake-icon-bytes'), { headers: { 'content-type': 'image/png' } })
      );

    const token = await login(app, 'admin_user', 'testpass');

    const syncResponse = await app.inject({
      method: 'POST',
      url: `/api/admin/apps/${appId}/sync`,
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(syncResponse.statusCode).toBe(200);
    const synced = JSON.parse(syncResponse.body) as Record<string, unknown>;
    expect(synced).not.toHaveProperty('api_key');
    expect(synced.icon_type).toBe('image');
    expect(synced.icon).toBeNull();
    expect(typeof synced.icon_url).toBe('string');
    expect((synced.icon_url as string).startsWith('/api/app-icons/image-icon-app?v=')).toBe(true);
    expect(synced.icon_background).toBe('#FFFFFF');

    expect(fetchMock).toHaveBeenCalledTimes(5);
    const downloadCall = fetchMock.mock.calls[4];
    expect(downloadCall[0]).toBe('https://cdn.example.com/app-icon.png');
  });

  it('prevents duplicate slug when creating apps', async () => {
    const app = await buildApp(pool);
    await createTestUser(pool, 'admin_user', 'admin', 'testpass');
    await createTestApp(pool, { slug: 'dup-app', name: 'Dup App' });

    mockUpstreamMetadata(fetchMock);

    const token = await login(app, 'admin_user', 'testpass');

    const response = await app.inject({
      method: 'POST',
      url: '/api/admin/apps',
      headers: { Authorization: `Bearer ${token}` },
      payload: { slug: 'dup-app', name: 'Another', api_base_url: 'https://yiai.example.com/v1', api_key: 'key' },
    });

    expect(response.statusCode).toBe(409);
  });

  it('allows an admin to reset a user password without returning it', async () => {
    const app = await buildApp(pool);
    await createTestUser(pool, 'admin_user', 'admin', 'testpass');
    const targetUserId = await createTestUser(pool, 'target_user', 'user', 'oldpass');
    const token = await login(app, 'admin_user', 'testpass');

    const response = await app.inject({
      method: 'PUT',
      url: `/api/admin/users/${targetUserId}/password`,
      headers: { Authorization: `Bearer ${token}` },
      payload: { newPassword: 'newpass123' },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as Record<string, unknown>;
    expect(body).toEqual({ id: targetUserId, username: 'target_user', password_changed: true });
    expect(response.body).not.toContain('newpass123');

    const stored = await pool.query<{ password_hash: string }>('SELECT password_hash FROM users WHERE id = $1', [targetUserId]);
    expect(stored.rows[0].password_hash).toBe('hashed-newpass123');

    const newLogin = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'target_user', password: 'newpass123' },
    });
    expect(newLogin.statusCode).toBe(200);
  });

  it('adds app and AI reply metadata to user ledgers and merges all user consumption records', async () => {
    const app = await buildApp(pool);
    await createTestUser(pool, 'admin_user', 'admin', 'testpass');
    const firstUserId = await createTestUser(pool, 'first_user');
    const secondUserId = await createTestUser(pool, 'second_user');
    const appId = await createTestApp(pool, { slug: 'medical-app', name: '循证西医' });

    const firstUsage = await pool.query<{ id: string }>(
      `INSERT INTO yiai_usage_records
       (user_id, app_id, conversation_id, message_id, task_id, total_tokens)
       VALUES ($1, $2, 'conversation-1', 'message-1', 'task-1', 120)
       RETURNING id`,
      [firstUserId, appId]
    );
    const secondUsage = await pool.query<{ id: string }>(
      `INSERT INTO yiai_usage_records
       (user_id, app_id, conversation_id, message_id, task_id, total_tokens)
       VALUES ($1, $2, 'conversation-2', 'message-2', 'task-2', 80)
       RETURNING id`,
      [secondUserId, appId]
    );
    await pool.query(
      `INSERT INTO token_ledger_entries
       (user_id, delta_tokens, bucket, entry_type, usage_record_id, note, created_at)
       VALUES
         ($1, -120, 'gift', 'usage', $2, '使用消耗', '2026-08-13T02:00:00Z'),
         ($3, -80, 'recharge', 'usage', $4, '使用消耗', '2026-08-13T03:00:00Z'),
         ($1, 50000, 'gift', 'login_streak_gift', NULL, '连续登录奖励', '2026-08-13T04:00:00Z')`,
      [firstUserId, firstUsage.rows[0].id, secondUserId, secondUsage.rows[0].id]
    );

    const token = await login(app, 'admin_user', 'testpass');
    const ledgerResponse = await app.inject({
      method: 'GET',
      url: `/api/admin/users/${firstUserId}/ledger`,
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(ledgerResponse.statusCode).toBe(200);
    expect(JSON.parse(ledgerResponse.body)).toEqual([
      expect.objectContaining({
        entry_type: 'login_streak_gift',
        app_name: null,
        ai_reply_available: false,
      }),
      expect.objectContaining({
        entry_type: 'usage',
        delta_tokens: -120,
        app_name: '循证西医',
        ai_reply_available: true,
      }),
    ]);

    const allResponse = await app.inject({
      method: 'GET',
      url: '/api/admin/usage-records?page=1&page_size=50',
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(allResponse.statusCode).toBe(200);
    const allBody = JSON.parse(allResponse.body) as {
      items: Array<{ username: string; delta_tokens: number; app_name: string }>;
      total: number;
      page: number;
      page_size: number;
    };
    expect(allBody).toMatchObject({ total: 2, page: 1, page_size: 50 });
    expect(allBody.items).toEqual([
      expect.objectContaining({ username: 'second_user', delta_tokens: -80, app_name: '循证西医' }),
      expect.objectContaining({ username: 'first_user', delta_tokens: -120, app_name: '循证西医' }),
    ]);
    await app.close();
  });

  it('loads an AI reply only when an admin requests a consumption detail', async () => {
    const app = await buildApp(pool);
    await createTestUser(pool, 'admin_user', 'admin', 'testpass');
    const targetUserId = await createTestUser(pool, 'target_user');
    const appId = await createTestApp(pool, {
      slug: 'reply-app',
      name: 'Reply App',
      api_base_url: 'https://yiai.example.com/v1',
      api_key: 'reply-key',
      enabled: false,
    });
    const usage = await pool.query<{ id: string }>(
      `INSERT INTO yiai_usage_records
       (user_id, app_id, conversation_id, message_id, task_id, total_tokens)
       VALUES ($1, $2, 'conversation-old', 'message-target', 'task-target', 25)
       RETURNING id`,
      [targetUserId, appId]
    );
    const ledger = await pool.query<{ id: string }>(
      `INSERT INTO token_ledger_entries
       (user_id, delta_tokens, bucket, entry_type, usage_record_id, note)
       VALUES ($1, -25, 'gift', 'usage', $2, '使用消耗')
       RETURNING id`,
      [targetUserId, usage.rows[0].id]
    );
    const token = await login(app, 'admin_user', 'testpass');

    const listResponse = await app.inject({
      method: 'GET',
      url: '/api/admin/usage-records',
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(listResponse.statusCode).toBe(200);
    expect(fetchMock).not.toHaveBeenCalled();

    fetchMock
      .mockResolvedValueOnce(
        new Response(JSON.stringify({
          data: [
            {
              id: 'message-page-first',
              conversation_id: 'conversation-old',
              query: 'older question on the current page',
              answer: 'older answer on the current page',
              created_at: 2,
            },
            {
              id: 'message-newer',
              conversation_id: 'conversation-old',
              query: 'newer question',
              answer: 'newer answer',
              created_at: 3,
            },
          ],
          has_more: true,
        }))
      )
      .mockResolvedValueOnce(
      new Response(JSON.stringify({
        data: [{
          id: 'message-target',
          conversation_id: 'conversation-old',
          query: 'question',
          answer: '<think>hidden</think>**Visible answer**',
          created_at: 1,
        }],
        has_more: false,
      }))
      );
    const detailResponse = await app.inject({
      method: 'GET',
      url: `/api/admin/usage-records/${ledger.rows[0].id}/ai-reply`,
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(detailResponse.statusCode).toBe(200);
    expect(JSON.parse(detailResponse.body)).toMatchObject({
      username: 'target_user',
      app_name: 'Reply App',
      answer: '<think>hidden</think>**Visible answer**',
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][0]).toContain('/messages?');
    expect(fetchMock.mock.calls[0][0]).toContain('user=yiai-platform-');
    expect(fetchMock.mock.calls[0][0]).toContain('conversation_id=conversation-old');
    expect(fetchMock.mock.calls[1][0]).toContain('first_id=message-page-first');
    expect((fetchMock.mock.calls[0][1]?.headers as Record<string, string>).Authorization).toBe('Bearer reply-key');
    await app.close();
  });

  it('keeps consumption rows visible when their historical usage link has been removed', async () => {
    const app = await buildApp(pool);
    await createTestUser(pool, 'admin_user', 'admin', 'testpass');
    const targetUserId = await createTestUser(pool, 'target_user');
    const ledger = await pool.query<{ id: string }>(
      `INSERT INTO token_ledger_entries
       (user_id, delta_tokens, bucket, entry_type, usage_record_id, note)
       VALUES ($1, -25, 'gift', 'usage', NULL, '使用消耗')
       RETURNING id`,
      [targetUserId]
    );
    const token = await login(app, 'admin_user', 'testpass');

    const listResponse = await app.inject({
      method: 'GET',
      url: '/api/admin/usage-records',
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(listResponse.statusCode).toBe(200);
    expect(JSON.parse(listResponse.body)).toMatchObject({
      total: 1,
      items: [{
        id: ledger.rows[0].id,
        username: 'target_user',
        app_name: null,
        ai_reply_available: false,
      }],
    });

    const detailResponse = await app.inject({
      method: 'GET',
      url: `/api/admin/usage-records/${ledger.rows[0].id}/ai-reply`,
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(detailResponse.statusCode).toBe(410);
    expect(fetchMock).not.toHaveBeenCalled();
    await app.close();
  });

  it('rejects a too-short admin password reset', async () => {
    const app = await buildApp(pool);
    await createTestUser(pool, 'admin_user', 'admin', 'testpass');
    const targetUserId = await createTestUser(pool, 'target_user', 'user', 'oldpass');
    const token = await login(app, 'admin_user', 'testpass');

    const response = await app.inject({
      method: 'PUT',
      url: `/api/admin/users/${targetUserId}/password`,
      headers: { Authorization: `Bearer ${token}` },
      payload: { newPassword: 'short' },
    });

    expect(response.statusCode).toBe(400);
  });

  it('allows an admin to delete an application', async () => {
    const app = await buildApp(pool);
    await createTestUser(pool, 'admin_user', 'admin', 'testpass');
    const appId = await createTestApp(pool, { slug: 'delete-me', name: 'Delete Me' });
    const token = await login(app, 'admin_user', 'testpass');

    const response = await app.inject({
      method: 'DELETE',
      url: `/api/admin/apps/${appId}`,
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toMatchObject({ id: appId, slug: 'delete-me', deleted: true });
    const remaining = await pool.query('SELECT id FROM yiai_apps WHERE id = $1', [appId]);
    expect(remaining.rowCount).toBe(0);
  });

  it('prevents non-admin users from accessing admin endpoints', async () => {
    const app = await buildApp(pool);
    const userId = await createTestUser(pool, 'normal_user');
    const appId = await createTestApp(pool, { slug: 'admin-test-app', api_key: 'key' });
    const token = await login(app, 'normal_user', 'secret123');

    const endpoints = [
      { method: 'GET' as const, url: '/api/admin/users' },
      { method: 'GET' as const, url: `/api/admin/users/${userId}/ledger` },
      { method: 'GET' as const, url: '/api/admin/usage-records' },
      { method: 'GET' as const, url: '/api/admin/usage-records/not-allowed/ai-reply' },
      { method: 'POST' as const, url: `/api/admin/users/${userId}/recharge`, payload: { amount: 100 } },
      { method: 'PUT' as const, url: `/api/admin/users/${userId}/password`, payload: { newPassword: 'newpass123' } },
      { method: 'GET' as const, url: '/api/admin/apps' },
      { method: 'POST' as const, url: '/api/admin/apps', payload: { slug: 'x', api_base_url: 'https://x', api_key: 'k' } },
      { method: 'PATCH' as const, url: `/api/admin/apps/${appId}`, payload: { name: 'x' } },
      { method: 'DELETE' as const, url: `/api/admin/apps/${appId}` },
      { method: 'PUT' as const, url: `/api/admin/apps/${appId}/connection`, payload: { api_base_url: 'https://x' } },
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
