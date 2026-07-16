import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
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
});
