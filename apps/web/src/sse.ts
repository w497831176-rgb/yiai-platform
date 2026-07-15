export interface SSEEvent {
  event: string;
  data: Record<string, unknown>;
}

export interface ParsedSSE {
  events: SSEEvent[];
  remainder: string;
}

export interface SSECallbacks {
  onMessage?: (data: Record<string, unknown>) => void;
  onMessageFile?: (data: Record<string, unknown>) => void;
  onMessageEnd?: (data: Record<string, unknown>) => void;
  onError?: (data: Record<string, unknown>) => void;
  onComplete?: () => void;
}

export function parseSSEBuffer(buffer: string): ParsedSSE {
  const events: SSEEvent[] = [];
  const regex = /(.*?)(?:\r\n\r\n|\n\n)/gs;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(buffer)) !== null) {
    const raw = match[1].trim();
    lastIndex = match.index + match[0].length;
    if (!raw) {
      continue;
    }

    const dataLines = raw
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart());

    const dataStr = dataLines.join('');
    if (!dataStr) {
      continue;
    }

    try {
      const data = JSON.parse(dataStr) as Record<string, unknown>;
      const eventName = typeof data.event === 'string' ? data.event : '';
      events.push({ event: eventName, data });
    } catch {
      // Ignore malformed JSON data lines.
    }
  }

  return { events, remainder: buffer.slice(lastIndex) };
}

function dispatchEvent(event: SSEEvent, callbacks: SSECallbacks): void {
  switch (event.event) {
    case 'message':
      callbacks.onMessage?.(event.data);
      break;
    case 'message_file':
      callbacks.onMessageFile?.(event.data);
      break;
    case 'message_end':
      callbacks.onMessageEnd?.(event.data);
      break;
    case 'error':
      callbacks.onError?.(event.data);
      break;
    default:
      // Unknown events are ignored but do not break the stream.
  }
}

export async function readSSEStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  callbacks: SSECallbacks,
  abortSignal?: AbortSignal
): Promise<void> {
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    for (;;) {
      if (abortSignal?.aborted === true) {
        return;
      }

      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      const { events, remainder } = parseSSEBuffer(buffer);
      buffer = remainder;

      for (const event of events) {
        dispatchEvent(event, callbacks);
      }
    }
  } finally {
    reader.releaseLock();
  }

  callbacks.onComplete?.();
}
