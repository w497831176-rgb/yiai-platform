import type { Pool, PoolClient } from 'pg';
import type {
  YiaiApp,
  YiaiConversation,
  YiaiMessage,
  UserInputFormField,
  UserInputFormType,
  ChatRequest,
  UploadedFile,
} from '@yiai/shared';
import { getLocalIconUrl } from './icon-cache.js';

interface DbApp extends YiaiApp {
  api_base_url: string;
  api_key: string;
  icon_cache_filename: string | null;
  icon_cache_content_type: string | null;
  icon_cached_at: Date | null;
}

interface YiaiApiResponse<T> {
  data?: T[];
  total?: number;
  page?: number;
  limit?: number;
}

interface YiaiInfoResponse {
  name?: string;
  description?: string;
  icon?: string;
  icon_type?: 'image' | 'emoji';
  icon_url?: string;
  icon_background?: string;
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

interface YiaiParametersResponse {
  opening_statement?: string;
  suggested_questions?: string[];
  user_input_form?: unknown;
}

interface IconFields {
  icon: string | null;
  icon_type: 'image' | 'emoji' | null;
  icon_url: string | null;
  icon_background: string | null;
}

export interface AppMetadata extends IconFields {
  name: string | null;
  description: string | null;
  user_input_form: UserInputFormField[] | null;
}

export interface UpstreamAppMetadata extends AppMetadata {
  requires_new_conversation_inputs: boolean;
  opening_statement: string | null;
  suggested_questions: string[] | null;
}

export interface AppBootstrapResult {
  app: YiaiApp;
  opening_statement: string | null;
  suggested_questions: string[] | null;
  user_input_form: UserInputFormField[] | null;
}

export interface UploadFileInput {
  buffer: Buffer;
  mimetype: string;
  filename: string;
}

export class YiaiAppNotFoundError extends Error {
  constructor(slug: string) {
    super(`应用不存在: ${slug}`);
    this.name = 'YiaiAppNotFoundError';
  }
}

export class YiaiUpstreamError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'YiaiUpstreamError';
  }
}

function getUpstreamUserId(userId: string): string {
  return `yiai-platform-${userId}`;
}

function isValidIconType(value: unknown): value is 'image' | 'emoji' {
  return value === 'image' || value === 'emoji';
}

function looksLikeUrl(value: string): boolean {
  return /^https?:\/\//.test(value);
}

function inferIconType(icon: string | null): 'image' | 'emoji' | null {
  if (!icon) {
    return null;
  }
  // 简单 Emoji 检测：仅由扩展象形文字字符组成
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

function pickSiteInfo(site: YiaiSiteResponse): YiaiSiteInfoResponse {
  return site.site_info ?? site;
}

function extractIconFields(info: YiaiInfoResponse, siteInfo: YiaiSiteInfoResponse): IconFields {
  const rawIcon =
    (typeof siteInfo.icon === 'string' && siteInfo.icon.trim() !== '' ? siteInfo.icon : null) ??
    (typeof info.icon === 'string' && info.icon.trim() !== '' ? info.icon : null) ??
    null;

  const icon_type = resolveIconType(rawIcon, siteInfo.icon_type ?? info.icon_type);

  let icon_url =
    (typeof siteInfo.icon_url === 'string' && siteInfo.icon_url.trim() !== '' ? siteInfo.icon_url : null) ??
    (typeof info.icon_url === 'string' && info.icon_url.trim() !== '' ? info.icon_url : null) ??
    null;
  const icon_background =
    (typeof siteInfo.icon_background === 'string' && siteInfo.icon_background.trim() !== ''
      ? siteInfo.icon_background
      : null) ??
    (typeof info.icon_background === 'string' && info.icon_background.trim() !== '' ? info.icon_background : null) ??
    null;

  const icon = rawIcon;
  if (icon_type === 'image') {
    if (!icon_url && rawIcon && looksLikeUrl(rawIcon)) {
      icon_url = rawIcon;
    }
  }

  return {
    icon,
    icon_type,
    icon_url,
    icon_background,
  };
}

function normalizeOptions(options: unknown): UserInputFormField['options'] {
  if (!Array.isArray(options)) {
    return undefined;
  }

  const normalized: NonNullable<UserInputFormField['options']> = [];

  for (const option of options) {
    if (typeof option === 'string') {
      normalized.push({ label: option, value: option });
    } else if (option && typeof option === 'object') {
      const raw = option as Record<string, unknown>;
      const label = typeof raw.label === 'string' ? raw.label : undefined;
      const value = typeof raw.value === 'string' ? raw.value : undefined;
      if (label !== undefined && value !== undefined) {
        normalized.push({ label, value });
      }
    }
  }

  return normalized.length > 0 ? normalized : undefined;
}

function normalizeUserInputForm(raw: unknown): UserInputFormField[] | null {
  if (!Array.isArray(raw)) {
    return null;
  }

  const normalized: UserInputFormField[] = [];

  for (const item of raw) {
    if (item && typeof item === 'object') {
      if ('type' in item && typeof (item as Record<string, unknown>).type === 'string') {
        const field = item as UserInputFormField;
        normalized.push({
          ...field,
          options: normalizeOptions(field.options),
        });
        continue;
      }

      const keys = Object.keys(item as Record<string, unknown>);
      if (keys.length === 1) {
        const type = keys[0] as UserInputFormType;
        const config = (item as Record<string, unknown>)[type];
        if (config && typeof config === 'object') {
          const cfg = config as Record<string, unknown>;
          normalized.push({
            type,
            label: typeof cfg.label === 'string' ? cfg.label : '',
            variable: typeof cfg.variable === 'string' ? cfg.variable : '',
            required: cfg.required === true,
            default: typeof cfg.default === 'string' ? cfg.default : undefined,
            options: normalizeOptions(cfg.options),
          });
        }
      }
    }
  }

  return normalized.length > 0 ? normalized : null;
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
    throw new YiaiUpstreamError(`YIAI 接口请求失败: ${err instanceof Error ? err.message : '未知错误'}`);
  }

  if (!response.ok) {
    throw new YiaiUpstreamError(`YIAI 接口返回错误: ${String(response.status)} ${response.statusText}`);
  }

  return (await response.json()) as T;
}

