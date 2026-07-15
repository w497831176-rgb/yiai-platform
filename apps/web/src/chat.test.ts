import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { startChatStream, type ChatRequestBody } from './chat';

describe('startChatStream', () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends POST with Authorization and JSON body', async () => {
    const body: ChatRequestBody = {
      query: '你好',
      inputs: { name: '张三' },
      conversation_id: 'conv-123',
    };

    const stream = new ReadableStream({
      start(controller) {
        controller.close();
      },
    });

    fetchMock.mockResolvedValueOnce(new Response(stream, { status: 200 }));

    const response = await startChatStream('shouyi-tcm-dual-ai', 'test-token', body);

    expect(response.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/apps/shouyi-tcm-dual-ai/chat');
    expect(init?.method).toBe('POST');

    const headers = init?.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers.Authorization).toBe('Bearer test-token');

    const sentBody = JSON.parse(init?.body as string) as ChatRequestBody;
    expect(sentBody.query).toBe('你好');
    expect(sentBody.inputs).toEqual({ name: '张三' });
    expect(sentBody.conversation_id).toBe('conv-123');
  });

  it('omits conversation_id when not provided', async () => {
    const body: ChatRequestBody = { query: 'hi', inputs: {} };

    const stream = new ReadableStream({
      start(controller) {
        controller.close();
      },
    });

    fetchMock.mockResolvedValueOnce(new Response(stream, { status: 200 }));

    await startChatStream('zhouyi-divination', 'token', body);

    const [, init] = fetchMock.mock.calls[0];
    const sentBody = JSON.parse(init?.body as string) as ChatRequestBody;
    expect(sentBody).not.toHaveProperty('conversation_id');
  });

  it('omits Authorization header when token is null', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.close();
          },
        }),
        { status: 200 }
      )
    );

    await startChatStream('dunjiazi', null, { query: 'hello', inputs: {} });

    const [, init] = fetchMock.mock.calls[0];
    const headers = init?.headers as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
  });

  it('throws readable error when response is not ok', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: '聊天服务繁忙' }), { status: 502 }));

    await expect(startChatStream('zhouyi-divination', 'token', { query: 'hi', inputs: {} })).rejects.toThrow(
      '聊天服务繁忙'
    );
  });

  it('throws when response has no body', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 200 }));

    await expect(startChatStream('zhouyi-divination', 'token', { query: 'hi', inputs: {} })).rejects.toThrow(
      '响应不支持流式读取'
    );
  });

  it('passes abort signal to fetch', async () => {
    const body: ChatRequestBody = { query: 'hi', inputs: {} };
    const controller = new AbortController();

    fetchMock.mockResolvedValueOnce(
      new Response(
        new ReadableStream({
          start(controller2) {
            controller2.close();
          },
        }),
        { status: 200 }
      )
    );

    await startChatStream('zhouyi-divination', 'token', body, controller.signal);

    const [, init] = fetchMock.mock.calls[0];
    expect(init?.signal).toBe(controller.signal);
  });
});
