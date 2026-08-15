import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { Pool } from 'pg';
import type { UserInputFormField, UserInputFormType, YiaiAppType } from '@yiai/shared';
import { sortAppsByTagAndName } from '../services/app-order.js';
import { authenticate } from '../auth/decorator.js';
import { hashPassword } from '../auth/password.js';
import {
  getAdminLedgerEntries,
  getAdminUsageReplyTarget,
  getAllUsageLedgerEntries,
  getAllUserAccounts,
  rechargeTokens,
} from '../services/token-account.js';
import {
  getAdminUsageReply,
  syncAppMetadata,
  toSafeApp,
  YiaiUpstreamError,
  type UpstreamAppMetadata,
} from '../services/yiai.js';
import { cacheImageIconUrl, getLocalIconUrl, refreshAppIconCache } from '../services/icon-cache.js';

interface AdminParams {
  userId: string;
  id: string;
}

interface AdminUsageQuery {
  page?: string;
  page_size?: string;
}

interface RechargeBody {
  amount: number;
  note?: string;
}

interface ResetPasswordBody {
  newPassword?: string;
}

interface CreateAppBody {
  slug?: string;
  app_type?: YiaiAppType;
  api_base_url?: string;
  api_key?: string;
  enabled?: boolean;
  supports_images?: boolean;
  agent_input_form?: unknown;
}

interface UpdateAppSettingsBody {
  enabled?: boolean;
  name?: string;
  description?: string;
  icon?: string;
  tags?: string[];
  supports_images?: boolean;
  token_multiplier?: number;
  agent_input_form?: unknown;
}

interface UpdateAppConnectionBody {
  api_base_url?: string;
  api_key?: string;
}

interface AdminAppRow {
  id: string;
  slug: string;
  app_type: YiaiAppType;
  name: string;
  description: string | null;
  icon: string | null;
  icon_type: 'image' | 'emoji' | null;
  icon_background: string | null;
  tags: string[];
  icon_source: 'yiai' | 'platform';
  api_base_url: string;
  api_key: string;
  enabled: boolean;
  supports_images: boolean;
  token_multiplier: number;
  sort_order: number;
  requires_new_conversation_inputs: boolean;
  agent_input_form: UserInputFormField[];
  created_at: string;
  updated_at: string;
  icon_cache_filename: string | null;
  icon_cache_content_type: string | null;
  icon_cached_at: Date | null;
}

interface AdminUserAccount {
  id: string;
  username: string;
  role: string;
  created_at: string;
  gift_tokens: number;
  recharge_tokens: number;
}

const ADMIN_APP_COLUMNS = `id, slug, name, description, icon, icon_type, icon_background,
  api_base_url, api_key, enabled, supports_images, token_multiplier, sort_order, app_type, requires_new_conversation_inputs, agent_input_form,
  created_at, updated_at, icon_cache_filename, icon_cache_content_type, icon_cached_at, tags, icon_source`;

const MAX_TOKEN_MULTIPLIER = 1_000_000;

function assertAdmin(request: FastifyRequest, reply: FastifyReply): boolean {
  const user = request.user;
  if (!user) {
    void reply.status(401).send({ error: '请先登录' });
    return false;
  }
  if (user.role !== 'admin') {
    void reply.status(403).send({ error: '无权限' });
    return false;
  }
  return true;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

function isValidTokenMultiplier(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isInteger(value)
    && value >= 1
    && value <= MAX_TOKEN_MULTIPLIER;
}

function normalizeBaseUrl(value: unknown): string | null {
  if (!isNonEmptyString(value)) {
    return null;
  }

  const normalized = value.trim().replace(/\/+$/, '');
  try {
    const parsed = new URL(normalized);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return null;
    }
  } catch {
    return null;
  }
  return normalized;
}

function normalizeTags(value: unknown): string[] | null {
  if (!Array.isArray(value)) {
    return null;
  }

  const tags = value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter((item) => item !== '');
  const unique = [...new Set(tags)];
  if (unique.length > 10 || unique.some((tag) => tag.length > 20)) {
    return null;
  }
  return unique;
}

function normalizeAppType(value: unknown): YiaiAppType | null {
  if (value === undefined) {
    return 'chatflow';
  }
  return value === 'chatflow' || value === 'agent' ? value : null;
}

