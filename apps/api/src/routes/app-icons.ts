import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { Pool } from 'pg';
import { serveIconFile } from '../services/icon-cache.js';

interface AppIconParams {
  slug: string;
}

export function appIconRoutes(fastify: FastifyInstance, options: { pool: Pool }): void {
  const { pool } = options;

  fastify.get('/:slug', async (request: FastifyRequest, reply: FastifyReply) => {
    const params = request.params as AppIconParams;
    await serveIconFile(params.slug, pool, reply);
  });
}
