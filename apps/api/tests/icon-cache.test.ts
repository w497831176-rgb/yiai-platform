import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createInMemoryPool, createTestApp, createTestUser } from './helpers/in-memory-db.js';
import { appIconRoutes } from '../src/routes/app-icons.js';
import { authRoutes } from '../src/routes/auth.js';
import { appRoutes } from '../src/routes/apps.js';
import { adminRoutes } from '../src/routes/admin.js';
import {
  refreshAppIconCache,
  getLocalIconUrl,
  cacheFilePath,
  refreshAllEnabledAppIcons,
} from '../src/services/icon-cache.js';

vi.mock('../src/auth/password.js', () => ({
  hashPassword: vi.fn((password: string) => `hashed-${password}`),
  verifyPassword: vi.fn((plain: string, hash: string) => hash === `hashed-${plain}`),
}));

async function buildApp(pool: Pool): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(authRoutes, { prefix: '/api/auth', pool });
  await app.register(appRoutes, { prefix: '/api/apps', pool });
  await app.register(appIconRoutes, { prefix: '/api/app-icons', pool });
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

function createIconCacheDir(): string {
  return path.join(os.tmpdir(), 'yiai-platform-icon-cache-test');
}

async function cleanIconCache(slug: string): Promise<void> {
  const dir = createIconCacheDir();
  try {
    await fs.unlink(path.join(dir, slug));
  } catch {
    // ignore
  }
  try {
    await fs.unlink(`${path.join(dir, slug)}.tmp`);
  } catch {
    // ignore
  }
}

