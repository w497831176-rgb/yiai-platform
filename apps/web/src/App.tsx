import { useCallback, useEffect, useRef, useState } from 'react';
import './App.css';
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
  name: string;
  description: string | null;
  icon: string | null;
  icon_type: 'emoji' | 'image' | null;
  icon_url: string | null;
  icon_background: string | null;
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
  name: string;
  description: string | null;
  icon: string | null;
  icon_type: 'emoji' | 'image' | null;
  icon_url: string | null;
  icon_background: string | null;
  api_base_url: string;
  api_key_configured: boolean;
  enabled: boolean;
  sort_order: number;
  requires_new_conversation_inputs: boolean;
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

async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = localStorage.getItem(TOKEN_KEY);
  const baseHeaders: Record<string, string> = {
    'Content-Type': 'application/json',
  };

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

  const data = (await response.json()) as T & { error?: string };
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
        <div className="app-grid">
          {apps.map((app) => (
            <button key={app.id} className="app-card" onClick={() => { onSelectApp(app.slug); }}>
              <div className="app-icon">
                <AppIcon app={app} />
              </div>
              <h3>{app.name || app.slug}</h3>
              {app.description && <p>{app.description}</p>}
            </button>
          ))}
        </div>
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
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [showInputForm, setShowInputForm] = useState(false);
  const [pendingInputs, setPendingInputs] = useState<Record<string, unknown> | undefined>(undefined);
  const [inputFormLoadError, setInputFormLoadError] = useState('');
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [pendingImage, setPendingImage] = useState<
    | {
        file: File;
        previewUrl: string;
        uploaded?: { id: string; type: string; url: string };
      }
    | null
  >(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

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
    try {
      const [bs, list] = await Promise.all([
        api<AppBootstrap>(`/apps/${slug}/bootstrap`),
        api<YiaiConversation[]>(`/apps/${slug}/conversations`),
      ]);
      setBootstrap(bs);
      setConversations(list);

      if (list.length > 0) {
        const latest = list[0];
        setActiveConversationId(latest.id);
        setPendingInputs(latest.inputs);
        setInputFormLoadError('');
        await loadMessages(latest.id);
      } else if (bs.app.requires_new_conversation_inputs) {
        const formFields = bs.user_input_form ?? [];
        if (formFields.length === 0) {
          setInputFormLoadError('用户信息表单加载失败，请重试');
          setShowInputForm(false);
        } else {
          setInputFormLoadError('');
          setShowInputForm(true);
        }
      } else {
        setMessages([]);
        setActiveConversationId(undefined);
        setPendingInputs({});
        setInputFormLoadError('');
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
    setActiveConversationId(undefined);
    setMessages([]);
    setPendingInputs({});
    setInputFormLoadError('');

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

  const uploadImage = async (file: File): Promise<{ id: string; type: string; url: string }> => {
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
    if (!data.id || !data.url) {
      throw new Error('上传返回数据不完整');
    }
    return { id: data.id, type: data.type ?? 'image', url: data.url };
  };

  const clearPendingImage = () => {
    if (pendingImage?.previewUrl) {
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

    const userFiles = pendingImage?.uploaded ? [{ type: 'image' as const, url: pendingImage.uploaded.url }] : undefined;
    const userMessage: ChatMessage = {
      role: 'user',
      content: text,
      files: userFiles,
    };
    const assistantMessage: ChatMessage = { role: 'assistant', content: '', rawContent: '' };
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
                next[next.length - 1] = { ...last, files: [...(last.files ?? []), { type, url }] };
              }
              return next;
            });
          },
          onMessageEnd: (data) => {
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
          },
          onComplete: () => {
            setLoading(false);
          },
        },
        abortControllerRef.current.signal
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : '发送失败');
      setLoading(false);
    }
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
          <button className="secondary" onClick={startNewConversation} disabled={loading}>
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
                setActiveConversationId(conv.id);
                setPendingInputs(conv.inputs);
                setError('');
                setDrawerOpen(false);
                void loadMessages(conv.id);
              }}
            >
              <span className="conversation-name">{conv.name}</span>
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

        <div className="messages">
          {messages.map((msg, idx) => (
            <div key={idx} className={`message ${msg.role}`}>
              <div className="message-content">
                <div className="bubble">
                  {msg.content}
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
              </div>
            </div>
          ))}
          <div ref={messagesEndRef} />
        </div>

        <div className="input-area">
          {pendingImage && (
            <div className="pending-image">
              <img src={pendingImage.previewUrl} alt="待发送图片" />
              {!pendingImage.uploaded && <span className="uploading-hint">图片上传中...</span>}
              <button
                className="secondary remove-image"
                onClick={clearPendingImage}
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
              void handleSend(input);
              setInput('');
              clearPendingImage();
            }}
          >
            <input
              type="text"
              value={input}
              onChange={(e) => {
                setInput(e.target.value);
              }}
              placeholder={isBalanceInsufficient ? '余额不足，请等待每日赠送或联系管理员充值' : '输入问题...'}
              disabled={loading || !!inputFormLoadError || (pendingImage !== null && !pendingImage.uploaded)}
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
              type="submit"
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
    </div>
  );
}

function AdminAppsTab() {
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
                YIAI Chatflow API Base URL
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
                YIAI Chatflow API Key
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
