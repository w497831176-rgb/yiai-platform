import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { Pool } from 'pg';
import { authenticate } from '../auth/decorator.js';
import { getAllUserAccounts, getLedgerEntries, rechargeTokens } from '../services/token-account.js';

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
}

interface AdminAppRow {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  icon: string | null;
  api_base_url: string;
  api_key_configured: boolean;
  enabled: boolean;
  sort_order: number;
  requires_new_conversation_inputs: boolean;
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

export function adminRoutes(fastify: FastifyInstance, options: { pool: Pool }) {
  const { pool } = options;

  fastify.get('/admin/users', { preHandler: authenticate }, async (request, reply) => {
    if (!assertAdmin(request, reply)) return;
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
      return reply.status(400).send({ error: 'amount 必须为正整数' });
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
      `SELECT id, slug, name, description, icon, api_base_url, enabled, sort_order,
              requires_new_conversation_inputs,
              CASE WHEN api_key IS NULL OR api_key = '' THEN false ELSE true END AS api_key_configured
       FROM yiai_apps
       ORDER BY sort_order, id`
    );
    return result.rows;
  });

  fastify.post('/admin/apps', { preHandler: authenticate }, async (request, reply) => {
    if (!assertAdmin(request, reply)) return;
    const body = request.body as AppBody;

    if (!body.slug || !body.name || !body.api_base_url) {
      return reply.status(400).send({ error: 'slug、name、api_base_url 不能为空' });
    }

    try {
      const result = await pool.query(
        `
          INSERT INTO yiai_apps (slug, name, description, icon, api_base_url, api_key, enabled, sort_order, requires_new_conversation_inputs)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
          RETURNING id, slug, name, description, icon, api_base_url, enabled, sort_order, requires_new_conversation_inputs
        `,
        [
          body.slug,
          body.name,
          body.description ?? null,
          body.icon ?? null,
          body.api_base_url,
          body.api_key ?? '',
          body.enabled ?? true,
          body.sort_order ?? 0,
          body.requires_new_conversation_inputs ?? false,
        ]
      );
      return await reply.status(201).send(result.rows[0]);
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === '23505') {
        return reply.status(409).send({ error: 'slug 已存在' });
      }
      throw error;
    }
  });

  fastify.patch('/admin/apps/:id', { preHandler: authenticate }, async (request, reply) => {
    if (!assertAdmin(request, reply)) return;
    const params = request.params as AdminParams;
    const body = request.body as AppBody;

    const fields: string[] = [];
    const values: unknown[] = [];
    let idx = 1;

    if (body.name !== undefined) { fields.push(`name = $${String(idx++)}`); values.push(body.name); }
    if (body.description !== undefined) { fields.push(`description = $${String(idx++)}`); values.push(body.description); }
    if (body.icon !== undefined) { fields.push(`icon = $${String(idx++)}`); values.push(body.icon); }
    if (body.api_base_url !== undefined) { fields.push(`api_base_url = $${String(idx++)}`); values.push(body.api_base_url); }
    if (body.enabled !== undefined) { fields.push(`enabled = $${String(idx++)}`); values.push(body.enabled); }
    if (body.sort_order !== undefined) { fields.push(`sort_order = $${String(idx++)}`); values.push(body.sort_order); }
    if (body.requires_new_conversation_inputs !== undefined) { fields.push(`requires_new_conversation_inputs = $${String(idx++)}`); values.push(body.requires_new_conversation_inputs); }
    if (body.api_key !== undefined && body.api_key !== '') { fields.push(`api_key = $${String(idx++)}`); values.push(body.api_key); }

    if (fields.length === 0) {
      return reply.status(400).send({ error: '没有要更新的字段' });
    }

    values.push(params.id);
    const result = await pool.query(
      `UPDATE yiai_apps SET ${fields.join(', ')}, updated_at = NOW() WHERE id = $${String(idx)} RETURNING id, slug, name, description, icon, api_base_url, enabled, sort_order, requires_new_conversation_inputs`,
      values
    );

    if (result.rowCount === 0) {
      return reply.status(404).send({ error: '应用不存在' });
    }

    return result.rows[0];
  });
}
