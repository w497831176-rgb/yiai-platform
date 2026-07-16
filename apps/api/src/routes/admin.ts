import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { Pool } from 'pg';
import { authenticate } from '../auth/decorator.js';
import { ensureDailyGift, getAllUserAccounts, getLedgerEntries, rechargeTokens } from '../services/token-account.js';
import { fetchAppMetadata, toSafeApp, YiaiUpstreamError } from '../services/yiai.js';

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
  api_base_url: string;
  api_key: string;
  enabled: boolean;
  sort_order: number;
  requires_new_conversation_inputs: boolean;
  created_at: string;
  updated_at: string;
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

function toAdminAppResponse(row: AdminAppRow) {
  return {
    ...toSafeApp(row),
    api_base_url: row.api_base_url,
    api_key_configured: typeof row.api_key === 'string' && row.api_key !== '',
    enabled: row.enabled,
  };
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
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
      total_tokens: u.gift_tokens + u.recharge_tokens,
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
      total_tokens: account.gift_tokens + account.recharge_tokens,
    };
  });

  fastify.get('/admin/apps', { preHandler: authenticate }, async (request, reply) => {
    if (!assertAdmin(request, reply)) return;
    const result = await pool.query<AdminAppRow>(
      `SELECT id, slug, name, description, icon, api_base_url, api_key, enabled, sort_order,
              requires_new_conversation_inputs, created_at, updated_at
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

    let metadata;
    try {
      metadata = await fetchAppMetadata(body.api_base_url, body.api_key);
    } catch (err) {
      if (err instanceof YiaiUpstreamError) {
        return reply.status(400).send({ error: `同步应用元数据失败：${err.message}` });
      }
      throw err;
    }

    const hasUserInputForm = Array.isArray(metadata.user_input_form) && metadata.user_input_form.length > 0;
    const requiresNewConversationInputs =
      body.requires_new_conversation_inputs !== undefined ? body.requires_new_conversation_inputs : hasUserInputForm;

    try {
      const result = await pool.query(
        `
          INSERT INTO yiai_apps (slug, name, description, icon, api_base_url, api_key, enabled, sort_order, requires_new_conversation_inputs)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
          RETURNING id, slug, name, description, icon, api_base_url, api_key, enabled, sort_order, requires_new_conversation_inputs, created_at, updated_at
        `,
        [
          body.slug,
          metadata.name ?? body.name ?? body.slug,
          metadata.description ?? body.description ?? null,
          metadata.icon ?? body.icon ?? null,
          body.api_base_url,
          body.api_key,
          body.enabled ?? true,
          body.sort_order ?? 0,
          requiresNewConversationInputs,
        ]
      );
      return await reply.status(201).send(toAdminAppResponse(result.rows[0] as AdminAppRow));
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
    const body = (request.body ?? {}) as AppBody;

    const existing = await pool.query<AdminAppRow>('SELECT * FROM yiai_apps WHERE id = $1', [params.id]);
    const app = existing.rows.at(0);
    if (!app) {
      return reply.status(404).send({ error: '应用不存在或无权访问' });
    }

    let metadata;
    try {
      metadata = await fetchAppMetadata(pool, app.slug);
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
    addField('icon', metadata.icon ?? app.icon);
    if (body.requires_new_conversation_inputs !== undefined) {
      addField('requires_new_conversation_inputs', body.requires_new_conversation_inputs);
    }

    fields.push('updated_at = NOW()');
    values.push(params.id);
    const result = await pool.query(
      `UPDATE yiai_apps SET ${fields.join(', ')} WHERE id = $${String(values.length)} RETURNING id, slug, name, description, icon, api_base_url, api_key, enabled, sort_order, requires_new_conversation_inputs, created_at, updated_at`,
      values
    );

    return toAdminAppResponse(result.rows[0] as AdminAppRow);
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
    if (body.icon !== undefined) addField('icon', body.icon);
    if (body.api_base_url !== undefined) addField('api_base_url', body.api_base_url);
    if (body.enabled !== undefined) addField('enabled', body.enabled);
    if (body.sort_order !== undefined) addField('sort_order', body.sort_order);
    if (body.requires_new_conversation_inputs !== undefined) addField('requires_new_conversation_inputs', body.requires_new_conversation_inputs);
    if (isNonEmptyString(body.api_key)) addField('api_key', body.api_key);

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
      if (body.name === undefined) addField('name', metadata.name ?? app.name);
      if (body.description === undefined) addField('description', metadata.description ?? app.description);
      if (body.icon === undefined) addField('icon', metadata.icon ?? app.icon);
    }

    if (fields.length === 0) {
      return reply.status(400).send({ error: '没有需要更新的字段' });
    }

    fields.push('updated_at = NOW()');
    values.push(params.id);
    const result = await pool.query(
      `UPDATE yiai_apps SET ${fields.join(', ')} WHERE id = $${String(values.length)} RETURNING id, slug, name, description, icon, api_base_url, api_key, enabled, sort_order, requires_new_conversation_inputs, created_at, updated_at`,
      values
    );

    return toAdminAppResponse(result.rows[0] as AdminAppRow);
  });
}
