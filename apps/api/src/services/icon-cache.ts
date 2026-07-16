import fs from 'node:fs/promises';
import path from 'node:path';
import type { Pool } from 'pg';
import type { FastifyReply } from 'fastify';

const MAX_ICON_BYTES = 5 * 1024 * 1024;

interface CacheableApp {
  id: string;
  slug: string;
  api_base_url: string;
  api_key: string;
}

interface IconCacheRow {
  icon_cache_filename: string | null;
  icon_cache_content_type: string | null;
  icon_cached_at: Date | null;
}

interface IconCacheFields {
  slug: string;
  icon_cache_filename?: string | null;
  icon_cached_at?: Date | string | null;
}

interface YiaiSiteInfoResponse {
  title?: string;
  icon?: string;
  description?: string;
  icon_type?: 'image' | 'emoji';
  icon_url?: string;
  icon_background?: string;
}

interface YiaiSiteResponse {
  title?: string;
  icon?: string;
  description?: string;
  icon_type?: 'image' | 'emoji';
  icon_url?: string;
  icon_background?: string;
  site_info?: YiaiSiteInfoResponse;
}

function getIconCacheDir(): string {
  return process.env.YIAI_PLATFORM_ICON_CACHE_DIR ?? '/app/data/icon-cache';
}

function isValidIconType(value: unknown): value is 'image' | 'emoji' {
  return value === 'image' || value === 'emoji';
}

function inferIconType(icon: string | null): 'image' | 'emoji' | null {
  if (!icon) {
    return null;
  }
  if (/^\p{Extended_Pictographic}+$/u.test(icon)) {
    return 'emoji';
  }
  return 'image';
}

function resolveIconType(rawIcon: string | null, explicitType: unknown): 'image' | 'emoji' | null {
  if (isValidIconType(explicitType)) {
    return explicitType;
  }
  return inferIconType(rawIcon);
}

function looksLikeUrl(value: string): boolean {
  return /^https?:\/\//.test(value);
}

function extractIconFields(siteInfo: YiaiSiteInfoResponse): {
  icon: string | null;
  icon_type: 'image' | 'emoji' | null;
  icon_url: string | null;
  icon_background: string | null;
} {
  const rawIcon =
    typeof siteInfo.icon === 'string' && siteInfo.icon.trim() !== '' ? siteInfo.icon.trim() : null;

  const icon_type = resolveIconType(rawIcon, siteInfo.icon_type);

  let icon_url =
    typeof siteInfo.icon_url === 'string' && siteInfo.icon_url.trim() !== ''
      ? siteInfo.icon_url.trim()
      : null;
  const icon_background =
    typeof siteInfo.icon_background === 'string' && siteInfo.icon_background.trim() !== ''
      ? siteInfo.icon_background.trim()
      : null;

  const icon = rawIcon;
  if (icon_type === 'image' && !icon_url && rawIcon && looksLikeUrl(rawIcon)) {
    icon_url = rawIcon;
  }

  return { icon, icon_type, icon_url, icon_background };
}

function pickSiteInfo(site: YiaiSiteResponse): YiaiSiteInfoResponse {
  return site.site_info ?? site;
}

export function sanitizeSlug(slug: string): string | null {
  const sanitized = slug.replace(/[^a-zA-Z0-9_-]/g, '');
  if (sanitized === '' || sanitized !== slug) {
    return null;
  }
  return sanitized;
}

export function cacheFilePath(slug: string): string {
  const sanitized = sanitizeSlug(slug);
  if (!sanitized) {
    throw new Error(`非法的 slug: ${slug}`);
  }
  return path.join(getIconCacheDir(), sanitized);
}

async function ensureCacheDir(): Promise<void> {
  await fs.mkdir(getIconCacheDir(), { recursive: true });
}

