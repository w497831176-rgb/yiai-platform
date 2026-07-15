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
      return await reply.status(400).send({ error: 'Invalid request body' });
    }

    const { username, password } = body;

    if (!validateUsername(username)) {
      return await reply
        .status(400)
        .send({ error: 'Username must be 3-32 characters and contain only letters, numbers, and underscores' });
    }

    if (!validatePassword(password)) {
      return await reply.status(400).send({ error: 'Password must be at least 6 characters' });
    }

    try {
      const existing = await findUserByUsername(pool, username);
      if (existing) {
        return await reply.status(409).send({ error: 'Username already exists' });
      }

      const passwordHash = await hashPassword(password);
      const result = await pool.query<DbUser>(
        `INSERT INTO users (username, password_hash, role)
         VALUES ($1, $2, 'user')
         RETURNING id, username, role, created_at, updated_at`,
        [username, passwordHash]
      );

      const user = result.rows.at(0);
      if (!user) {
        return await reply.status(500).send({ error: 'Internal server error' });
      }

      return await reply.status(201).send(toSafeUser(user));
    } catch {
      return await reply.status(500).send({ error: 'Internal server error' });
    }
  });

  fastify.post('/login', async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body;
    if (!validateAuthBody(body)) {
      return await reply.status(400).send({ error: 'Invalid request body' });
    }

    const { username, password } = body;

    try {
      const user = await findUserByUsername(pool, username);
      if (!user) {
        return await reply.status(401).send({ error: 'Invalid username or password' });
      }

      const valid = await verifyPassword(password, user.password_hash);
      if (!valid) {
        return await reply.status(401).send({ error: 'Invalid username or password' });
      }

      const token = signToken(toSafeUser(user));
      return await reply.send({ token, user: toSafeUser(user) });
    } catch {
      return await reply.status(500).send({ error: 'Internal server error' });
    }
  });

  fastify.get('/me', { preHandler: authenticate }, async (request: FastifyRequest, reply: FastifyReply) => {
    const userId = request.user?.userId;
    if (!userId) {
      return await reply.status(401).send({ error: 'Unauthorized' });
    }

    try {
      const result = await pool.query<DbUser>(
        'SELECT id, username, role, created_at, updated_at FROM users WHERE id = $1',
        [userId]
      );

      const user = result.rows.at(0);
      if (!user) {
        return await reply.status(401).send({ error: 'Unauthorized' });
      }

      return await reply.send(toSafeUser(user));
    } catch {
      return await reply.status(500).send({ error: 'Internal server error' });
    }
  });

  fastify.post(
    '/change-password',
    { preHandler: authenticate },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const userId = request.user?.userId;
      if (!userId) {
        return await reply.status(401).send({ error: 'Unauthorized' });
      }

      const body = request.body;
      if (!validateChangePasswordBody(body)) {
        return await reply.status(400).send({ error: 'Invalid request body' });
      }

      const { currentPassword, newPassword } = body;

      if (!validatePassword(newPassword)) {
        return await reply.status(400).send({ error: 'New password must be at least 6 characters' });
      }

      try {
        const result = await pool.query<DbUserPasswordOnly>(
          'SELECT id, password_hash FROM users WHERE id = $1',
          [userId]
        );

        const user = result.rows.at(0);
        if (!user) {
          return await reply.status(401).send({ error: 'Unauthorized' });
        }

        const valid = await verifyPassword(currentPassword, user.password_hash);
        if (!valid) {
          return await reply.status(401).send({ error: 'Current password is incorrect' });
        }

        const newHash = await hashPassword(newPassword);
        await pool.query('UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2', [
          newHash,
          user.id,
        ]);

        return await reply.send({ message: 'Password updated successfully' });
      } catch {
        return await reply.status(500).send({ error: 'Internal server error' });
      }
    }
  );
}
