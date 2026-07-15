export interface ChatRequestBody {
  query: string;
  inputs: Record<string, unknown>;
  conversation_id?: string;
}

export async function startChatStream(
  slug: string,
  token: string | null,
  body: ChatRequestBody,
  signal?: AbortSignal
): Promise<Response> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const response = await fetch(`/api/apps/${slug}/chat`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal,
  });

  if (!response.ok) {
    const data = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(data.error ?? '聊天请求失败');
  }

  if (!response.body) {
    throw new Error('响应不支持流式读取');
  }

  return response;
}