async function fetchUpstreamAppMetadata(baseUrl: string, apiKey: string): Promise<UpstreamAppMetadata> {
  const normalizedBaseUrl = baseUrl.replace(/\/$/, '');

  const [info, site, parameters] = await Promise.all([
    yiaiGet<YiaiInfoResponse>(`${normalizedBaseUrl}/info`, apiKey),
    yiaiGet<YiaiSiteResponse>(`${normalizedBaseUrl}/site`, apiKey),
    yiaiGet<YiaiParametersResponse>(`${normalizedBaseUrl}/parameters`, apiKey),
  ]);

  const siteInfo = pickSiteInfo(site);

  const name: string | null =
    (typeof siteInfo.title === 'string' && siteInfo.title.trim() !== '' ? siteInfo.title : null) ??
    (typeof info.name === 'string' && info.name.trim() !== '' ? info.name : null);

  const description: string | null =
    (typeof siteInfo.description === 'string' && siteInfo.description.trim() !== '' ? siteInfo.description : null) ??
    (typeof info.description === 'string' && info.description.trim() !== '' ? info.description : null) ??
    null;

  const iconFields = extractIconFields(info, siteInfo);
  const user_input_form = normalizeUserInputForm(parameters.user_input_form);

  return {
    name,
    description,
    ...iconFields,
    user_input_form,
    requires_new_conversation_inputs: (user_input_form ?? []).length > 0,
    opening_statement: parameters.opening_statement ?? null,
    suggested_questions: parameters.suggested_questions ?? null,
  };
}

export async function syncAppMetadata(
  poolOrBaseUrl: Pool | string,
  slugOrApiKey: string
): Promise<UpstreamAppMetadata> {
  let baseUrl: string;
  let apiKey: string;

  if (typeof poolOrBaseUrl === 'string') {
    baseUrl = poolOrBaseUrl;
    apiKey = slugOrApiKey;
  } else {
    const result = await poolOrBaseUrl.query<DbApp>('SELECT * FROM yiai_apps WHERE slug = $1', [slugOrApiKey]);
    const app = result.rows.at(0);
    if (!app) {
      throw new YiaiAppNotFoundError(slugOrApiKey);
    }
    baseUrl = app.api_base_url;
    apiKey = app.api_key;
  }

  return fetchUpstreamAppMetadata(baseUrl, apiKey);
}

export async function findAppBySlug(pool: Pool, slug: string): Promise<DbApp | undefined> {
  const result = await pool.query<DbApp>('SELECT * FROM yiai_apps WHERE slug = $1 AND enabled = true', [slug]);
  return result.rows.at(0);
}

export async function listEnabledApps(pool: Pool): Promise<YiaiApp[]> {
  const result = await pool.query<DbApp>(
    `SELECT id, slug, name, description, icon, icon_type, icon_background, sort_order,
            requires_new_conversation_inputs, created_at, updated_at,
            icon_cache_filename, icon_cached_at
     FROM yiai_apps
     WHERE enabled = true
     ORDER BY sort_order ASC, created_at ASC`
  );

  return result.rows.map((row) => toSafeApp(row));
}

