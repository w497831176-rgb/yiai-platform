import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { authenticate } from '../auth/decorator.js';
import { DAILY_GIFT_AMOUNT, MAX_GIFT_TOKENS, getLedgerEntries, getTokenAccount } from '../services/token-account.js';

export function tokenAccountRoutes(fastify: FastifyInstance, options: { pool: Pool }) {
  const { pool } = options;

  fastify.get('/token-account', { preHandler: authenticate }, async (request, reply) => {
    const userId = request.user?.id;
    if (!userId) {
      return await reply.status(401).send({ error: 'Unauthorized' });
    }

    const account = await getTokenAccount(pool, userId);

    return {
      gift_tokens: account.gift_tokens,
      recharge_tokens: account.recharge_tokens,
      total_tokens: account.gift_tokens + account.recharge_tokens,
      daily_gift_amount: DAILY_GIFT_AMOUNT,
      gift_tokens_max: MAX_GIFT_TOKENS,
      last_gift_date: account.last_gift_date,
    };
  });

  fastify.get('/token-account/ledger', { preHandler: authenticate }, async (request, reply) => {
    const userId = request.user?.id;
    if (!userId) {
      return await reply.status(401).send({ error: 'Unauthorized' });
    }

    const entries = await getLedgerEntries(pool, userId);
    return entries.map((entry) => ({
      id: entry.id,
      created_at: entry.created_at,
      entry_type: entry.entry_type,
      bucket: entry.bucket,
      delta_tokens: entry.delta_tokens,
      note: entry.note,
    }));
  });
}
