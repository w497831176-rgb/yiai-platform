import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import multipart from '@fastify/multipart';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { authenticate } from '../auth/decorator.js';
import { env } from '../env.js';

const MAX_SCREENSHOT_BYTES = 5 * 1024 * 1024;
const MAX_FEEDBACK_LENGTH = 3_000;

const screenshotExtensions: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
};

function feedbackUploadDirectory(): string {
  return process.env.YIAI_PLATFORM_FEEDBACK_UPLOAD_DIR ?? env.FEEDBACK_UPLOAD_DIR;
}

interface FeedbackParams {
  id: string;
}

interface FeedbackRow {
  id: string;
  user_id: string;
  username: string;
  content: string;
  screenshot_filename: string | null;
  screenshot_content_type: string | null;
  screenshot_size_bytes: number | null;
  created_at: string | Date;
}

interface FeedbackScreenshot {
  buffer: Buffer;
  contentType: string;
  extension: string;
}

function assertAdmin(request: FastifyRequest, reply: FastifyReply): boolean {
  if (!request.user) {
    void reply.status(401).send({ error: '请先登录' });
    return false;
  }
  if (request.user.role !== 'admin') {
    void reply.status(403).send({ error: '无权限' });
    return false;
  }
  return true;
}

function toFeedbackResponse(row: FeedbackRow, includeContent = true) {
  return {
    id: row.id,
    user_id: row.user_id,
    username: row.username,
    ...(includeContent ? { content: row.content } : { content_preview: row.content.slice(0, 120) }),
    has_screenshot: row.screenshot_filename !== null,
    screenshot_content_type: row.screenshot_content_type,
    screenshot_size_bytes: row.screenshot_size_bytes,
    created_at: row.created_at,
  };
}

async function saveScreenshot(screenshot: FeedbackScreenshot): Promise<{ filename: string; size: number }> {
  const directory = path.resolve(feedbackUploadDirectory());
  await fs.mkdir(directory, { recursive: true });

  const filename = `${crypto.randomUUID()}.${screenshot.extension}`;
  const target = path.join(directory, filename);
  const temporary = `${target}.tmp`;
  try {
    await fs.writeFile(temporary, screenshot.buffer, { flag: 'wx' });
    await fs.rename(temporary, target);
    return { filename, size: screenshot.buffer.length };
  } catch (error) {
    await fs.unlink(temporary).catch(() => undefined);
    throw error;
  }
}

async function removeScreenshot(filename: string | null): Promise<void> {
  if (!filename) return;
  const directory = path.resolve(feedbackUploadDirectory());
  const target = path.resolve(directory, filename);
  if (path.dirname(target) !== directory) return;
  await fs.unlink(target).catch(() => undefined);
}

