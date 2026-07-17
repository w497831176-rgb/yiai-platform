import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { DataType, newDb } from 'pg-mem';
import type { Pool } from 'pg';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export async function createInMemoryPool(): Promise<Pool> {
  const db = newDb();

  db.public.registerFunction({
    name: 'gen_random_uuid',
    returns: DataType.uuid,
    implementation: () => crypto.randomUUID(),
    impure: true,
  });

  db.public.registerFunction({
    name: 'now',
    returns: DataType.timestamp,
    implementation: () => new Date(),
    impure: true,
  });

  const PoolClass = db.adapters.createPg().Pool;
  const pool = new PoolClass();

  const migrationsDir = path.resolve(__dirname, '../../../../db/migrations');
  const files = [
    '001_create_users.sql',
    '002_create_yiai_apps_and_usage.sql',
    '003_create_token_accounts_and_ledger.sql',
    '004_add_yiai_app_icon_fields.sql',
    '005_add_yiai_app_icon_cache.sql',
    '006_allow_negative_gift_tokens.sql',
    '007_add_yiai_app_tags_and_icon_source.sql',
  ];

  for (const file of files) {
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf-8');
    await pool.query(sql);
  }

  const iconCacheDir = path.join(os.tmpdir(), 'yiai-platform-icon-cache-test');
  fs.mkdirSync(iconCacheDir, { recursive: true });
  process.env.YIAI_PLATFORM_ICON_CACHE_DIR = iconCacheDir;

  return pool;
}

export async function createTestUser(pool: Pool, username: string, role: 'user' | 'admin' = 'user', password = 'secret123'): Promise<string> {
  const result = await pool.query<{ id: string }>(
    'INSERT INTO users (username, password_hash, role) VALUES ($1, $2, $3) RETURNING id',
    [username, `hashed-${password}`, role]
  );
  const userId = result.rows[0].id;
  await pool.query(
    'INSERT INTO token_accounts (user_id, gift_tokens, recharge_tokens, last_gift_date) VALUES ($1, 0, 0, NULL) ON CONFLICT (user_id) DO NOTHING',
    [userId]
  );
  return userId;
}

export async function createTestApp(
  pool: Pool,
  overrides: Partial<{
    slug: string;
    name: string;
    description: string | null;
    icon: string | null;
    icon_type: 'image' | 'emoji' | null;
    icon_background: string | null;
    tags: string[];
    icon_source: 'yiai' | 'platform';
    api_base_url: string;
    api_key: string;
    enabled: boolean;
    sort_order: number;
    requires_new_conversation_inputs: boolean;
    icon_cache_filename: string | null;
    icon_cache_content_type: string | null;
    icon_cached_at: Date | string | null;
  }> = {}
): Promise<string> {
  const slug = overrides.slug ?? `app-${crypto.randomUUID()}`;
  const icon = overrides.icon ?? null;
  const icon_type = overrides.icon_type ?? (icon ? ( /^\p{Extended_Pictographic}+$/u.test(icon) ? 'emoji' : 'image') : null);
  const icon_cache_filename = overrides.icon_cache_filename ?? null;
  const icon_cache_content_type = overrides.icon_cache_content_type ?? null;
  const icon_cached_at = overrides.icon_cached_at ?? null;
  const result = await pool.query<{ id: string }>(
    `INSERT INTO yiai_apps (slug, name, description, icon, icon_type, icon_background, api_base_url, api_key, enabled, sort_order, requires_new_conversation_inputs, icon_cache_filename, icon_cache_content_type, icon_cached_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
     RETURNING id`,
    [
      slug,
      overrides.name ?? 'Test App',
      overrides.description ?? null,
      icon,
      icon_type,
      overrides.icon_background ?? null,
      overrides.api_base_url ?? 'https://yiai.example.com/v1',
      overrides.api_key ?? 'test-key',
      overrides.enabled ?? true,
      overrides.sort_order ?? 1,
      overrides.requires_new_conversation_inputs ?? false,
      icon_cache_filename,
      icon_cache_content_type,
      icon_cached_at,
    ]
  );
  return result.rows[0].id;
}