function normalizeAgentInputForm(value: unknown): UserInputFormField[] | null {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value) || value.length > 20) {
    return null;
  }

  const allowedTypes: UserInputFormType[] = ['text-input', 'paragraph', 'select'];
  const variables = new Set<string>();
  const fields: UserInputFormField[] = [];

  for (const item of value) {
    if (!item || typeof item !== 'object') return null;
    const raw = item as Record<string, unknown>;
    const type = raw.type;
    const label = raw.label;
    const variable = raw.variable;
    if (
      typeof type !== 'string' ||
      !allowedTypes.includes(type as UserInputFormType) ||
      typeof label !== 'string' ||
      label.trim() === '' ||
      label.length > 100 ||
      typeof variable !== 'string' ||
      !/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(variable) ||
      typeof raw.required !== 'boolean' ||
      variables.has(variable)
    ) {
      return null;
    }
    variables.add(variable);

    const field: UserInputFormField = {
      type: type as UserInputFormType,
      label: label.trim(),
      variable,
      required: raw.required,
    };
    if (raw.default !== undefined) {
      if (typeof raw.default !== 'string' || raw.default.length > 1000) return null;
      field.default = raw.default;
    }
    if (raw.options !== undefined) {
      if (!Array.isArray(raw.options) || type !== 'select' || raw.options.length === 0 || raw.options.length > 100) return null;
      const options = raw.options.map((option) => {
        if (!option || typeof option !== 'object') return null;
        const item = option as Record<string, unknown>;
        if (
          typeof item.label !== 'string' ||
          item.label.trim() === '' ||
          typeof item.value !== 'string' ||
          item.value.trim() === ''
        ) {
          return null;
        }
        return { label: item.label.trim(), value: item.value.trim() };
      });
      if (options.some((option) => option === null)) return null;
      field.options = options as NonNullable<UserInputFormField['options']>;
    }
    fields.push(field);
  }

  return fields;
}

function parsePlatformIcon(value: unknown):
  | { icon: string; iconType: 'emoji' | 'image'; imageUrl?: string }
  | undefined
  | null {
  if (value === undefined) {
    return undefined;
  }
  if (!isNonEmptyString(value)) {
    return null;
  }

  const icon = value.trim();
  if (/^https?:\/\//.test(icon)) {
    try {
      const parsed = new URL(icon);
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
        return { icon, iconType: 'image', imageUrl: icon };
      }
    } catch {
      return null;
    }
  }

  if (/^\p{Extended_Pictographic}+$/u.test(icon)) {
    return { icon, iconType: 'emoji' };
  }
  return null;
}

function extractStoredIconFields(metadata: UpstreamAppMetadata) {
  return {
    icon: metadata.icon,
    icon_type: metadata.icon_type,
    icon_background: metadata.icon_background,
  };
}

function maskApiKey(apiKey: string): string | null {
  if (apiKey === '') return null;
  if (apiKey.length <= 10) return `${apiKey.slice(0, 3)}…${apiKey.slice(-2)}`;
  return `${apiKey.slice(0, 6)}…${apiKey.slice(-4)}`;
}

function toAdminAppResponse(row: AdminAppRow, duplicateOfSlug: string | null = null): Record<string, unknown> {
  return {
    ...toSafeApp(row, getLocalIconUrl(row)),
    api_base_url: row.api_base_url,
    api_key_configured: row.api_key !== '',
    api_key_preview: maskApiKey(row.api_key),
    enabled: row.enabled,
    token_multiplier: row.token_multiplier,
    app_type: row.app_type,
    agent_input_form: row.app_type === 'agent' ? row.agent_input_form : [],
    connection_duplicate_of_slug: duplicateOfSlug,
  };
}

function getDuplicatePrimary(rows: AdminAppRow[], row: AdminAppRow): AdminAppRow | undefined {
  const sameConnection = rows
    .filter((candidate) => candidate.api_base_url === row.api_base_url && candidate.api_key === row.api_key)
    .sort((a, b) => Number(b.enabled) - Number(a.enabled) || a.sort_order - b.sort_order || a.id.localeCompare(b.id));
  return sameConnection[0]?.id === row.id ? undefined : sameConnection[0];
}

async function getAppById(pool: Pool, id: string): Promise<AdminAppRow | undefined> {
  const result = await pool.query<AdminAppRow>(`SELECT ${ADMIN_APP_COLUMNS} FROM yiai_apps WHERE id = $1`, [id]);
  return result.rows.at(0);
}

