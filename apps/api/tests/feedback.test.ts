import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { authRoutes } from '../src/routes/auth.js';
import { feedbackRoutes } from '../src/routes/feedback.js';
import { createInMemoryPool, createTestUser } from './helpers/in-memory-db.js';

vi.mock('../src/auth/password.js', () => ({
  hashPassword: vi.fn((password: string) => `hashed-${password}`),
  verifyPassword: vi.fn((plain: string, hash: string) => hash === `hashed-${plain}`),
}));

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);

interface MultipartPart {
  name: string;
  contentType: string;
  data: Buffer | string;
  filename?: string;
}

function buildMultipartBody(parts: MultipartPart[], boundary: string): Buffer {
  const chunks: Buffer[] = [];
  for (const part of parts) {
    let header = `--${boundary}\r\nContent-Disposition: form-data; name="${part.name}"`;
    if (part.filename) header += `; filename="${part.filename}"`;
    header += `\r\nContent-Type: ${part.contentType}\r\n\r\n`;
    chunks.push(Buffer.from(header));
    chunks.push(Buffer.isBuffer(part.data) ? part.data : Buffer.from(part.data));
    chunks.push(Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return Buffer.concat(chunks);
}

async function buildApp(pool: Pool): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(authRoutes, { prefix: '/api/auth', pool });
  await app.register(feedbackRoutes, { prefix: '/api', pool });
  await app.ready();
  return app;
}

async function login(app: FastifyInstance, username: string, password: string): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username, password },
  });
  return (JSON.parse(response.body) as { token: string }).token;
}

describe('Feedback routes', () => {
  let pool: Pool;
  let uploadDirectory: string;

  beforeEach(async () => {
    uploadDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'yiai-feedback-test-'));
    process.env.YIAI_PLATFORM_FEEDBACK_UPLOAD_DIR = uploadDirectory;
    pool = await createInMemoryPool();
  });

  afterEach(async () => {
    await fs.rm(uploadDirectory, { recursive: true, force: true });
    delete process.env.YIAI_PLATFORM_FEEDBACK_UPLOAD_DIR;
  });

  it('requires login before feedback can be submitted', async () => {
    const app = await buildApp(pool);
    const response = await app.inject({ method: 'POST', url: '/api/feedback', payload: { content: '未登录反馈' } });

    expect(response.statusCode).toBe(401);
    expect(JSON.parse(response.body)).toEqual({ error: '请先登录' });
    await app.close();
  });

  it('requires non-blank feedback text', async () => {
    const app = await buildApp(pool);
    await createTestUser(pool, 'feedback_user', 'user', 'testpass');
    const token = await login(app, 'feedback_user', 'testpass');
    const boundary = '----FeedbackRequiredText';

    const response = await app.inject({
      method: 'POST',
      url: '/api/feedback',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
      },
      payload: buildMultipartBody([{ name: 'content', contentType: 'text/plain', data: '   ' }], boundary),
    });

    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body)).toEqual({ error: '请填写意见内容' });
    await app.close();
  });

  it('stores an optional PNG screenshot and lets only admins inspect it', async () => {
    const app = await buildApp(pool);
    const feedbackUserId = await createTestUser(pool, 'feedback_user', 'user', 'testpass');
    await createTestUser(pool, 'feedback_admin', 'admin', 'adminpass');
    const userToken = await login(app, 'feedback_user', 'testpass');
    const adminToken = await login(app, 'feedback_admin', 'adminpass');
    const boundary = '----FeedbackWithScreenshot';

    const submitResponse = await app.inject({
      method: 'POST',
      url: '/api/feedback',
      headers: {
        Authorization: `Bearer ${userToken}`,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
      },
      payload: buildMultipartBody(
        [
          { name: 'content', contentType: 'text/plain', data: '截图中的按钮看不清楚，请优化。' },
          { name: 'screenshot', filename: 'feedback.png', contentType: 'image/png', data: PNG_BYTES },
        ],
        boundary
      ),
    });

    expect(submitResponse.statusCode).toBe(201);
    const submitted = JSON.parse(submitResponse.body) as { id: string; has_screenshot: boolean };
    expect(submitted.has_screenshot).toBe(true);

    const stored = await pool.query<{
      user_id: string;
      content: string;
      screenshot_filename: string;
      screenshot_content_type: string;
      screenshot_size_bytes: number;
    }>('SELECT user_id, content, screenshot_filename, screenshot_content_type, screenshot_size_bytes FROM feedbacks WHERE id = $1', [
      submitted.id,
    ]);
    expect(stored.rows[0]).toMatchObject({
      user_id: feedbackUserId,
      content: '截图中的按钮看不清楚，请优化。',
      screenshot_content_type: 'image/png',
      screenshot_size_bytes: PNG_BYTES.length,
    });
    await expect(fs.readFile(path.join(uploadDirectory, stored.rows[0].screenshot_filename))).resolves.toEqual(PNG_BYTES);

    const userListResponse = await app.inject({
      method: 'GET',
      url: '/api/admin/feedback',
      headers: { Authorization: `Bearer ${userToken}` },
    });
    expect(userListResponse.statusCode).toBe(403);

    for (const url of [`/api/admin/feedback/${submitted.id}`, `/api/admin/feedback/${submitted.id}/screenshot`]) {
      const response = await app.inject({
        method: 'GET',
        url,
        headers: { Authorization: `Bearer ${userToken}` },
      });
      expect(response.statusCode).toBe(403);
    }

    const listResponse = await app.inject({
      method: 'GET',
      url: '/api/admin/feedback',
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(listResponse.statusCode).toBe(200);
    expect(JSON.parse(listResponse.body)).toMatchObject([
      { id: submitted.id, username: 'feedback_user', content_preview: '截图中的按钮看不清楚，请优化。', has_screenshot: true },
    ]);

    const detailResponse = await app.inject({
      method: 'GET',
      url: `/api/admin/feedback/${submitted.id}`,
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(detailResponse.statusCode).toBe(200);
    expect(JSON.parse(detailResponse.body)).toMatchObject({
      id: submitted.id,
      username: 'feedback_user',
      content: '截图中的按钮看不清楚，请优化。',
      has_screenshot: true,
    });

    const screenshotResponse = await app.inject({
      method: 'GET',
      url: `/api/admin/feedback/${submitted.id}/screenshot`,
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(screenshotResponse.statusCode).toBe(200);
    expect(screenshotResponse.headers['content-type']).toContain('image/png');
    expect(Buffer.from(screenshotResponse.rawPayload).equals(PNG_BYTES)).toBe(true);
    await app.close();
  });
});
