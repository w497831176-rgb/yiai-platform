import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import App, { AppIcon, ChatPage } from './App';

const TOKEN_KEY = 'yiai_token';

type FetchFn = (input: string | Request, init?: RequestInit) => Promise<Response>;

describe('App', () => {
  it('renders the login page by default', () => {
    render(<App />);

    expect(screen.getByRole('heading', { name: '登录' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '登录' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '注册' })).toBeInTheDocument();
  });
});

describe('AppHub', () => {
  const fetchMock = vi.fn<FetchFn>((input, init) => {
    const url = typeof input === 'string' ? input : input.url;
    const method = init?.method ?? 'GET';

    if (url.endsWith('/auth/me')) {
      return Promise.resolve(
        new Response(JSON.stringify({ id: 'user-1', username: 'tester', role: 'user' }))
      );
    }

    if (url.endsWith('/token-account')) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            gift_tokens: 100,
            recharge_tokens: 50,
            daily_gift_amount: 10,
            gift_tokens_max: 200,
            last_gift_date: null,
          })
        )
      );
    }

    if (url.endsWith('/apps') && method === 'GET') {
      return Promise.resolve(
        new Response(
          JSON.stringify([
            {
              id: 'app-1',
              slug: 'test-app',
              name: 'Test App',
              description: '测试应用说明',
              icon: null,
              icon_type: null,
              icon_url: null,
              icon_background: null,
              sort_order: 1,
              supports_images: false,
              requires_new_conversation_inputs: false,
            },
          ])
        )
      );
    }

    return Promise.reject(new Error(`Unexpected fetch: ${method} ${url}`));
  });

  beforeEach(() => {
    fetchMock.mockClear();
    vi.stubGlobal('fetch', fetchMock);
    localStorage.setItem(TOKEN_KEY, 'test-token');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.removeItem(TOKEN_KEY);
  });

  it('renders app names and descriptions from /api/apps', async () => {
    render(<App />);

    await waitFor(() => {
      expect(screen.getByText('应用中心')).toBeInTheDocument();
    });

    expect(screen.getByText('Test App')).toBeInTheDocument();
    expect(screen.getByText('测试应用说明')).toBeInTheDocument();
  });

  it('filters app cards by tags', async () => {
    const originalMock = fetchMock.getMockImplementation();
    fetchMock.mockImplementation((input, init) => {
      const url = typeof input === 'string' ? input : input.url;
      const method = init?.method ?? 'GET';
      if (url.endsWith('/apps') && method === 'GET') {
        return Promise.resolve(
          new Response(JSON.stringify([
            {
              id: 'tag-app-1', slug: 'philosophy-app', name: 'Philosophy App', description: null,
              icon: null, icon_type: null, icon_url: null, icon_background: null,
              tags: ['哲学'], sort_order: 1, requires_new_conversation_inputs: false,
            },
            {
              id: 'tag-app-2', slug: 'classics-app', name: 'Classics App', description: null,
              icon: null, icon_type: null, icon_url: null, icon_background: null,
              tags: ['国学'], sort_order: 2, requires_new_conversation_inputs: false,
            },
          ]))
        );
      }
      return originalMock?.(input, init) ?? Promise.reject(new Error(`Unexpected fetch: ${method} ${url}`));
    });

    render(<App />);
    await waitFor(() => {
      expect(screen.getByText('Philosophy App')).toBeInTheDocument();
      expect(screen.getByText('Classics App')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: '哲学' }));
    expect(screen.getByText('Philosophy App')).toBeInTheDocument();
    expect(screen.queryByText('Classics App')).not.toBeInTheDocument();
  });

  it('falls back to slug when app name is empty', async () => {
    const originalMock = fetchMock.getMockImplementation();
    fetchMock.mockImplementation((input, init) => {
      const url = typeof input === 'string' ? input : input.url;
      const method = init?.method ?? 'GET';
      if (url.endsWith('/apps') && method === 'GET') {
        return Promise.resolve(
          new Response(
            JSON.stringify([
              {
                id: 'app-2',
                slug: 'fallback-slug',
                name: '',
                description: '说明',
                icon: null,
                icon_type: null,
                icon_url: null,
                icon_background: null,
                sort_order: 1,
                requires_new_conversation_inputs: false,
              },
            ])
          )
        );
      }
      return originalMock?.(input, init) ?? Promise.reject(new Error(`Unexpected fetch: ${method} ${url}`));
    });

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText('应用中心')).toBeInTheDocument();
    });

    expect(screen.getByText('fallback-slug')).toBeInTheDocument();
    expect(screen.getByText('说明')).toBeInTheDocument();
  });

  it('shows only gift and recharge balances, no total balance', async () => {
    render(<App />);

    await waitFor(() => {
      expect(screen.getByText('应用中心')).toBeInTheDocument();
    });

    expect(screen.getByText('赠送余额 100')).toBeInTheDocument();
    expect(screen.getByText('充值余额 50')).toBeInTheDocument();
    expect(screen.queryByText(/可用/)).not.toBeInTheDocument();
    expect(screen.queryByText(/总余额/)).not.toBeInTheDocument();
    expect(screen.queryByText(/总计/)).not.toBeInTheDocument();
  });
});

