import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { Pool } from 'pg';
import multipart from '@fastify/multipart';
import { authenticate } from '../auth/decorator.js';
import type { ChatRequest } from '@yiai/shared';
import {
  listEnabledApps,
  bootstrapApp,
  listConversations,
  listMessages,
  chatUpstream,
  hideConversation,
  renameConversation,
  uploadFileToUpstream,
  recordUsage,
  YiaiAppNotFoundError,
  YiaiUpstreamError,
  type AppBootstrapResult,
  type UploadFileInput,
} from '../services/yiai.js';
import { deductForUsage, getTokenAccount } from '../services/token-account.js';

interface RouteParams {
  slug: string;
  conversationId: string;
}

interface RenameConversationBody {
  name?: unknown;
}

const MAX_IMAGE_BYTES = 200 * 1024;
const MAX_CHAT_FILES = 10;

function validateRequiredInputs(bootstrap: AppBootstrapResult, inputs: Record<string, unknown> | undefined): string | null {
  if (!bootstrap.user_input_form || bootstrap.user_input_form.length === 0) {
    return null;
  }

  const missing: string[] = [];
  for (const field of bootstrap.user_input_form) {
    if (!field.required) {
      continue;
    }
    const value = inputs?.[field.variable];
    if (value === undefined || value === null || (typeof value === 'string' && value.trim() === '')) {
      missing.push(field.label || field.variable);
    }
  }

  return missing.length > 0 ? `缺少必填信息：${missing.join('、')}` : null;
}

