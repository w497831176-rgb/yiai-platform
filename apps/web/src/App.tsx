import { useCallback, useEffect, useRef, useState } from 'react';
import './App.css';

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
}

interface ChatMessage {
  id?: string;
  role: 'user' | 'assistant';
  content: string;
  files?: YiaiMessageFile[];
  usage?: number;
}

type View =
  | { type: 'login' }
  | { type: 'register' }
  | { type: 'profile' }
  | { type: 'hub' }
  | { type: 'chat'; slug: string };

const TOKEN_KEY = 'yiai_token';

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
    throw new Error(data.error ?? 'Request failed');
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
        setError(err instanceof Error ? err.message : 'Login failed');
      } finally {
        setLoading(false);
      }
    })();
  };

  return (
    <div className="auth-page">
      <form className="auth-form" onSubmit={handleSubmit}>
        <h2>Login</h2>
        {error && <p className="error">{error}</p>}
        <label>
          Username
          <input
            type="text"
            value={username}
            onChange={(e) => {
              setUsername(e.target.value);
            }}
            minLength={3}
            required
          />
        </label>
        <label>
          Password
          <input
            type="password"
            value={password}
            onChange={(e) => {
              setPassword(e.target.value);
            }}
            minLength={6}
            required
          />
        </label>
        <button type="submit" disabled={loading}>
          {loading ? 'Logging in...' : 'Login'}
        </button>
        <p>
          No account?{' '}
          <button type="button" className="link" onClick={onSwitch}>
            Register
          </button>
        </p>
      </form>
    </div>
  );
}

function RegisterPage({ onLogin, onSwitch }: { onLogin: (res: AuthResponse) => void; onSwitch: () => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const handleSubmit = (e: React.SyntheticEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError('');
    setSuccess('');
    setLoading(true);
    void (async () => {
      try {
        await api('/auth/register', {
          method: 'POST',
          body: JSON.stringify({ username, password }),
        });
        setSuccess('Registration successful, logging in...');
        const res = await api<AuthResponse>('/auth/login', {
          method: 'POST',
          body: JSON.stringify({ username, password }),
        });
        onLogin(res);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Registration failed');
      } finally {
        setLoading(false);
      }
    })();
  };

  return (
    <div className="auth-page">
      <form className="auth-form" onSubmit={handleSubmit}>
        <h2>Register</h2>
        {error && <p className="error">{error}</p>}
        {success && <p className="success">{success}</p>}
        <label>
          Username
          <input
            type="text"
            value={username}
            onChange={(e) => {
              setUsername(e.target.value);
            }}
            minLength={3}
            required
          />
        </label>
        <label>
          Password
          <input
            type="password"
            value={password}
            onChange={(e) => {
              setPassword(e.target.value);
            }}
            minLength={6}
            required
          />
        </label>
        <button type="submit" disabled={loading}>
          {loading ? 'Registering...' : 'Register'}
        </button>
        <p>
          Already have an account?{' '}
          <button type="button" className="link" onClick={onSwitch}>
            Login
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
        setMessage('Password updated. Please log in again.');
        setTimeout(() => {
          onLogout();
        }, 1500);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to change password');
      } finally {
        setLoading(false);
      }
    })();
  };

  return (
    <div className="profile-page">
      <header className="profile-header">
        <h1>YIAI Platform</h1>
        <div className="user-info">
          <button className="secondary" onClick={onBack}>
            Back
          </button>
          <span>
            {user.username} ({user.role})
          </span>
          <button onClick={onLogout}>Logout</button>
        </div>
      </header>

      <main className="profile-main">
        <section className="change-password">
          <h3>Change Password</h3>
          {error && <p className="error">{error}</p>}
          {message && <p className="success">{message}</p>}
          <form onSubmit={handleChangePassword}>
            <label>
              Current Password
              <input
                type="password"
                value={currentPassword}
                onChange={(e) => {
                  setCurrentPassword(e.target.value);
                }}
                minLength={6}
                required
              />
            </label>
            <label>
              New Password
              <input
                type="password"
                value={newPassword}
                onChange={(e) => {
                  setNewPassword(e.target.value);
                }}
                minLength={6}
                required
              />
            </label>
            <button type="submit" disabled={loading}>
              {loading ? 'Updating...' : 'Update Password'}
            </button>
          </form>
        </section>
      </main>
    </div>
  );
}