describe('AdminAppsTab', () => {
  const fetchMock = vi.fn<FetchFn>((input, init) => {
    const url = typeof input === 'string' ? input : input.url;
    const method = init?.method ?? 'GET';

    if (url.endsWith('/auth/me')) {
      return Promise.resolve(
        new Response(JSON.stringify({ id: 'admin-1', username: 'admin', role: 'admin' }))
      );
    }

    if (url.endsWith('/token-account')) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            gift_tokens: 100,
            recharge_tokens: 50,
            daily_gift_amount: 10,
            gift_tokens_max: 200,
            last_gift_date: null,
          })
        )
      );
    }

    if (url.endsWith('/admin/apps') && method === 'GET') {
      return Promise.resolve(
        new Response(
          JSON.stringify([
            {
              id: 'app-1',
              slug: 'test-app',
              name: 'Test App',
              description: null,
              icon: null,
              icon_type: null,
              icon_url: null,
              icon_background: null,
              api_base_url: 'https://yiai.example.com/v1',
              api_key_configured: true,
              api_key_preview: 'test-k…-key',
              enabled: true,
              supports_images: false,
              sort_order: 1,
              requires_new_conversation_inputs: false,
            },
            {
              id: 'app-2',
              slug: 'input-app',
              name: 'Input App',
              description: null,
              icon: null,
              icon_type: null,
              icon_url: null,
              icon_background: null,
              api_base_url: 'https://yiai.example.com/v1',
              api_key_configured: true,
              api_key_preview: 'input-…-key',
              enabled: true,
              supports_images: true,
              sort_order: 2,
              requires_new_conversation_inputs: true,
            },
          ])
        )
      );
    }

    if (url.endsWith('/apps') && method === 'GET' && !url.includes('/admin')) {
      return Promise.resolve(
        new Response(
          JSON.stringify([
            {
              id: 'app-1',
              slug: 'test-app',
              name: 'Test App',
              description: null,
              icon: null,
              icon_type: null,
              icon_url: null,
              icon_background: null,
              sort_order: 1,
              requires_new_conversation_inputs: false,
            },
          ])
        )
      );
    }

    if (url.endsWith('/admin/apps') && method === 'POST') {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            id: 'app-new',
            slug: 'new-app',
            name: 'New App',
          })
        )
      );
    }

    if (url.endsWith('/admin/apps/app-1/sync') && method === 'POST') {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            id: 'app-1',
            slug: 'test-app',
            name: 'Test App',
          })
        )
      );
    }

    if (url.endsWith('/admin/apps/app-1') && method === 'PATCH') {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            id: 'app-1',
            slug: 'test-app',
            name: 'Test App Updated',
          })
        )
      );
    }

    if (url.endsWith('/admin/apps/app-1') && method === 'DELETE') {
      return Promise.resolve(
        new Response(JSON.stringify({ id: 'app-1', slug: 'test-app', deleted: true }))
      );
    }

    if (url.endsWith('/admin/apps/app-1/connection') && method === 'PUT') {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            id: 'app-1',
            slug: 'test-app',
            name: 'Verified App',
          })
        )
      );
    }

    return Promise.reject(new Error(`Unexpected fetch: ${method} ${url}`));
  });

  beforeEach(() => {
    fetchMock.mockClear();
    vi.stubGlobal('fetch', fetchMock);
    localStorage.setItem(TOKEN_KEY, 'admin-token');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.removeItem(TOKEN_KEY);
  });

  it('has "新增应用" button and submits a Chatflow body', async () => {
    render(<App />);

    await waitFor(() => {
      expect(screen.getByText('应用中心')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: '管理后台' }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: '应用管理' })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: '应用管理' }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: '新增应用' })).toBeInTheDocument();
    });
    expect(screen.getByText('test-k…-key')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '新增应用' }));

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: '新增应用' })).toBeInTheDocument();
    });

    fireEvent.change(screen.getByLabelText('平台应用标识 slug'), { target: { value: 'new-app' } });
    fireEvent.change(screen.getByLabelText('YIAI API Base URL'), {
      target: { value: 'https://yiai.example.com/v1' },
    });
    fireEvent.change(screen.getByLabelText('YIAI API Key'), {
      target: { value: 'secret-api-key' },
    });
    fireEvent.click(screen.getByRole('button', { name: '验证并创建' }));

    await waitFor(() => {
      const createCall = fetchMock.mock.calls.find(([url, init]) => {
        const callUrl = typeof url === 'string' ? url : url.url;
        const callMethod = init?.method ?? 'GET';
        return callUrl.endsWith('/admin/apps') && callMethod === 'POST';
      });
      expect(createCall).toBeDefined();
      if (!createCall) return;
      const [, init] = createCall;
      const body = JSON.parse(init?.body as string) as Record<string, unknown>;
      expect(body.slug).toBe('new-app');
      expect(body.api_base_url).toBe('https://yiai.example.com/v1');
      expect(body.api_key).toBe('secret-api-key');
      expect(body.app_type).toBe('chatflow');
      expect(body).not.toHaveProperty('sort_order');
      expect(body.enabled).toBe(true);
      expect(body.supports_images).toBe(false);
      expect(body).not.toHaveProperty('requires_new_conversation_inputs');
    });

    await waitFor(() => {
      expect(screen.getByText('应用已创建，并已从 YIAI 同步信息')).toBeInTheDocument();
    });
  });

  it('switches the create form to Agent without leaving the admin page', async () => {
    render(<App />);

    await waitFor(() => {
      expect(screen.getByText('应用中心')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: '管理后台' }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '应用管理' })).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: '应用管理' }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '新增应用' })).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: '新增应用' }));
    fireEvent.click(screen.getByRole('button', { name: 'Agent' }));

    expect(screen.getByText('Agent 新对话信息表单（JSON 数组，可留空）')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '新增应用' })).toBeInTheDocument();
  });

  it('confirms before deleting an application from the admin list', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<App />);

    await waitFor(() => {
      expect(screen.getByText('应用中心')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: '管理后台' }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '应用管理' })).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: '应用管理' }));

    await waitFor(() => {
      expect(screen.getAllByRole('button', { name: '删除' })).toHaveLength(2);
    });
    fireEvent.click(screen.getAllByRole('button', { name: '删除' })[0]);

    expect(confirmSpy).toHaveBeenCalledWith('确定删除「Test App」吗？这会删除该应用及其使用记录，且无法恢复。');
    await waitFor(() => {
      const deleteCall = fetchMock.mock.calls.find(([url, init]) => {
        const callUrl = typeof url === 'string' ? url : url.url;
        return callUrl.endsWith('/admin/apps/app-1') && init?.method === 'DELETE';
      });
      expect(deleteCall).toBeDefined();
    });
    confirmSpy.mockRestore();
  });

  it.skip('shows sync button for existing apps', async () => {
    render(<App />);

    await waitFor(() => {
      expect(screen.getByText('应用中心')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: '管理后台' }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: '应用管理' })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: '应用管理' }));

    await waitFor(() => {
      expect(screen.getAllByRole('button', { name: '同步 YIAI 信息' }).length).toBeGreaterThan(0);
    });
  });

  it.skip('sync button triggers POST and refreshes list', async () => {
    render(<App />);

    await waitFor(() => {
      expect(screen.getByText('应用中心')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: '管理后台' }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: '应用管理' })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: '应用管理' }));

    await waitFor(() => {
      expect(screen.getAllByRole('button', { name: '同步 YIAI 信息' }).length).toBeGreaterThan(0);
    });

    fireEvent.click(screen.getAllByRole('button', { name: '同步 YIAI 信息' })[0]);

    await waitFor(() => {
      const syncCall = fetchMock.mock.calls.find(([url, init]) => {
        const callUrl = typeof url === 'string' ? url : url.url;
        const callMethod = init?.method ?? 'GET';
        return callUrl.endsWith('/admin/apps/app-1/sync') && callMethod === 'POST';
      });
      expect(syncCall).toBeDefined();
    });

    await waitFor(() => {
      expect(screen.getByText('应用同步成功')).toBeInTheDocument();
    });
  });

  it.skip('shows input collection status labels in app list', async () => {
    render(<App />);

    await waitFor(() => {
      expect(screen.getByText('应用中心')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: '管理后台' }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: '应用管理' })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: '应用管理' }));

    await waitFor(() => {
      expect(screen.getByText('无需采集')).toBeInTheDocument();
      expect(screen.getByText('新对话采集信息')).toBeInTheDocument();
    });
  });

  it.skip('edit modal shows disabled checkbox and hint text', async () => {
    render(<App />);

    await waitFor(() => {
      expect(screen.getByText('应用中心')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: '管理后台' }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: '应用管理' })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: '应用管理' }));

    await waitFor(() => {
      expect(screen.getAllByRole('button', { name: '编辑' })[0]).toBeInTheDocument();
    });

    fireEvent.click(screen.getAllByRole('button', { name: '编辑' })[0]);

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: '编辑应用：test-app' })).toBeInTheDocument();
    });

    expect(
      screen.getByText('由 YIAI Chatflow 的用户输入表单自动识别；请点击“同步 YIAI 信息”更新。')
    ).toBeInTheDocument();

    const checkbox = screen.getByRole('checkbox', { name: '每次新对话采集用户信息' });
    expect(checkbox).toBeDisabled();
    expect(checkbox).not.toBeChecked();
  });

  it.skip('edit form submit does not send requires_new_conversation_inputs', async () => {
    render(<App />);

    await waitFor(() => {
      expect(screen.getByText('应用中心')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: '管理后台' }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: '应用管理' })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: '应用管理' }));

    await waitFor(() => {
      expect(screen.getAllByRole('button', { name: '编辑' })[0]).toBeInTheDocument();
    });

    fireEvent.click(screen.getAllByRole('button', { name: '编辑' })[0]);

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: '编辑应用：test-app' })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => {
      const patchCall = fetchMock.mock.calls.find(([url, init]) => {
        const callUrl = typeof url === 'string' ? url : url.url;
        const callMethod = init?.method ?? 'GET';
        return callUrl.endsWith('/admin/apps/app-1') && callMethod === 'PATCH';
      });
      expect(patchCall).toBeDefined();
      if (!patchCall) return;
      const [, init] = patchCall;
      const body = JSON.parse(init?.body as string) as Record<string, unknown>;
      expect(body).not.toHaveProperty('requires_new_conversation_inputs');
    });

    await waitFor(() => {
      expect(screen.getByText('应用 test-app 已更新')).toBeInTheDocument();
    });
  });

  it('edits platform-managed metadata and tags through platform settings', async () => {
    render(<App />);

    await waitFor(() => {
      expect(screen.getByText('应用中心')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: '管理后台' }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '应用管理' })).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: '应用管理' }));

    await waitFor(() => {
      expect(screen.getAllByRole('button', { name: '平台设置' })).toHaveLength(2);
    });
    fireEvent.click(screen.getAllByRole('button', { name: '平台设置' })[0]);

    expect(screen.getByRole('heading', { name: '平台设置：Test App' })).toBeInTheDocument();
    const supportsImages = screen.getByRole('checkbox', { name: '是否支持图片' });
    expect(supportsImages).not.toBeChecked();
    fireEvent.click(supportsImages);
    fireEvent.change(screen.getByLabelText('应用名称'), { target: { value: 'Renamed App' } });
    fireEvent.change(screen.getByLabelText('应用说明'), { target: { value: 'Platform description' } });
    fireEvent.change(screen.getByLabelText('图标（Emoji 或图片地址）'), { target: { value: '🧠' } });
    fireEvent.change(screen.getByLabelText('标签（用逗号分隔）'), { target: { value: '哲学，国学' } });
    fireEvent.click(screen.getByRole('button', { name: '保存应用设置' }));

    await waitFor(() => {
      const patchCall = fetchMock.mock.calls.find(([url, init]) => {
        const callUrl = typeof url === 'string' ? url : url.url;
        return callUrl.endsWith('/admin/apps/app-1') && init?.method === 'PATCH';
      });
      expect(patchCall).toBeDefined();
      const [, init] = patchCall as [string | Request, RequestInit];
      const body = JSON.parse(init.body as string) as Record<string, unknown>;
      expect(body).toEqual({
        enabled: true,
        supports_images: true,
        name: 'Renamed App',
        description: 'Platform description',
        icon: '🧠',
        tags: ['哲学', '国学'],
      });
    });
  });

  it('uses direct labeled switches for enabled and image support, while keeping input collection automatic', async () => {
    render(<App />);

    await waitFor(() => {
      expect(screen.getByText('应用中心')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: '管理后台' }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '应用管理' })).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: '应用管理' }));

    const enabledSwitch = await screen.findByRole('switch', { name: '启用：Test App：已启用' });
    const imageSwitch = screen.getByRole('switch', { name: '支持图片：Test App：不支持图片' });
    const collectionSwitch = screen.getByRole('switch', { name: '新对话采集：Input App：需要采集' });

    expect(enabledSwitch).toHaveAttribute('aria-checked', 'true');
    expect(imageSwitch).toHaveAttribute('aria-checked', 'false');
    expect(collectionSwitch).toBeDisabled();
    expect(collectionSwitch).toHaveAttribute('aria-readonly', 'true');
    expect(screen.getAllByText('YIAI 自动')).toHaveLength(2);

    fireEvent.click(enabledSwitch);
    await waitFor(() => {
      const patchCall = fetchMock.mock.calls.find(([url, init]) => {
        const callUrl = typeof url === 'string' ? url : url.url;
        return callUrl.endsWith('/admin/apps/app-1') && init?.method === 'PATCH';
      });
      expect(patchCall).toBeDefined();
      if (!patchCall) return;
      const [, init] = patchCall as [string | Request, RequestInit];
      expect(JSON.parse(init.body as string)).toEqual({ enabled: false });
    });
    expect(screen.getByRole('switch', { name: '启用：Test App：已停用' })).toHaveAttribute('aria-checked', 'false');

    fireEvent.click(imageSwitch);
    await waitFor(() => {
      const patchCalls = fetchMock.mock.calls.filter(([url, init]) => {
        const callUrl = typeof url === 'string' ? url : url.url;
        return callUrl.endsWith('/admin/apps/app-1') && init?.method === 'PATCH';
      });
      expect(patchCalls).toHaveLength(2);
      const [, init] = patchCalls[1] as [string | Request, RequestInit];
      expect(JSON.parse(init.body as string)).toEqual({ supports_images: true });
    });
    expect(screen.getByRole('switch', { name: '支持图片：Test App：支持图片' })).toHaveAttribute('aria-checked', 'true');
  });

  it('saves a YIAI connection through the dedicated validation endpoint', async () => {
    render(<App />);

    await waitFor(() => {
      expect(screen.getByText('应用中心')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: '管理后台' }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '应用管理' })).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: '应用管理' }));

    await waitFor(() => {
      expect(screen.getAllByRole('button', { name: '连接配置' })).toHaveLength(2);
    });
    fireEvent.click(screen.getAllByRole('button', { name: '连接配置' })[0]);

    expect(screen.getByRole('heading', { name: '连接配置：test-app' })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('新 API Key（留空保留原值）'), { target: { value: 'replacement-key' } });
    fireEvent.click(screen.getByRole('button', { name: '保存并验证连接' }));

    await waitFor(() => {
      const connectionCall = fetchMock.mock.calls.find(([url, init]) => {
        const callUrl = typeof url === 'string' ? url : url.url;
        return callUrl.endsWith('/admin/apps/app-1/connection') && init?.method === 'PUT';
      });
      expect(connectionCall).toBeDefined();
      const [, init] = connectionCall as [string | Request, RequestInit];
      expect(JSON.parse(init.body as string)).toEqual({
        api_base_url: 'https://yiai.example.com/v1',
        api_key: 'replacement-key',
      });
    });
  });
});

