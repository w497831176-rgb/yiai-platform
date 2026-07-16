import type { Pool, PoolClient } from 'pg';
import type {
  YiaiApp,
  YiaiConversation,
  YiaiMessage,
  UserInputFormField,
  UserInputFormType,
  ChatRequest,
} from '@yiai/shared';

interface DbApp extends YiaiApp {
  api_base_url: string;
  api_key: string;
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
}

interface YiaiSiteResponse {
  title?: string;
  icon?: string;
  description?: string;
  site_info?: {
    title?: string;
    icon?: string;
    description?: string;
  };
}

interface YiaiParametersResponse {
  opening_statement?: string;
  suggested_questions?: string[];
  user_input_form?: unknown;
}

export interface AppMetadata {
  name: string | null;
  description: string | null;
  icon: string | null;
  user_input_form: UserInputFormField[] | null;
}

interface UpstreamAppMetadata extends AppMetadata {
  opening_statement: string | null;
  suggested_questions: string[] | null;
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

export async function findAppBySlug(pool: Pool, slug: string): Promise<DbApp | undefined> {
  const result = await pool.query<DbApp>('SELECT * FROM yiai_apps WHERE slug = $1 AND enabled = true', [slug]);
  return result.rows.at(0);
}

export async function listEnabledApps(pool: Pool): Promise<YiaiApp[]> {
  const result = await pool.query<YiaiApp>(
    `SELECT id, slug, name, description, icon, sort_order, requires_new_conversation_inputs, created_at, updated_at
     FROM yiai_apps
     WHERE enabled = true
     ORDER BY sort_order ASC, created_at ASC`
  );
  return result.rows;
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

export interface AppBootstrapResult {
  app: YiaiApp;
  opening_statement: string | null;
  suggested_questions: string[] | null;
  user_input_form: UserInputFormField[] | null;
}

function pickSiteInfo(site: YiaiSiteResponse): { title?: string; description?: string; icon?: string } {
  return site.site_info ?? site;
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

  const icon: string | null =
    (typeof info.icon === 'string' && info.icon.trim() !== '' ? info.icon : null) ??
    (typeof siteInfo.icon === 'string' && siteInfo.icon.trim() !== '' ? siteInfo.icon : null) ??
    null;

  return {
    name,
    description,
    icon,
    user_input_form: normalizeUserInputForm(parameters.user_input_form),
    opening_statement: parameters.opening_statement ?? null,
    suggested_questions: parameters.suggested_questions ?? null,
  };
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
    user_input_form: metadata.user_input_form,
  };
}

export async function bootstrapApp(pool: Pool, slug: string): Promise<AppBootstrapResult> {
  const app = await findAppBySlug(pool, slug);
  if (!app) {
    throw new YiaiAppNotFoundError(slug);
  }

  const metadata = await fetchUpstreamAppMetadata(app.api_base_url, app.api_key);

  return {
    app: {
      id: app.id,
      slug: app.slug,
      name: app.name || metadata.name || slug,
      description: app.description ?? metadata.description ?? null,
      icon: app.icon ?? metadata.icon ?? null,
      sort_order: app.sort_order,
      requires_new_conversation_inputs: app.requires_new_conversation_inputs,
      created_at: app.created_at,
      updated_at: app.updated_at,
    },
    opening_statement: metadata.opening_statement,
    suggested_questions: metadata.suggested_questions,
    user_input_form: metadata.user_input_form,
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

  const upstreamBody = {
    query: request.query,
    inputs: request.inputs ?? {},
    response_mode: 'streaming',
    conversation_id: request.conversation_id,
    user: upstreamUserId,
  };

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

export function toSafeApp(app: DbApp | YiaiApp): YiaiApp {
  return {
    id: app.id,
    slug: app.slug,
    name: app.name,
    description: app.description,
    icon: app.icon,
    sort_order: app.sort_order,
    requires_new_conversation_inputs: app.requires_new_conversation_inputs,
    created_at: app.created_at,
    updated_at: app.updated_at,
  };
}
