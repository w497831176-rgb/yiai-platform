import { useCallback, useEffect, useRef, useState } from 'react';
import './App.css';
import { MarkdownMessage } from './MarkdownMessage';
import { readSSEStream } from './sse';
import { startChatStream, type ChatRequestBody } from './chat';
import {
  stripThinkContent,
  normalizeYiaiTimestamp,
  formatShanghaiTime,
} from './utils/message';

interface User {
  id: string;
  username: string;
  role: 'user' | 'admin';
}

interface AuthResponse {
  token: string;
  user: User;
}

interface YiaiApp {
  id: string;
  slug: string;
  app_type: 'chatflow' | 'agent';
  name: string;
  description: string | null;
  icon: string | null;
  icon_type: 'emoji' | 'image' | null;
  icon_url: string | null;
  icon_background: string | null;
  tags?: string[];
  sort_order: number;
  requires_new_conversation_inputs: boolean;
}

interface UserInputFormOption {
  label: string;
  value: string;
}

interface UserInputFormField {
  type: 'text-input' | 'paragraph' | 'select';
  label: string;
  variable: string;
  required: boolean;
  default?: string;
  options?: UserInputFormOption[];
}

interface AppBootstrap {
  app: YiaiApp;
  opening_statement: string | null;
  suggested_questions: string[] | null;
  user_input_form: UserInputFormField[] | null;
}

interface YiaiConversation {
  id: string;
  name: string;
  inputs: Record<string, unknown>;
  status: string;
  updated_at: number;
  created_at: number;
}

interface YiaiMessageFile {
  type: string;
  url: string;
}

interface YiaiMessage {
  id: string;
  conversation_id: string;
  query: string;
  answer: string;
  message_files?: YiaiMessageFile[] | null;
  created_at: number;
  metadata?: {
    usage?: {
      total_tokens?: number;
    };
  };
}

interface ChatMessage {
  id?: string;
  role: 'user' | 'assistant';
  content: string;
  rawContent?: string;
  isPending?: boolean;
  files?: YiaiMessageFile[];
  usage?: number;
  createdAt?: number;
}

interface TokenAccount {
  gift_tokens: number;
  recharge_tokens: number;
  daily_gift_amount: number;
  gift_tokens_max: number;
  last_gift_date: string | null;
}

interface LedgerEntry {
  id: string;
  created_at: string;
  entry_type: 'daily_gift' | 'admin_recharge' | 'usage';
  bucket: 'gift' | 'recharge';
  delta_tokens: number;
  note: string | null;
}

interface AdminUser {
  id: string;
  username: string;
  role: string;
  gift_tokens: number;
  recharge_tokens: number;
  created_at: string;
}

interface AdminApp {
  id: string;
  slug: string;
  app_type: 'chatflow' | 'agent';
  name: string;
  description: string | null;
  icon: string | null;
  icon_type: 'emoji' | 'image' | null;
  icon_url: string | null;
  icon_background: string | null;
  tags?: string[];
  api_base_url: string;
  api_key_configured: boolean;
  api_key_preview?: string | null;
  enabled: boolean;
  sort_order: number;
  requires_new_conversation_inputs: boolean;
  agent_input_form: UserInputFormField[];
  connection_duplicate_of_slug?: string | null;
}

type View =
  | { type: 'login' }
  | { type: 'register' }
  | { type: 'profile' }
  | { type: 'hub' }
  | { type: 'chat'; slug: string }
  | { type: 'ledger' }
  | { type: 'admin' };

const TOKEN_KEY = 'yiai_token';

function formatMessageMeta(msg: ChatMessage): string {
  const parts: string[] = [];
  if (msg.usage !== undefined) {
    parts.push(`本次消耗：${msg.usage.toLocaleString()} Tokens`);
  }
  const createdAt = normalizeYiaiTimestamp(msg.createdAt);
  if (createdAt !== null) {
    parts.push(formatShanghaiTime(createdAt));
  }
  return parts.join(' · ');
}

async function copyMessageText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch {
    // LAN HTTP pages can lack Clipboard API permission; use the legacy fallback below.
  }

  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.select();
  // eslint-disable-next-line @typescript-eslint/no-deprecated -- fallback for browsers without Clipboard API permission.
  const copied = document.execCommand('copy');
  textarea.remove();
  if (!copied) {
    throw new Error('浏览器不支持复制');
  }
}

async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = localStorage.getItem(TOKEN_KEY);
  const baseHeaders: Record<string, string> = {};

  if (options.body !== undefined && options.body !== null && !(options.body instanceof FormData)) {
    baseHeaders['Content-Type'] = 'application/json';
  }

  if (options.headers) {
    const extraHeaders = options.headers as Record<string, string>;
    for (const key of Object.keys(extraHeaders)) {
      baseHeaders[key] = extraHeaders[key];
    }
  }

  if (token) {
    baseHeaders.Authorization = `Bearer ${token}`;
  }

  const response = await fetch(`/api${path}`, {
    ...options,
    headers: baseHeaders,
  });

  const responseText = await response.text();
  let data = {} as T & { error?: string };
  if (responseText) {
    try {
      data = JSON.parse(responseText) as T & { error?: string };
    } catch {
      if (!response.ok) {
        throw new Error(`请求失败（${String(response.status)}）`);
      }
    }
  }
  if (!response.ok) {
    throw new Error(data.error ?? '请求失败');
  }
  return data;
}

