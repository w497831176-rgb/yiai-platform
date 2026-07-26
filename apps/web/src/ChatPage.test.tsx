import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, waitFor, fireEvent } from '@testing-library/react';
import { ChatPage } from './App';

const TOKEN_KEY = 'yiai_token';

type FetchFn = (input: string | Request, init?: RequestInit) => Promise<Response>;

describe('ChatPage latest conversation inputs restore', () => {
  const fetchMock = vi.fn<FetchFn>((input, _init) => {
    const url = typeof input === 'string' ? input : input.url;

    if (url.endsWith('/bootstrap')) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            app: {
              id: 'app-shouyi',
              slug: 'shouyi-tcm-dual-ai',
              name: '守一中医双AI',
              description: null,
              icon: null,
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
              inputs: { name: '张三', gender: '男' },
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

    if (url.endsWith('/chat')) {
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(
              'data: {"event":"message_end","conversation_id":"conv-1","metadata":{"usage":{"total_tokens":8}}}\n\n'
            )
          );
          controller.close();
        },
      });
      return Promise.resolve(new Response(stream, { status: 200 }));
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

  it('sends chat request with restored inputs from the latest conversation', async () => {
    render(
      <ChatPage
        slug="shouyi-tcm-dual-ai"
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
      expect(screen.getByText('历史会话')).toBeInTheDocument();
    });

    const input = screen.getByPlaceholderText('输入问题...');
    fireEvent.change(input, { target: { value: '继续问诊' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));

    await waitFor(() => {
      const chatCall = fetchMock.mock.calls.find(([url]) => {
        const callUrl = typeof url === 'string' ? url : url.url;
        return callUrl.endsWith('/chat');
      });
      expect(chatCall).toBeDefined();
      if (!chatCall) {
        throw new Error('chat request was not sent');
      }
      const [, init] = chatCall;
      const body = JSON.parse(init?.body as string) as { query: string; inputs: Record<string, unknown> };
      expect(body.query).toBe('继续问诊');
      expect(body.inputs).toEqual({ name: '张三', gender: '男' });
    });
  });

  it('renders an assistant history reply as Markdown', async () => {
    fetchMock.mockImplementation((input) => {
      const url = typeof input === 'string' ? input : input.url;
      if (url.endsWith('/bootstrap')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              app: {
                id: 'app-markdown', slug: 'markdown-app', name: 'Markdown App', description: null,
                icon: null, sort_order: 1, requires_new_conversation_inputs: false, created_at: '', updated_at: '',
              },
              opening_statement: null, suggested_questions: [], user_input_form: null,
            })
          )
        );
      }
      if (url.endsWith('/conversations')) return Promise.resolve(new Response(JSON.stringify([{ id: 'markdown-conv', name: 'Markdown', inputs: {}, status: 'normal', updated_at: 1, created_at: 1 }])));
      if (url.includes('/conversations/') && url.endsWith('/messages')) {
        return Promise.resolve(new Response(JSON.stringify([{ id: 'message-1', conversation_id: 'markdown-conv', query: 'q', answer: '## 命盘结果\n\n| 项目 | 内容 |\n| --- | --- |\n| 命宫 | 戌 |', created_at: 1 }])));
      }
      return Promise.reject(new Error(`Unexpected fetch: ${url}`));
    });

    render(
      <ChatPage
        slug="markdown-app"
        user={{ id: 'user-1', username: 'tester', role: 'user' }}
        account={{ gift_tokens: 100, recharge_tokens: 50, daily_gift_amount: 10, gift_tokens_max: 200, last_gift_date: null }}
        onBack={() => {}}
        onLogout={() => {}}
      />
    );

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: '命盘结果' })).toBeInTheDocument();
      expect(screen.getByRole('table')).toBeInTheDocument();
    });
  });

  it('copies both user messages and AI answers', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });

    fetchMock.mockImplementation((input) => {
      const url = typeof input === 'string' ? input : input.url;
      if (url.endsWith('/bootstrap')) {
        return Promise.resolve(new Response(JSON.stringify({
          app: { id: 'copy-app', slug: 'copy-app', name: 'Copy App', description: null, icon: null, sort_order: 1, requires_new_conversation_inputs: false, created_at: '', updated_at: '' },
          opening_statement: null, suggested_questions: [], user_input_form: null,
        })));
      }
      if (url.endsWith('/conversations')) return Promise.resolve(new Response(JSON.stringify([{ id: 'copy-conv', name: 'Copy', inputs: {}, status: 'normal', updated_at: 1, created_at: 1 }])));
      if (url.includes('/conversations/') && url.endsWith('/messages')) {
        return Promise.resolve(new Response(JSON.stringify([{ id: 'copy-message', conversation_id: 'copy-conv', query: '用户问题', answer: '**AI 回答**', created_at: 1 }])));
      }
      return Promise.reject(new Error(`Unexpected fetch: ${url}`));
    });

    render(
      <ChatPage
        slug="copy-app"
        user={{ id: 'user-1', username: 'tester', role: 'user' }}
        account={{ gift_tokens: 100, recharge_tokens: 50, daily_gift_amount: 10, gift_tokens_max: 200, last_gift_date: null }}
        onBack={() => {}}
        onLogout={() => {}}
      />
    );

    await waitFor(() => {
      expect(screen.getByRole('button', { name: '复制用户消息' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: '复制 AI 回答' })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: '复制用户消息' }));
    await waitFor(() => { expect(writeText).toHaveBeenLastCalledWith('用户问题'); });
    fireEvent.click(screen.getByRole('button', { name: '复制 AI 回答' }));
    await waitFor(() => { expect(writeText).toHaveBeenLastCalledWith('**AI 回答**'); });
  });

  it('deletes a conversation without sending an empty JSON request body', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    fetchMock.mockImplementation((input, init) => {
      const url = typeof input === 'string' ? input : input.url;
      if (url.endsWith('/bootstrap')) {
        return Promise.resolve(new Response(JSON.stringify({
          app: { id: 'delete-app', slug: 'delete-app', name: 'Delete App', description: null, icon: null, sort_order: 1, requires_new_conversation_inputs: false, created_at: '', updated_at: '' },
          opening_statement: null, suggested_questions: [], user_input_form: null,
        })));
      }
      if (url.endsWith('/conversations') && init?.method !== 'DELETE') {
        return Promise.resolve(new Response(JSON.stringify([{ id: 'delete-conv', name: '待删除会话', inputs: {}, status: 'normal', updated_at: 1, created_at: 1 }])));
      }
      if (url.includes('/conversations/delete-conv') && init?.method === 'DELETE') {
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      if (url.includes('/conversations/') && url.endsWith('/messages')) return Promise.resolve(new Response(JSON.stringify([])));
      return Promise.reject(new Error(`Unexpected fetch: ${url}`));
    });

    render(
      <ChatPage
        slug="delete-app"
        user={{ id: 'user-1', username: 'tester', role: 'user' }}
        account={{ gift_tokens: 100, recharge_tokens: 50, daily_gift_amount: 10, gift_tokens_max: 200, last_gift_date: null }}
        onBack={() => {}}
        onLogout={() => {}}
      />
    );

    await waitFor(() => { expect(screen.getByText('待删除会话')).toBeInTheDocument(); });
    fireEvent.click(screen.getByRole('button', { name: '删除' }));

    await waitFor(() => {
      const deleteCall = fetchMock.mock.calls.find(([input, init]) => {
        const url = typeof input === 'string' ? input : input.url;
        return url.includes('/conversations/delete-conv') && init?.method === 'DELETE';
      });
      expect(deleteCall).toBeDefined();
      const headers = deleteCall?.[1]?.headers as Record<string, string>;
      expect(headers).not.toHaveProperty('Content-Type');
      expect(headers).not.toHaveProperty('content-type');
      expect(screen.queryByText('待删除会话')).not.toBeInTheDocument();
    });
    confirm.mockRestore();
  });

  it('keeps mobile chat controls available as a collapsed floating menu', async () => {
    render(
      <ChatPage
        slug="shouyi-tcm-dual-ai"
        user={{ id: 'user-1', username: 'tester', role: 'user' }}
        account={{ gift_tokens: 100, recharge_tokens: 50, daily_gift_amount: 10, gift_tokens_max: 200, last_gift_date: null }}
        onBack={() => {}}
        onLogout={() => {}}
      />
    );

    await waitFor(() => { expect(screen.getByRole('button', { name: /历史会话/ })).toBeInTheDocument(); });
    const menu = screen.getByRole('button', { name: '展开会话操作' });
    expect(menu).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(menu);
    expect(menu).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('button', { name: '移动端新建对话' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '移动端历史会话' })).toBeInTheDocument();
  });

  it('keeps a new chat usable when loading conversation history fails', async () => {
    fetchMock.mockImplementation((input) => {
      const url = typeof input === 'string' ? input : input.url;
      if (url.endsWith('/bootstrap')) {
        return Promise.resolve(new Response(JSON.stringify({
          app: { id: 'recover-app', slug: 'recover-app', name: 'Recover App', description: null, icon: null, sort_order: 1, requires_new_conversation_inputs: false, created_at: '', updated_at: '' },
          opening_statement: null, suggested_questions: [], user_input_form: null,
        })));
      }
      if (url.endsWith('/conversations')) {
        return Promise.resolve(new Response(JSON.stringify({ error: '上游暂时不可用' }), { status: 502 }));
      }
      if (url.endsWith('/chat')) {
        return Promise.resolve(new Response(new ReadableStream({ start(controller) { controller.close(); } }), { status: 200 }));
      }
      return Promise.reject(new Error(`Unexpected fetch: ${url}`));
    });

    render(
      <ChatPage
        slug="recover-app"
        user={{ id: 'user-1', username: 'tester', role: 'user' }}
        account={{ gift_tokens: 100, recharge_tokens: 50, daily_gift_amount: 10, gift_tokens_max: 200, last_gift_date: null }}
        onBack={() => {}}
        onLogout={() => {}}
      />
    );

    await waitFor(() => {
      expect(screen.getByText(/历史会话加载失败，已切换为新对话/)).toBeInTheDocument();
    });
    const input = screen.getByPlaceholderText('输入问题...');
    expect(input).not.toBeDisabled();
    fireEvent.change(input, { target: { value: '重新开始' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([url]) => (typeof url === 'string' ? url : url.url).endsWith('/chat'))).toBe(true);
    });
  });

  it('only sends when the visible send button is clicked and keeps a one-line textarea', async () => {
    fetchMock.mockImplementation((input) => {
      const url = typeof input === 'string' ? input : input.url;
      if (url.endsWith('/bootstrap')) {
        return Promise.resolve(new Response(JSON.stringify({
          app: { id: 'textarea-app', slug: 'textarea-app', name: 'Textarea App', description: null, icon: null, sort_order: 1, requires_new_conversation_inputs: false, created_at: '', updated_at: '' },
          opening_statement: null, suggested_questions: [], user_input_form: null,
        })));
      }
      if (url.endsWith('/conversations')) return Promise.resolve(new Response(JSON.stringify([])));
      if (url.endsWith('/chat')) return Promise.resolve(new Response(new ReadableStream({ start(controller) { controller.close(); } }), { status: 200 }));
      return Promise.reject(new Error(`Unexpected fetch: ${url}`));
    });

    render(
      <ChatPage
        slug="textarea-app"
        user={{ id: 'user-1', username: 'tester', role: 'user' }}
        account={{ gift_tokens: 100, recharge_tokens: 50, daily_gift_amount: 10, gift_tokens_max: 200, last_gift_date: null }}
        onBack={() => {}}
        onLogout={() => {}}
      />
    );

    const input = await screen.findByPlaceholderText('输入问题...');
    expect(input.tagName).toBe('TEXTAREA');
    expect(input).toHaveAttribute('rows', '1');
    fireEvent.change(input, { target: { value: '保留在输入框里的内容' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => { expect(input).toHaveValue('保留在输入框里的内容\n'); });
    fireEvent.change(input, { target: { value: '输入法发送键也只能换行' } });
    const form = input.closest('form');
    if (!form) {
      throw new Error('chat input form is missing');
    }
    fireEvent.submit(form);
    await waitFor(() => { expect(input).toHaveValue('输入法发送键也只能换行\n'); });
    expect(fetchMock.mock.calls.some(([url]) => (typeof url === 'string' ? url : url.url).endsWith('/chat'))).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([url]) => (typeof url === 'string' ? url : url.url).endsWith('/chat'))).toBe(true);
    });
  });

  it('shows a replying indicator until the first stream text arrives', async () => {
    let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
    fetchMock.mockImplementation((input) => {
      const url = typeof input === 'string' ? input : input.url;
      if (url.endsWith('/bootstrap')) {
        return Promise.resolve(new Response(JSON.stringify({
          app: { id: 'replying-app', slug: 'replying-app', name: 'Replying App', description: null, icon: null, sort_order: 1, requires_new_conversation_inputs: false, created_at: '', updated_at: '' },
          opening_statement: null, suggested_questions: [], user_input_form: null,
        })));
      }
      if (url.endsWith('/conversations')) return Promise.resolve(new Response(JSON.stringify([])));
      if (url.endsWith('/chat')) {
        return Promise.resolve(new Response(new ReadableStream({
          start(controller) {
            streamController = controller;
          },
        }), { status: 200 }));
      }
      return Promise.reject(new Error(`Unexpected fetch: ${url}`));
    });

    render(
      <ChatPage
        slug="replying-app"
        user={{ id: 'user-1', username: 'tester', role: 'user' }}
        account={{ gift_tokens: 100, recharge_tokens: 50, daily_gift_amount: 10, gift_tokens_max: 200, last_gift_date: null }}
        onBack={() => {}}
        onLogout={() => {}}
      />
    );

    const input = await screen.findByPlaceholderText('输入问题...');
    fireEvent.change(input, { target: { value: '请开始回答' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));

    expect(await screen.findByRole('status', { name: 'AI 回复中' })).toBeInTheDocument();
    act(() => {
      streamController?.enqueue(new TextEncoder().encode('data: {"event":"message","answer":"已收到"}\n\n'));
    });
    await waitFor(() => {
      expect(screen.getByText('已收到')).toBeInTheDocument();
      expect(screen.queryByRole('status', { name: 'AI 回复中' })).not.toBeInTheDocument();
    });
    act(() => {
      streamController?.close();
    });
  });
});