function AppHub({
  user,
  apps,
  onSelectApp,
  onProfile,
  onLogout,
}: {
  user: User;
  apps: YiaiApp[];
  onSelectApp: (slug: string) => void;
  onProfile: () => void;
  onLogout: () => void;
}) {
  return (
    <div className="hub-page">
      <header className="hub-header">
        <h1>YIAI Platform</h1>
        <div className="user-actions">
          <span>
            {user.username} ({user.role})
          </span>
          <button className="secondary" onClick={onProfile}>
            Profile
          </button>
          <button onClick={onLogout}>Logout</button>
        </div>
      </header>
      <main className="hub-main">
        <h2>应用中心</h2>
        <div className="app-grid">
          {apps.map((app) => (
            <button key={app.id} className="app-card" onClick={() => { onSelectApp(app.slug); }}>
              <div className="app-icon">{app.icon ?? '🤖'}</div>
              <h3>{app.name}</h3>
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

function ChatPage({
  slug,
  user: _user,
  onBack,
  onLogout,
}: {
  slug: string;
  user: User;
  onBack: () => void;
  onLogout: () => void;
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
  const [usage, setUsage] = useState<number | undefined>(undefined);
  const messagesEndRef = useRef<HTMLDivElement>(null);

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
      setError(err instanceof Error ? err.message : 'Failed to load conversations');
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
          id: `${msg.id}-answer`,
          role: 'assistant',
          content: msg.answer,
          files: msg.message_files ?? undefined,
        });
      }
      setMessages(loaded);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load messages');
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
        await loadMessages(latest.id);
      } else if (bs.app.requires_new_conversation_inputs) {
        setShowInputForm(true);
      } else {
        setMessages([]);
        setActiveConversationId(undefined);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load app');
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
    setUsage(undefined);
    setPendingInputs(undefined);

    if (bootstrap?.app.requires_new_conversation_inputs) {
      setShowInputForm(true);
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

  const handleSend = (query: string) => {
    if (!query.trim() || loading) return;

    setLoading(true);
    setError('');
    setUsage(undefined);

    const userMessage: ChatMessage = { role: 'user', content: query.trim() };
    const assistantMessage: ChatMessage = { role: 'assistant', content: '' };
    setMessages((prev) => [...prev, userMessage, assistantMessage]);

    const token = localStorage.getItem(TOKEN_KEY);
    const body: Record<string, unknown> = {
      query: query.trim(),
      inputs: pendingInputs ?? {},
    };
    if (activeConversationId) {
      body.conversation_id = activeConversationId;
    }

    const eventSource = new EventSource(`/api/apps/${slug}/chat`, {
      fetch: (input: RequestInfo | URL, init: RequestInit | undefined) =>
        fetch(input, {
          ...init,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: token ? `Bearer ${token}` : '',
          },
          body: JSON.stringify(body),
        }),
    } as EventSourceInit);

    eventSource.onmessage = (event: MessageEvent<string>) => {
      try {
        const data = JSON.parse(event.data) as { event: string; answer?: string; url?: string; type?: string; conversation_id?: string; message_id?: string; metadata?: { usage?: { total_tokens?: number } } };

        if (data.event === 'message') {
          setMessages((prev) => {
            const next = [...prev];
            const last = next[next.length - 1];
            if (last.role === 'assistant') {
              last.content += data.answer ?? '';
            }
            return next;
          });
        } else if (data.event === 'message_file') {
          setMessages((prev) => {
            const next = [...prev];
            const last = next[next.length - 1];
            if (last.role === 'assistant' && data.url) {
              last.files = [...(last.files ?? []), { type: data.type ?? 'image', url: data.url }];
            }
            return next;
          });
        } else if (data.event === 'message_end') {
          if (data.conversation_id && !activeConversationId) {
            setActiveConversationId(data.conversation_id);
            void loadConversations();
          }
          const totalTokens = data.metadata?.usage?.total_tokens;
          if (typeof totalTokens === 'number') {
            setUsage(totalTokens);
          }
          eventSource.close();
          setLoading(false);
        } else if (data.event === 'error') {
          setError('Chat error');
          eventSource.close();
          setLoading(false);
        }
      } catch {
        // Ignore malformed events
      }
    };

    eventSource.onerror = () => {
      eventSource.close();
      setLoading(false);
    };
  };

  const handleSuggestedQuestion = (question: string) => {
    handleSend(question);
  };

  return (
    <div className="chat-page">
      <header className="chat-header">
        <button className="secondary" onClick={onBack}>
          ← 应用中心
        </button>
        <div className="chat-title">
          <span className="chat-icon">{bootstrap?.app.icon ?? '🤖'}</span>
          <span>{bootstrap?.app.name ?? slug}</span>
        </div>
        <div className="chat-actions">
          <button className="secondary" onClick={startNewConversation} disabled={loading}>
            新建对话
          </button>
          <button onClick={onLogout}>Logout</button>
        </div>
      </header>

      <aside className="chat-sidebar">
        <h4>最近会话</h4>
        {conversations.length === 0 && <p className="empty">暂无会话</p>}
        <ul>
          {conversations.map((conv) => (
            <li
              key={conv.id}
              className={conv.id === activeConversationId ? 'active' : ''}
              onClick={() => {
                setActiveConversationId(conv.id);
                setPendingInputs(conv.inputs);
                setUsage(undefined);
                void loadMessages(conv.id);
              }}
            >
              {conv.name}
            </li>
          ))}
        </ul>
      </aside>

      <main className="chat-main">
        {error && <p className="error-banner">{error}</p>}

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
              <div className="bubble">
                {msg.content}
                {msg.files && msg.files.length > 0 && (
                  <div className="message-files">
                    {msg.files.map((file, fidx) => (
                      <img key={fidx} src={file.url} alt="message file" />
                    ))}
                  </div>
                )}
              </div>
            </div>
          ))}
          {usage !== undefined && (
            <div className="usage">
              本次消耗：{usage} Tokens
            </div>
          )}
          <div ref={messagesEndRef} />
        </div>

        <form
          className="input-bar"
          onSubmit={(e) => {
            e.preventDefault();
            handleSend(input);
            setInput('');
          }}
        >
          <input
            type="text"
            value={input}
            onChange={(e) => {
              setInput(e.target.value);
            }}
            placeholder="输入问题..."
            disabled={loading}
          />
          <button type="submit" disabled={loading || !input.trim()}>
            {loading ? '发送中...' : '发送'}
          </button>
        </form>
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

function App() {
  const [view, setView] = useState<View>({ type: 'login' });
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [apps, setApps] = useState<YiaiApp[]>([]);

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
      })
      .catch(() => {
        localStorage.removeItem(TOKEN_KEY);
      })
      .finally(() => {
        setLoading(false);
      });
  }, []);

  const handleLogin = (res: AuthResponse) => {
    localStorage.setItem(TOKEN_KEY, res.token);
    setUser(res.user);
    void (async () => {
      try {
        const list = await api<YiaiApp[]>('/apps');
        setApps(list);
        setView({ type: 'hub' });
      } catch {
        setView({ type: 'hub' });
      }
    })();
  };

  const handleLogout = () => {
    localStorage.removeItem(TOKEN_KEY);
    setUser(null);
    setApps([]);
    setView({ type: 'login' });
  };

  if (loading) {
    return (
      <div className="app">
        <p>Loading...</p>
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
      {view.type === 'hub' && user && (
        <AppHub
          user={user}
          apps={apps}
          onSelectApp={(slug) => { setView({ type: 'chat', slug }); }}
          onProfile={() => { setView({ type: 'profile' }); }}
          onLogout={handleLogout}
        />
      )}
      {view.type === 'chat' && user && (
        <ChatPage slug={view.slug} user={user} onBack={() => { setView({ type: 'hub' }); }} onLogout={handleLogout} />
      )}
    </div>
  );
}

export default App;