async function yiaiGet<T>(url: string, apiKey: string): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
    });
  } catch (err) {
    throw new Error(`YIAI 接口请求失败: ${err instanceof Error ? err.message : '未知错误'}`);
  }

  if (!response.ok) {
    throw new Error(`YIAI 接口返回错误: ${String(response.status)} ${response.statusText}`);
  }

  return (await response.json()) as T;
}

async function downloadIcon(url: string): Promise<{ buffer: Buffer; contentType: string }> {
  let response: Response;
  try {
    response = await fetch(url, { method: 'GET' });
  } catch (err) {
    throw new Error(`下载图标失败: ${err instanceof Error ? err.message : '未知错误'}`);
  }

  if (!response.ok) {
    throw new Error(`下载图标返回错误: ${String(response.status)} ${response.statusText}`);
  }

  const contentType = response.headers.get('content-type') ?? 'application/octet-stream';
  if (!contentType.startsWith('image/')) {
    throw new Error(`非法图标 Content-Type: ${contentType}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  if (buffer.length > MAX_ICON_BYTES) {
    throw new Error(`图标超过最大限制 ${String(MAX_ICON_BYTES)} 字节`);
  }

  return { buffer, contentType };
}

export async function refreshAppIconCache(pool: Pool, app: CacheableApp): Promise<void> {
  const slug = sanitizeSlug(app.slug);
  if (!slug) {
    return;
  }

  const baseUrl = app.api_base_url.replace(/\/$/, '');
  let siteInfo: YiaiSiteInfoResponse;
  try {
    const site = await yiaiGet<YiaiSiteResponse>(`${baseUrl}/site`, app.api_key);
    siteInfo = pickSiteInfo(site);
  } catch (err) {
    console.error(`[icon-cache] 刷新应用 ${app.slug} /site 失败:`, err instanceof Error ? err.message : err);
    return;
  }

  const name =
    typeof siteInfo.title === 'string' && siteInfo.title.trim() !== '' ? siteInfo.title.trim() : null;
  const description =
    typeof siteInfo.description === 'string' && siteInfo.description.trim() !== ''
      ? siteInfo.description.trim()
      : null;

  const iconFields = extractIconFields(siteInfo);

  if (iconFields.icon_type !== 'image' || !iconFields.icon_url) {
    // 非图片图标：只更新元数据，不清理已有缓存文件
    await pool.query(
      `UPDATE yiai_apps
       SET name = COALESCE($2, name),
           description = COALESCE($3, description),
           icon = $4,
           icon_type = $5,
           icon_background = $6,
           icon_cache_filename = NULL,
           icon_cache_content_type = NULL,
           icon_cached_at = NULL
       WHERE id = $1`,
      [app.id, name, description, iconFields.icon, iconFields.icon_type, iconFields.icon_background]
    );
    return;
  }

  let buffer: Buffer;
  let contentType: string;
  try {
    const downloaded = await downloadIcon(iconFields.icon_url);
    buffer = downloaded.buffer;
    contentType = downloaded.contentType;
  } catch (err) {
    console.error(
      `[icon-cache] 下载应用 ${app.slug} 图标失败:`,
      err instanceof Error ? err.message : err
    );
    return;
  }

  try {
    await ensureCacheDir();
    const targetPath = cacheFilePath(slug);
    const tempPath = `${targetPath}.tmp`;
    await fs.writeFile(tempPath, buffer);
    await fs.rename(tempPath, targetPath);
  } catch (err) {
    console.error(
      `[icon-cache] 写入应用 ${app.slug} 图标文件失败:`,
      err instanceof Error ? err.message : err
    );
    return;
  }

  try {
    await pool.query(
      `UPDATE yiai_apps
       SET name = COALESCE($2, name),
           description = COALESCE($3, description),
           icon = $4,
           icon_type = $5,
           icon_background = $6,
           icon_cache_filename = $7,
           icon_cache_content_type = $8,
           icon_cached_at = NOW()
       WHERE id = $1`,
      [
        app.id,
        name,
        description,
        iconFields.icon,
        iconFields.icon_type,
        iconFields.icon_background,
        slug,
        contentType,
      ]
    );
  } catch (err) {
    console.error(
      `[icon-cache] 更新应用 ${app.slug} 图标缓存记录失败:`,
      err instanceof Error ? err.message : err
    );
  }
}

export function getLocalIconUrl(app: IconCacheFields | null | undefined): string | null {
  if (!app || !app.icon_cache_filename || !app.icon_cached_at) {
    return null;
  }
  const cachedAt =
    app.icon_cached_at instanceof Date ? app.icon_cached_at.getTime() : new Date(app.icon_cached_at).getTime();
  if (Number.isNaN(cachedAt)) {
    return null;
  }
  return `/api/app-icons/${app.slug}?v=${String(cachedAt)}`;
}

export async function serveIconFile(slug: string, pool: Pool, reply: FastifyReply): Promise<void> {
  const sanitized = sanitizeSlug(slug);
  if (!sanitized) {
    await reply.status(404).send({ error: '图标不存在' });
    return;
  }

  const result = await pool.query<IconCacheRow & { enabled: boolean }>(
    'SELECT icon_cache_filename, icon_cache_content_type, icon_cached_at, enabled FROM yiai_apps WHERE slug = $1',
    [sanitized]
  );
  const row = result.rows.at(0);
  if (!row || !row.enabled || !row.icon_cache_filename || !row.icon_cache_content_type) {
    await reply.status(404).send({ error: '图标不存在' });
    return;
  }

  const filePath = cacheFilePath(sanitized);
  try {
    const buffer = await fs.readFile(filePath);
    await reply
      .status(200)
      .header('Content-Type', row.icon_cache_content_type)
      .header('Cache-Control', 'public, max-age=86400')
      .send(buffer);
  } catch (err) {
    if (err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT') {
      await reply.status(404).send({ error: '图标不存在' });
      return;
    }
    throw err;
  }
}

export async function refreshAllEnabledAppIcons(pool: Pool): Promise<void> {
  const result = await pool.query<CacheableApp>(
    'SELECT id, slug, api_base_url, api_key FROM yiai_apps WHERE enabled = true'
  );

  let success = 0;
  let failed = 0;

  for (const app of result.rows) {
    try {
      await refreshAppIconCache(pool, app);
      success += 1;
    } catch (err) {
      failed += 1;
      console.error(
        `[icon-cache] 刷新应用 ${app.slug} 图标失败:`,
        err instanceof Error ? err.message : err
      );
    }
  }

  console.log(`[icon-cache] 完成每日刷新: 成功 ${String(success)}, 失败 ${String(failed)}`);
}

function getShanghaiOffsetMinutes(date: Date): number {
  const utc = new Date(date.toLocaleString('en-US', { timeZone: 'UTC' }));
  const shanghai = new Date(date.toLocaleString('en-US', { timeZone: 'Asia/Shanghai' }));
  return (shanghai.getTime() - utc.getTime()) / 60000;
}

function getNextRefreshAt(): Date {
  const now = new Date();
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });

  const parts = formatter.formatToParts(now);
  const getPart = (type: string): string => parts.find((p) => p.type === type)?.value ?? '0';

  const year = getPart('year');
  const month = getPart('month');
  const day = getPart('day');

  const today3amStr = `${year}-${month}-${day}T03:00:00`;
  const offsetMinutes = getShanghaiOffsetMinutes(now);
  let nextMs = new Date(`${today3amStr}Z`).getTime() - offsetMinutes * 60000;

  if (nextMs <= now.getTime()) {
    nextMs += 24 * 60 * 60 * 1000;
  }

  return new Date(nextMs);
}

export function scheduleDailyIconRefresh(pool: Pool): void {
  function schedule(): void {
    const next = getNextRefreshAt();
    const delay = next.getTime() - Date.now();
    setTimeout(() => {
      void refreshAllEnabledAppIcons(pool).finally(schedule);
    }, Math.max(0, delay));
  }

  schedule();
}
