import jwt from 'jsonwebtoken';
import { env } from '../env.js';
import type { SafeUser } from '@yiai/shared';

const JWT_EXPIRES_IN = '7d';

export interface TokenPayload {
  userId: string;
  username: string;
  role: 'user' | 'admin';
}

export function signToken(user: SafeUser): string {
  if (!env.JWT_SECRET) {
    throw new Error('JWT secret is not configured');
  }
  return jwt.sign(
    { userId: user.id, username: user.username, role: user.role },
    env.JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN }
  );
}

export function verifyToken(token: string): TokenPayload {
  if (!env.JWT_SECRET) {
    throw new Error('JWT secret is not configured');
  }
  return jwt.verify(token, env.JWT_SECRET) as TokenPayload;
}