export function feedbackRoutes(fastify: FastifyInstance, options: { pool: Pool }): void {
  const { pool } = options;

  void fastify.register(multipart, {
    limits: { fileSize: MAX_SCREENSHOT_BYTES },
  });

  fastify.post('/feedback', { preHandler: authenticate }, async (request, reply) => {
    const userId = request.user?.id;
    if (!userId) {
      return reply.status(401).send({ error: '请先登录' });
    }
    if (!request.isMultipart()) {
      return reply.status(400).send({ error: '请使用反馈表单提交' });
    }

    let content = '';
    let screenshot: FeedbackScreenshot | undefined;
    let inputError = '';
    try {
      const parts = request.parts();
      for await (const part of parts) {
        if (part.type === 'file') {
          const buffer = await part.toBuffer();
          if (part.fieldname !== 'screenshot') {
            inputError ||= '仅支持上传一张截图';
            continue;
          }
          if (screenshot) {
            inputError ||= '一次只能上传一张截图';
            continue;
          }
          const extension = screenshotExtensions[part.mimetype];
          if (!extension) {
            inputError ||= '截图仅支持 PNG、JPEG 或 WebP 图片';
            continue;
          }
          if (part.file.truncated || buffer.length > MAX_SCREENSHOT_BYTES) {
            inputError ||= '截图不能超过 5MB';
            continue;
          }
          screenshot = { buffer, contentType: part.mimetype, extension };
        } else if (part.fieldname === 'content' && typeof part.value === 'string') {
          content = part.value.trim();
        }
      }
    } catch (error) {
      const code = typeof error === 'object' && error !== null && 'code' in error ? (error as { code?: string }).code : undefined;
      if (code === 'FST_REQ_FILE_TOO_LARGE') {
        return reply.status(400).send({ error: '截图不能超过 5MB' });
      }
      return reply.status(400).send({ error: '反馈表单解析失败，请重试' });
    }

    if (inputError) {
      return reply.status(400).send({ error: inputError });
    }
    if (!content) {
      return reply.status(400).send({ error: '请填写意见内容' });
    }
    if (content.length > MAX_FEEDBACK_LENGTH) {
      return reply.status(400).send({ error: `意见内容不能超过 ${String(MAX_FEEDBACK_LENGTH)} 个字符` });
    }

    let saved: { filename: string; size: number } | undefined;
    try {
      if (screenshot) {
        saved = await saveScreenshot(screenshot);
      }
      const result = await pool.query<Omit<FeedbackRow, 'username'>>(
        `INSERT INTO feedbacks (user_id, content, screenshot_filename, screenshot_content_type, screenshot_size_bytes)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, user_id, content, screenshot_filename, screenshot_content_type, screenshot_size_bytes, created_at`,
        [userId, content, saved?.filename ?? null, screenshot?.contentType ?? null, saved?.size ?? null]
      );
      const feedback = result.rows.at(0);
      if (!feedback) {
        throw new Error('反馈提交人不存在');
      }
      return await reply.status(201).send(toFeedbackResponse({ ...feedback, username: '' }));
    } catch {
      await removeScreenshot(saved?.filename ?? null);
      return reply.status(500).send({ error: '反馈提交失败，请稍后重试' });
    }
  });

  fastify.get('/admin/feedback', { preHandler: authenticate }, async (request, reply) => {
    if (!assertAdmin(request, reply)) return;
    const result = await pool.query<FeedbackRow>(
      `SELECT f.id, f.user_id, u.username, f.content, f.screenshot_filename, f.screenshot_content_type,
              f.screenshot_size_bytes, f.created_at
       FROM feedbacks f
       JOIN users u ON u.id = f.user_id
       ORDER BY f.created_at DESC`
    );
    return result.rows.map((row) => toFeedbackResponse(row, false));
  });

  fastify.get('/admin/feedback/:id', { preHandler: authenticate }, async (request, reply) => {
    if (!assertAdmin(request, reply)) return;
    const { id } = request.params as FeedbackParams;
    const result = await pool.query<FeedbackRow>(
      `SELECT f.id, f.user_id, u.username, f.content, f.screenshot_filename, f.screenshot_content_type,
              f.screenshot_size_bytes, f.created_at
       FROM feedbacks f
       JOIN users u ON u.id = f.user_id
       WHERE f.id = $1`,
      [id]
    );
    const feedback = result.rows.at(0);
    if (!feedback) {
      return reply.status(404).send({ error: '反馈不存在' });
    }
    return toFeedbackResponse(feedback);
  });

  fastify.get('/admin/feedback/:id/screenshot', { preHandler: authenticate }, async (request, reply) => {
    if (!assertAdmin(request, reply)) return;
    const { id } = request.params as FeedbackParams;
    const result = await pool.query<Pick<FeedbackRow, 'screenshot_filename' | 'screenshot_content_type'>>(
      'SELECT screenshot_filename, screenshot_content_type FROM feedbacks WHERE id = $1',
      [id]
    );
    const feedback = result.rows.at(0);
    if (!feedback?.screenshot_filename || !feedback.screenshot_content_type) {
      return reply.status(404).send({ error: '此反馈没有截图' });
    }

    const directory = path.resolve(feedbackUploadDirectory());
    const target = path.resolve(directory, feedback.screenshot_filename);
    if (path.dirname(target) !== directory) {
      return reply.status(404).send({ error: '截图不存在' });
    }
    try {
      const image = await fs.readFile(target);
      return await reply
        .header('Cache-Control', 'private, no-store')
        .type(feedback.screenshot_content_type)
        .send(image);
    } catch {
      return reply.status(404).send({ error: '截图不存在' });
    }
  });
}