describe('AppIcon', () => {
  it('renders local icon_url when icon_type is image', () => {
    const { container } = render(
      <AppIcon
        app={{
          icon_type: 'image',
          icon: '550e8400-e29b-41d4-a716-446655440000',
          icon_url: '/api/app-icons/app-1/icon.png',
          icon_background: null,
        }}
      />
    );

    const img = container.querySelector('img');
    expect(img).toBeInTheDocument();
    expect(img?.getAttribute('src')).toBe('/api/app-icons/app-1/icon.png');
  });

  it('does not render UUID text when icon_url is local path but icon field is UUID', () => {
    const { container } = render(
      <AppIcon
        app={{
          icon_type: 'image',
          icon: '550e8400-e29b-41d4-a716-446655440000',
          icon_url: '/api/app-icons/app-1/icon.png',
          icon_background: null,
        }}
      />
    );

    expect(container.querySelector('img')).toBeInTheDocument();
    expect(container.textContent).not.toContain('550e8400');
  });

  it('shows placeholder when icon_url is null even if icon_type is image', () => {
    const { container } = render(
      <AppIcon
        app={{
          icon_type: 'image',
          icon: '550e8400-e29b-41d4-a716-446655440000',
          icon_url: null,
          icon_background: null,
        }}
      />
    );

    expect(container.querySelector('.app-icon-placeholder')).toBeInTheDocument();
    expect(container.querySelector('img')).not.toBeInTheDocument();
    expect(container.textContent).not.toContain('550e8400');
  });

  it('renders emoji text when icon_type is emoji', () => {
    render(<AppIcon app={{ icon_type: 'emoji', icon: '🤖', icon_url: null, icon_background: null }} />);
    expect(screen.getByText('🤖')).toBeInTheDocument();
  });

  it('renders placeholder for unknown icon types', () => {
    const { container } = render(
      <AppIcon app={{ icon_type: null, icon: '550e8400-e29b-41d4-a716-446655440000', icon_url: null, icon_background: null }} />
    );
    expect(container.querySelector('.app-icon-placeholder')).toBeInTheDocument();
    expect(container.textContent).not.toContain('550e8400');
  });
});

