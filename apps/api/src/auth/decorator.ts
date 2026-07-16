import type { FastifyRequest, FastifyReply, HookHandlerDoneFunction } from 'fastify';
import { verifyToken } from './jwt.js';

declare module 'fastify' {
  interface FastifyRequest {
    user?: {
      id: string;
      username: string;
      role: 'user' | 'admin';
    };
  }
}

export function authenticate(
  request: FastifyRequest,
  reply: FastifyReply,
  done: HookHandlerDoneFunction
): void {
  const authHeader = request.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    void reply.status(401).send({ error: '请先登录' });
    return;
  }

  const token = authHeader.slice(7);
  try {
    request.user = verifyToken(token);
    done();
  } catch {
    void reply.status(401).send({ error: '登录已过期，请重新登录' });
  }
}