describe('Icon Cache', () => {
  let pool: Pool;
  const fetchMock = vi.fn<typeof fetch>();

  vi.stubGlobal('fetch', fetchMock);

  beforeEach(async () => {
    fetchMock.mockReset();
    pool = await createInMemoryPool();
    await createTestUser(pool, 'admin_user', 'admin', 'testpass');
  });

  it('refreshAppIconCache writes file and updates DB for image icons', async () => {
    const appId = await createTestApp(pool, {
      slug: 'cache-image-app',
      api_base_url: 'https://yiai.example.com/v1',
      api_key: 'key',
    });

    fetchMock
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            title: 'Cached Image App',
            icon_type: 'image',
            icon: 'icon-uuid',
            icon_url: 'https://cdn.example.com/icon.png',
            icon_background: '#000000',
          })
        )
      )
      .mockResolvedValueOnce(
        new Response(Buffer.from('cached-image'), { headers: { 'content-type': 'image/png' } })
      );

    const appRow = await pool.query<{ id: string; slug: string; api_base_url: string; api_key: string }>(
      'SELECT id, slug, api_base_url, api_key FROM yiai_apps WHERE id = $1',
      [appId]
    );
    const refreshResult = await refreshAppIconCache(pool, appRow.rows[0]);
    expect(refreshResult.success).toBe(true);

    const row = await pool.query<{
      name: string;
      description: string | null;
      icon: string | null;
      icon_type: 'image' | 'emoji' | null;
      icon_background: string | null;
      icon_cache_filename: string | null;
      icon_cache_content_type: string | null;
      icon_cached_at: Date | null;
    }>(
      'SELECT name, description, icon, icon_type, icon_background, icon_cache_filename, icon_cache_content_type, icon_cached_at FROM yiai_apps WHERE id = $1',
      [appId]
    );
    expect(row.rows[0].name).toBe('Cached Image App');
    expect(row.rows[0].icon_type).toBe('image');
    expect(row.rows[0].icon_background).toBe('#000000');
    expect(row.rows[0].icon_cache_filename).toBe('cache-image-app');
    expect(row.rows[0].icon_cache_content_type).toBe('image/png');
    expect(row.rows[0].icon_cached_at).not.toBeNull();

    const filePath = cacheFilePath('cache-image-app');
    const content = await fs.readFile(filePath, 'utf-8');
    expect(content).toBe('cached-image');

    await cleanIconCache('cache-image-app');
  });

  it('listEnabledApps returns local icon URL and does not call YIAI /site', async () => {
    const app = await buildApp(pool);
    const token = await login(app, 'admin_user', 'testpass');

    const cachedAt = new Date('2026-06-01T12:00:00.000Z');
    await createTestApp(pool, {
      slug: 'local-image-app',
      name: 'Local Image App',
      icon_type: 'image',
      icon: 'icon-uuid',
      icon_cache_filename: 'local-image-app',
      icon_cache_content_type: 'image/png',
      icon_cached_at: cachedAt,
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/apps',
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as Array<{ slug: string; icon_url: string | null }>;
    const found = body.find((a) => a.slug === 'local-image-app');
    expect(found?.icon_url).toBe(`/api/app-icons/local-image-app?v=${String(cachedAt.getTime())}`);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('GET /api/app-icons/:slug serves cached file publicly and returns 404 for missing', async () => {
    const app = await buildApp(pool);
    await createTestApp(pool, {
      slug: 'public-image-app',
      icon_type: 'image',
      icon: 'icon-uuid',
      icon_cache_filename: 'public-image-app',
      icon_cache_content_type: 'image/png',
      icon_cached_at: new Date(),
    });

    const cacheDir = createIconCacheDir();
    await fs.mkdir(cacheDir, { recursive: true });
    await fs.writeFile(path.join(cacheDir, 'public-image-app'), Buffer.from('public-icon'));

    const response = await app.inject({
      method: 'GET',
      url: '/api/app-icons/public-image-app',
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('image/png');
    expect(response.headers['cache-control']).toBe('public, max-age=86400');
    expect(response.body).toBe('public-icon');

    const missing = await app.inject({
      method: 'GET',
      url: '/api/app-icons/nonexistent-app',
    });
    expect(missing.statusCode).toBe(404);

    await cleanIconCache('public-image-app');
  });

  it('refresh failure preserves old cache', async () => {
    const appId = await createTestApp(pool, {
      slug: 'preserve-cache-app',
      api_base_url: 'https://yiai.example.com/v1',
      api_key: 'key',
      icon_type: 'image',
      icon: 'icon-uuid',
      icon_cache_filename: 'preserve-cache-app',
      icon_cache_content_type: 'image/png',
      icon_cached_at: new Date('2026-01-01T00:00:00.000Z'),
    });

    const cacheDir = createIconCacheDir();
    await fs.mkdir(cacheDir, { recursive: true });
    await fs.writeFile(path.join(cacheDir, 'preserve-cache-app'), Buffer.from('old-icon'));

    fetchMock.mockRejectedValueOnce(new Error('network error'));

    const appRow = await pool.query<{ id: string; slug: string; api_base_url: string; api_key: string }>(
      'SELECT id, slug, api_base_url, api_key FROM yiai_apps WHERE id = $1',
      [appId]
    );
    const result = await refreshAppIconCache(pool, appRow.rows[0]);
    expect(result.success).toBe(false);

    const row = await pool.query<{
      icon_cache_filename: string | null;
      icon_cache_content_type: string | null;
      icon_cached_at: Date | null;
    }>(
      'SELECT icon_cache_filename, icon_cache_content_type, icon_cached_at FROM yiai_apps WHERE id = $1',
      [appId]
    );
    expect(row.rows[0].icon_cache_filename).toBe('preserve-cache-app');
    expect(row.rows[0].icon_cache_content_type).toBe('image/png');
    expect(row.rows[0].icon_cached_at).not.toBeNull();

    const content = await fs.readFile(path.join(cacheDir, 'preserve-cache-app'), 'utf-8');
    expect(content).toBe('old-icon');

    await cleanIconCache('preserve-cache-app');
  });

  it('sync/create triggers icon cache refresh', async () => {
    const app = await buildApp(pool);
    const token = await login(app, 'admin_user', 'testpass');

    const siteResponse = {
      title: 'New Image App',
      icon_type: 'image',
      icon: 'new-icon-uuid',
      icon_url: 'https://cdn.example.com/new-icon.png',
      icon_background: '#FFFFFF',
    };

    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ name: 'New Image App' })))
      .mockResolvedValueOnce(new Response(JSON.stringify(siteResponse)))
      .mockResolvedValueOnce(new Response(JSON.stringify({ user_input_form: [] })))
      .mockResolvedValueOnce(new Response(JSON.stringify(siteResponse)))
      .mockResolvedValueOnce(
        new Response(Buffer.from('new-icon'), { headers: { 'content-type': 'image/png' } })
      );

    const createResponse = await app.inject({
      method: 'POST',
      url: '/api/admin/apps',
      headers: { Authorization: `Bearer ${token}` },
      payload: {
        slug: 'new-image-app',
        api_base_url: 'https://yiai.example.com/v1',
        api_key: 'key',
      },
    });

    expect(createResponse.statusCode).toBe(201);
    const created = JSON.parse(createResponse.body) as Record<string, unknown>;
    expect(created.icon_type).toBe('image');
    expect(typeof created.icon_url).toBe('string');
    expect((created.icon_url as string).startsWith('/api/app-icons/new-image-app?v=')).toBe(true);

    const filePath = cacheFilePath('new-image-app');
    const content = await fs.readFile(filePath, 'utf-8');
    expect(content).toBe('new-icon');

    await cleanIconCache('new-image-app');
  });

  it('refreshAllEnabledAppIcons counts success and failure while preserving old cache on failure', async () => {
    await createTestApp(pool, {
      slug: 'refresh-success-app',
      api_base_url: 'https://yiai.example.com/v1',
      api_key: 'key1',
    });

    const failureAppId = await createTestApp(pool, {
      slug: 'refresh-failure-app',
      api_base_url: 'https://yiai.example.com/v1',
      api_key: 'key2',
      icon_type: 'image',
      icon: 'old-icon-uuid',
      icon_cache_filename: 'refresh-failure-app',
      icon_cache_content_type: 'image/png',
      icon_cached_at: new Date('2026-01-01T00:00:00.000Z'),
    });

    await createTestApp(pool, {
      slug: 'refresh-disabled-app',
      api_base_url: 'https://yiai.example.com/v1',
      api_key: 'key3',
      enabled: false,
    });

    const cacheDir = createIconCacheDir();
    await fs.mkdir(cacheDir, { recursive: true });
    await fs.writeFile(path.join(cacheDir, 'refresh-failure-app'), Buffer.from('old-icon'));

    fetchMock
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ title: 'Success App', icon_type: 'image', icon_url: 'https://cdn.example.com/success.png' })
        )
      )
      .mockResolvedValueOnce(
        new Response(Buffer.from('success-icon'), { headers: { 'content-type': 'image/png' } })
      )
      .mockRejectedValueOnce(new Error('network error'));

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await refreshAllEnabledAppIcons(pool);
    expect(logSpy).toHaveBeenCalledWith('[icon-cache] 完成每日刷新: 成功 1, 失败 1');
    logSpy.mockRestore();

    const successRow = await pool.query<{ icon_cache_filename: string | null }>(
      'SELECT icon_cache_filename FROM yiai_apps WHERE slug = $1',
      ['refresh-success-app']
    );
    expect(successRow.rows[0].icon_cache_filename).toBe('refresh-success-app');

    const failureRow = await pool.query<{
      icon_cache_filename: string | null;
      icon_cache_content_type: string | null;
      icon_cached_at: Date | null;
    }>(
      'SELECT icon_cache_filename, icon_cache_content_type, icon_cached_at FROM yiai_apps WHERE id = $1',
      [failureAppId]
    );
    expect(failureRow.rows[0].icon_cache_filename).toBe('refresh-failure-app');
    expect(failureRow.rows[0].icon_cache_content_type).toBe('image/png');
    expect(failureRow.rows[0].icon_cached_at).not.toBeNull();

    const failureContent = await fs.readFile(path.join(cacheDir, 'refresh-failure-app'), 'utf-8');
    expect(failureContent).toBe('old-icon');

    const disabled = await pool.query<{ icon_cache_filename: string | null }>(
      'SELECT icon_cache_filename FROM yiai_apps WHERE slug = $1',
      ['refresh-disabled-app']
    );
    expect(disabled.rows[0].icon_cache_filename).toBeNull();

    await cleanIconCache('refresh-success-app');
    await cleanIconCache('refresh-failure-app');
  });

  it('getLocalIconUrl returns null for missing cache fields', () => {
    expect(getLocalIconUrl(null)).toBeNull();
    expect(getLocalIconUrl({ slug: 'x', icon_cache_filename: null, icon_cached_at: new Date() })).toBeNull();
    expect(getLocalIconUrl({ slug: 'x', icon_cache_filename: 'x', icon_cached_at: null })).toBeNull();
  });
});