function LoginPage({ onLogin, onSwitch }: { onLogin: (res: AuthResponse) => void; onSwitch: () => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = (e: React.SyntheticEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    void (async () => {
      try {
        const res = await api<AuthResponse>('/auth/login', {
          method: 'POST',
          body: JSON.stringify({ username, password }),
        });
        onLogin(res);
      } catch (err) {
        setError(err instanceof Error ? err.message : '登录失败');
      } finally {
        setLoading(false);
      }
    })();
  };

  return (
    <div className="auth-page">
      <form className="auth-form" onSubmit={handleSubmit}>
        <h2>登录</h2>
        {error && <p className="error">{error}</p>}
        <label>
          用户名
          <input
            type="text"
            value={username}
            onChange={(e) => {
              setUsername(e.target.value);
            }}
            minLength={3}
            required
            autoComplete="username"
          />
        </label>
        <label>
          密码
          <input
            type="password"
            value={password}
            onChange={(e) => {
              setPassword(e.target.value);
            }}
            minLength={6}
            required
            autoComplete="current-password"
          />
        </label>
        <button type="submit" disabled={loading}>
          {loading ? '登录中...' : '登录'}
        </button>
        <p>
          还没有账号？{' '}
          <button type="button" className="link" onClick={onSwitch}>
            注册
          </button>
        </p>
      </form>
    </div>
  );
}

function RegisterPage({ onLogin, onSwitch }: { onLogin: (res: AuthResponse) => void; onSwitch: () => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const handleSubmit = (e: React.SyntheticEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError('');
    setSuccess('');

    if (password !== confirmPassword) {
      setError('两次输入的密码不一致');
      return;
    }

    setLoading(true);
    void (async () => {
      try {
        await api('/auth/register', {
          method: 'POST',
          body: JSON.stringify({ username, password }),
        });
        setSuccess('注册成功，正在登录…');
        const res = await api<AuthResponse>('/auth/login', {
          method: 'POST',
          body: JSON.stringify({ username, password }),
        });
        onLogin(res);
      } catch (err) {
        setError(err instanceof Error ? err.message : '注册失败');
      } finally {
        setLoading(false);
      }
    })();
  };

  return (
    <div className="auth-page">
      <form className="auth-form" onSubmit={handleSubmit}>
        <h2>注册</h2>
        {error && <p className="error">{error}</p>}
        {success && <p className="success">{success}</p>}
        <label>
          用户名
          <input
            type="text"
            value={username}
            onChange={(e) => {
              setUsername(e.target.value);
            }}
            minLength={3}
            required
            autoComplete="username"
          />
        </label>
        <label>
          密码
          <input
            type="password"
            value={password}
            onChange={(e) => {
              setPassword(e.target.value);
            }}
            minLength={6}
            required
            autoComplete="new-password"
          />
        </label>
        <label>
          确认密码
          <input
            type="password"
            value={confirmPassword}
            onChange={(e) => {
              setConfirmPassword(e.target.value);
            }}
            minLength={6}
            required
            autoComplete="new-password"
          />
        </label>
        <button type="submit" disabled={loading}>
          {loading ? '注册中...' : '注册'}
        </button>
        <p>
          已有账号？{' '}
          <button type="button" className="link" onClick={onSwitch}>
            登录
          </button>
        </p>
      </form>
    </div>
  );
}

function ProfilePage({
  user,
  onLogout,
  onBack,
}: {
  user: User;
  onLogout: () => void;
  onBack: () => void;
}) {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  const handleChangePassword = (e: React.SyntheticEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError('');
    setMessage('');
    setLoading(true);
    void (async () => {
      try {
        await api('/auth/change-password', {
          method: 'POST',
          body: JSON.stringify({ currentPassword, newPassword }),
        });
        setMessage('密码已修改，请重新登录。');
        setTimeout(() => {
          onLogout();
        }, 1500);
      } catch (err) {
        setError(err instanceof Error ? err.message : '修改密码失败');
      } finally {
        setLoading(false);
      }
    })();
  };

  const roleLabel = user.role === 'admin' ? '管理员' : '用户';

  return (
    <div className="profile-page">
      <header className="profile-header">
        <h1>YIAI Platform</h1>
        <div className="user-info">
          <button className="secondary" onClick={onBack}>
            返回
          </button>
          <span>
            {user.username} ({roleLabel})
          </span>
          <button onClick={onLogout}>退出登录</button>
        </div>
      </header>

      <main className="profile-main">
        <section className="change-password">
          <h3>修改密码</h3>
          {error && <p className="error">{error}</p>}
          {message && <p className="success">{message}</p>}
          <form onSubmit={handleChangePassword}>
            <label>
              当前密码
              <input
                type="password"
                value={currentPassword}
                onChange={(e) => {
                  setCurrentPassword(e.target.value);
                }}
                minLength={6}
                required
                autoComplete="current-password"
              />
            </label>
            <label>
              新密码
              <input
                type="password"
                value={newPassword}
                onChange={(e) => {
                  setNewPassword(e.target.value);
                }}
                minLength={6}
                required
                autoComplete="new-password"
              />
            </label>
            <button type="submit" disabled={loading}>
              {loading ? '更新中...' : '更新密码'}
            </button>
          </form>
        </section>
      </main>
    </div>
  );
}

function TokenBadge({ account, onClick }: { account: TokenAccount | null; onClick?: () => void }) {
  if (!account) {
    return <span className="token-badge loading">余额加载中...</span>;
  }
  return (
    <button className="token-badge" onClick={onClick} type="button">
      <span className="token-item gift">赠送余额 {account.gift_tokens.toLocaleString()}</span>
      <span className="token-item recharge">充值余额 {account.recharge_tokens.toLocaleString()}</span>
    </button>
  );
}

interface AppIconApp {
  icon_type?: 'emoji' | 'image' | null;
  icon?: string | null;
  icon_url?: string | null;
  icon_background?: string | null;
}

export function AppIcon({ app }: { app: AppIconApp | null | undefined }) {
  const [failed, setFailed] = useState(false);

  if (!app) {
    return <span className="app-icon-placeholder" aria-hidden="true" />;
  }

  if (app.icon_type === 'image' && app.icon_url && !failed) {
    return (
      <img
        className="app-icon-image"
        src={app.icon_url}
        alt=""
        onError={() => {
          setFailed(true);
        }}
        style={{ background: app.icon_background ?? undefined }}
      />
    );
  }

  if (app.icon_type === 'emoji' && app.icon) {
    return <span className="app-icon-text">{app.icon}</span>;
  }

  return <span className="app-icon-placeholder" aria-hidden="true" />;
}

function AppHub({
  user,
  apps,
  account,
  onSelectApp,
  onProfile,
  onLogout,
  onLedger,
  onAdmin,
}: {
  user: User;
  apps: YiaiApp[];
  account: TokenAccount | null;
  onSelectApp: (slug: string) => void;
  onProfile: () => void;
  onLogout: () => void;
  onLedger: () => void;
  onAdmin: () => void;
}) {
  const roleLabel = user.role === 'admin' ? '管理员' : '用户';
  const [activeTag, setActiveTag] = useState<string>('');
  const tags = [...new Set(apps.flatMap((app) => app.tags ?? []))];
  const visibleApps = activeTag === '' ? apps : apps.filter((app) => (app.tags ?? []).includes(activeTag));

  return (
    <div className="hub-page">
      <header className="hub-header">
        <h1>YIAI Platform</h1>
        <div className="user-actions">
          <TokenBadge account={account} onClick={onLedger} />
          <span className="user-name">
            {user.username} ({roleLabel})
          </span>
          {user.role === 'admin' && (
            <button className="secondary admin-btn" onClick={onAdmin}>
              管理后台
            </button>
          )}
          <button className="secondary" onClick={onProfile}>
            个人资料
          </button>
          <button onClick={onLogout}>退出登录</button>
        </div>
      </header>
      <main className="hub-main">
        <h2>应用中心</h2>
        {account && (
          <p className="token-hint">
            每日赠送 +{account.daily_gift_amount.toLocaleString()} Tokens，赠送余额最多累积至 {account.gift_tokens_max.toLocaleString()} Tokens
          </p>
        )}
        {tags.length > 0 && (
          <div className="tag-filter" aria-label="应用标签筛选">
            <button
              type="button"
              className={activeTag === '' ? 'tag-filter-button active' : 'tag-filter-button'}
              onClick={() => { setActiveTag(''); }}
            >
              全部
            </button>
            {tags.map((tag) => (
              <button
                key={tag}
                type="button"
                className={activeTag === tag ? 'tag-filter-button active' : 'tag-filter-button'}
                onClick={() => { setActiveTag(tag); }}
              >
                {tag}
              </button>
            ))}
          </div>
        )}
        <div className="app-grid">
          {visibleApps.map((app) => (
            <button key={app.id} className="app-card" onClick={() => { onSelectApp(app.slug); }}>
              <div className="app-icon">
                <AppIcon app={app} />
              </div>
              <h3>{app.name || app.slug}</h3>
              {app.description && <p>{app.description}</p>}
              {(app.tags ?? []).length > 0 && (
                <span className="app-tags">
                  {(app.tags ?? []).map((tag) => <span key={tag}>{tag}</span>)}
                </span>
              )}
            </button>
          ))}
        </div>
        {visibleApps.length === 0 && <p className="empty-state">没有符合该标签的应用。</p>}
      </main>
    </div>
  );
}

function InputFormModal({
  fields,
  onConfirm,
  onCancel,
}: {
  fields: UserInputFormField[];
  onConfirm: (values: Record<string, string>) => void;
  onCancel: () => void;
}) {
  const [values, setValues] = useState<Record<string, string>>(() => {
    const initial: Record<string, string> = {};
    for (const field of fields) {
      initial[field.variable] = field.default ?? '';
    }
    return initial;
  });
  const [error, setError] = useState('');

  const handleSubmit = (e: React.SyntheticEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError('');

    for (const field of fields) {
      if (field.required && !values[field.variable].trim()) {
        setError(`请填写 ${field.label}`);
        return;
      }
    }

    onConfirm(values);
  };

  return (
    <div className="modal-overlay">
      <div className="modal">
        <h3>新对话信息采集</h3>
        {error && <p className="error">{error}</p>}
        <form onSubmit={handleSubmit}>
          {fields.map((field) => (
            <label key={field.variable}>
              {field.label}
              {field.required && <span className="required">*</span>}
              {field.type === 'text-input' && (
                <input
                  type="text"
                  value={values[field.variable] ?? ''}
                  onChange={(e) => {
                    setValues((prev) => ({ ...prev, [field.variable]: e.target.value }));
                  }}
                  required={field.required}
                />
              )}
              {field.type === 'paragraph' && (
                <textarea
                  value={values[field.variable] ?? ''}
                  onChange={(e) => {
                    setValues((prev) => ({ ...prev, [field.variable]: e.target.value }));
                  }}
                  required={field.required}
                />
              )}
              {field.type === 'select' && (
                <select
                  value={values[field.variable] ?? ''}
                  onChange={(e) => {
                    setValues((prev) => ({ ...prev, [field.variable]: e.target.value }));
                  }}
                  required={field.required}
                >
                  <option value="">请选择</option>
                  {field.options?.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              )}
            </label>
          ))}
          <div className="modal-actions">
            <button type="button" className="secondary" onClick={onCancel}>
              取消
            </button>
            <button type="submit">确认</button>
          </div>
        </form>
      </div>
    </div>
  );
}

export function ChatPage({
  slug,
  user: _user,
  account,
  onBack,
  onLogout,
  onRefreshAccount,
}: {
  slug: string;
  user: User;
  account: TokenAccount | null;
  onBack: () => void;
  onLogout: () => void;
  onRefreshAccount?: () => void;
}) {
  const [bootstrap, setBootstrap] = useState<AppBootstrap | null>(null);
  const [conversations, setConversations] = useState<YiaiConversation[]>([]);
  const [activeConversationId, setActiveConversationId] = useState<string | undefined>(undefined);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [copiedMessageIndex, setCopiedMessageIndex] = useState<number | null>(null);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [showInputForm, setShowInputForm] = useState(false);
  const [pendingInputs, setPendingInputs] = useState<Record<string, unknown> | undefined>(undefined);
  const [inputFormLoadError, setInputFormLoadError] = useState('');
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [mobileActionsOpen, setMobileActionsOpen] = useState(false);
  const [renamingConversation, setRenamingConversation] = useState<YiaiConversation | null>(null);
  const [conversationNameDraft, setConversationNameDraft] = useState('');
  const [renameError, setRenameError] = useState('');
  const [renameSaving, setRenameSaving] = useState(false);
  const [pendingImage, setPendingImage] = useState<
    | {
        file: File;
        previewUrl: string;
        uploaded?: { id: string; type: string; url?: string };
      }
    | null
  >(null);
  const messagesRef = useRef<HTMLDivElement>(null);
  const followLatestMessagesRef = useRef(true);
  const abortControllerRef = useRef<AbortController | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const chatInputRef = useRef<HTMLTextAreaElement>(null);

  const scrollToBottom = () => {
    const messagesElement = messagesRef.current;
    if (messagesElement) {
      messagesElement.scrollTop = messagesElement.scrollHeight;
    }
  };

  const handleMessagesScroll = () => {
    const messagesElement = messagesRef.current;
    if (!messagesElement) {
      return;
    }
    followLatestMessagesRef.current =
      messagesElement.scrollHeight - messagesElement.scrollTop - messagesElement.clientHeight < 48;
  };

  const handleCopyMessage = (index: number, content: string) => {
    void (async () => {
      try {
        await copyMessageText(content);
        setCopiedMessageIndex(index);
      } catch (err) {
        setError(err instanceof Error ? err.message : '复制失败，请手动复制');
      }
    })();
  };

  useEffect(() => {
    if (!followLatestMessagesRef.current) {
      return;
    }
    const frame = requestAnimationFrame(scrollToBottom);
    return () => {
      cancelAnimationFrame(frame);
    };
  }, [messages]);

  useEffect(() => {
    const textarea = chatInputRef.current;
    if (!textarea) {
      return;
    }

    textarea.style.height = 'auto';
    textarea.style.height = `${String(textarea.scrollHeight)}px`;
  }, [input]);

  const loadConversations = async () => {
    try {
      const list = await api<YiaiConversation[]>(`/apps/${slug}/conversations`);
      setConversations(list);
      return list;
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载会话失败');
      return [];
    }
  };

  const loadMessages = useCallback(async (conversationId: string) => {
    try {
      const history = await api<YiaiMessage[]>(`/apps/${slug}/conversations/${conversationId}/messages`);
      const loaded: ChatMessage[] = [];
      for (const msg of history) {
        loaded.push({ id: msg.id, role: 'user', content: msg.query });
        loaded.push({
          id: msg.id,
          role: 'assistant',
          content: stripThinkContent(msg.answer),
          rawContent: msg.answer,
          files: msg.message_files ?? undefined,
          usage: msg.metadata?.usage?.total_tokens,
          createdAt: normalizeYiaiTimestamp(msg.created_at) ?? undefined,
        });
      }
      setMessages(loaded);
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载消息失败');
    }
  }, [slug]);

  const initialize = useCallback(async () => {
    setLoading(true);
    setError('');
    setMessages([]);
    followLatestMessagesRef.current = true;
    setActiveConversationId(undefined);
    setPendingInputs({});
    setInputFormLoadError('');
    try {
      const bs = await api<AppBootstrap>(`/apps/${slug}/bootstrap`);
      setBootstrap(bs);

      try {
        const list = await api<YiaiConversation[]>(`/apps/${slug}/conversations`);
        setConversations(list);

        if (list.length > 0) {
          const latest = list[0];
          setActiveConversationId(latest.id);
          setPendingInputs(latest.inputs);
          await loadMessages(latest.id);
        } else if (bs.app.requires_new_conversation_inputs) {
          const formFields = bs.user_input_form ?? [];
          if (formFields.length === 0) {
            setInputFormLoadError('用户信息表单加载失败，请重试');
            setShowInputForm(false);
          } else {
            setShowInputForm(true);
          }
        } else {
          setShowInputForm(false);
        }
      } catch (err) {
        setConversations([]);
        setError(
          err instanceof Error
            ? `历史会话加载失败，已切换为新对话：${err.message}`
            : '历史会话加载失败，已切换为新对话'
        );

        if (bs.app.requires_new_conversation_inputs) {
          const formFields = bs.user_input_form ?? [];
          if (formFields.length === 0) {
            setInputFormLoadError('用户信息表单加载失败，请重试');
            setShowInputForm(false);
          } else {
            setShowInputForm(true);
          }
        } else {
          setShowInputForm(false);
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载应用失败');
    } finally {
      setLoading(false);
    }
  }, [slug, loadMessages]);

  useEffect(() => {
    void initialize();
  }, [initialize]);

  const startNewConversation = () => {
    setError('');
    setActiveConversationId(undefined);
    setMessages([]);
    followLatestMessagesRef.current = true;
    setPendingInputs({});
    setInputFormLoadError('');
    setDrawerOpen(false);
    setMobileActionsOpen(false);

    if (bootstrap?.app.requires_new_conversation_inputs) {
      const formFields = bootstrap.user_input_form ?? [];
      if (formFields.length === 0) {
        setInputFormLoadError('用户信息表单加载失败，请重试');
        setShowInputForm(false);
      } else {
        setShowInputForm(true);
      }
    }
  };

  const handleInputFormConfirm = (values: Record<string, string>) => {
    setPendingInputs(values);
    setShowInputForm(false);
  };

  const handleInputFormCancel = () => {
    setShowInputForm(false);
    onBack();
  };

  const uploadImage = async (file: File): Promise<{ id: string; type: string; url?: string }> => {
    const formData = new FormData();
    formData.append('file', file);
    const token = localStorage.getItem(TOKEN_KEY);
    const headers: Record<string, string> = {};
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }

    const response = await fetch(`/api/apps/${slug}/files`, {
      method: 'POST',
      headers,
      body: formData,
    });
    const data = (await response.json()) as { error?: string; id?: string; type?: string; url?: string };
    if (!response.ok) {
      throw new Error(data.error ?? '上传失败');
    }
    if (!data.id) {
      throw new Error('上传返回数据不完整');
    }
    return { id: data.id, type: data.type ?? 'image', ...(data.url ? { url: data.url } : {}) };
  };

  const clearPendingImage = (preservePreview = false) => {
    if (!preservePreview && pendingImage?.previewUrl) {
      URL.revokeObjectURL(pendingImage.previewUrl);
    }
    setPendingImage(null);
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const handleImageSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) {
      return;
    }
    const previewUrl = URL.createObjectURL(file);
    setPendingImage({ file, previewUrl });

    void (async () => {
      try {
        const uploaded = await uploadImage(file);
        setPendingImage((prev) => (prev ? { ...prev, uploaded } : null));
      } catch (err) {
        setError(err instanceof Error ? err.message : '图片上传失败');
        clearPendingImage();
      }
    })();
  };

  const handleDeleteConversation = async (conv: YiaiConversation) => {
    if (!window.confirm(`确认删除「${conv.name}」吗？删除后不可恢复。`)) {
      return;
    }
    setError('');
    try {
      await api(`/apps/${slug}/conversations/${conv.id}`, { method: 'DELETE' });
      const remaining = conversations.filter((c) => c.id !== conv.id);
      setConversations(remaining);

      if (conv.id === activeConversationId) {
        setActiveConversationId(undefined);
        setMessages([]);
        followLatestMessagesRef.current = true;
        setPendingInputs({});
        setInputFormLoadError('');

        if (remaining.length > 0) {
          const latest = remaining[0];
          setActiveConversationId(latest.id);
          setPendingInputs(latest.inputs);
          await loadMessages(latest.id);
        } else if (bootstrap?.app.requires_new_conversation_inputs) {
          const formFields = bootstrap.user_input_form ?? [];
          if (formFields.length === 0) {
            setInputFormLoadError('用户信息表单加载失败，请重试');
            setShowInputForm(false);
          } else {
            setInputFormLoadError('');
            setShowInputForm(true);
          }
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '删除失败');
    }
  };

  const openRenameConversation = (conv: YiaiConversation) => {
    setRenamingConversation(conv);
    setConversationNameDraft(conv.name);
    setRenameError('');
  };

  const handleRenameConversation = async (event: React.SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!renamingConversation) {
      return;
    }

    const name = conversationNameDraft.trim();
    if (!name) {
      setRenameError('会话名称不能为空');
      return;
    }

    setRenameSaving(true);
    setRenameError('');
    try {
      const renamed = await api<{ id: string; name: string }>(
        `/apps/${slug}/conversations/${renamingConversation.id}`,
        { method: 'PATCH', body: JSON.stringify({ name }) }
      );
      setConversations((previous) =>
        previous.map((conversation) =>
          conversation.id === renamed.id ? { ...conversation, name: renamed.name } : conversation
        )
      );
      setRenamingConversation(null);
    } catch (err) {
      setRenameError(err instanceof Error ? err.message : '重命名失败');
    } finally {
      setRenameSaving(false);
    }
  };

  const isBalanceInsufficient = account !== null && account.gift_tokens <= 0 && account.recharge_tokens <= 0;

  const handleSend = async (query: string) => {
    const text = query.trim();
    if ((!text && !pendingImage?.uploaded) || loading) {
      return;
    }
    if (isBalanceInsufficient) {
      setError('余额不足，请等待每日赠送或联系管理员充值');
      return;
    }
    setLoading(true);
    setError('');
    followLatestMessagesRef.current = true;

    const userFiles = pendingImage?.uploaded
      ? [{ type: 'image' as const, url: pendingImage.uploaded.url ?? pendingImage.previewUrl }]
      : undefined;
    const userMessage: ChatMessage = {
      role: 'user',
      content: text,
      files: userFiles,
    };
    const assistantMessage: ChatMessage = { role: 'assistant', content: '', rawContent: '', isPending: true };
    setMessages((prev) => [...prev, userMessage, assistantMessage]);

    const token = localStorage.getItem(TOKEN_KEY);
    const body: ChatRequestBody = {
      query: text,
      inputs: pendingInputs ?? {},
    };
    if (activeConversationId) {
      body.conversation_id = activeConversationId;
    }
    if (pendingImage?.uploaded) {
      body.files = [
        {
          type: 'image',
          transfer_method: 'local_file',
          upload_file_id: pendingImage.uploaded.id,
        },
      ];
    }

    abortControllerRef.current?.abort();
    abortControllerRef.current = new AbortController();

    try {
      const response = await startChatStream(slug, token, body, abortControllerRef.current.signal);
      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error('响应不支持流式读取');
      }

      await readSSEStream(
        reader,
        {
          onMessage: (data) => {
            const answer = typeof data.answer === 'string' ? data.answer : '';
            setMessages((prev) => {
              const next = [...prev];
              const last = next[next.length - 1];
              if (last.role === 'assistant') {
                const rawContent = (last.rawContent ?? last.content) + answer;
                next[next.length - 1] = {
                  ...last,
                  rawContent,
                  content: stripThinkContent(rawContent),
                  isPending: false,
                };
              }
              return next;
            });
          },
          onMessageReplace: (data) => {
            const answer = typeof data.answer === 'string' ? data.answer : '';
            setMessages((prev) => {
              const next = [...prev];
              const last = next[next.length - 1];
              if (last.role === 'assistant') {
                next[next.length - 1] = {
                  ...last,
                  rawContent: answer,
                  content: stripThinkContent(answer),
                  isPending: false,
                };
              }
              return next;
            });
          },
          onMessageFile: (data) => {
            const url = typeof data.url === 'string' ? data.url : '';
            const type = typeof data.type === 'string' ? data.type : 'image';
            if (!url) {
              return;
            }
            setMessages((prev) => {
              const next = [...prev];
              const last = next[next.length - 1];
              if (last.role === 'assistant') {
                next[next.length - 1] = { ...last, isPending: false, files: [...(last.files ?? []), { type, url }] };
              }
              return next;
            });
          },
          onMessageEnd: (data) => {
            setLoading(false);
            if (typeof data.conversation_id === 'string' && !activeConversationId) {
              setActiveConversationId(data.conversation_id);
              void loadConversations();
            }

            const totalTokens = ((data.metadata as Record<string, unknown> | undefined)?.usage as Record<string, unknown> | undefined)?.total_tokens;
            const messageCreatedAt = normalizeYiaiTimestamp(data.created_at) ?? Date.now();

            setMessages((prev) => {
              const next = [...prev];
              const last = next[next.length - 1];
              if (last.role === 'assistant') {
                next[next.length - 1] = {
                  ...last,
                  id: typeof data.message_id === 'string' ? data.message_id : last.id,
                  usage: typeof totalTokens === 'number' ? totalTokens : last.usage,
                  createdAt: messageCreatedAt,
                  isPending: false,
                };
              }
              return next;
            });

            if (typeof totalTokens === 'number') {
              onRefreshAccount?.();
            }
          },
          onError: (data) => {
            const message = typeof data.message === 'string' ? data.message : '聊天服务返回错误';
            setError(message);
            setLoading(false);
            setMessages((prev) => {
              const next = [...prev];
              const last = next[next.length - 1];
              if (last.role === 'assistant' && last.isPending) {
                next[next.length - 1] = { ...last, isPending: false };
              }
              return next;
            });
          },
          onComplete: () => {
            setLoading(false);
            setMessages((prev) => {
              const next = [...prev];
              const last = next[next.length - 1];
              if (last.role === 'assistant' && last.isPending) {
                next[next.length - 1] = { ...last, isPending: false };
              }
              return next;
            });
          },
        },
        abortControllerRef.current.signal
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : '发送失败');
      setLoading(false);
      setMessages((prev) => {
        const next = [...prev];
        const last = next[next.length - 1];
        if (last.role === 'assistant' && last.isPending) {
          next[next.length - 1] = { ...last, isPending: false };
        }
        return next;
      });
    }
  };

  const sendCurrentInput = () => {
    if (loading || !!inputFormLoadError || isBalanceInsufficient || (!input.trim() && !pendingImage?.uploaded)) {
      return;
    }
    const preserveImagePreview = Boolean(pendingImage?.uploaded && !pendingImage.uploaded.url);
    void handleSend(input);
    setInput('');
    clearPendingImage(preserveImagePreview);
  };

  const insertInputNewline = () => {
    const textarea = chatInputRef.current;
    if (!textarea || textarea.disabled) {
      return;
    }
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const nextValue = `${input.slice(0, start)}\n${input.slice(end)}`;
    setInput(nextValue);
    requestAnimationFrame(() => {
      textarea.focus();
      textarea.setSelectionRange(start + 1, start + 1);
    });
  };

  const handleSuggestedQuestion = (question: string) => {
    void handleSend(question);
  };

  return (
    <div className="chat-page">
      <header className="chat-header">
        <button className="secondary" onClick={onBack}>
          ← 应用中心
        </button>
        <button
          className="secondary mobile-history-toggle"
          onClick={() => {
            setDrawerOpen((open) => !open);
          }}
          type="button"
        >
          历史会话（{conversations.length}）
        </button>
        <div className="chat-title">
          <span className="chat-icon">
            <AppIcon app={bootstrap?.app} />
          </span>
          <span>{bootstrap?.app.name || slug}</span>
        </div>
        <div className="chat-actions">
          <button className="secondary header-new-conversation" onClick={startNewConversation} disabled={loading}>
            新建对话
          </button>
          <button onClick={onLogout}>退出登录</button>
        </div>
      </header>

      <aside className={`chat-sidebar${drawerOpen ? ' open' : ''}`} data-testid="chat-sidebar">
        <div className="chat-sidebar-header">
          <h4>最近会话</h4>
          <button
            className="secondary drawer-close"
            onClick={() => {
              setDrawerOpen(false);
            }}
            type="button"
          >
            关闭
          </button>
        </div>
        {conversations.length === 0 && <p className="empty">暂无会话</p>}
        <ul>
          {conversations.map((conv) => (
            <li
              key={conv.id}
              className={conv.id === activeConversationId ? 'active' : ''}
              onClick={() => {
                followLatestMessagesRef.current = true;
                setActiveConversationId(conv.id);
                setPendingInputs(conv.inputs);
                setError('');
                setDrawerOpen(false);
                void loadMessages(conv.id);
              }}
            >
              <span className="conversation-name">{conv.name}</span>
              <div className="conversation-actions">
                <button
                  className="secondary rename-conversation"
                  title="重命名会话"
                  onClick={(e) => {
                    e.stopPropagation();
                    openRenameConversation(conv);
                  }}
                  type="button"
                >
                  重命名
                </button>
                <button
                  className="secondary delete-conversation"
                  title="删除会话"
                  onClick={(e) => {
                    e.stopPropagation();
                    void handleDeleteConversation(conv);
                  }}
                  type="button"
                >
                  删除
                </button>
              </div>
            </li>
          ))}
        </ul>
      </aside>
      {drawerOpen && (
        <div
          className="chat-sidebar-backdrop"
          onClick={() => {
            setDrawerOpen(false);
          }}
          aria-hidden="true"
        />
      )}

      <div className="mobile-chat-fab">
        {mobileActionsOpen && (
          <div className="mobile-chat-fab-actions">
            <button
              type="button"
              className="secondary"
              onClick={startNewConversation}
              disabled={loading}
              aria-label="移动端新建对话"
            >
              新建对话
            </button>
            <button
              type="button"
              className="secondary"
              onClick={() => {
                setDrawerOpen(true);
                setMobileActionsOpen(false);
              }}
              aria-label="移动端历史会话"
            >
              历史会话（{conversations.length}）
            </button>
          </div>
        )}
        <button
          type="button"
          className="mobile-chat-fab-toggle"
          onClick={() => {
            setMobileActionsOpen((open) => !open);
          }}
          aria-label="展开会话操作"
          aria-expanded={mobileActionsOpen}
        >
          {mobileActionsOpen ? '收起' : '会话'}
        </button>
      </div>

      <main className="chat-main">
        {(error || inputFormLoadError) && (
          <p className="error-banner">{error || inputFormLoadError}</p>
        )}

        {messages.length === 0 && bootstrap?.opening_statement && (
          <div className="opening">
            <p>{bootstrap.opening_statement}</p>
          </div>
        )}

        {messages.length === 0 && bootstrap?.suggested_questions && bootstrap.suggested_questions.length > 0 && (
          <div className="suggested-questions">
            {bootstrap.suggested_questions.map((q, idx) => (
              <button key={idx} className="suggested" onClick={() => { handleSuggestedQuestion(q); }}>
                {q}
              </button>
            ))}
          </div>
        )}

        <div className="messages" ref={messagesRef} onScroll={handleMessagesScroll} data-testid="messages-viewport">
          {messages.map((msg, idx) => (
            <div key={idx} className={`message ${msg.role}`}>
              <div className="message-content">
                <div className="bubble">
                  {msg.role === 'assistant' && msg.isPending ? (
                    <span className="replying-indicator" role="status" aria-label="AI 回复中">
                      <span>回复中</span>
                      <span className="replying-dot" aria-hidden="true">.</span>
                      <span className="replying-dot" aria-hidden="true">.</span>
                      <span className="replying-dot" aria-hidden="true">.</span>
                    </span>
                  ) : msg.role === 'assistant' ? <MarkdownMessage content={msg.content} /> : msg.content}
                  {msg.files && msg.files.length > 0 && (
                    <div className="message-files">
                      {msg.files.map((file, fidx) => (
                        <img key={fidx} src={file.url} alt="消息文件" />
                      ))}
                    </div>
                  )}
                </div>
                {msg.role === 'assistant' &&
                  (msg.usage !== undefined || normalizeYiaiTimestamp(msg.createdAt) !== null) && (
                    <div className="message-meta">{formatMessageMeta(msg)}</div>
                  )}
                {!msg.isPending && <div className="message-actions">
                  <button
                    type="button"
                    className="copy-message"
                    onClick={() => { handleCopyMessage(idx, msg.content); }}
                    aria-label={msg.role === 'assistant' ? '复制 AI 回答' : '复制用户消息'}
                  >
                    {copiedMessageIndex === idx ? '已复制' : '复制'}
                  </button>
                </div>}
              </div>
            </div>
          ))}
        </div>

        <div className="input-area">
          {pendingImage && (
            <div className="pending-image">
              <img src={pendingImage.previewUrl} alt="待发送图片" />
              {!pendingImage.uploaded && <span className="uploading-hint">图片上传中...</span>}
              <button
                className="secondary remove-image"
                onClick={() => { clearPendingImage(); }}
                type="button"
                disabled={loading}
              >
                移除
              </button>
            </div>
          )}
          <form
            className="input-bar"
            onSubmit={(e) => {
              e.preventDefault();
              insertInputNewline();
            }}
          >
            <textarea
              ref={chatInputRef}
              className="chat-input"
              rows={1}
              value={input}
              onChange={(e) => {
                setInput(e.target.value);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  insertInputNewline();
                }
              }}
              placeholder={isBalanceInsufficient ? '余额不足，请等待每日赠送或联系管理员充值' : '输入问题...'}
              disabled={loading || !!inputFormLoadError || (pendingImage !== null && !pendingImage.uploaded)}
              enterKeyHint="enter"
              aria-label="聊天输入框"
            />
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              onChange={handleImageSelect}
              style={{ display: 'none' }}
            />
            <button
              type="button"
              className="secondary"
              onClick={() => {
                fileInputRef.current?.click();
              }}
              disabled={loading || !!inputFormLoadError || pendingImage !== null}
            >
              图片
            </button>
            <button
              type="button"
              onClick={sendCurrentInput}
              disabled={
                loading ||
                !!inputFormLoadError ||
                isBalanceInsufficient ||
                (!input.trim() && !pendingImage?.uploaded)
              }
            >
              {loading ? '发送中...' : '发送'}
            </button>
          </form>
        </div>
      </main>

      {renamingConversation && (
        <div className="modal-overlay" onClick={() => { if (!renameSaving) setRenamingConversation(null); }}>
          <div className="modal" onClick={(event) => { event.stopPropagation(); }}>
            <h3>重命名会话</h3>
            <form onSubmit={(event) => { void handleRenameConversation(event); }}>
              {renameError && <p className="error">{renameError}</p>}
              <label>
                会话名称
                <input
                  autoFocus
                  value={conversationNameDraft}
                  maxLength={80}
                  onChange={(event) => { setConversationNameDraft(event.target.value); }}
                  disabled={renameSaving}
                />
              </label>
              <div className="modal-actions">
                <button
                  type="button"
                  className="secondary"
                  disabled={renameSaving}
                  onClick={() => { setRenamingConversation(null); }}
                >
                  取消
                </button>
                <button type="submit" disabled={renameSaving}>
                  {renameSaving ? '保存中...' : '保存'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {showInputForm && bootstrap?.user_input_form && (
        <InputFormModal
          fields={bootstrap.user_input_form}
          onConfirm={handleInputFormConfirm}
          onCancel={handleInputFormCancel}
        />
      )}
    </div>
  );
}

function formatEntryType(type: LedgerEntry['entry_type']): string {
  switch (type) {
    case 'daily_gift':
      return '每日赠送';
    case 'admin_recharge':
      return '管理员充值';
    case 'usage':
      return '使用消耗';
    default:
      return type;
  }
}

function formatBucket(bucket: LedgerEntry['bucket']): string {
  return bucket === 'gift' ? '赠送余额' : '充值余额';
}

function formatDelta(delta: number): string {
  const sign = delta > 0 ? '+' : '';
  return `${sign}${delta.toLocaleString()}`;
}

function LedgerPage({ onBack }: { onBack: () => void }) {
  const [entries, setEntries] = useState<LedgerEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    setLoading(true);
    api<LedgerEntry[]>('/token-account/ledger')
      .then(setEntries)
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : '加载失败');
      })
      .finally(() => {
        setLoading(false);
      });
  }, []);

  return (
    <div className="ledger-page">
      <header className="ledger-header">
        <button className="secondary" onClick={onBack}>
          ← 返回
        </button>
        <h1>余额明细</h1>
      </header>
      <main className="ledger-main">
        {error && <p className="error-banner">{error}</p>}
        {loading && <p>加载中...</p>}
        {!loading && entries.length === 0 && <p className="empty">暂无明细</p>}
        {!loading && entries.length > 0 && (
          <table className="ledger-table">
            <thead>
              <tr>
                <th>时间</th>
                <th>类型</th>
                <th>来源余额</th>
                <th>变动 Token</th>
                <th>备注</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => (
                <tr key={entry.id}>
                  <td>{new Date(entry.created_at).toLocaleString('zh-CN')}</td>
                  <td>{formatEntryType(entry.entry_type)}</td>
                  <td>{formatBucket(entry.bucket)}</td>
                  <td className={entry.delta_tokens > 0 ? 'positive' : 'negative'}>
                    {formatDelta(entry.delta_tokens)}
                  </td>
                  <td>{entry.note ?? '-'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </main>
    </div>
  );
}

function AdminUsersTab() {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [ledgerUserId, setLedgerUserId] = useState<string | null>(null);
  const [ledgerEntries, setLedgerEntries] = useState<LedgerEntry[]>([]);
  const [rechargeUser, setRechargeUser] = useState<AdminUser | null>(null);
  const [rechargeAmount, setRechargeAmount] = useState('');
  const [rechargeNote, setRechargeNote] = useState('');
  const [passwordUser, setPasswordUser] = useState<AdminUser | null>(null);
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  const loadUsers = useCallback(async () => {
    const list = await api<AdminUser[]>('/admin/users');
    setUsers(list);
  }, []);

  useEffect(() => {
    setLoading(true);
    loadUsers()
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : '加载失败');
      })
      .finally(() => {
        setLoading(false);
      });
  }, [loadUsers]);

  const openLedger = async (userId: string) => {
    setLedgerUserId(userId);
    try {
      const entries = await api<LedgerEntry[]>(`/admin/users/${userId}/ledger`);
      setLedgerEntries(entries);
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载账本失败');
    }
  };

  const handleRecharge = (e: React.SyntheticEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!rechargeUser) return;
    const amount = parseInt(rechargeAmount, 10);
    if (!Number.isFinite(amount) || amount <= 0) {
      setError('充值余额必须为正整数');
      return;
    }
    void (async () => {
      try {
        await api(`/admin/users/${rechargeUser.id}/recharge`, {
          method: 'POST',
          body: JSON.stringify({ amount, note: rechargeNote || undefined }),
        });
        setMessage(`已为 ${rechargeUser.username} 充值 ${amount.toLocaleString()} Tokens`);
        setRechargeUser(null);
        setRechargeAmount('');
        setRechargeNote('');
        await loadUsers();
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : '充值失败');
      }
    })();
  };

  const closePasswordReset = () => {
    setPasswordUser(null);
    setNewPassword('');
    setConfirmPassword('');
  };

  const handlePasswordReset = (e: React.SyntheticEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!passwordUser) return;
    setError('');
    if (newPassword.length < 6) {
      setError('新密码至少需要 6 位');
      return;
    }
    if (newPassword !== confirmPassword) {
      setError('两次输入的密码不一致');
      return;
    }

    void (async () => {
      try {
        await api(`/admin/users/${passwordUser.id}/password`, {
          method: 'PUT',
          body: JSON.stringify({ newPassword }),
        });
        setMessage(`已重设 ${passwordUser.username} 的密码`);
        closePasswordReset();
      } catch (err) {
        setError(err instanceof Error ? err.message : '重设密码失败');
      }
    })();
  };

  return (
    <div className="admin-tab">
      {error && <p className="error-banner">{error}</p>}
      {message && <p className="success-banner">{message}</p>}
      {loading && <p>加载中...</p>}
      {!loading && (
        <table className="admin-table">
          <thead>
            <tr>
              <th>用户名</th>
              <th>角色</th>
              <th>赠送余额</th>
              <th>充值余额</th>
              <th>注册时间</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id}>
                <td>{u.username}</td>
                <td>{u.role === 'admin' ? '管理员' : '用户'}</td>
                <td>{u.gift_tokens.toLocaleString()}</td>
                <td>{u.recharge_tokens.toLocaleString()}</td>
                <td>{new Date(u.created_at).toLocaleString('zh-CN')}</td>
                <td>
                  <button className="secondary" onClick={() => { void openLedger(u.id); }}>
                    账本
                  </button>
                  <button className="secondary" onClick={() => { setRechargeUser(u); }}>
                    充值
                  </button>
                  <button className="secondary" onClick={() => { setPasswordUser(u); }}>
                    重设密码
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {ledgerUserId && (
        <div className="modal-overlay" onClick={() => { setLedgerUserId(null); }}>
          <div className="modal wide" onClick={(e) => { e.stopPropagation(); }}>
            <h3>用户账本</h3>
            {ledgerEntries.length === 0 && <p className="empty">暂无明细</p>}
            {ledgerEntries.length > 0 && (
              <table className="ledger-table">
                <thead>
                  <tr>
                    <th>时间</th>
                    <th>类型</th>
                    <th>来源余额</th>
                    <th>变动 Token</th>
                    <th>备注</th>
                  </tr>
                </thead>
                <tbody>
                  {ledgerEntries.map((entry) => (
                    <tr key={entry.id}>
                      <td>{new Date(entry.created_at).toLocaleString('zh-CN')}</td>
                      <td>{formatEntryType(entry.entry_type)}</td>
                      <td>{formatBucket(entry.bucket)}</td>
                      <td className={entry.delta_tokens > 0 ? 'positive' : 'negative'}>
                        {formatDelta(entry.delta_tokens)}
                      </td>
                      <td>{entry.note ?? '-'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <div className="modal-actions">
              <button onClick={() => { setLedgerUserId(null); }}>关闭</button>
            </div>
          </div>
        </div>
      )}

      {rechargeUser && (
        <div className="modal-overlay" onClick={() => { setRechargeUser(null); }}>
          <div className="modal" onClick={(e) => { e.stopPropagation(); }}>
            <h3>为 {rechargeUser.username} 充值余额</h3>
            <form onSubmit={handleRecharge}>
              <label>
                充值 Token 数量（正整数）
                <input
                  type="number"
                  min={1}
                  step={1}
                  value={rechargeAmount}
                  onChange={(e) => { setRechargeAmount(e.target.value); }}
                  required
                />
              </label>
              <label>
                备注（可选）
                <input
                  type="text"
                  value={rechargeNote}
                  onChange={(e) => { setRechargeNote(e.target.value); }}
                />
              </label>
              <div className="modal-actions">
                <button type="button" className="secondary" onClick={() => { setRechargeUser(null); }}>
                  取消
                </button>
                <button type="submit">确认充值</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {passwordUser && (
        <div className="modal-overlay" onClick={closePasswordReset}>
          <div className="modal" onClick={(e) => { e.stopPropagation(); }}>
            <h3>重设 {passwordUser.username} 的密码</h3>
            <form onSubmit={handlePasswordReset}>
              <label>
                新密码（至少 6 位）
                <input
                  type="password"
                  value={newPassword}
                  onChange={(e) => { setNewPassword(e.target.value); }}
                  minLength={6}
                  required
                  autoComplete="new-password"
                />
              </label>
              <label>
                确认新密码
                <input
                  type="password"
                  value={confirmPassword}
                  onChange={(e) => { setConfirmPassword(e.target.value); }}
                  minLength={6}
                  required
                  autoComplete="new-password"
                />
              </label>
              <div className="modal-actions">
                <button type="button" className="secondary" onClick={closePasswordReset}>
                  取消
                </button>
                <button type="submit">确认重设</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

export function LegacyAdminAppsTab() {
  const [apps, setApps] = useState<AdminApp[]>([]);
  const [editingApp, setEditingApp] = useState<AdminApp | null>(null);
  const [creating, setCreating] = useState(false);
  const [newApiKey, setNewApiKey] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [createForm, setCreateForm] = useState({
    slug: '',
    api_base_url: '',
    api_key: '',
    requires_new_conversation_inputs: false,
    enabled: true,
    sort_order: 0,
  });
  const [createFormError, setCreateFormError] = useState('');

  const loadApps = useCallback(async () => {
    const list = await api<AdminApp[]>('/admin/apps');
    setApps(list);
  }, []);

  useEffect(() => {
    setLoading(true);
    loadApps()
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : '加载失败');
      })
      .finally(() => {
        setLoading(false);
      });
  }, [loadApps]);

  const validateCreateForm = (form: typeof createForm): string | null => {
    if (!form.slug.trim()) {
      return '应用标识不能为空';
    }
    if (!/^[a-zA-Z0-9_-]+$/.test(form.slug.trim())) {
      return '应用标识只能包含字母、数字、下划线和连字符';
    }
    if (!form.api_base_url.trim()) {
      return 'API Base URL 不能为空';
    }
    if (!form.api_key.trim()) {
      return 'API Key 不能为空';
    }
    return null;
  };

  const handleCreateSubmit = (e: React.SyntheticEvent<HTMLFormElement>) => {
    e.preventDefault();
    setCreateFormError('');
    setError('');

    const validationError = validateCreateForm(createForm);
    if (validationError) {
      setCreateFormError(validationError);
      return;
    }

    const body = {
      slug: createForm.slug.trim(),
      api_base_url: createForm.api_base_url.trim(),
      api_key: createForm.api_key,
      enabled: createForm.enabled,
      sort_order: createForm.sort_order,
    };

    void (async () => {
      try {
        await api('/admin/apps', {
          method: 'POST',
          body: JSON.stringify(body),
        });
        setMessage('应用创建成功');
        setCreating(false);
        setCreateForm({
          slug: '',
          api_base_url: '',
          api_key: '',
          requires_new_conversation_inputs: false,
          enabled: true,
          sort_order: 0,
        });
        await loadApps();
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : '创建失败');
      }
    })();
  };

  const handleSync = async (id: string) => {
    setError('');
    setMessage('');
    try {
      await api(`/admin/apps/${id}/sync`, {
        method: 'POST',
        body: JSON.stringify({}),
      });
      setMessage('应用同步成功');
      await loadApps();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : '同步失败');
    }
  };

  const handleSave = (e: React.SyntheticEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!editingApp) return;
    const form = e.currentTarget;
    const getValue = (name: string): string => {
      const element = form.elements.namedItem(name);
      return element instanceof HTMLInputElement ? element.value : '';
    };
    const getChecked = (name: string): boolean => {
      const element = form.elements.namedItem(name);
      return element instanceof HTMLInputElement ? element.checked : false;
    };
    const body: Record<string, unknown> = {
      name: getValue('name'),
      description: getValue('description'),
      icon: getValue('icon'),
      api_base_url: getValue('api_base_url'),
      enabled: getChecked('enabled'),
      sort_order: parseInt(getValue('sort_order') || '0', 10),
    };
    if (newApiKey.trim()) {
      body.api_key = newApiKey.trim();
    }
    void (async () => {
      try {
        await api(`/admin/apps/${editingApp.id}`, {
          method: 'PATCH',
          body: JSON.stringify(body),
        });
        setMessage(`应用 ${editingApp.slug} 已更新`);
        setEditingApp(null);
        setNewApiKey('');
        await loadApps();
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : '保存失败');
      }
    })();
  };

  return (
    <div className="admin-tab">
      {error && <p className="error-banner">{error}</p>}
      {message && <p className="success-banner">{message}</p>}
      <div className="admin-actions">
        <button
          onClick={() => {
            setCreating(true);
          }}
        >
          新增 Chatflow 应用
        </button>
      </div>
      {loading && <p>加载中...</p>}
      {!loading && (
        <table className="admin-table">
          <thead>
            <tr>
              <th>排序</th>
              <th>标识</th>
              <th>名称</th>
              <th>API Key</th>
              <th>启用</th>
              <th>新对话采集</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {apps.map((app) => (
              <tr key={app.id}>
                <td>{app.sort_order}</td>
                <td>{app.slug}</td>
                <td>{app.name}</td>
                <td>{app.api_key_configured ? '已配置' : '未配置'}</td>
                <td>{app.enabled ? '是' : '否'}</td>
                <td>{app.requires_new_conversation_inputs ? '新对话采集信息' : '无需采集'}</td>
                <td>
                  <button className="secondary" onClick={() => { setEditingApp(app); }}>
                    编辑
                  </button>
                  <button className="secondary" onClick={() => { void handleSync(app.id); }}>
                    同步 YIAI 信息
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {creating && (
        <div className="modal-overlay" onClick={() => { setCreating(false); }}>
          <div className="modal wide" onClick={(e) => { e.stopPropagation(); }}>
            <h3>新增 Chatflow 应用</h3>
            {createFormError && <p className="error">{createFormError}</p>}
            <form onSubmit={handleCreateSubmit}>
              <label>
                应用标识 slug
                <input
                  type="text"
                  value={createForm.slug}
                  onChange={(e) => {
                    setCreateForm((prev) => ({ ...prev, slug: e.target.value }));
                  }}
                  required
                />
              </label>
              <label>
                YIAI API Base URL
                <input
                  type="text"
                  value={createForm.api_base_url}
                  onChange={(e) => {
                    setCreateForm((prev) => ({ ...prev, api_base_url: e.target.value }));
                  }}
                  required
                />
              </label>
              <label>
                YIAI API Key
                <input
                  type="password"
                  value={createForm.api_key}
                  onChange={(e) => {
                    setCreateForm((prev) => ({ ...prev, api_key: e.target.value }));
                  }}
                  required
                />
              </label>
              <label>
                排序
                <input
                  type="number"
                  step={1}
                  value={createForm.sort_order}
                  onChange={(e) => {
                    setCreateForm((prev) => ({ ...prev, sort_order: parseInt(e.target.value || '0', 10) }));
                  }}
                  required
                />
              </label>
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={createForm.enabled}
                  onChange={(e) => {
                    setCreateForm((prev) => ({ ...prev, enabled: e.target.checked }));
                  }}
                />
                启用
              </label>
              <div className="modal-actions">
                <button type="button" className="secondary" onClick={() => { setCreating(false); }}>
                  取消
                </button>
                <button type="submit">保存</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {editingApp && (
        <div className="modal-overlay" onClick={() => { setEditingApp(null); }}>
          <div className="modal wide" onClick={(e) => { e.stopPropagation(); }}>
            <h3>编辑应用：{editingApp.slug}</h3>
            <form onSubmit={handleSave}>
              <label>
                名称
                <input name="name" type="text" defaultValue={editingApp.name} required />
              </label>
              <label>
                描述
                <input name="description" type="text" defaultValue={editingApp.description ?? ''} />
              </label>
              <label>
                图标
                <input name="icon" type="text" defaultValue={editingApp.icon ?? ''} />
              </label>
              <label>
                API Base URL
                <input name="api_base_url" type="text" defaultValue={editingApp.api_base_url} required />
              </label>
              <label>
                新 API Key（留空保持原值，保存后不回显）
                <input
                  type="password"
                  value={newApiKey}
                  onChange={(e) => { setNewApiKey(e.target.value); }}
                  placeholder="留空则不修改"
                />
              </label>
              <label>
                排序
                <input name="sort_order" type="number" defaultValue={editingApp.sort_order} required />
              </label>
              <label className="checkbox">
                <input name="enabled" type="checkbox" defaultChecked={editingApp.enabled} />
                启用
              </label>
              <label className="checkbox">
                <input
                  name="requires_new_conversation_inputs"
                  type="checkbox"
                  defaultChecked={editingApp.requires_new_conversation_inputs}
                  disabled
                />
                每次新对话采集用户信息
              </label>
              <p className="input-hint">
                由 YIAI Chatflow 的用户输入表单自动识别；请点击“同步 YIAI 信息”更新。
              </p>
              <div className="modal-actions">
                <button type="button" className="secondary" onClick={() => { setEditingApp(null); }}>
                  取消
                </button>
                <button type="submit">保存</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

function AdminAppsTab() {
  const [apps, setApps] = useState<AdminApp[]>([]);
  const [creating, setCreating] = useState(false);
  const [settingsApp, setSettingsApp] = useState<AdminApp | null>(null);
  const [connectionApp, setConnectionApp] = useState<AdminApp | null>(null);
  const [connectionApiKey, setConnectionApiKey] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [createForm, setCreateForm] = useState({
    slug: '',
    app_type: 'chatflow' as 'chatflow' | 'agent',
    api_base_url: 'https://yiai.charprint.com/v1',
    api_key: '',
    agent_input_form: '[]',
    enabled: true,
  });
  const [createFormError, setCreateFormError] = useState('');

  const loadApps = useCallback(async () => {
    const list = await api<AdminApp[]>('/admin/apps');
    setApps(list);
  }, []);

  useEffect(() => {
    setLoading(true);
    loadApps()
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : '加载失败');
      })
      .finally(() => {
        setLoading(false);
      });
  }, [loadApps]);

  const validateCreateForm = (): string | null => {
    if (createForm.app_type === 'agent') {
      try {
        if (!Array.isArray(JSON.parse(createForm.agent_input_form))) {
          return 'Agent 新对话表单必须是 JSON 数组';
        }
      } catch {
        return 'Agent 新对话表单不是有效的 JSON';
      }
    }
    if (!createForm.slug.trim()) return '应用标识不能为空';
    if (!/^[a-zA-Z0-9_-]+$/.test(createForm.slug.trim())) {
      return '应用标识只能包含字母、数字、下划线和连字符';
    }
    if (!createForm.api_base_url.trim()) return 'YIAI API Base URL 不能为空';
    if (!createForm.api_key.trim()) return 'YIAI API Key 不能为空';
    return null;
  };

  const handleCreateSubmit = (event: React.SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError('');
    setMessage('');
    const validationError = validateCreateForm();
    if (validationError) {
      setCreateFormError(validationError);
      return;
    }

    let agentInputForm: unknown[] | undefined;
    if (createForm.app_type === 'agent') {
      const parsed: unknown = JSON.parse(createForm.agent_input_form);
      if (!Array.isArray(parsed)) {
        setCreateFormError('Agent 新对话表单必须是 JSON 数组');
        return;
      }
      agentInputForm = parsed;
    }

    void (async () => {
      try {
        await api('/admin/apps', {
          method: 'POST',
          body: JSON.stringify({
            slug: createForm.slug.trim(),
            app_type: createForm.app_type,
            api_base_url: createForm.api_base_url.trim(),
            api_key: createForm.api_key,
            ...(agentInputForm !== undefined ? { agent_input_form: agentInputForm } : {}),
            enabled: createForm.enabled,
          }),
        });
        setCreating(false);
        setCreateFormError('');
        setCreateForm({
          slug: '',
          app_type: 'chatflow',
          api_base_url: 'https://yiai.charprint.com/v1',
          api_key: '',
          agent_input_form: '[]',
          enabled: true,
        });
        setMessage('应用已创建，并已从 YIAI 同步信息');
        await loadApps();
      } catch (err: unknown) {
        setCreateFormError(err instanceof Error ? err.message : '应用创建失败');
      }
    })();
  };

  const handleSync = (app: AdminApp) => {
    setError('');
    setMessage('');
    void (async () => {
      try {
        await api(`/admin/apps/${app.id}/sync`, { method: 'POST', body: JSON.stringify({}) });
        setMessage(`已同步「${app.slug}」的 YIAI 信息`);
        await loadApps();
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : '同步失败');
      }
    })();
  };

  const handleSettingsSubmit = (event: React.SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!settingsApp) return;
    const form = event.currentTarget;
    const enabled = (form.elements.namedItem('enabled') as HTMLInputElement).checked;
    const name = (form.elements.namedItem('name') as HTMLInputElement).value.trim();
    const description = (form.elements.namedItem('description') as HTMLTextAreaElement).value.trim();
    const icon = (form.elements.namedItem('icon') as HTMLInputElement).value.trim();
    const tags = (form.elements.namedItem('tags') as HTMLInputElement).value
      .split(/[,，]/)
      .map((tag) => tag.trim())
      .filter((tag) => tag !== '');
    let agentInputForm: unknown[] | undefined;
    if (settingsApp.app_type === 'agent') {
      const raw = (form.elements.namedItem('agent_input_form') as HTMLTextAreaElement).value;
      try {
        const parsed: unknown = JSON.parse(raw);
        if (!Array.isArray(parsed)) throw new Error();
        agentInputForm = parsed;
      } catch {
        setError('Agent 新对话表单必须是 JSON 数组');
        return;
      }
    }
    setError('');
    setMessage('');

    void (async () => {
      try {
        await api(`/admin/apps/${settingsApp.id}`, {
          method: 'PATCH',
          body: JSON.stringify({
            enabled,
            name,
            description,
            tags,
            ...(icon !== '' ? { icon } : {}),
            ...(agentInputForm !== undefined ? { agent_input_form: agentInputForm } : {}),
          }),
        });
        setSettingsApp(null);
        setMessage(`已更新「${settingsApp.slug}」的平台设置`);
        await loadApps();
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : '保存设置失败');
      }
    })();
  };

  const handleConnectionSubmit = (event: React.SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!connectionApp) return;
    const form = event.currentTarget;
    const apiBaseUrl = (form.elements.namedItem('api_base_url') as HTMLInputElement).value.trim();
    setError('');
    setMessage('');

    void (async () => {
      try {
        await api(`/admin/apps/${connectionApp.id}/connection`, {
          method: 'PUT',
          body: JSON.stringify({ api_base_url: apiBaseUrl, api_key: connectionApiKey }),
        });
        setConnectionApp(null);
        setConnectionApiKey('');
        setMessage(`已验证并更新「${connectionApp.slug}」的 YIAI 连接`);
        await loadApps();
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : '保存连接失败');
      }
    })();
  };

  const handleDelete = (app: AdminApp) => {
    const appName = app.name || app.slug;
    if (!window.confirm(`确定删除「${appName}」吗？这会删除该应用及其使用记录，且无法恢复。`)) return;
    setError('');
    setMessage('');
    void (async () => {
      try {
        await api(`/admin/apps/${app.id}`, { method: 'DELETE' });
        setMessage(`已删除应用「${appName}」`);
        await loadApps();
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : '删除应用失败');
      }
    })();
  };

  return (
    <div className="admin-tab">
      {error && <p className="error-banner">{error}</p>}
      {message && <p className="success-banner">{message}</p>}
      <div className="admin-actions">
        <div>
          <h2>应用</h2>
          <p className="input-hint">Chatflow 会自动识别 YIAI 表单；Agent 的首次信息表单由平台保存，并不会被同步覆盖。</p>
        </div>
        <button onClick={() => { setCreating(true); }}>新增应用</button>
      </div>

      {loading && <p>加载中...</p>}
      {!loading && (
        <table className="admin-table">
          <thead>
            <tr>
              <th>应用</th>
              <th>类型</th>
              <th>连接</th>
              <th>启用</th>
              <th>新对话采集</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {apps.map((app) => (
              <tr key={app.id}>
                <td>
                  <div className="admin-app-summary">
                    <span className="admin-app-icon"><AppIcon app={app} /></span>
                    <span>
                      <strong>{app.name || app.slug}</strong>
                      <code>{app.slug}</code>
                      {app.description && <small>{app.description}</small>}
                      {(app.tags ?? []).length > 0 && (
                        <span className="admin-app-tags">{(app.tags ?? []).join(' · ')}</span>
                      )}
                    </span>
                  </div>
                </td>
                <td>{app.app_type === 'agent' ? 'Agent' : 'Chatflow'}</td>
                <td className="admin-connection-status">
                  {app.connection_duplicate_of_slug ? (
                    <span className="error">与「{app.connection_duplicate_of_slug}」连接重复</span>
                  ) : app.api_key_configured ? (
                    <span>已配置</span>
                  ) : (
                    <span>未配置</span>
                  )}
                  {app.api_key_preview && <code>{app.api_key_preview}</code>}
                </td>
                <td>{app.enabled ? '已启用' : '已停用'}</td>
                <td>{app.requires_new_conversation_inputs ? '需要采集信息' : '无需采集'}</td>
                <td className="admin-app-actions">
                  <button className="secondary" onClick={() => { setSettingsApp(app); }}>平台设置</button>
                  <button
                    className="secondary"
                    onClick={() => {
                      setConnectionApiKey('');
                      setConnectionApp(app);
                    }}
                  >
                    连接配置
                  </button>
                  <button className="secondary" onClick={() => { handleSync(app); }}>同步 YIAI</button>
                  <button className="danger" onClick={() => { handleDelete(app); }}>删除</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {creating && (
        <div className="modal-overlay" onClick={() => { setCreating(false); }}>
          <div className="modal wide" onClick={(event) => { event.stopPropagation(); }}>
            <h3>新增应用</h3>
            <p className="input-hint">Chatflow 会自动识别 YIAI 表单；Agent 的首次信息表单由平台保存，并不会被同步覆盖。</p>
            {createFormError && <p className="error">{createFormError}</p>}
            <form onSubmit={handleCreateSubmit}>
              <div className="app-type-switch" role="group" aria-label="应用类型">
                <span>应用类型</span>
                <button
                  type="button"
                  className={createForm.app_type === 'chatflow' ? 'active' : 'secondary'}
                  onClick={() => { setCreateForm((previous) => ({ ...previous, app_type: 'chatflow' })); }}
                >
                  Chatflow
                </button>
                <button
                  type="button"
                  className={createForm.app_type === 'agent' ? 'active' : 'secondary'}
                  onClick={() => { setCreateForm((previous) => ({ ...previous, app_type: 'agent' })); }}
                >
                  Agent
                </button>
              </div>
              <label>
                平台应用标识 slug
                <input
                  type="text"
                  value={createForm.slug}
                  onChange={(event) => { setCreateForm((previous) => ({ ...previous, slug: event.target.value })); }}
                  required
                />
              </label>
              <label>
                YIAI API Base URL
                <input
                  type="url"
                  value={createForm.api_base_url}
                  onChange={(event) => { setCreateForm((previous) => ({ ...previous, api_base_url: event.target.value })); }}
                  required
                />
              </label>
              <label>
                YIAI API Key
                <input
                  type="password"
                  value={createForm.api_key}
                  onChange={(event) => { setCreateForm((previous) => ({ ...previous, api_key: event.target.value })); }}
                  required
                />
              </label>
              {createForm.app_type === 'agent' && (
                <label>
                  Agent 新对话信息表单（JSON 数组，可留空）
                  <textarea
                    value={createForm.agent_input_form}
                    onChange={(event) => { setCreateForm((previous) => ({ ...previous, agent_input_form: event.target.value })); }}
                    placeholder={'[{"type":"text-input","label":"出生日期","variable":"birth_date","required":true}]'}
                  />
                </label>
              )}
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={createForm.enabled}
                  onChange={(event) => { setCreateForm((previous) => ({ ...previous, enabled: event.target.checked })); }}
                />
                创建后立即启用
              </label>
              <div className="modal-actions">
                <button type="button" className="secondary" onClick={() => { setCreating(false); }}>取消</button>
                <button type="submit">验证并创建</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {settingsApp && (
        <div className="modal-overlay" onClick={() => { setSettingsApp(null); }}>
          <div className="modal" onClick={(event) => { event.stopPropagation(); }}>
            <h3>平台设置：{settingsApp.name || settingsApp.slug}</h3>
            <p className="input-hint">这里的名称、说明、图标和标签为平台自定义属性。点击“同步 YIAI”后会被 YIAI 最新信息覆盖。</p>
            <form onSubmit={handleSettingsSubmit}>
              <label>
                应用名称
                <input name="name" type="text" defaultValue={settingsApp.name || settingsApp.slug} maxLength={255} required />
              </label>
              <label>
                应用说明
                <textarea name="description" defaultValue={settingsApp.description ?? ''} maxLength={2000} />
              </label>
              <label>
                图标（Emoji 或图片地址）
                <input name="icon" type="text" placeholder={settingsApp.icon_type === 'image' ? '当前为图片图标；留空保持不变' : '例如：🧠 或 https://...'} />
              </label>
              <label>
                标签（用逗号分隔）
                <input name="tags" type="text" defaultValue={(settingsApp.tags ?? []).join('，')} placeholder="例如：哲学，国学" />
              </label>
              {settingsApp.app_type === 'agent' && (
                <label>
                  Agent 新对话信息表单（JSON 数组）
                  <textarea name="agent_input_form" defaultValue={JSON.stringify(settingsApp.agent_input_form, null, 2)} />
                </label>
              )}
              <label className="checkbox">
                <input name="enabled" type="checkbox" defaultChecked={settingsApp.enabled} />
                在首页启用此应用
              </label>
              <div className="modal-actions">
                <button type="button" className="secondary" onClick={() => { setSettingsApp(null); }}>取消</button>
                <button type="submit">保存应用设置</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {connectionApp && (
        <div className="modal-overlay" onClick={() => { setConnectionApp(null); }}>
          <div className="modal wide" onClick={(event) => { event.stopPropagation(); }}>
            <h3>连接配置：{connectionApp.slug}</h3>
            <p className="input-hint">保存时会先向 YIAI 验证，再同步名称、说明、图标和新对话采集规则。API Key 留空会保留原值且永不回显。</p>
            <form onSubmit={handleConnectionSubmit}>
              <label>
                YIAI API Base URL
                <input name="api_base_url" type="url" defaultValue={connectionApp.api_base_url} required />
              </label>
              <label>
                新 API Key（留空保留原值）
                <input
                  type="password"
                  value={connectionApiKey}
                  onChange={(event) => { setConnectionApiKey(event.target.value); }}
                  placeholder="留空则不修改"
                />
              </label>
              <div className="modal-actions">
                <button type="button" className="secondary" onClick={() => { setConnectionApp(null); }}>取消</button>
                <button type="submit">保存并验证连接</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

function AdminPage({ onBack }: { onBack: () => void }) {
  const [tab, setTab] = useState<'users' | 'apps'>('users');

  return (
    <div className="admin-page">
      <header className="admin-header">
        <button className="secondary" onClick={onBack}>
          ← 返回
        </button>
        <h1>管理后台</h1>
      </header>
      <nav className="admin-nav">
        <button className={tab === 'users' ? 'active' : ''} onClick={() => { setTab('users'); }}>
          用户与余额
        </button>
        <button className={tab === 'apps' ? 'active' : ''} onClick={() => { setTab('apps'); }}>
          应用管理
        </button>
      </nav>
      <main className="admin-main">
        {tab === 'users' && <AdminUsersTab />}
        {tab === 'apps' && <AdminAppsTab />}
      </main>
    </div>
  );
}

function App() {
  const [view, setView] = useState<View>({ type: 'login' });
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [apps, setApps] = useState<YiaiApp[]>([]);
  const [account, setAccount] = useState<TokenAccount | null>(null);

  const refreshAccount = useCallback(async () => {
    try {
      const data = await api<TokenAccount>('/token-account');
      setAccount(data);
    } catch {
      setAccount(null);
    }
  }, []);

  useEffect(() => {
    const token = localStorage.getItem(TOKEN_KEY);
    if (!token) {
      setLoading(false);
      return;
    }

    api<User>('/auth/me')
      .then((me) => {
        setUser(me);
        return api<YiaiApp[]>('/apps');
      })
      .then((list) => {
        setApps(list);
        setView({ type: 'hub' });
        void refreshAccount();
      })
      .catch(() => {
        localStorage.removeItem(TOKEN_KEY);
      })
      .finally(() => {
        setLoading(false);
      });
  }, [refreshAccount]);

  const handleLogin = (res: AuthResponse) => {
    localStorage.setItem(TOKEN_KEY, res.token);
    setUser(res.user);
    void (async () => {
      try {
        const list = await api<YiaiApp[]>('/apps');
        setApps(list);
        setView({ type: 'hub' });
        await refreshAccount();
      } catch {
        setView({ type: 'hub' });
      }
    })();
  };

  const handleLogout = () => {
    localStorage.removeItem(TOKEN_KEY);
    setUser(null);
    setApps([]);
    setAccount(null);
    setView({ type: 'login' });
  };

  if (loading) {
    return (
      <div className="app">
        <p>加载中...</p>
      </div>
    );
  }

  return (
    <div className="app">
      {view.type === 'login' && (
        <LoginPage onLogin={handleLogin} onSwitch={() => { setView({ type: 'register' }); }} />
      )}
      {view.type === 'register' && (
        <RegisterPage onLogin={handleLogin} onSwitch={() => { setView({ type: 'login' }); }} />
      )}
      {view.type === 'profile' && user && (
        <ProfilePage user={user} onLogout={handleLogout} onBack={() => { setView({ type: 'hub' }); }} />
      )}
      {view.type === 'ledger' && user && <LedgerPage onBack={() => { setView({ type: 'hub' }); }} />}
      {view.type === 'admin' && user && user.role === 'admin' && (
        <AdminPage onBack={() => { setView({ type: 'hub' }); }} />
      )}
      {view.type === 'hub' && user && (
        <AppHub
          user={user}
          apps={apps}
          account={account}
          onSelectApp={(slug) => { setView({ type: 'chat', slug }); }}
          onProfile={() => { setView({ type: 'profile' }); }}
          onLogout={handleLogout}
          onLedger={() => { setView({ type: 'ledger' }); }}
          onAdmin={() => { setView({ type: 'admin' }); }}
        />
      )}
      {view.type === 'chat' && user && (
        <ChatPage
          slug={view.slug}
          user={user}
          account={account}
          onBack={() => { setView({ type: 'hub' }); }}
          onLogout={handleLogout}
          onRefreshAccount={() => { void refreshAccount(); }}
        />
      )}
    </div>
  );
}

export default App;
