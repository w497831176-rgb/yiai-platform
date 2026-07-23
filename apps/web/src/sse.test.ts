import { describe, it, expect, vi } from 'vitest';
import { parseSSEBuffer, readSSEStream, type SSEEvent } from './sse';

function makeEvent(event: string, data: Record<string, unknown>): SSEEvent {
  return { event, data: { event, ...data } };
}

describe('parseSSEBuffer', () => {
  it('returns no events and keeps remainder when delimiter is missing', () => {
    const { events, remainder } = parseSSEBuffer('data: {"event":"message","answer":"hi"}');
    expect(events).toHaveLength(0);
    expect(remainder).toBe('data: {"event":"message","answer":"hi"}');
  });

  it('parses a single message event', () => {
    const { events, remainder } = parseSSEBuffer('data: {"event":"message","answer":"Hello"}\n\n');
    expect(remainder).toBe('');
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual(makeEvent('message', { answer: 'Hello' }));
  });

  it('parses multiple events in one buffer', () => {
    const buffer =
      'data: {"event":"message","answer":"A"}\n\ndata: {"event":"message","answer":"B"}\n\n';
    const { events, remainder } = parseSSEBuffer(buffer);
    expect(remainder).toBe('');
    expect(events).toHaveLength(2);
    expect(events[0]).toEqual(makeEvent('message', { answer: 'A' }));
    expect(events[1]).toEqual(makeEvent('message', { answer: 'B' }));
  });

  it('handles \\r\\n\\r\\n delimiters', () => {
    const buffer = 'data: {"event":"message","answer":"Hi"}\r\n\r\n';
    const { events, remainder } = parseSSEBuffer(buffer);
    expect(remainder).toBe('');
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual(makeEvent('message', { answer: 'Hi' }));
  });

  it('reassembles an event split across chunks', () => {
    const first = parseSSEBuffer('data: {"event":"message","answer":"Hel');
    expect(first.events).toHaveLength(0);

    const second = parseSSEBuffer(first.remainder + 'lo"}\n\ndata: {"event":"message_end"}\n\n');
    expect(second.remainder).toBe('');
    expect(second.events).toHaveLength(2);
    expect(second.events[0]).toEqual(makeEvent('message', { answer: 'Hello' }));
    expect(second.events[1]).toEqual(makeEvent('message_end', {}));
  });

  it('parses message_end with metadata', () => {
    const { events } = parseSSEBuffer(
      'data: {"event":"message_end","conversation_id":"c-1","metadata":{"usage":{"total_tokens":42}}}\n\n'
    );
    expect(events).toHaveLength(1);
    expect(events[0].event).toBe('message_end');
    expect(events[0].data.conversation_id).toBe('c-1');
    expect((events[0].data.metadata as Record<string, unknown>).usage).toEqual({ total_tokens: 42 });
  });

  it('parses error event', () => {
    const { events } = parseSSEBuffer('data: {"event":"error","message":"Something went wrong"}\n\n');
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual(makeEvent('error', { message: 'Something went wrong' }));
  });

  it('ignores malformed JSON and empty events', () => {
    const { events, remainder } = parseSSEBuffer('data: not-json\n\n\n\ndata: {"event":"message","answer":"ok"}\n\n');
    expect(remainder).toBe('');
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual(makeEvent('message', { answer: 'ok' }));
  });
});

describe('readSSEStream', () => {
  it('dispatches callbacks and onComplete', async () => {
    const onMessage = vi.fn();
    const onMessageEnd = vi.fn();
    const onComplete = vi.fn();

    const encoder = new TextEncoder();
    const chunks: Uint8Array[] = [
      encoder.encode('data: {"event":"message","answer":"Hello"}\n\n'),
      encoder.encode('data: {"event":"message_end","metadata":{"usage":{"total_tokens":10}}}\n\n'),
    ];

    let index = 0;
    const releaseLock = vi.fn();
    const reader = {
      read: () => {
        if (index < chunks.length) {
          return Promise.resolve({ done: false, value: chunks[index++] });
        }
        return Promise.resolve({ done: true, value: undefined });
      },
      releaseLock,
    } as unknown as ReadableStreamDefaultReader<Uint8Array>;

    await readSSEStream(reader, { onMessage, onMessageEnd, onComplete });

    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(onMessage).toHaveBeenCalledWith({ event: 'message', answer: 'Hello' });
    expect(onMessageEnd).toHaveBeenCalledTimes(1);
    expect(onComplete).toHaveBeenCalled();
    expect(releaseLock).toHaveBeenCalled();
  });

  it('treats Agent chunks as messages and dispatches message replacements', async () => {
    const onMessage = vi.fn();
    const onMessageReplace = vi.fn();
    const encoder = new TextEncoder();
    let index = 0;
    const chunks = [
      encoder.encode('data: {"event":"agent_message","answer":"draft"}\n\ndata: {"event":"message_replace","answer":"final"}\n\n'),
    ];
    const reader = {
      read: () => Promise.resolve(index < chunks.length ? { done: false, value: chunks[index++] } : { done: true, value: undefined }),
      releaseLock: vi.fn(),
    } as unknown as ReadableStreamDefaultReader<Uint8Array>;

    await readSSEStream(reader, { onMessage, onMessageReplace });

    expect(onMessage).toHaveBeenCalledWith({ event: 'agent_message', answer: 'draft' });
    expect(onMessageReplace).toHaveBeenCalledWith({ event: 'message_replace', answer: 'final' });
  });

  it('stops early when abort signal is triggered', async () => {
    const onMessage = vi.fn();
    const controller = new AbortController();

    const releaseLock = vi.fn();
    const reader = {
      read: () => {
        controller.abort();
        return Promise.resolve({ done: true, value: undefined });
      },
      releaseLock,
    } as unknown as ReadableStreamDefaultReader<Uint8Array>;

    await readSSEStream(reader, { onMessage }, controller.signal);
    expect(onMessage).not.toHaveBeenCalled();
    expect(releaseLock).toHaveBeenCalled();
  });
});