export async function fetchAppMetadata(
  poolOrBaseUrl: Pool | string,
  slugOrApiKey: string
): Promise<AppMetadata> {
  let baseUrl: string;
  let apiKey: string;

  if (typeof poolOrBaseUrl === 'string') {
    baseUrl = poolOrBaseUrl;
    apiKey = slugOrApiKey;
  } else {
    const result = await poolOrBaseUrl.query<DbApp>('SELECT * FROM yiai_apps WHERE slug = $1', [slugOrApiKey]);
    const app = result.rows.at(0);
    if (!app) {
      throw new YiaiAppNotFoundError(slugOrApiKey);
    }
    baseUrl = app.api_base_url;
    apiKey = app.api_key;
  }

  const metadata = await fetchUpstreamAppMetadata(baseUrl, apiKey);
  return {
    name: metadata.name,
    description: metadata.description,
    icon: metadata.icon,
    icon_type: metadata.icon_type,
    icon_url: metadata.icon_url,
    icon_background: metadata.icon_background,
    user_input_form: metadata.user_input_form,
  };
}

export async function bootstrapApp(pool: Pool, slug: string): Promise<AppBootstrapResult> {
  const app = await findAppBySlug(pool, slug);
  if (!app) {
    throw new YiaiAppNotFoundError(slug);
  }

  const baseUrl = app.api_base_url.replace(/\/$/, '');
  const parameters = await yiaiGet<YiaiParametersResponse>(`${baseUrl}/parameters`, app.api_key);
  const iconType = app.icon_type ?? inferIconType(app.icon);

  return {
    app: {
      id: app.id,
      slug: app.slug,
      name: app.name || slug,
      description: app.description ?? null,
      icon: iconType === 'image' ? null : app.icon,
      icon_type: iconType,
      icon_url: getLocalIconUrl(app),
      icon_background: app.icon_background,
      sort_order: app.sort_order,
      requires_new_conversation_inputs: app.requires_new_conversation_inputs,
      created_at: app.created_at,
      updated_at: app.updated_at,
    },
    opening_statement: parameters.opening_statement ?? null,
    suggested_questions: parameters.suggested_questions ?? null,
    user_input_form: normalizeUserInputForm(parameters.user_input_form),
  };
}

export async function listConversations(
  pool: Pool,
  slug: string,
  userId: string
): Promise<YiaiConversation[]> {
  const app = await findAppBySlug(pool, slug);
  if (!app) {
    throw new YiaiAppNotFoundError(slug);
  }

  const baseUrl = app.api_base_url.replace(/\/$/, '');
  const upstreamUserId = getUpstreamUserId(userId);
  const url = `${baseUrl}/conversations?user=${encodeURIComponent(upstreamUserId)}&limit=20&sort_by=-updated_at`;

  const response = await yiaiGet<YiaiApiResponse<YiaiConversation>>(url, app.api_key);
  return response.data ?? [];
}