export function appRoutes(fastify: FastifyInstance, options: { pool: Pool }): void {
  const { pool } = options;

  void fastify.register(multipart, {
    limits: {
      fileSize: MAX_IMAGE_BYTES,
    },
  });
  fastify.addHook('preHandler', authenticate);

  fastify.get('/', async (_request: FastifyRequest, reply: FastifyReply) => {
    try {
      const apps = await listEnabledApps(pool);
      return await reply.send(apps);
    } catch {
      return await reply.status(500).send({ error: '服务器内部错误' });
    }
  });

  fastify.get('/:slug/bootstrap', async (request: FastifyRequest, reply: FastifyReply) => {
    const params = request.params as RouteParams;
    const { slug } = params;
    const userId = request.user?.id;
    if (!userId) {
      return await reply.status(401).send({ error: '未登录' });
    }

    try {
      const bootstrap = await bootstrapApp(pool, slug);
      return await reply.send(bootstrap);
    } catch (err) {
      if (err instanceof YiaiAppNotFoundError) {
        return await reply.status(404).send({ error: err.message });
      }
      if (err instanceof YiaiUpstreamError) {
        return await reply.status(502).send({ error: err.message });
      }
      return await reply.status(500).send({ error: '服务器内部错误' });
    }
  });

  fastify.get('/:slug/conversations', async (request: FastifyRequest, reply: FastifyReply) => {
    const params = request.params as RouteParams;
    const { slug } = params;
    const userId = request.user?.id;
    if (!userId) {
      return await reply.status(401).send({ error: '未登录' });
    }

    try {
      const conversations = await listConversations(pool, slug, userId);
      return await reply.send(conversations);
    } catch (err) {
      if (err instanceof YiaiAppNotFoundError) {
        return await reply.status(404).send({ error: err.message });
      }
      if (err instanceof YiaiUpstreamError) {
        return await reply.status(502).send({ error: err.message });
      }
      return await reply.status(500).send({ error: '服务器内部错误' });
    }
  });

  fastify.delete('/:slug/conversations/:conversationId', async (request: FastifyRequest, reply: FastifyReply) => {
    const params = request.params as RouteParams;
    const { slug, conversationId } = params;
    const userId = request.user?.id;
    if (!userId) {
      return await reply.status(401).send({ error: '未登录' });
    }

    try {
      await hideConversation(pool, slug, userId, conversationId);
      return await reply.status(204).send();
    } catch (err) {
      if (err instanceof YiaiAppNotFoundError) {
        return await reply.status(404).send({ error: err.message });
      }
      if (err instanceof YiaiUpstreamError) {
        return await reply.status(502).send({ error: err.message });
      }
      return await reply.status(500).send({ error: '服务器内部错误' });
    }
  });

  fastify.patch('/:slug/conversations/:conversationId', async (request: FastifyRequest, reply: FastifyReply) => {
    const params = request.params as RouteParams;
    const { slug, conversationId } = params;
    const userId = request.user?.id;
    if (!userId) {
      return await reply.status(401).send({ error: '未登录' });
    }

    const body = request.body as RenameConversationBody | undefined;
    const name = typeof body?.name === 'string' ? body.name.trim() : '';
    if (!name) {
      return await reply.status(400).send({ error: '会话名称不能为空' });
    }
    if (name.length > 80) {
      return await reply.status(400).send({ error: '会话名称不能超过 80 个字符' });
    }

    try {
      const conversations = await listConversations(pool, slug, userId);
      if (!conversations.some((conversation) => conversation.id === conversationId)) {
        return await reply.status(404).send({ error: '会话不存在或已删除' });
      }

      await renameConversation(pool, slug, userId, conversationId, name);
      return await reply.send({ id: conversationId, name });
    } catch (err) {
      if (err instanceof YiaiAppNotFoundError) {
        return await reply.status(404).send({ error: err.message });
      }
      if (err instanceof YiaiUpstreamError) {
        return await reply.status(502).send({ error: err.message });
      }
      return await reply.status(500).send({ error: '服务器内部错误' });
    }
  });

  fastify.get(
    '/:slug/conversations/:conversationId/messages',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const params = request.params as RouteParams;
      const { slug, conversationId } = params;
      const userId = request.user?.id;
      if (!userId) {
        return await reply.status(401).send({ error: '未登录' });
      }

      try {
        const messages = await listMessages(pool, slug, userId, conversationId);
        return await reply.send(messages);
      } catch (err) {
        if (err instanceof YiaiAppNotFoundError) {
          return await reply.status(404).send({ error: err.message });
        }
        if (err instanceof YiaiUpstreamError) {
          return await reply.status(502).send({ error: err.message });
        }
        return await reply.status(500).send({ error: '服务器内部错误' });
      }
    }
  );

  fastify.post('/:slug/files', async (request: FastifyRequest, reply: FastifyReply) => {
    const params = request.params as RouteParams;
    const { slug } = params;
    const userId = request.user?.id;
    if (!userId) {
      return await reply.status(401).send({ error: '未登录' });
    }

    const appResult = await pool.query<{ supports_images: boolean }>(
      'SELECT supports_images FROM yiai_apps WHERE slug = $1 AND enabled = true',
      [slug]
    );
    const app = appResult.rows.at(0);
    if (!app) {
      return await reply.status(404).send({ error: `应用不存在: ${slug}` });
    }
    if (!app.supports_images) {
      return await reply.status(400).send({ error: '此应用未开启图片支持' });
    }

    let fileData;
    try {
      fileData = await request.file();
    } catch (err) {
      request.log.error(err);
      if (err instanceof Error && (err.name === 'RequestFileTooLargeError' || /too large/i.test(err.message))) {
        return await reply.status(400).send({ error: '单张图片不能超过 200KB' });
      }
      return await reply.status(400).send({ error: '请求格式错误' });
    }

    if (!fileData) {
      return await reply.status(400).send({ error: '请求格式错误' });
    }

    if (!fileData.mimetype.startsWith('image/')) {
      return await reply.status(400).send({ error: '仅支持图片文件' });
    }

    let buffer: Buffer;
    try {
      buffer = await fileData.toBuffer();
    } catch (err) {
      request.log.error(err);
      if (err instanceof Error && (err.name === 'RequestFileTooLargeError' || /too large/i.test(err.message))) {
        return await reply.status(400).send({ error: '单张图片不能超过 200KB' });
      }
      return await reply.status(400).send({ error: '读取图片失败' });
    }

    if (buffer.length > MAX_IMAGE_BYTES) {
      return await reply.status(400).send({ error: '单张图片不能超过 200KB' });
    }

    try {
      const fileInput: UploadFileInput = {
        buffer,
        mimetype: fileData.mimetype,
        filename: fileData.filename,
      };
      const uploaded = await uploadFileToUpstream(pool, slug, userId, fileInput);
      return await reply.send(uploaded);
    } catch (err) {
      if (err instanceof YiaiAppNotFoundError) {
        return await reply.status(404).send({ error: err.message });
      }
      if (err instanceof YiaiUpstreamError) {
        return await reply.status(502).send({ error: err.message });
      }
      request.log.error(err);
      return await reply.status(500).send({ error: '服务器内部错误' });
    }
  });

  fastify.post('/:slug/chat', async (request: FastifyRequest, reply: FastifyReply) => {
    const params = request.params as RouteParams;
    const { slug } = params;
    const userId = request.user?.id;
    if (!userId) {
      return await reply.status(401).send({ error: '未登录' });
    }

    const body = request.body as ChatRequest | undefined;
    const hasFiles = Array.isArray(body?.files) && body.files.length > 0;
    if (!body || typeof body.query !== 'string' || (body.query.trim().length === 0 && !hasFiles)) {
      return await reply.status(400).send({ error: '请求格式错误' });
    }
    if (Array.isArray(body.files) && body.files.length > MAX_CHAT_FILES) {
      return await reply.status(400).send({ error: '一次最多发送 10 张图片' });
    }

    let upstreamResponse: Response;
    let appRow: { id: string; requires_new_conversation_inputs: boolean; supports_images: boolean } | undefined;
    try {
      const appResult = await pool.query<{
        id: string;
        requires_new_conversation_inputs: boolean;
        supports_images: boolean;
      }>('SELECT id, requires_new_conversation_inputs, supports_images FROM yiai_apps WHERE slug = $1 AND enabled = true', [slug]);
      appRow = appResult.rows.at(0);
      if (!appRow) {
        return await reply.status(404).send({ error: `应用不存在: ${slug}` });
      }

      if (hasFiles && !appRow.supports_images) {
        return await reply.status(400).send({ error: '此应用未开启图片支持' });
      }

      if (appRow.requires_new_conversation_inputs && !body.conversation_id) {
        const bootstrap = await bootstrapApp(pool, slug);
        const validationError = validateRequiredInputs(bootstrap, body.inputs);
        if (validationError) {
          return await reply.status(400).send({ error: validationError });
        }
      }

      const account = await getTokenAccount(pool, userId);
      if (account.gift_tokens <= 0 && account.recharge_tokens <= 0) {
        return await reply.status(402).send({
          error: '余额不足，请登录领取赠送额度或联系管理员充值',
        });
      }

      upstreamResponse = await chatUpstream(pool, slug, userId, {
        query: body.query.trim(),
        conversation_id: body.conversation_id,
        inputs: body.inputs,
        files: body.files,
      });
    } catch (err) {
      if (err instanceof YiaiAppNotFoundError) {
        return await reply.status(404).send({ error: err.message });
      }
      if (err instanceof YiaiUpstreamError) {
        return await reply.status(502).send({ error: err.message });
      }
      return await reply.status(500).send({ error: '服务器内部错误' });
    }

    if (!upstreamResponse.ok) {
      return await reply.status(502).send({ error: '上游接口错误' });
    }

    if (!upstreamResponse.body) {
      return await reply.status(502).send({ error: '上游响应为空' });
    }

    const appId = appRow.id;

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    reply.hijack();

    const reader = upstreamResponse.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    const processChunk = async (): Promise<void> => {
      const { done, value } = await reader.read();
      if (done) {
        reply.raw.end();
        return;
      }

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) {
          reply.raw.write('\n');
          continue;
        }
        reply.raw.write(`${trimmed}\n`);

        // Parse SSE data line for usage tracking and token deduction
        if (trimmed.startsWith('data:') && appId) {
          const jsonStr = trimmed.slice(5).trim();
          try {
            const eventData = JSON.parse(jsonStr) as Record<string, unknown>;
            if (eventData.event === 'message_end') {
              const metadata = eventData.metadata as Record<string, unknown> | undefined;
              const usage = metadata?.usage as Record<string, unknown> | undefined;
              const totalTokens = typeof usage?.total_tokens === 'number' ? usage.total_tokens : undefined;
              const messageId = typeof eventData.message_id === 'string' ? eventData.message_id : undefined;
              if (totalTokens !== undefined && totalTokens >= 0 && messageId) {
                const client = await pool.connect();
                try {
                  await client.query('BEGIN');
                  const usageRecordId = await recordUsage(client, {
                    userId,
                    appId,
                    conversationId: typeof eventData.conversation_id === 'string' ? eventData.conversation_id : undefined,
                    messageId,
                    taskId: typeof eventData.task_id === 'string' ? eventData.task_id : undefined,
                    totalTokens,
                  });
                  await deductForUsage(client, userId, totalTokens, usageRecordId);
                  await client.query('COMMIT');
                } catch (error) {
                  await client.query('ROLLBACK');
                  // Unique violation on message_id means duplicate upstream event; ignore idempotently
                  if (error && typeof error === 'object' && 'code' in error && error.code === '23505') {
                    request.log.warn({ messageId }, 'Duplicate message_end usage record ignored');
                  } else {
                    request.log.error(error);
                  }
                } finally {
                  client.release();
                }
              }
            }
          } catch {
            // Ignore malformed JSON in SSE data
          }
        }
      }

      void processChunk();
    };

    processChunk().catch((err: unknown) => {
      request.log.error(err);
      if (!reply.raw.writableEnded) {
        reply.raw.write('event: error\ndata: {"message":"Stream error"}\n\n');
        reply.raw.end();
      }
    });
  });
}