async function findConnectionDuplicate(
  pool: Pool,
  apiBaseUrl: string,
  apiKey: string,
  excludingId?: string
): Promise<{ id: string; slug: string } | undefined> {
  const result = await pool.query<{ id: string; slug: string }>(
    `SELECT id, slug
     FROM yiai_apps
     WHERE api_base_url = $1
       AND api_key = $2
       ${excludingId ? 'AND id <> $3' : ''}
     ORDER BY enabled DESC, sort_order ASC, created_at ASC
     LIMIT 1`,
    excludingId ? [apiBaseUrl, apiKey, excludingId] : [apiBaseUrl, apiKey]
  );
  return result.rows.at(0);
}

async function fetchMetadata(reply: FastifyReply, apiBaseUrl: string, apiKey: string): Promise<UpstreamAppMetadata | undefined> {
  try {
    return await syncAppMetadata(apiBaseUrl, apiKey);
  } catch (err) {
    if (err instanceof YiaiUpstreamError) {
      await reply.status(400).send({ error: `YIAI 连接验证失败：${err.message}` });
      return undefined;
    }
    throw err;
  }
}

async function updateMetadata(
  pool: Pool,
  app: AdminAppRow,
  metadata: UpstreamAppMetadata,
  connection?: { apiBaseUrl: string; apiKey: string }
): Promise<AdminAppRow> {
  const iconFields = extractStoredIconFields(metadata);
  const result = await pool.query<AdminAppRow>(
    `UPDATE yiai_apps
     SET name = $2,
         description = $3,
         icon = $4,
         icon_type = $5,
         icon_background = $6,
         requires_new_conversation_inputs = $7,
         tags = $8,
         icon_source = 'yiai',
         api_base_url = COALESCE($9, api_base_url),
         api_key = COALESCE($10, api_key),
         updated_at = NOW()
     WHERE id = $1
     RETURNING ${ADMIN_APP_COLUMNS}`,
    [
      app.id,
      metadata.name ?? app.name,
      metadata.description,
      iconFields.icon,
      iconFields.icon_type,
      iconFields.icon_background,
      app.app_type === 'agent' ? app.requires_new_conversation_inputs : metadata.requires_new_conversation_inputs,
      metadata.tags,
      connection?.apiBaseUrl ?? null,
      connection?.apiKey ?? null,
    ]
  );
  return result.rows[0];
}

async function refreshAndLoadApp(pool: Pool, app: AdminAppRow): Promise<AdminAppRow> {
  await refreshAppIconCache(pool, app);
  const refreshed = await getAppById(pool, app.id);
  if (!refreshed) {
    throw new Error('应用更新后不存在');
  }
  return refreshed;
}

