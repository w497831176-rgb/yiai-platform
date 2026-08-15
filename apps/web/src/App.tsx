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

interface LoginReward {
  streak_days: number;
  reward_tokens: number;
  granted_tokens: number;
}

interface AuthResponse {
  token: string;
  user: User;
  login_reward?: LoginReward;
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
  supports_images: boolean;
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

interface PendingImageDraft {
  id: string;
  file: File;
  previewUrl: string;
}

interface TokenAccount {
  gift_tokens: number;
  recharge_tokens: number;
  login_reward_base: number;
  gift_tokens_max: number;
  login_streak_days: number;
  last_login_reward_date: string | null;
}

interface LedgerEntry {
  id: string;
  created_at: string;
  entry_type: 'daily_gift' | 'login_streak_gift' | 'admin_recharge' | 'usage';
  bucket: 'gift' | 'recharge';
  delta_tokens: number;
  note: string | null;
  username?: string;
  app_name?: string | null;
  ai_reply_available?: boolean;
}

interface AdminUsagePage {
  items: LedgerEntry[];
  total: number;
  page: number;
  page_size: number;
}

interface AdminUsageReply {
  ledger_entry_id: string;
  username: string;
  app_name: string | null;
  created_at: string;
  answer: string;
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
  supports_images: boolean;
  token_multiplier: number;
  sort_order: number;
  requires_new_conversation_inputs: boolean;
  agent_input_form: UserInputFormField[];
  connection_duplicate_of_slug?: string | null;
}

interface FeedbackSummary {
  id: string;
  user_id: string;
  username: string;
  content_preview: string;
  has_screenshot: boolean;
  screenshot_content_type: string | null;
  screenshot_size_bytes: number | null;
  created_at: string;
}

interface FeedbackDetail extends Omit<FeedbackSummary, 'content_preview'> {
  content: string;
}

type ReplyPhase = 'idle' | 'waiting' | 'streaming';

type View =
  | { type: 'login' }
  | { type: 'register' }
  | { type: 'profile' }
  | { type: 'hub' }
  | { type: 'chat'; slug: string }
  | { type: 'ledger' }
  | { type: 'admin' };

const TOKEN_KEY = 'yiai_token';
const MAX_DRAFT_IMAGES = 10;
const MAX_DRAFT_IMAGE_BYTES = 200 * 1024;
const MAX_DRAFT_IMAGE_SIZE_LABEL = '200KB';
const MAX_FEEDBACK_SCREENSHOT_BYTES = 5 * 1024 * 1024;
const MAX_FEEDBACK_SCREENSHOT_SIZE_LABEL = '5MB';
const MAX_TOKEN_MULTIPLIER = 1_000_000;

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
        <div className="auth-brand">
          <div className="auth-logo" role="img" aria-label="OAI Platform 标志">
            <svg viewBox="0 0 64 64" aria-hidden="true" focusable="false">
              <defs>
                <linearGradient id="oai-logo-gradient" x1="8" y1="4" x2="56" y2="60" gradientUnits="userSpaceOnUse">
                  <stop stopColor="#5f71e8" />
                  <stop offset="1" stopColor="#8a42c8" />
                </linearGradient>
              </defs>
              <path d="M32 5.5 54.5 18v28L32 58.5 9.5 46V18L32 5.5Z" fill="url(#oai-logo-gradient)" />
              <path d="M21 27.5c0-5.9 4.7-10.5 11-10.5 6.2 0 11 4.6 11 10.5S38.2 38 32 38c-6.3 0-11-4.6-11-10.5Z" fill="none" stroke="white" strokeWidth="4" />
              <path d="M16.5 43.5h31" stroke="white" strokeWidth="4" strokeLinecap="round" opacity=".86" />
            </svg>
          </div>
          <p className="auth-eyebrow">OAI Platform</p>
          <h2>欢迎回来</h2>
          <p className="auth-welcome">继续探索你的 AI 助手</p>
        </div>
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
        <h1>OAI Platform</h1>
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

function FeedbackModal({ onClose }: { onClose: () => void }) {
  const [content, setContent] = useState('');
  const [screenshot, setScreenshot] = useState<File | null>(null);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const handleScreenshotChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0] ?? null;
    if (!file) {
      setScreenshot(null);
      return;
    }
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
      setScreenshot(null);
      setError('截图仅支持 PNG、JPEG 或 WebP 图片');
      event.target.value = '';
      return;
    }
    if (file.size > MAX_FEEDBACK_SCREENSHOT_BYTES) {
      setScreenshot(null);
      setError(`截图不能超过 ${MAX_FEEDBACK_SCREENSHOT_SIZE_LABEL}`);
      event.target.value = '';
      return;
    }
    setError('');
    setScreenshot(file);
  };

  const handleSubmit = (event: React.SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    const text = content.trim();
    if (!text) {
      setError('请填写意见内容');
      return;
    }

    setSubmitting(true);
    setError('');
    void (async () => {
      try {
        const formData = new FormData();
        formData.append('content', text);
        if (screenshot) {
          formData.append('screenshot', screenshot);
        }
        await api('/feedback', { method: 'POST', body: formData });
        setSuccess('感谢反馈，已提交。');
        setContent('');
        setScreenshot(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : '提交失败，请稍后重试');
      } finally {
        setSubmitting(false);
      }
    })();
  };

  return (
    <div className="modal-overlay" onClick={() => { if (!submitting) onClose(); }}>
      <div className="modal feedback-modal" onClick={(event) => { event.stopPropagation(); }}>
        <h3>意见反馈</h3>
        <p className="input-hint">你的意见会直接进入管理员后台，感谢帮助我们把平台做得更好。</p>
        {error && <p className="error">{error}</p>}
        {success && <p className="success">{success}</p>}
        <form onSubmit={handleSubmit}>
          <label>
            意见内容 <span className="required">*</span>
            <textarea
              value={content}
              onChange={(event) => { setContent(event.target.value); }}
              placeholder="例如：哪里不好用、希望增加什么功能…"
              maxLength={3000}
              rows={6}
              disabled={submitting}
              required
            />
          </label>
          <label>
            截图（选填，最多 {MAX_FEEDBACK_SCREENSHOT_SIZE_LABEL}）
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp"
              onChange={handleScreenshotChange}
              disabled={submitting}
            />
          </label>
          {screenshot && <p className="selected-file">已选择：{screenshot.name}</p>}
          <div className="modal-actions">
            <button type="button" className="secondary" onClick={onClose} disabled={submitting}>关闭</button>
            <button type="submit" disabled={submitting}>{submitting ? '提交中...' : '提交反馈'}</button>
          </div>
        </form>
      </div>
    </div>
  );
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
  loginReward,
}: {
  user: User;
  apps: YiaiApp[];
  account: TokenAccount | null;
  onSelectApp: (slug: string) => void;
  onProfile: () => void;
  onLogout: () => void;
  onLedger: () => void;
  onAdmin: () => void;
  loginReward: LoginReward | null;
}) {
  const roleLabel = user.role === 'admin' ? '管理员' : '用户';
  const [activeTag, setActiveTag] = useState<string>('');
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const tags = [...new Set(apps.flatMap((app) => app.tags ?? []))];
  const visibleApps = activeTag === '' ? apps : apps.filter((app) => (app.tags ?? []).includes(activeTag));

  return (
    <div className="hub-page">
      <header className="hub-header">
        <h1>OAI Platform</h1>
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
           <button className="secondary" onClick={() => { setFeedbackOpen(true); }}>
             意见反馈
           </button>
           <button onClick={onLogout}>退出登录</button>
        </div>
      </header>
      <main className="hub-main">
        <h2>应用中心</h2>
        {loginReward && loginReward.granted_tokens > 0 && (
          <div className="login-reward-notice" role="status">
            <span aria-hidden="true">✦</span>
            <span>连续登录第 {loginReward.streak_days} 天，赠送余额 +{loginReward.granted_tokens.toLocaleString()} Tokens</span>
          </div>
        )}
        {account && (
          <p className="token-hint">
            {account.login_streak_days > 0 ? (
              <>
                已连续登录第 {account.login_streak_days} 天。明天继续登录，第 {account.login_streak_days + 1} 天奖励额度为 {((account.login_streak_days + 1) * account.login_reward_base).toLocaleString()} Tokens；连续登录时每日奖励增加 {account.login_reward_base.toLocaleString()} Tokens，若中断则下次从第 1 天 {account.login_reward_base.toLocaleString()} Tokens 重新计算。仅在登录或当天首次恢复登录状态时发放；实际到账不超过赠送余额的剩余空间，赠送余额最高 {account.gift_tokens_max.toLocaleString()} Tokens。
              </>
            ) : (
              <>
                下次登录从第 1 天开始，奖励额度为 {account.login_reward_base.toLocaleString()} Tokens；连续登录时每日奖励增加 {account.login_reward_base.toLocaleString()} Tokens，若中断则重新从第 1 天计算。仅在登录或当天首次恢复登录状态时发放；实际到账不超过赠送余额的剩余空间，赠送余额最高 {account.gift_tokens_max.toLocaleString()} Tokens。
              </>
            )}
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
      {feedbackOpen && <FeedbackModal onClose={() => { setFeedbackOpen(false); }} />}
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

function ReplyProgress({ phase, startedAt }: { phase: ReplyPhase; startedAt: number | null }) {
  const [elapsedSeconds, setElapsedSeconds] = useState(0);

  useEffect(() => {
    if (phase === 'idle' || startedAt === null) {
      setElapsedSeconds(0);
      return;
    }

    const update = () => {
      setElapsedSeconds(Math.max(0, Math.floor((Date.now() - startedAt) / 1000)));
    };
    update();
    const timer = window.setInterval(update, 1000);
    return () => {
      window.clearInterval(timer);
    };
  }, [phase, startedAt]);

  if (phase === 'idle') {
    return null;
  }

  const isWaiting = phase === 'waiting';
  return (
    <div className={`reply-progress ${isWaiting ? 'waiting' : 'streaming'}`} role="status" aria-live="polite" aria-label="AI 正在回复">
      <span className="reply-progress-orbit" aria-hidden="true"><span /></span>
      <div className="reply-progress-copy">
        <strong>{isWaiting ? '正在连接 AI，等待回复…' : 'AI 正在生成回复…'}</strong>
        <span>已等待 {elapsedSeconds} 秒 · 较长回答可能需要一些时间</span>
      </div>
      <span className="reply-progress-shimmer" aria-hidden="true" />
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
  const [replyPhase, setReplyPhase] = useState<ReplyPhase>('idle');
  const [replyStartedAt, setReplyStartedAt] = useState<number | null>(null);
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
  const [pendingImages, setPendingImages] = useState<PendingImageDraft[]>([]);
  const [imageUploadProgress, setImageUploadProgress] = useState('');
  const messagesRef = useRef<HTMLDivElement>(null);
  const followLatestMessagesRef = useRef(true);
  const abortControllerRef = useRef<AbortController | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const chatInputRef = useRef<HTMLTextAreaElement>(null);
  const supportsImages = bootstrap?.app.supports_images === true;

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
    setReplyPhase('idle');
    setReplyStartedAt(null);
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
    setReplyPhase('idle');
    setReplyStartedAt(null);
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
    const responseText = await response.text();
    let data = {} as { error?: string; id?: string; type?: string; url?: string };
    if (responseText.trim() !== '') {
      try {
        data = JSON.parse(responseText) as { error?: string; id?: string; type?: string; url?: string };
      } catch {
        if (response.ok) {
          throw new Error('上传返回数据格式错误，请检查应用接口配置');
        }
      }
    }
    if (!response.ok && !data.error) {
      if (response.status === 413) {
        throw new Error('单张图片不能超过 ' + MAX_DRAFT_IMAGE_SIZE_LABEL);
      }
      throw new Error('图片上传失败（服务器响应异常，HTTP ' + String(response.status) + '）');
    }
    if (!response.ok) {
      throw new Error(data.error ?? '上传失败');
    }
    if (!data.id) {
      throw new Error('上传返回数据不完整');
    }
    return { id: data.id, type: data.type ?? 'image', ...(data.url ? { url: data.url } : {}) };
  };

  const clearPendingImages = (revokePreviews = true) => {
    setPendingImages((previous) => {
      if (revokePreviews) {
        previous.forEach((draft) => {
          URL.revokeObjectURL(draft.previewUrl);
        });
      }
      return [];
    });
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const handleImageSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!supportsImages) {
      e.target.value = '';
      setError('此应用暂不支持图片');
      return;
    }
    const selectedFiles = Array.from(e.target.files ?? []);
    e.target.value = '';
    if (selectedFiles.length === 0) {
      return;
    }

    const imageFiles = selectedFiles.filter((file) => file.type.startsWith('image/'));
    const oversizedFiles = imageFiles.filter((file) => file.size > MAX_DRAFT_IMAGE_BYTES);
    const filesWithinSizeLimit = imageFiles.filter((file) => file.size <= MAX_DRAFT_IMAGE_BYTES);
    const available = Math.max(0, MAX_DRAFT_IMAGES - pendingImages.length);
    const acceptedFiles = filesWithinSizeLimit.slice(0, available);

    if (acceptedFiles.length > 0) {
      const timestamp = Date.now();
      setPendingImages((previous) => [
        ...previous,
        ...acceptedFiles.map((file, index) => ({
          id: `${String(timestamp)}-${String(index)}-${Math.random().toString(36).slice(2)}`,
          file,
          previewUrl: URL.createObjectURL(file),
        })),
      ]);
    }

    if (imageFiles.length !== selectedFiles.length) {
      setError('仅支持图片文件');
    } else if (oversizedFiles.length > 0) {
      setError('单张图片不能超过 ' + MAX_DRAFT_IMAGE_SIZE_LABEL);
    } else if (acceptedFiles.length !== filesWithinSizeLimit.length) {
      setError(`一次最多选择 ${String(MAX_DRAFT_IMAGES)} 张图片`);
    } else {
      setError('');
    }
  };

  const removePendingImage = (id: string) => {
    setPendingImages((previous) => {
      const draft = previous.find((item) => item.id === id);
      if (draft) {
        URL.revokeObjectURL(draft.previewUrl);
      }
      return previous.filter((item) => item.id !== id);
    });
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
    const imageDrafts = pendingImages;
    if ((!text && imageDrafts.length === 0) || loading) {
      return;
    }
    if (imageDrafts.length > 0 && !supportsImages) {
      setError('此应用暂不支持图片');
      return;
    }
    if (imageDrafts.some((draft) => draft.file.size > MAX_DRAFT_IMAGE_BYTES)) {
      setError('单张图片不能超过 ' + MAX_DRAFT_IMAGE_SIZE_LABEL);
      return;
    }
    if (isBalanceInsufficient) {
      setError('余额不足，请登录领取赠送额度或联系管理员充值');
      return;
    }
    setLoading(true);
    setError('');
    followLatestMessagesRef.current = true;

    let uploadedImages: Array<{ id: string; type: string; url?: string }>;
    try {
      uploadedImages = [];
      for (const [index, draft] of imageDrafts.entries()) {
        setImageUploadProgress(`正在上传图片 ${String(index + 1)}/${String(imageDrafts.length)}...`);
        uploadedImages.push(await uploadImage(draft.file));
      }
    } catch (err) {
      setImageUploadProgress('');
      setError(err instanceof Error ? err.message : '图片上传失败');
      setLoading(false);
      return;
    }
    setImageUploadProgress('');
    setInput('');
    // Keep the preview URLs alive because the just-created user message uses them.
    clearPendingImages(false);

    const userFiles = imageDrafts.length > 0
      ? imageDrafts.map((draft) => ({ type: 'image' as const, url: draft.previewUrl }))
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
    if (uploadedImages.length > 0) {
      body.files = uploadedImages.map((uploaded) => ({
          type: 'image',
          transfer_method: 'local_file',
          upload_file_id: uploaded.id,
        }));
    }

    abortControllerRef.current?.abort();
    abortControllerRef.current = new AbortController();
    setReplyStartedAt(Date.now());
    setReplyPhase('waiting');

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
            setReplyPhase('streaming');
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
            setReplyPhase('streaming');
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
            setReplyPhase('streaming');
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
            setReplyPhase('idle');
            setReplyStartedAt(null);
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
            setReplyPhase('idle');
            setReplyStartedAt(null);
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
            setReplyPhase('idle');
            setReplyStartedAt(null);
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
      setReplyPhase('idle');
      setReplyStartedAt(null);
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
    if (loading || !!inputFormLoadError || isBalanceInsufficient || (!input.trim() && pendingImages.length === 0)) {
      return;
    }
    void handleSend(input);
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
          <ReplyProgress phase={replyPhase} startedAt={replyStartedAt} />
          {supportsImages && pendingImages.length > 0 && (
            <div className="pending-images" data-testid="image-drafts">
              <span className="pending-image-count">已选 {pendingImages.length}/{MAX_DRAFT_IMAGES} 张图片</span>
              {pendingImages.map((draft, index) => (
                <div className="pending-image" key={draft.id}>
                  <img src={draft.previewUrl} alt={`待发送图片 ${String(index + 1)}`} />
                  <button
                    className="secondary remove-image"
                    onClick={() => { removePendingImage(draft.id); }}
                    type="button"
                    disabled={loading}
                    aria-label={`删除已选图片 ${String(index + 1)}`}
                  >
                    ×
                  </button>
                </div>
              ))}
              {imageUploadProgress && <span className="uploading-hint">{imageUploadProgress}</span>}
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
              placeholder={isBalanceInsufficient ? '余额不足，请登录领取赠送额度或联系管理员充值' : '输入问题...'}
              disabled={loading || !!inputFormLoadError}
              enterKeyHint="enter"
              aria-label="聊天输入框"
            />
            {supportsImages && (
              <>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              multiple
              onChange={handleImageSelect}
              style={{ display: 'none' }}
            />
            <button
              type="button"
              className="secondary"
              onClick={() => {
                fileInputRef.current?.click();
              }}
              disabled={loading || !!inputFormLoadError || pendingImages.length >= MAX_DRAFT_IMAGES}
            >
              图片
            </button>
              </>
            )}
            <button
              type="button"
              onClick={sendCurrentInput}
              disabled={
                loading ||
                !!inputFormLoadError ||
                isBalanceInsufficient ||
                (!input.trim() && pendingImages.length === 0)
              }
            >
              {imageUploadProgress || (replyPhase !== 'idle' ? '回复生成中...' : loading ? '发送中...' : '发送')}
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
      return '旧版每日赠送';
    case 'login_streak_gift':
      return '连续登录奖励';
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

function UsageReplyModal({ entry, onClose }: { entry: LedgerEntry; onClose: () => void }) {
  const [reply, setReply] = useState<AdminUsageReply | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    api<AdminUsageReply>(`/admin/usage-records/${entry.id}/ai-reply`)
      .then((data) => {
        if (active) setReply(data);
      })
      .catch((err: unknown) => {
        if (active) setError(err instanceof Error ? err.message : 'AI 详细回复加载失败');
      });
    return () => {
      active = false;
    };
  }, [entry.id]);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal wide usage-reply-modal" onClick={(event) => { event.stopPropagation(); }}>
        <h3>AI 详细回复</h3>
        <dl className="feedback-detail-meta">
          <div><dt>用户</dt><dd>{reply?.username ?? entry.username ?? '-'}</dd></div>
          <div><dt>应用名称</dt><dd>{reply?.app_name ?? entry.app_name ?? '应用已删除'}</dd></div>
          <div><dt>消耗时间</dt><dd>{new Date(reply?.created_at ?? entry.created_at).toLocaleString('zh-CN')}</dd></div>
          <div><dt>扣减 Token</dt><dd>{formatDelta(entry.delta_tokens)}</dd></div>
        </dl>
        {!reply && !error && <p className="input-hint usage-reply-loading">正在读取 AI 回复…</p>}
        {error && <p className="error-banner">{error}</p>}
        {reply && (
          <div className="message assistant usage-reply-message">
            <div className="message-content">
              <div className="bubble">
                <MarkdownMessage content={stripThinkContent(reply.answer)} />
              </div>
            </div>
          </div>
        )}
        <div className="modal-actions">
          <button aria-label="关闭AI详细回复" onClick={onClose}>关闭</button>
        </div>
      </div>
    </div>
  );
}

function AdminLedgerTable({ entries, showUsername = false }: { entries: LedgerEntry[]; showUsername?: boolean }) {
  const [selectedEntry, setSelectedEntry] = useState<LedgerEntry | null>(null);

  return (
    <>
      <div className="admin-ledger-scroll">
        <table className="ledger-table admin-ledger-table">
          <thead>
            <tr>
              <th>时间</th>
              {showUsername && <th>用户</th>}
              <th>类型</th>
              <th>应用名称</th>
              <th>来源余额</th>
              <th>变动 Token</th>
              <th>备注</th>
              <th>AI 回复</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((entry) => (
              <tr key={entry.id}>
                <td>{new Date(entry.created_at).toLocaleString('zh-CN')}</td>
                {showUsername && <td>{entry.username ?? '-'}</td>}
                <td>{formatEntryType(entry.entry_type)}</td>
                <td>{entry.entry_type === 'usage' ? (entry.app_name ?? '应用已删除') : '-'}</td>
                <td>{formatBucket(entry.bucket)}</td>
                <td className={entry.delta_tokens > 0 ? 'positive' : 'negative'}>
                  {formatDelta(entry.delta_tokens)}
                </td>
                <td>{entry.note ?? '-'}</td>
                <td className="admin-ledger-reply-cell">
                  {entry.entry_type !== 'usage' ? '-' : entry.ai_reply_available ? (
                    <button className="secondary" onClick={() => { setSelectedEntry(entry); }}>
                      查看AI详细回复
                    </button>
                  ) : '回复不可用'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {selectedEntry && <UsageReplyModal entry={selectedEntry} onClose={() => { setSelectedEntry(null); }} />}
    </>
  );
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
  const [ledgerLoading, setLedgerLoading] = useState(false);
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
    setLedgerEntries([]);
    setLedgerUserId(userId);
    setLedgerLoading(true);
    try {
      const entries = await api<LedgerEntry[]>(`/admin/users/${userId}/ledger`);
      setLedgerEntries(entries);
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载账本失败');
    } finally {
      setLedgerLoading(false);
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
            {ledgerLoading && <p>加载中...</p>}
            {!ledgerLoading && ledgerEntries.length === 0 && <p className="empty">暂无明细</p>}
            {!ledgerLoading && ledgerEntries.length > 0 && <AdminLedgerTable entries={ledgerEntries} />}
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

type AdminListToggleField = 'enabled' | 'supports_images';

function AdminBooleanSwitch({
  label,
  checked,
  checkedLabel,
  uncheckedLabel,
  onChange,
  updating = false,
  readOnly = false,
}: {
  label: string;
  checked: boolean;
  checkedLabel: string;
  uncheckedLabel: string;
  onChange?: () => void;
  updating?: boolean;
  readOnly?: boolean;
}) {
  const valueLabel = checked ? checkedLabel : uncheckedLabel;

  return (
    <button
      type="button"
      className={`admin-boolean-switch ${checked ? 'is-on' : 'is-off'}`}
      role="switch"
      aria-label={`${label}：${valueLabel}`}
      aria-checked={checked}
      aria-readonly={readOnly || undefined}
      aria-busy={updating || undefined}
      disabled={updating || readOnly}
      onClick={onChange}
      title={readOnly ? '由 YIAI 表单自动识别；点击“同步 YIAI”更新' : `点击切换为 ${checked ? uncheckedLabel : checkedLabel}`}
    >
      <span className="admin-boolean-switch-track">
        <span className="admin-boolean-switch-knob" aria-hidden="true" />
        <span className="admin-boolean-switch-value">{valueLabel}</span>
      </span>
    </button>
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
  const [togglingKey, setTogglingKey] = useState<string | null>(null);
  const [createForm, setCreateForm] = useState({
    slug: '',
    app_type: 'chatflow' as 'chatflow' | 'agent',
    api_base_url: 'https://yiai.charprint.com/v1',
    api_key: '',
    agent_input_form: '[]',
    enabled: true,
    supports_images: false,
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
            supports_images: createForm.supports_images,
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
          supports_images: false,
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

  const handleListToggle = (app: AdminApp, field: AdminListToggleField) => {
    const nextValue = !app[field];
    const key = `${app.id}:${field}`;
    const fieldLabel = field === 'enabled' ? '启用状态' : '图片上传';
    setError('');
    setMessage('');
    setTogglingKey(key);

    void (async () => {
      try {
        await api<Partial<AdminApp>>(`/admin/apps/${app.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ [field]: nextValue }),
        });
        setApps((previous) => previous.map((item) => (
          item.id === app.id ? { ...item, [field]: nextValue } : item
        )));
        setMessage(`已${nextValue ? '开启' : '关闭'}「${app.name || app.slug}」的${fieldLabel}`);
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : '更新应用状态失败');
      } finally {
        setTogglingKey(null);
      }
    })();
  };

  const handleSettingsSubmit = (event: React.SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!settingsApp) return;
    const form = event.currentTarget;
    const enabled = (form.elements.namedItem('enabled') as HTMLInputElement).checked;
    const supportsImages = (form.elements.namedItem('supports_images') as HTMLInputElement).checked;
    const name = (form.elements.namedItem('name') as HTMLInputElement).value.trim();
    const description = (form.elements.namedItem('description') as HTMLTextAreaElement).value.trim();
    const icon = (form.elements.namedItem('icon') as HTMLInputElement).value.trim();
    const tags = (form.elements.namedItem('tags') as HTMLInputElement).value
      .split(/[,，]/)
      .map((tag) => tag.trim())
      .filter((tag) => tag !== '');
    const tokenMultiplier = Number((form.elements.namedItem('token_multiplier') as HTMLInputElement).value);
    if (!Number.isInteger(tokenMultiplier) || tokenMultiplier < 1 || tokenMultiplier > MAX_TOKEN_MULTIPLIER) {
      setError('Token 消耗倍率必须是 1 到 1,000,000 的整数');
      return;
    }
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
            supports_images: supportsImages,
            token_multiplier: tokenMultiplier,
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
      {error && !settingsApp && <p className="error-banner">{error}</p>}
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
                <th>支持图片</th>
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
                <td>
                  <div className="admin-status-cell">
                    <AdminBooleanSwitch
                      label={`启用：${app.name || app.slug}`}
                      checked={app.enabled}
                      checkedLabel="已启用"
                      uncheckedLabel="已停用"
                      updating={togglingKey === `${app.id}:enabled`}
                      onChange={() => { handleListToggle(app, 'enabled'); }}
                    />
                  </div>
                </td>
                <td>
                  <div className="admin-status-cell">
                    <AdminBooleanSwitch
                      label={`支持图片：${app.name || app.slug}`}
                      checked={app.supports_images}
                      checkedLabel="支持图片"
                      uncheckedLabel="不支持图片"
                      updating={togglingKey === `${app.id}:supports_images`}
                      onChange={() => { handleListToggle(app, 'supports_images'); }}
                    />
                  </div>
                </td>
                <td>
                  <div className="admin-status-cell">
                    <AdminBooleanSwitch
                      label={`新对话采集：${app.name || app.slug}`}
                      checked={app.requires_new_conversation_inputs}
                      checkedLabel="需要采集"
                      uncheckedLabel="无需采集"
                      readOnly
                    />
                    <small className="admin-status-note">YIAI 自动</small>
                  </div>
                </td>
                <td className="admin-app-actions">
                  <button
                    className="secondary"
                    onClick={() => {
                      setError('');
                      setSettingsApp(app);
                    }}
                  >
                    平台设置
                  </button>
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
                  checked={createForm.supports_images}
                  onChange={(event) => { setCreateForm((previous) => ({ ...previous, supports_images: event.target.checked })); }}
                />
                是否支持图片
              </label>
              <p className="input-hint">开启后，聊天框会显示图片上传按钮；默认关闭。</p>
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
            {error && <p className="error">{error}</p>}
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
              <label>
                Token 消耗倍率（正整数）
                <input
                  name="token_multiplier"
                  type="number"
                  min={1}
                  max={MAX_TOKEN_MULTIPLIER}
                  step={1}
                  defaultValue={settingsApp.token_multiplier}
                  required
                />
              </label>
              <p className="input-hint">
                实际扣减和 AI 回复气泡显示值 = 上游原始 Token × 倍率；只影响保存后的新回复，且同步 YIAI 不会覆盖。
              </p>
              <label className="checkbox">
                <input name="supports_images" type="checkbox" defaultChecked={settingsApp.supports_images} />
                是否支持图片
              </label>
              <p className="input-hint">开启后，聊天框会显示图片上传按钮；关闭后平台会拒绝图片上传和带图消息。</p>
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

function FeedbackScreenshot({ feedbackId }: { feedbackId: string }) {
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    const controller = new AbortController();
    let objectUrl: string | null = null;
    const token = localStorage.getItem(TOKEN_KEY);
    void (async () => {
      try {
        const response = await fetch(`/api/admin/feedback/${feedbackId}/screenshot`, {
          headers: token ? { Authorization: `Bearer ${token}` } : undefined,
          signal: controller.signal,
        });
        if (!response.ok) {
          throw new Error('截图加载失败');
        }
        const blob = await response.blob();
        objectUrl = URL.createObjectURL(blob);
        setImageUrl(objectUrl);
      } catch (err) {
        if (!controller.signal.aborted) {
          setError(err instanceof Error ? err.message : '截图加载失败');
        }
      }
    })();

    return () => {
      controller.abort();
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
      }
    };
  }, [feedbackId]);

  if (error) return <p className="error">{error}</p>;
  if (!imageUrl) return <p className="input-hint">正在加载截图…</p>;
  return <img className="feedback-screenshot" src={imageUrl} alt="用户提交的反馈截图" />;
}

function AdminFeedbackTab() {
  const [feedbacks, setFeedbacks] = useState<FeedbackSummary[]>([]);
  const [selected, setSelected] = useState<FeedbackDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const loadFeedbacks = useCallback(async () => {
    const list = await api<FeedbackSummary[]>('/admin/feedback');
    setFeedbacks(list);
  }, []);

  useEffect(() => {
    setLoading(true);
    loadFeedbacks()
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : '加载反馈失败');
      })
      .finally(() => {
        setLoading(false);
      });
  }, [loadFeedbacks]);

  const openDetail = (feedbackId: string) => {
    setError('');
    void (async () => {
      try {
        setSelected(await api<FeedbackDetail>(`/admin/feedback/${feedbackId}`));
      } catch (err) {
        setError(err instanceof Error ? err.message : '加载反馈详情失败');
      }
    })();
  };

  return (
    <div className="admin-tab feedback-admin-tab">
      {error && <p className="error-banner">{error}</p>}
      {loading && <p>加载中...</p>}
      {!loading && feedbacks.length === 0 && <p className="empty">暂时没有用户反馈。</p>}
      {!loading && feedbacks.length > 0 && (
        <table className="admin-table feedback-table">
          <thead>
            <tr>
              <th>时间</th>
              <th>用户</th>
              <th>内容摘要</th>
              <th>截图</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {feedbacks.map((feedback) => (
              <tr key={feedback.id}>
                <td>{new Date(feedback.created_at).toLocaleString('zh-CN')}</td>
                <td>{feedback.username}</td>
                <td className="feedback-preview">{feedback.content_preview}</td>
                <td>{feedback.has_screenshot ? '有截图' : '无'}</td>
                <td><button className="secondary" onClick={() => { openDetail(feedback.id); }}>查看详情</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {selected && (
        <div className="modal-overlay" onClick={() => { setSelected(null); }}>
          <div className="modal wide feedback-detail-modal" onClick={(event) => { event.stopPropagation(); }}>
            <h3>用户反馈详情</h3>
            <dl className="feedback-detail-meta">
              <div><dt>提交用户</dt><dd>{selected.username}</dd></div>
              <div><dt>提交时间</dt><dd>{new Date(selected.created_at).toLocaleString('zh-CN')}</dd></div>
            </dl>
            <p className="feedback-detail-content">{selected.content}</p>
            {selected.has_screenshot && <FeedbackScreenshot feedbackId={selected.id} />}
            <div className="modal-actions">
              <button onClick={() => { setSelected(null); }}>关闭</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function AdminUsageTab() {
  const [pageData, setPageData] = useState<AdminUsagePage>({ items: [], total: 0, page: 1, page_size: 50 });
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError('');
    api<AdminUsagePage>(`/admin/usage-records?page=${String(page)}&page_size=50`)
      .then((data) => {
        if (active) setPageData(data);
      })
      .catch((err: unknown) => {
        if (active) setError(err instanceof Error ? err.message : '全部消耗记录加载失败');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [page]);

  const totalPages = Math.max(1, Math.ceil(pageData.total / pageData.page_size));

  return (
    <div className="admin-tab admin-usage-tab">
      {error && <p className="error-banner">{error}</p>}
      {loading && <p>加载中...</p>}
      {!loading && pageData.items.length === 0 && <p className="empty">暂无 Token 消耗记录。</p>}
      {!loading && pageData.items.length > 0 && (
        <>
          <AdminLedgerTable entries={pageData.items} showUsername />
          <div className="admin-usage-pagination">
            <span>共 {pageData.total.toLocaleString()} 条</span>
            <button className="secondary" disabled={page <= 1} onClick={() => { setPage((value) => value - 1); }}>
              上一页
            </button>
            <span>第 {page} / {totalPages} 页</span>
            <button className="secondary" disabled={page >= totalPages} onClick={() => { setPage((value) => value + 1); }}>
              下一页
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function AdminPage({ onBack }: { onBack: () => void }) {
  const [tab, setTab] = useState<'users' | 'apps' | 'feedback' | 'usage'>('users');

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
        <button className={tab === 'feedback' ? 'active' : ''} onClick={() => { setTab('feedback'); }}>
          意见反馈
        </button>
        <button className={tab === 'usage' ? 'active' : ''} onClick={() => { setTab('usage'); }}>
          全部消耗记录
        </button>
      </nav>
      <main className="admin-main">
        {tab === 'users' && <AdminUsersTab />}
        {tab === 'apps' && <AdminAppsTab />}
        {tab === 'feedback' && <AdminFeedbackTab />}
        {tab === 'usage' && <AdminUsageTab />}
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
  const [loginReward, setLoginReward] = useState<LoginReward | null>(null);

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
      .then(async (me) => {
        setUser(me);
        const [list, rewardResult] = await Promise.all([
          api<YiaiApp[]>('/apps'),
          api<{ login_reward: LoginReward }>('/auth/login-reward', { method: 'POST' })
            .catch(() => null),
        ]);
        const restoredReward = rewardResult?.login_reward;
        const loginReward: LoginReward | null = restoredReward &&
          typeof restoredReward.streak_days === 'number' &&
          typeof restoredReward.reward_tokens === 'number' &&
          typeof restoredReward.granted_tokens === 'number'
          ? restoredReward
          : null;
        return { list, loginReward };
      })
      .then(({ list, loginReward: restoredLoginReward }) => {
        setApps(list);
        const grantedTokens = restoredLoginReward?.granted_tokens ?? 0;
        if (grantedTokens > 0) {
          setLoginReward({
            streak_days: restoredLoginReward?.streak_days ?? 0,
            reward_tokens: restoredLoginReward?.reward_tokens ?? grantedTokens,
            granted_tokens: grantedTokens,
          });
        }
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
    setLoginReward(res.login_reward ?? null);
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
    setLoginReward(null);
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
           loginReward={loginReward}
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
