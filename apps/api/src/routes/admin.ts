import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { Pool } from 'pg';
import { authenticate } from '../auth/decorator.js';
import { ensureDailyGift, getAllUserAccounts, getLedgerEntries, rechargeTokens } from '../services/token-account.js';
import { syncAppMetadata, fetchAppMetadata, toSafeApp, YiaiUpstreamError, type AppMetadata, type UpstreamAppMetadata } from '../services/yiai.js';
import { getLocalIconUrl, refreshAppIconCache } from '../services/icon-cache.js';

interface AdminParams {
  userId: string;
  id: string;
}

interface RechargeBody {
  amount: number;
  note?: string;
}

interface AppBody {
  slug?: string;
  name?: string;
  description?: string;
  icon?: string;
  api_base_url?: string;
  api_key?: string;
  enabled?: boolean;
  sort_order?: number;
  requires_new_conversation_inputs?: boolean;
  sync_metadata?: boolean;
}

interface AdminAppRow {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  icon: string | null;
  icon_type: 'image' | 'emoji' | null;
  icon_background: string | null;
  api_base_url: string;
  api_key: string;
  enabled: boolean;
  sort_order: number;
  requires_new_conversation_inputs: boolean;
  created_at: string;
  updated_at: string;
  icon_cache_filename: string | null;
  icon_cache_content_type: string | null;
  icon_cached_at: Date | null;
}