export async function deleteConversation(
  pool: Pool,
  slug: string,
  userId: string,
  conversationId: string
): Promise<void> {
  const app = await findAppBySlug(pool, slug);
  if (!app) {
    throw new YiaiAppNotFoundError(slug);
  }

  const baseUrl = app.api_base_url.replace(/\/$/, '');
  const upstreamUserId = getUpstreamUserId(userId);
  const url = `${baseUrl}/conversations/${encodeURIComponent(conversationId)}?user=${encodeURIComponent(upstreamUserId)}`;

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${app.api_key}`,
      },
    });
  } catch (err) {
    throw new YiaiUpstreamError(`删除会话失败：${err instanceof Error ? err.message : '未知错误'}`);
  }

  if (!response.ok) {
    throw new YiaiUpstreamError(`删除会话失败：上游返回 ${String(response.status)} ${response.statusText}`);
  }
}

export async function listMessages(
  pool: Pool,
  slug: string,
  userId: string,
  conversationId: string
): Promise<YiaiMessage[]> {
  const app = await findAppBySlug(pool, slug);
  if (!app) {
    throw new YiaiAppNotFoundError(slug);
  }

  const baseUrl = app.api_base_url.replace(/\/$/, '');
  const upstreamUserId = getUpstreamUserId(userId);
  const url = `${baseUrl}/messages?user=${encodeURIComponent(upstreamUserId)}&conversation_id=${encodeURIComponent(
    conversationId
  )}&limit=100`;

  const response = await yiaiGet<YiaiApiResponse<YiaiMessage>>(url, app.api_key);
  const messages = response.data ?? [];

  const usageResult = await pool.query<{ message_id: string; total_tokens: number }>(
    `SELECT message_id, total_tokens
     FROM yiai_usage_records
     WHERE user_id = $1 AND conversation_id = $2`,
    [userId, conversationId]
  );
  const usageMap = new Map(usageResult.rows.map((row) => [row.message_id, row.total_tokens]));

  for (const message of messages) {
    const recorded = usageMap.get(message.id);
    if (recorded !== undefined && message.metadata?.usage?.total_tokens === undefined) {
      message.metadata = {
        ...(message.metadata ?? {}),
        usage: {
          ...(message.metadata?.usage ?? {}),
          total_tokens: recorded,
        },
      };
    }
  }

  // YIAI returns newest first; frontend needs oldest first
  return messages.slice().sort((a, b) => a.created_at - b.created_at);
}

export async function chatUpstream(
  pool: Pool,
  slug: string,
  userId: string,
  request: ChatRequest
): Promise<Response> {
  const app = await findAppBySlug(pool, slug);
  if (!app) {
    throw new YiaiAppNotFoundError(slug);
  }

  const baseUrl = app.api_base_url.replace(/\/$/, '');
  const upstreamUserId = getUpstreamUserId(userId);

  const upstreamBody: Record<string, unknown> = {
    query: request.query,
    inputs: request.inputs ?? {},
    response_mode: 'streaming',
    conversation_id: request.conversation_id,
    user: upstreamUserId,
  };

  if (Array.isArray(request.files) && request.files.length > 0) {
    upstreamBody.files = request.files;
  }

  return fetch(`${baseUrl}/chat-messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${app.api_key}`,
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    },
    body: JSON.stringify(upstreamBody),
  });
}

export async function uploadFileToUpstream(
  pool: Pool,
  slug: string,
  userId: string,
  file: UploadFileInput
): Promise<UploadedFile> {
  const app = await findAppBySlug(pool, slug);
  if (!app) {
    throw new YiaiAppNotFoundError(slug);
  }

  const baseUrl = app.api_base_url.replace(/\/$/, '');
  const upstreamUserId = getUpstreamUserId(userId);
  const url = `${baseUrl}/files?user=${encodeURIComponent(upstreamUserId)}`;

  const formData = new FormData();
  const fileBytes = new Uint8Array(file.buffer);
  formData.append('file', new Blob([fileBytes], { type: file.mimetype }), file.filename);

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${app.api_key}`,
      },
      body: formData,
    });
  } catch (err) {
    throw new YiaiUpstreamError(`文件上传失败：${err instanceof Error ? err.message : '未知错误'}`);
  }

  if (!response.ok) {
    throw new YiaiUpstreamError(`文件上传失败：上游返回 ${String(response.status)} ${response.statusText}`);
  }

  const data = (await response.json()) as Record<string, unknown>;
  const id = typeof data.id === 'string' ? data.id : '';
  const urlField = typeof data.url === 'string' ? data.url : '';
  const name = typeof data.name === 'string' ? data.name : undefined;

  return {
    id,
    type: 'image',
    url: urlField,
    ...(name !== undefined ? { name } : {}),
  };
}

export interface UsageRecordPayload {
  userId: string;
  appId: string;
  conversationId?: string;
  messageId?: string;
  taskId?: string;
  totalTokens: number;
}

export async function recordUsage(client: Pool | PoolClient, payload: UsageRecordPayload): Promise<string> {
  const result = await client.query<{ id: string }>(
    `INSERT INTO yiai_usage_records
     (user_id, app_id, conversation_id, message_id, task_id, total_tokens)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id`,
    [payload.userId, payload.appId, payload.conversationId, payload.messageId, payload.taskId, payload.totalTokens]
  );
  const row = result.rows.at(0);
  if (!row) {
    throw new Error('记录用量失败');
  }
  return row.id;
}

export function toSafeApp(
  app: Omit<YiaiApp, 'icon_url'> & {
    icon_url?: string | null;
    icon_cache_filename?: string | null;
    icon_cached_at?: Date | string | null;
  },
  iconUrl: string | null = null
): YiaiApp {
  const iconType = app.icon_type ?? inferIconType(app.icon);
  const resolvedIconUrl = iconUrl ?? getLocalIconUrl(app);
  return {
    id: app.id,
    slug: app.slug,
    name: app.name,
    description: app.description,
    icon: iconType === 'image' ? null : app.icon,
    icon_type: iconType,
    icon_url: iconType === 'image' ? resolvedIconUrl : null,
    icon_background: app.icon_background,
    sort_order: app.sort_order,
    requires_new_conversation_inputs: app.requires_new_conversation_inputs,
    created_at: app.created_at,
    updated_at: app.updated_at,
  };
}

export function normalizeYiaiTimestamp(value: unknown): number | null {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0) {
      return null;
    }
    // 10 位秒 -> 毫秒；13 位毫秒保持
    if (value < 1_000_000_000_000) {
      return value * 1000;
    }
    return value;
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '') {
      return null;
    }
    const parsed = Number(trimmed);
    if (!Number.isNaN(parsed) && parsed > 0) {
      if (parsed < 1_000_000_000_000) {
        return parsed * 1000;
      }
      return parsed;
    }
    const date = new Date(trimmed);
    if (!Number.isNaN(date.getTime())) {
      return date.getTime();
    }
  }

  return null;
}