export function adminRoutes(fastify: FastifyInstance, options: { pool: Pool }) {
  const { pool } = options;

  fastify.get('/admin/users', { preHandler: authenticate }, async (request, reply) => {
    if (!assertAdmin(request, reply)) return;
    const users: AdminUserAccount[] = await getAllUserAccounts(pool);
    return users.map((u: AdminUserAccount) => ({
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
    const entries = await getAdminLedgerEntries(pool, params.userId);
    return entries.map((entry) => ({
      id: entry.id,
      created_at: entry.created_at,
      entry_type: entry.entry_type,
      bucket: entry.bucket,
      delta_tokens: entry.delta_tokens,
      note: entry.note,
      username: entry.username,
      app_name: entry.app_name,
      ai_reply_available: entry.ai_reply_available,
    }));
  });

  fastify.get('/admin/usage-records', { preHandler: authenticate }, async (request, reply) => {
    if (!assertAdmin(request, reply)) return;
    const query = request.query as AdminUsageQuery;
    const page = Number(query.page ?? '1');
    const pageSize = Number(query.page_size ?? '50');
    if (!Number.isInteger(page) || page < 1 || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) {
      return reply.status(400).send({ error: '分页参数无效' });
    }
    return getAllUsageLedgerEntries(pool, page, pageSize);
  });

  fastify.get('/admin/usage-records/:id/ai-reply', { preHandler: authenticate }, async (request, reply) => {
    if (!assertAdmin(request, reply)) return;
    const params = request.params as AdminParams;
    const target = await getAdminUsageReplyTarget(pool, params.id);
    if (!target) {
      return reply.status(404).send({ error: '消耗记录不存在' });
    }
    if (target.entry_type !== 'usage' || target.delta_tokens >= 0) {
      return reply.status(400).send({ error: '这不是一条 Token 消耗记录' });
    }
    if (!target.usage_record_id || !target.api_base_url || !target.api_key) {
      return reply.status(410).send({ error: '关联应用已删除，AI 回复不可用' });
    }
    if (!target.conversation_id || !target.message_id) {
      return reply.status(410).send({ error: '该历史消耗缺少会话或消息关联，AI 回复不可用' });
    }

    try {
      const message = await getAdminUsageReply({
        apiBaseUrl: target.api_base_url,
        apiKey: target.api_key,
        userId: target.user_id,
        conversationId: target.conversation_id,
        messageId: target.message_id,
      });
      if (!message) {
        return await reply.status(404).send({ error: '上游历史中未找到这条 AI 回复' });
      }
      return {
        ledger_entry_id: target.id,
        username: target.username,
        app_name: target.app_name,
        created_at: target.created_at,
        answer: message.answer,
      };
    } catch (error) {
      if (error instanceof YiaiUpstreamError) {
        request.log.warn({ err: error, ledgerEntryId: target.id }, 'Unable to load admin usage AI reply');
        return reply.status(502).send({ error: '暂时无法读取上游 AI 回复，请稍后重试' });
      }
      throw error;
    }
  });

  fastify.post('/admin/users/:userId/recharge', { preHandler: authenticate }, async (request, reply) => {
    if (!assertAdmin(request, reply)) return;
    const admin = request.user;
    if (!admin) {
      return reply.status(401).send({ error: '请先登录' });
    }
    const params = request.params as AdminParams;
    const body = request.body as RechargeBody;

    if (!Number.isInteger(body.amount) || body.amount <= 0) {
      return reply.status(400).send({ error: '充值额度必须为正整数' });
    }

    const account = await rechargeTokens(pool, params.userId, body.amount, admin.id, body.note);
    return { gift_tokens: account.gift_tokens, recharge_tokens: account.recharge_tokens };
  });

  fastify.put('/admin/users/:userId/password', { preHandler: authenticate }, async (request, reply) => {
    if (!assertAdmin(request, reply)) return;
    const params = request.params as AdminParams;
    const body = request.body as ResetPasswordBody | undefined;

    if (typeof body?.newPassword !== 'string' || body.newPassword.length < 6) {
      return reply.status(400).send({ error: '新密码至少需要 6 位' });
    }

    const passwordHash = await hashPassword(body.newPassword);
    const result = await pool.query<{ id: string; username: string }>(
      'UPDATE users SET password_hash = $2, updated_at = NOW() WHERE id = $1 RETURNING id, username',
      [params.userId, passwordHash]
    );

    if (result.rowCount === 0) {
      return reply.status(404).send({ error: '用户不存在' });
    }

    return { id: result.rows[0].id, username: result.rows[0].username, password_changed: true };
  });

  fastify.get('/admin/apps', { preHandler: authenticate }, async (request, reply) => {
    if (!assertAdmin(request, reply)) return;
    const result = await pool.query<AdminAppRow>(`SELECT ${ADMIN_APP_COLUMNS} FROM yiai_apps`);
    const sortedApps = sortAppsByTagAndName(result.rows);
    return sortedApps.map((row) => toAdminAppResponse(row, getDuplicatePrimary(result.rows, row)?.slug ?? null));
  });

  fastify.post('/admin/apps', { preHandler: authenticate }, async (request, reply) => {
    if (!assertAdmin(request, reply)) return;
    const body = request.body as CreateAppBody;
    const slug = isNonEmptyString(body.slug) ? body.slug.trim() : '';
    const appType = normalizeAppType(body.app_type);
    const apiBaseUrl = normalizeBaseUrl(body.api_base_url);

    if (!/^[a-zA-Z0-9_-]+$/.test(slug)) {
      return reply.status(400).send({ error: '应用标识只能包含字母、数字、下划线和连字符' });
    }
    if (!apiBaseUrl) {
      return reply.status(400).send({ error: '请输入有效的 YIAI API Base URL' });
    }
    if (!appType) {
      return reply.status(400).send({ error: '应用类型只能是 Chatflow 或 Agent' });
    }
    if (!isNonEmptyString(body.api_key)) {
      return reply.status(400).send({ error: 'YIAI API Key 不能为空' });
    }
    if (body.supports_images !== undefined && typeof body.supports_images !== 'boolean') {
      return reply.status(400).send({ error: '是否支持图片格式错误' });
    }
    const duplicate = await findConnectionDuplicate(pool, apiBaseUrl, body.api_key);
    if (duplicate) {
      return reply.status(409).send({ error: `这套 YIAI 连接已经绑定到应用「${duplicate.slug}」，请编辑该应用，不要重复新增` });
    }

    const metadata = await fetchMetadata(reply, apiBaseUrl, body.api_key);
    if (!metadata) return;
    const agentInputForm = appType === 'agent' ? normalizeAgentInputForm(body.agent_input_form) : [];
    if (agentInputForm === null) {
      return reply.status(400).send({ error: 'Agent 新对话表单格式不正确' });
    }
    const iconFields = extractStoredIconFields(metadata);

    try {
      const result = await pool.query<AdminAppRow>(
        `INSERT INTO yiai_apps
          (slug, name, description, icon, icon_type, icon_background, tags, icon_source, api_base_url, api_key, enabled, supports_images, sort_order, app_type, requires_new_conversation_inputs, agent_input_form)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'yiai', $8, $9, $10, $11, $12, $13, $14, $15)
         RETURNING ${ADMIN_APP_COLUMNS}`,
        [
          slug,
          metadata.name ?? slug,
          metadata.description,
          iconFields.icon,
          iconFields.icon_type,
          iconFields.icon_background,
          metadata.tags,
          apiBaseUrl,
          body.api_key,
          body.enabled ?? true,
          body.supports_images ?? false,
          0,
          appType,
          appType === 'agent' ? agentInputForm.length > 0 : metadata.requires_new_conversation_inputs,
          JSON.stringify(agentInputForm),
        ]
      );
      const refreshed = await refreshAndLoadApp(pool, result.rows[0]);
      return await reply.status(201).send(toAdminAppResponse(refreshed));
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
    const app = await getAppById(pool, params.id);
    if (!app) {
      return reply.status(404).send({ error: '应用不存在' });
    }

    const metadata = await fetchMetadata(reply, app.api_base_url, app.api_key);
    if (!metadata) return;
    const updated = await updateMetadata(pool, app, metadata);
    const refreshed = await refreshAndLoadApp(pool, updated);
    return toAdminAppResponse(refreshed);
  });

  fastify.put('/admin/apps/:id/connection', { preHandler: authenticate }, async (request, reply) => {
    if (!assertAdmin(request, reply)) return;
    const params = request.params as AdminParams;
    const body = request.body as UpdateAppConnectionBody;
    const app = await getAppById(pool, params.id);
    if (!app) {
      return reply.status(404).send({ error: '应用不存在' });
    }

    const apiBaseUrl = normalizeBaseUrl(body.api_base_url);
    if (!apiBaseUrl) {
      return reply.status(400).send({ error: '请输入有效的 YIAI API Base URL' });
    }
    const apiKey = isNonEmptyString(body.api_key) ? body.api_key : app.api_key;
    const duplicate = await findConnectionDuplicate(pool, apiBaseUrl, apiKey, app.id);
    if (duplicate) {
      return reply.status(409).send({ error: `这套 YIAI 连接已经绑定到应用「${duplicate.slug}」，请编辑该应用，不要重复绑定` });
    }

    const metadata = await fetchMetadata(reply, apiBaseUrl, apiKey);
    if (!metadata) return;
    const updated = await updateMetadata(pool, app, metadata, { apiBaseUrl, apiKey });
    const refreshed = await refreshAndLoadApp(pool, updated);
    return toAdminAppResponse(refreshed);
  });

  fastify.patch('/admin/apps/:id', { preHandler: authenticate }, async (request, reply) => {
    if (!assertAdmin(request, reply)) return;
    const params = request.params as AdminParams;
    const body = request.body as UpdateAppSettingsBody;
    const app = await getAppById(pool, params.id);
    if (!app) {
      return reply.status(404).send({ error: '应用不存在' });
    }

    if (
      body.enabled === undefined &&
      body.name === undefined &&
      body.description === undefined &&
      body.icon === undefined &&
      body.tags === undefined &&
      body.supports_images === undefined &&
      body.token_multiplier === undefined &&
      body.agent_input_form === undefined
    ) {
      return reply.status(400).send({ error: '请至少修改一项平台设置' });
    }
    if (body.enabled !== undefined && typeof body.enabled !== 'boolean') {
      return reply.status(400).send({ error: '启用状态格式错误' });
    }
    if (body.supports_images !== undefined && typeof body.supports_images !== 'boolean') {
      return reply.status(400).send({ error: '是否支持图片格式错误' });
    }
    if (body.token_multiplier !== undefined && !isValidTokenMultiplier(body.token_multiplier)) {
      return reply.status(400).send({ error: 'Token 消耗倍率必须是 1 到 1,000,000 的整数' });
    }
    if (body.name !== undefined && !isNonEmptyString(body.name)) {
      return reply.status(400).send({ error: '应用名称不能为空' });
    }
    if (body.description !== undefined && typeof body.description !== 'string') {
      return reply.status(400).send({ error: '应用说明格式错误' });
    }
    const name = body.name === undefined ? undefined : body.name.trim();
    if (name !== undefined && (name === '' || name.length > 255)) {
      return reply.status(400).send({ error: '应用名称长度应为 1 至 255 个字符' });
    }
    const description = body.description === undefined ? undefined : body.description.trim();
    if (description !== undefined && description.length > 2000) {
      return reply.status(400).send({ error: '应用说明不能超过 2000 个字符' });
    }
    const tags = body.tags === undefined ? undefined : normalizeTags(body.tags);
    if (body.tags !== undefined && tags === null) {
      return reply.status(400).send({ error: '标签最多 10 个，单个标签最多 20 个字符' });
    }
    const iconUpdate = parsePlatformIcon(body.icon);
    if (body.icon !== undefined && iconUpdate === null) {
      return reply.status(400).send({ error: '图标仅支持 Emoji 或 http(s) 图片地址' });
    }
    const agentInputForm = body.agent_input_form === undefined ? undefined : normalizeAgentInputForm(body.agent_input_form);
    if (body.agent_input_form !== undefined && app.app_type !== 'agent') {
      return reply.status(400).send({ error: '只有 Agent 可以设置新对话表单' });
    }
    if (agentInputForm === null) {
      return reply.status(400).send({ error: 'Agent 新对话表单格式不正确' });
    }

    if (iconUpdate?.imageUrl) {
      const cached = await cacheImageIconUrl(pool, app, iconUpdate.imageUrl);
      if (!cached.success) {
        return reply.status(400).send({ error: '图片图标下载失败，未保存平台设置' });
      }
    }

    const setClauses = ['updated_at = NOW()'];
    const values: unknown[] = [app.id];
    const addValue = (column: string, value: unknown) => {
      values.push(value);
      setClauses.push(`${column} = $${String(values.length)}`);
    };

    if (body.enabled !== undefined) addValue('enabled', body.enabled);
    if (body.supports_images !== undefined) addValue('supports_images', body.supports_images);
    if (body.token_multiplier !== undefined) addValue('token_multiplier', body.token_multiplier);
    if (name !== undefined) addValue('name', name);
    if (description !== undefined) addValue('description', description);
    if (tags !== undefined) addValue('tags', tags);
    if (agentInputForm !== undefined) {
      addValue('agent_input_form', JSON.stringify(agentInputForm));
      addValue('requires_new_conversation_inputs', agentInputForm.length > 0);
    }
    if (iconUpdate) {
      addValue('icon', iconUpdate.icon);
      addValue('icon_type', iconUpdate.iconType);
      setClauses.push("icon_source = 'platform'");
      if (iconUpdate.iconType === 'emoji') {
        setClauses.push('icon_cache_filename = NULL', 'icon_cache_content_type = NULL', 'icon_cached_at = NULL');
      }
    }

    const result = await pool.query<AdminAppRow>(
      `UPDATE yiai_apps
       SET ${setClauses.join(', ')}
       WHERE id = $1
       RETURNING ${ADMIN_APP_COLUMNS}`,
      values
    );
    return toAdminAppResponse(result.rows[0]);
  });

  fastify.delete('/admin/apps/:id', { preHandler: authenticate }, async (request, reply) => {
    if (!assertAdmin(request, reply)) return;
    const params = request.params as AdminParams;
    const result = await pool.query<{ id: string; slug: string }>(
      'DELETE FROM yiai_apps WHERE id = $1 RETURNING id, slug',
      [params.id]
    );
    const deleted = result.rows.at(0);
    if (!deleted) {
      return reply.status(404).send({ error: '应用不存在' });
    }
    return { ...deleted, deleted: true };
  });
}
