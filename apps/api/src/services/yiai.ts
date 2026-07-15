import type { Pool } from 'pg';
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
  opening_statement?: string;
  suggested_questions?: string[];
}

interface YiaiParametersResponse {
  user_input_form?: unknown;
}

function normalizeUserInputForm(raw: unknown): UserInputFormField[] | null {
  if (!Array.isArray(raw)) {
    return null;
  }

  const normalized: UserInputFormField[] = [];

  for (const item of raw) {
    if (item && typeof item === 'object') {
      if ('type' in item && typeof (item as Record<string, unknown>).type === 'string') {
        normalized.push(item as UserInputFormField);
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
            options: Array.isArray(cfg.options) ? (cfg.options as UserInputFormField['options']) : undefined,
          });
        }
      }
    }
  }

  return normalized.length > 0 ? normalized : null;
}

export class YiaiAppNotFoundError extends Error {
  constructor(slug: string) {
    super(`App not found: ${slug}`);
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
  const response = await fetch(url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
  });

  if (!response.ok) {
    throw new YiaiUpstreamError(`YIAI API error: ${String(response.status)} ${response.statusText}`);
  }

  return (await response.json()) as T;
}

export interface AppBootstrapResult {
  app: YiaiApp;
  opening_statement: string | null;
  suggested_questions: string[] | null;
  user_input_form: UserInputFormField[] | null;
}

export async function bootstrapApp(pool: Pool, slug: string): Promise<AppBootstrapResult> {
  const app = await findAppBySlug(pool, slug);
  if (!app) {
    throw new YiaiAppNotFoundError(slug);
  }

  const baseUrl = app.api_base_url.replace(/\/$/, '');

  const [info, parameters] = await Promise.all([
    yiaiGet<YiaiInfoResponse>(`${baseUrl}/info`, app.api_key),
    yiaiGet<YiaiParametersResponse>(`${baseUrl}/parameters`, app.api_key),
  ]);

  return {
    app: {
      id: app.id,
      slug: app.slug,
      name: app.name,
      description: app.description,
      icon: app.icon,
      sort_order: app.sort_order,
      requires_new_conversation_inputs: app.requires_new_conversation_inputs,
      created_at: app.created_at,
      updated_at: app.updated_at,
    },
    opening_statement: info.opening_statement ?? null,
    suggested_questions: info.suggested_questions ?? null,
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

export async function recordUsage(pool: Pool, payload: UsageRecordPayload): Promise<void> {
  await pool.query(
    `INSERT INTO yiai_usage_records
     (user_id, app_id, conversation_id, message_id, task_id, total_tokens)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [payload.userId, payload.appId, payload.conversationId, payload.messageId, payload.taskId, payload.totalTokens]
  );
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
