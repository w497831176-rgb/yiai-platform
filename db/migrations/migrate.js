import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function getConnectionConfig() {
  if (process.env.YIAI_PLATFORM_DATABASE_URL) {
    return { connectionString: process.env.YIAI_PLATFORM_DATABASE_URL };
  }

  return {
    host: process.env.YIAI_PLATFORM_DB_HOST ?? 'localhost',
    port: parseInt(process.env.YIAI_PLATFORM_DB_PORT ?? '5432', 10),
    user: process.env.YIAI_PLATFORM_DB_USER ?? 'yiai',
    password: process.env.YIAI_PLATFORM_DB_PASSWORD ?? '',
    database: process.env.YIAI_PLATFORM_DB_NAME ?? 'yiai_platform',
  };
}

async function ensureMigrationsTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS migrations (
      id SERIAL PRIMARY KEY,
      filename VARCHAR(255) NOT NULL UNIQUE,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}

async function getAppliedMigrations(client) {
  const result = await client.query('SELECT filename FROM migrations ORDER BY filename');
  return new Set(result.rows.map((row) => row.filename));
}

async function runMigration(client, filename, sql) {
  await client.query('BEGIN');
  try {
    await client.query(sql);
    await client.query('INSERT INTO migrations (filename) VALUES ($1)', [filename]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

async function main() {
  const config = getConnectionConfig();
  const pool = new pg.Pool(config);

  try {
    const client = await pool.connect();
    try {
      await ensureMigrationsTable(client);
      const applied = await getAppliedMigrations(client);

      const migrationsDir = __dirname;
      const files = (await fs.readdir(migrationsDir))
        .filter((file) => file.endsWith('.sql'))
        .sort();

      let executedCount = 0;

      for (const file of files) {
        if (applied.has(file)) {
          console.log(`Skipping applied migration: ${file}`);
          continue;
        }

        const filePath = path.join(migrationsDir, file);
        const sql = await fs.readFile(filePath, 'utf-8');

        console.log(`Running migration: ${file}`);
        await runMigration(client, file, sql);
        executedCount += 1;
      }

      console.log(`Migrations complete. ${executedCount} migration(s) applied.`);
    } finally {
      client.release();
    }
  } catch (error) {
    console.error('Migration failed:', error);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

await main();
