import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { Pool } from 'pg';
import { authenticate } from '../auth/decorator.js';
import type { ChatRequest } from '@yiai/shared';
import {
  listEnabledApps,
  bootstrapApp,
  listConversations,
  listMessages,
  chatUpstream,
  recordUsage,
  YiaiAppNotFoundError,
  YiaiUpstreamError,
  type AppBootstrapResult,
} from '../services/yiai.js';
import { deductForUsage, getTokenAccount } from '../services/token-account.js';

interface RouteParams {
  slug: string;
  conversationId: string;
}

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

  fastify.addHook('preHandler', authenticate);

  fastify.get('/', async (_request: FastifyRequest, reply: FastifyReply) => {
    try {
      const apps = await listEnabledApps(pool);
      return await reply.send(apps);
    } catch {
      return await reply.status(500).send({ error: 'Internal server error' });
    }
  });

  fastify.get('/:slug/bootstrap', async (request: FastifyRequest, reply: FastifyReply) => {
    const params = request.params as RouteParams;
    const { slug } = params;
    const userId = request.user?.id;
    if (!userId) {
      return await reply.status(401).send({ error: 'Unauthorized' });
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
      return await reply.status(500).send({ error: 'Internal server error' });
    }
  });

  fastify.get('/:slug/conversations', async (request: FastifyRequest, reply: FastifyReply) => {
    const params = request.params as RouteParams;
    const { slug } = params;
    const userId = request.user?.id;
    if (!userId) {
      return await reply.status(401).send({ error: 'Unauthorized' });
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
      return await reply.status(500).send({ error: 'Internal server error' });
    }
  });

  fastify.get(
    '/:slug/conversations/:conversationId/messages',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const params = request.params as RouteParams;
      const { slug, conversationId } = params;
      const userId = request.user?.id;
      if (!userId) {
        return await reply.status(401).send({ error: 'Unauthorized' });
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
        return await reply.status(500).send({ error: 'Internal server error' });
      }
    }
  );

  fastify.post('/:slug/chat', async (request: FastifyRequest, reply: FastifyReply) => {
    const params = request.params as RouteParams;
    const { slug } = params;
    const userId = request.user?.id;
    if (!userId) {
      return await reply.status(401).send({ error: 'Unauthorized' });
    }

    const body = request.body as ChatRequest | undefined;
    if (!body || typeof body.query !== 'string' || body.query.trim().length === 0) {
      return await reply.status(400).send({ error: 'Invalid request body' });
    }

    let upstreamResponse: Response;
    let appRow: { id: string; requires_new_conversation_inputs: boolean } | undefined;
    try {
      const appResult = await pool.query<{
        id: string;
        requires_new_conversation_inputs: boolean;
      }>('SELECT id, requires_new_conversation_inputs FROM yiai_apps WHERE slug = $1 AND enabled = true', [slug]);
      appRow = appResult.rows.at(0);
      if (!appRow) {
        return await reply.status(404).send({ error: `App not found: ${slug}` });
      }

      if (appRow.requires_new_conversation_inputs && !body.conversation_id) {
        const bootstrap = await bootstrapApp(pool, slug);
        const validationError = validateRequiredInputs(bootstrap, body.inputs);
        if (validationError) {
          return await reply.status(400).send({ error: validationError });
        }
      }

      const account = await getTokenAccount(pool, userId);
      const totalAvailable = account.gift_tokens + account.recharge_tokens;
      if (totalAvailable <= 0) {
        return await reply.status(402).send({
          error: 'Token 余额不足，请联系管理员充值或等待每日赠送额度恢复',
        });
      }

      upstreamResponse = await chatUpstream(pool, slug, userId, {
        query: body.query.trim(),
        conversation_id: body.conversation_id,
        inputs: body.inputs,
      });
    } catch (err) {
      if (err instanceof YiaiAppNotFoundError) {
        return await reply.status(404).send({ error: err.message });
      }
      if (err instanceof YiaiUpstreamError) {
        return await reply.status(502).send({ error: err.message });
      }
      return await reply.status(500).send({ error: 'Internal server error' });
    }

    if (!upstreamResponse.ok) {
      return await reply.status(502).send({ error: 'Upstream API error' });
    }

    if (!upstreamResponse.body) {
      return await reply.status(502).send({ error: 'Upstream response has no body' });
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