describe('ChatPage mobile drawer', () => {
  const fetchMock = vi.fn<FetchFn>((input) => {
    const url = typeof input === 'string' ? input : input.url;

    if (url.endsWith('/bootstrap')) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            app: {
              id: 'app-1',
              slug: 'test-app',
              name: 'Test App',
              description: null,
              icon: null,
              icon_type: null,
              icon_url: null,
              icon_background: null,
              sort_order: 1,
              requires_new_conversation_inputs: false,
              created_at: '',
              updated_at: '',
            },
            opening_statement: null,
            suggested_questions: [],
            user_input_form: null,
          })
        )
      );
    }

    if (url.endsWith('/conversations')) {
      return Promise.resolve(
        new Response(
          JSON.stringify([
            {
              id: 'conv-1',
              name: '历史会话',
              inputs: {},
              status: 'normal',
              updated_at: 1,
              created_at: 1,
            },
          ])
        )
      );
    }

    if (url.includes('/conversations/') && url.endsWith('/messages')) {
      return Promise.resolve(new Response(JSON.stringify([])));
    }

    return Promise.reject(new Error(`Unexpected fetch: ${url}`));
  });

  beforeEach(() => {
    fetchMock.mockClear();
    vi.stubGlobal('fetch', fetchMock);
    localStorage.setItem(TOKEN_KEY, 'test-token');
    window.HTMLElement.prototype.scrollIntoView = vi.fn();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.removeItem(TOKEN_KEY);
  });

  it('drawer is closed by default and toggles open', async () => {
    render(
      <ChatPage
        slug="test-app"
        user={{ id: 'user-1', username: 'tester', role: 'user' }}
        account={{
          gift_tokens: 100,
          recharge_tokens: 50,
          daily_gift_amount: 10,
          gift_tokens_max: 200,
          last_gift_date: null,
        }}
        onBack={() => {}}
        onLogout={() => {}}
      />
    );

    await waitFor(() => {
      expect(screen.getByText('历史会话（1）')).toBeInTheDocument();
    });

    const sidebar = screen.getByTestId('chat-sidebar');
    expect(sidebar.classList.contains('open')).toBe(false);

    fireEvent.click(screen.getByText('历史会话（1）'));
    expect(sidebar.classList.contains('open')).toBe(true);
  });
});
