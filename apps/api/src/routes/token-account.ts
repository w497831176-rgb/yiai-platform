import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { authenticate } from '../auth/decorator.js';
import { LOGIN_STREAK_REWARD_BASE, MAX_GIFT_TOKENS, getLedgerEntries, getTokenAccount } from '../services/token-account.js';

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
      login_reward_base: LOGIN_STREAK_REWARD_BASE,
      gift_tokens_max: MAX_GIFT_TOKENS,
      login_streak_days: account.login_streak_days,
      last_login_reward_date: account.last_login_reward_date,
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