function assertAdmin(request: FastifyRequest, reply: FastifyReply): boolean {
  const user = request.user;
  if (!user) {
    void reply.status(401).send({ error: '未登录' });
    return false;
  }
  if (user.role !== 'admin') {
    void reply.status(403).send({ error: '无权限' });
    return false;
  }
  return true;
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

function toAdminAppResponse(row: AdminAppRow): Record<string, unknown> {
  return {
    ...toSafeApp(row, getLocalIconUrl(row)),
    api_base_url: row.api_base_url,
    api_key_configured: typeof row.api_key === 'string' && row.api_key !== '',
    enabled: row.enabled,
  };
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

function extractStoredIconFields(metadata: AppMetadata, body: AppBody) {
  const icon = metadata.icon ?? body.icon ?? null;
  let icon_type = metadata.icon_type;
  if (!icon_type && icon) {
    icon_type = inferIconType(icon);
  }
  return {
    icon,
    icon_type,
    icon_background: metadata.icon_background ?? null,
  };
}

export function adminRoutes(fastify: FastifyInstance, options: { pool: Pool }) {
  const { pool } = options;

  fastify.get('/admin/users', { preHandler: authenticate }, async (request, reply) => {
    if (!assertAdmin(request, reply)) return;
    const userRows = await pool.query<{ id: string }>('SELECT id FROM users ORDER BY created_at DESC');
    await Promise.all(userRows.rows.map((row) => ensureDailyGift(pool, row.id)));
    const users = await getAllUserAccounts(pool);
    return users.map((u) => ({
      id: u.id,
      username: u.username,
      role: u.role,
      gift_tokens: u.gift_tokens,
      recharge_tokens: u.recharge_tokens,
      created_at: u.created_at,
    }));
  });

  fastify.get('/admin/users/:userId/ledger', { preHandler: authenticate }, async (request, reply) => {
    if (!assertAdmin(request, reply)) return;
    const params = request.params as AdminParams;
    const entries = await getLedgerEntries(pool, params.userId);
    return entries.map((entry) => ({
      id: entry.id,
      created_at: entry.created_at,
      entry_type: entry.entry_type,
      bucket: entry.bucket,
      delta_tokens: entry.delta_tokens,
      note: entry.note,
    }));
  });

  fastify.post('/admin/users/:userId/recharge', { preHandler: authenticate }, async (request, reply) => {
    if (!assertAdmin(request, reply)) return;
    const admin = request.user;
    if (!admin) {
      return reply.status(401).send({ error: '未登录' });
    }
    const params = request.params as AdminParams;
    const body = request.body as RechargeBody;

    if (!Number.isInteger(body.amount) || body.amount <= 0) {
      return reply.status(400).send({ error: '充值额度必须为正整数' });
    }

    const account = await rechargeTokens(pool, params.userId, body.amount, admin.id, body.note);
    return {
      gift_tokens: account.gift_tokens,
      recharge_tokens: account.recharge_tokens,
    };
  });

  fastify.get('/admin/apps', { preHandler: authenticate }, async (request, reply) => {
    if (!assertAdmin(request, reply)) return;
    const result = await pool.query<AdminAppRow>(
      `SELECT id, slug, name, description, icon, icon_type, icon_background, api_base_url, api_key, enabled, sort_order,
              requires_new_conversation_inputs, created_at, updated_at,
              icon_cache_filename, icon_cache_content_type, icon_cached_at
       FROM yiai_apps
       ORDER BY sort_order, id`
    );
    return result.rows.map(toAdminAppResponse);
  });

  fastify.post('/admin/apps', { preHandler: authenticate }, async (request, reply) => {
    if (!assertAdmin(request, reply)) return;
    const body = request.body as AppBody;

    if (!isNonEmptyString(body.slug)) {
      return reply.status(400).send({ error: '应用标识不能为空' });
    }
    if (!isNonEmptyString(body.api_base_url)) {
      return reply.status(400).send({ error: 'API Base URL 不能为空' });
    }
    if (!isNonEmptyString(body.api_key)) {
      return reply.status(400).send({ error: 'API Key 不能为空' });
    }

    let metadata: UpstreamAppMetadata;
    try {
      metadata = await syncAppMetadata(body.api_base_url, body.api_key);
    } catch (err) {
      if (err instanceof YiaiUpstreamError) {
        return reply.status(400).send({ error: `同步应用元数据失败：${err.message}` });
      }
      throw err;
    }

    const iconFields = extractStoredIconFields(metadata, body);

    try {
      const result = await pool.query(
        `
          INSERT INTO yiai_apps (slug, name, description, icon, icon_type, icon_background, api_base_url, api_key, enabled, sort_order, requires_new_conversation_inputs)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
          RETURNING id, slug, name, description, icon, icon_type, icon_background, api_base_url, api_key, enabled, sort_order, requires_new_conversation_inputs, created_at, updated_at,
                   icon_cache_filename, icon_cache_content_type, icon_cached_at
        `,
        [
          body.slug,
          metadata.name ?? body.name ?? body.slug,
          metadata.description ?? body.description ?? null,
          iconFields.icon,
          iconFields.icon_type,
          iconFields.icon_background,
          body.api_base_url,
          body.api_key,
          body.enabled ?? true,
          body.sort_order ?? 0,
          metadata.requires_new_conversation_inputs,
        ]
      );
      const row = result.rows[0] as AdminAppRow;
      await refreshAppIconCache(pool, row);
      const refreshed = await pool.query<AdminAppRow>('SELECT * FROM yiai_apps WHERE id = $1', [row.id]);
      return await reply.status(201).send(toAdminAppResponse(refreshed.rows[0]));
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === '23505') {
        return reply.status(409).send({ error: '应用标识已存在' });
      }
      throw error;
    }
  });

  fastify.post('/admin/apps/:id/sync', { preHandler: authenticate }, async (request, reply) => {
    if (!assertAdmin(request, reply)) return;
    const params = request.params as AdminParams;

    const existing = await pool.query<AdminAppRow>('SELECT * FROM yiai_apps WHERE id = $1', [params.id]);
    const app = existing.rows.at(0);
    if (!app) {
      return reply.status(404).send({ error: '应用不存在或无权访问' });
    }

    let metadata: UpstreamAppMetadata;
    try {
      metadata = await syncAppMetadata(pool, app.slug);
    } catch (err) {
      if (err instanceof YiaiUpstreamError) {
        return reply.status(400).send({ error: `同步应用元数据失败：${err.message}` });
      }
      throw err;
    }

    const fields: string[] = [];
    const values: unknown[] = [];

    function addField(name: string, value: unknown) {
      fields.push(`${name} = $${String(values.length + 1)}`);
      values.push(value);
    }

    addField('name', metadata.name ?? app.name);
    addField('description', metadata.description ?? app.description);
    const iconFields = extractStoredIconFields(metadata, {});
    addField('icon', iconFields.icon ?? app.icon);
    addField('icon_type', iconFields.icon_type ?? app.icon_type);
    addField('icon_background', iconFields.icon_background ?? app.icon_background);
    addField('requires_new_conversation_inputs', metadata.requires_new_conversation_inputs);

    fields.push('updated_at = NOW()');
    values.push(params.id);
    const result = await pool.query(
      `UPDATE yiai_apps SET ${fields.join(', ')} WHERE id = $${String(values.length)} RETURNING id, slug, name, description, icon, icon_type, icon_background, api_base_url, api_key, enabled, sort_order, requires_new_conversation_inputs, created_at, updated_at,
       icon_cache_filename, icon_cache_content_type, icon_cached_at`,
      values
    );

    const row = result.rows[0] as AdminAppRow;
    await refreshAppIconCache(pool, row);
    const refreshed = await pool.query<AdminAppRow>('SELECT * FROM yiai_apps WHERE id = $1', [row.id]);
    return toAdminAppResponse(refreshed.rows[0]);
  });

  fastify.patch('/admin/apps/:id', { preHandler: authenticate }, async (request, reply) => {
    if (!assertAdmin(request, reply)) return;
    const params = request.params as AdminParams;
    const body = request.body as AppBody;

    const existing = await pool.query<AdminAppRow>('SELECT * FROM yiai_apps WHERE id = $1', [params.id]);
    const app = existing.rows.at(0);
    if (!app) {
      return reply.status(404).send({ error: '应用不存在或无权访问' });
    }

    const fields: string[] = [];
    const values: unknown[] = [];

    function addField(name: string, value: unknown) {
      fields.push(`${name} = $${String(values.length + 1)}`);
      values.push(value);
    }

    if (body.name !== undefined) addField('name', body.name);
    if (body.description !== undefined) addField('description', body.description);
    if (body.icon !== undefined) {
      addField('icon', body.icon);
      addField('icon_type', inferIconType(body.icon));
    }
    if (body.api_base_url !== undefined) addField('api_base_url', body.api_base_url);
    if (body.enabled !== undefined) addField('enabled', body.enabled);
    if (body.sort_order !== undefined) addField('sort_order', body.sort_order);
    if (body.requires_new_conversation_inputs !== undefined) addField('requires_new_conversation_inputs', body.requires_new_conversation_inputs);
    if (isNonEmptyString(body.api_key)) addField('api_key', body.api_key);

    let shouldRefreshIcon = false;
    if (body.sync_metadata) {
      let metadata;
      try {
        metadata = await fetchAppMetadata(pool, app.slug);
      } catch (err) {
        if (err instanceof YiaiUpstreamError) {
          return reply.status(400).send({ error: `同步应用元数据失败：${err.message}` });
        }
        throw err;
      }
      shouldRefreshIcon = true;
      if (body.name === undefined) addField('name', metadata.name ?? app.name);
      if (body.description === undefined) addField('description', metadata.description ?? app.description);
      if (body.icon === undefined) {
        const iconFields = extractStoredIconFields(metadata, {});
        addField('icon', iconFields.icon ?? app.icon);
        addField('icon_type', iconFields.icon_type ?? app.icon_type);
        addField('icon_background', iconFields.icon_background ?? app.icon_background);
      }
    }

    if (fields.length === 0) {
      return reply.status(400).send({ error: '没有需要更新的字段' });
    }

    fields.push('updated_at = NOW()');
    values.push(params.id);
    const result = await pool.query(
      `UPDATE yiai_apps SET ${fields.join(', ')} WHERE id = $${String(values.length)} RETURNING id, slug, name, description, icon, icon_type, icon_background, api_base_url, api_key, enabled, sort_order, requires_new_conversation_inputs, created_at, updated_at,
       icon_cache_filename, icon_cache_content_type, icon_cached_at`,
      values
    );

    const row = result.rows[0] as AdminAppRow;
    if (shouldRefreshIcon) {
      await refreshAppIconCache(pool, row);
    }
    const refreshed = await pool.query<AdminAppRow>('SELECT * FROM yiai_apps WHERE id = $1', [row.id]);
    return toAdminAppResponse(refreshed.rows[0]);
  });
}
