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
} from '../services/yiai.js';

interface RouteParams {
  slug: string;
  conversationId: string;
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
    const { slug } = request.params as RouteParams;
    const userId = request.user?.userId;
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
    const { slug } = request.params as RouteParams;
    const userId = request.user?.userId;
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
      const { slug, conversationId } = request.params as RouteParams;
      const userId = request.user?.userId;
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
    const { slug } = request.params as RouteParams;
    const userId = request.user?.userId;
    if (!userId) {
      return await reply.status(401).send({ error: 'Unauthorized' });
    }

    const body = request.body as ChatRequest | undefined;
    if (!body || typeof body.query !== 'string' || body.query.trim().length === 0) {
      return await reply.status(400).send({ error: 'Invalid request body' });
    }

    let upstreamResponse: Response;
    try {
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

    const appResult = await pool.query<{ id: string }>('SELECT id FROM yiai_apps WHERE slug = $1', [slug]);
    const appId = appResult.rows.at(0)?.id;

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

        // Parse SSE data line for usage tracking
        if (trimmed.startsWith('data:') && appId) {
          const jsonStr = trimmed.slice(5).trim();
          try {
            const eventData = JSON.parse(jsonStr) as Record<string, unknown>;
            if (eventData.event === 'message_end') {
              const metadata = eventData.metadata as Record<string, unknown> | undefined;
              const usage = metadata?.usage as Record<string, unknown> | undefined;
              const totalTokens = typeof usage?.total_tokens === 'number' ? usage.total_tokens : undefined;
              if (totalTokens !== undefined && totalTokens >= 0) {
                await recordUsage(pool, {
                  userId,
                  appId,
                  conversationId: typeof eventData.conversation_id === 'string' ? eventData.conversation_id : undefined,
                  messageId: typeof eventData.message_id === 'string' ? eventData.message_id : undefined,
                  taskId: typeof eventData.task_id === 'string' ? eventData.task_id : undefined,
                  totalTokens,
                });
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
