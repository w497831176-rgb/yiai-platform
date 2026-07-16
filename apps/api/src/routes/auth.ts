import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { Pool } from 'pg';
import { hashPassword, verifyPassword } from '../auth/password.js';
import { signToken } from '../auth/jwt.js';
import { authenticate } from '../auth/decorator.js';
import type { SafeUser } from '@yiai/shared';

interface AuthBody {
  username: string;
  password: string;
}

interface ChangePasswordBody {
  currentPassword: string;
  newPassword: string;
}

interface DbUser {
  id: string;
  username: string;
  password_hash: string;
  role: 'user' | 'admin';
  created_at: string | Date;
  updated_at: string | Date;
}

interface DbUserPasswordOnly {
  id: string;
  password_hash: string;
}

const USERNAME_REGEX = /^[a-zA-Z0-9_]{3,32}$/;

function toSafeUser(user: DbUser): SafeUser {
  return {
    id: user.id,
    username: user.username,
    role: user.role,
  };
}

async function findUserByUsername(pool: Pool, username: string): Promise<DbUser | undefined> {
  const result = await pool.query<DbUser>(
    'SELECT id, username, password_hash, role, created_at, updated_at FROM users WHERE username = $1',
    [username]
  );
  return result.rows.at(0);
}

function validateUsername(username: string): boolean {
  return USERNAME_REGEX.test(username);
}

function validatePassword(password: string): boolean {
  return password.length >= 6;
}

function validateAuthBody(body: unknown): body is AuthBody {
  return (
    typeof body === 'object' &&
    body !== null &&
    typeof (body as AuthBody).username === 'string' &&
    typeof (body as AuthBody).password === 'string'
  );
}

function validateChangePasswordBody(body: unknown): body is ChangePasswordBody {
  return (
    typeof body === 'object' &&
    body !== null &&
    typeof (body as ChangePasswordBody).currentPassword === 'string' &&
    typeof (body as ChangePasswordBody).newPassword === 'string'
  );
}

export function authRoutes(fastify: FastifyInstance, options: { pool: Pool }): void {
  const { pool } = options;

  fastify.post('/register', async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body;
    if (!validateAuthBody(body)) {
      return await reply.status(400).send({ error: '请求格式错误' });
    }

    const { username, password } = body;

    if (!validateUsername(username)) {
      return await reply
        .status(400)
        .send({ error: '用户名必须为 3-32 位，只能包含字母、数字和下划线' });
    }

    if (!validatePassword(password)) {
      return await reply.status(400).send({ error: '密码至少 6 位' });
    }

    try {
      const existing = await findUserByUsername(pool, username);
      if (existing) {
        return await reply.status(409).send({ error: '用户名已存在' });
      }

      const passwordHash = await hashPassword(password);
      const client = await pool.connect();
      let user: DbUser;
      try {
        await client.query('BEGIN');
        const result = await client.query<DbUser>(
          `INSERT INTO users (username, password_hash, role)
           VALUES ($1, $2, 'user')
           RETURNING id, username, role, created_at, updated_at`,
          [username, passwordHash]
        );

        const inserted = result.rows.at(0);
        if (!inserted) {
          await client.query('ROLLBACK');
          return await reply.status(500).send({ error: '服务器内部错误' });
        }
        user = inserted;

        await client.query(
          'INSERT INTO token_accounts (user_id, gift_tokens, recharge_tokens, last_gift_date) VALUES ($1, 0, 0, NULL)',
          [user.id]
        );
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }

      const { ensureDailyGift } = await import('../services/token-account.js');
      await ensureDailyGift(pool, user.id);

      const token = signToken(toSafeUser(user));
      return await reply.status(201).send({ token, user: toSafeUser(user) });
    } catch {
      return await reply.status(500).send({ error: '服务器内部错误' });
    }
  });

  fastify.post('/login', async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body;
    if (!validateAuthBody(body)) {
      return await reply.status(400).send({ error: '请求格式错误' });
    }

    const { username, password } = body;

    try {
      const user = await findUserByUsername(pool, username);
      if (!user) {
        return await reply.status(401).send({ error: '用户名或密码错误' });
      }

      const valid = await verifyPassword(password, user.password_hash);
      if (!valid) {
        return await reply.status(401).send({ error: '用户名或密码错误' });
      }

      const token = signToken(toSafeUser(user));
      return await reply.send({ token, user: toSafeUser(user) });
    } catch {
      return await reply.status(500).send({ error: '服务器内部错误' });
    }
  });

  fastify.get('/me', { preHandler: authenticate }, async (request: FastifyRequest, reply: FastifyReply) => {
    const userId = request.user?.id;
    if (!userId) {
      return await reply.status(401).send({ error: '未登录' });
    }

    try {
      const result = await pool.query<DbUser>(
        'SELECT id, username, role, created_at, updated_at FROM users WHERE id = $1',
        [userId]
      );

      const user = result.rows.at(0);
      if (!user) {
        return await reply.status(401).send({ error: '未登录' });
      }

      return await reply.send(toSafeUser(user));
    } catch {
      return await reply.status(500).send({ error: '服务器内部错误' });
    }
  });

  fastify.post(
    '/change-password',
    { preHandler: authenticate },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const userId = request.user?.id;
      if (!userId) {
        return await reply.status(401).send({ error: '未登录' });
      }

      const body = request.body;
      if (!validateChangePasswordBody(body)) {
        return await reply.status(400).send({ error: '请求格式错误' });
      }

      const { currentPassword, newPassword } = body;

      if (!validatePassword(newPassword)) {
        return await reply.status(400).send({ error: '新密码至少 6 位' });
      }

      try {
        const result = await pool.query<DbUserPasswordOnly>(
          'SELECT id, password_hash FROM users WHERE id = $1',
          [userId]
        );

        const user = result.rows.at(0);
        if (!user) {
          return await reply.status(401).send({ error: '未登录' });
        }

        const valid = await verifyPassword(currentPassword, user.password_hash);
        if (!valid) {
          return await reply.status(401).send({ error: '当前密码错误' });
        }

        const newHash = await hashPassword(newPassword);
        await pool.query('UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2', [
          newHash,
          user.id,
        ]);

        return await reply.send({ message: '密码已更新，请重新登录' });
      } catch {
        return await reply.status(500).send({ error: '服务器内部错误' });
      }
    }
  );
}
