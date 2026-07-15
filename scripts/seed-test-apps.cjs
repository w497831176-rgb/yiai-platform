const { Pool } = require('pg');
const dotenv = require('dotenv');
const path = require('path');

dotenv.config({ path: path.resolve(__dirname, '../apps/api/.env') });
dotenv.config({ path: path.resolve(__dirname, '../.env') });

function getEnv() {
  if (process.env.YIAI_PLATFORM_DATABASE_URL) {
    return { connectionString: process.env.YIAI_PLATFORM_DATABASE_URL };
  }

  return {
    host: process.env.YIAI_PLATFORM_DB_HOST || 'localhost',
    port: Number(process.env.YIAI_PLATFORM_DB_PORT || 5432),
    user: process.env.YIAI_PLATFORM_DB_USER,
    password: process.env.YIAI_PLATFORM_DB_PASSWORD,
    database: process.env.YIAI_PLATFORM_DB_NAME,
  };
}

const APPS = [
  {
    slug: 'zhouyi-divination',
    name: '周易占卦',
    description: '基于周易的占卜与解答',
    icon: '🔮',
    requires_new_conversation_inputs: false,
    sort_order: 1,
  },
  {
    slug: 'dunjiazi',
    name: '遁甲子',
    description: '奇门遁甲预测助手',
    icon: '🧭',
    requires_new_conversation_inputs: false,
    sort_order: 2,
  },
  {
    slug: 'shouyi-tcm-dual-ai',
    name: '守一中医双AI',
    description: '中医双 AI 问诊助手',
    icon: '🌿',
    requires_new_conversation_inputs: true,
    sort_order: 3,
  },
];

async function main() {
  const apiKeys = {
    'zhouyi-divination': process.env.YIAI_APP_ZHOUYI_API_KEY,
    'dunjiazi': process.env.YIAI_APP_DUNJIAZI_API_KEY,
    'shouyi-tcm-dual-ai': process.env.YIAI_APP_SHOUYI_API_KEY,
  };

  const missing = APPS.filter((app) => !apiKeys[app.slug]);
  if (missing.length > 0) {
    console.error(`Missing API keys for: ${missing.map((a) => a.slug).join(', ')}`);
    console.error('Please set YIAI_APP_ZHOUYI_API_KEY, YIAI_APP_DUNJIAZI_API_KEY, YIAI_APP_SHOUYI_API_KEY');
    process.exit(1);
  }

  const pool = new Pool(getEnv());

  try {
    for (const app of APPS) {
      await pool.query(
        `INSERT INTO yiai_apps (
          slug, name, description, icon, api_base_url, api_key,
          enabled, sort_order, requires_new_conversation_inputs
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        ON CONFLICT (slug) DO UPDATE SET
          name = EXCLUDED.name,
          description = EXCLUDED.description,
          icon = EXCLUDED.icon,
          api_base_url = EXCLUDED.api_base_url,
          api_key = EXCLUDED.api_key,
          enabled = EXCLUDED.enabled,
          sort_order = EXCLUDED.sort_order,
          requires_new_conversation_inputs = EXCLUDED.requires_new_conversation_inputs,
          updated_at = NOW()`,
        [
          app.slug,
          app.name,
          app.description,
          app.icon,
          'https://yiai.charprint.com/v1',
          apiKeys[app.slug],
          true,
          app.sort_order,
          app.requires_new_conversation_inputs,
        ]
      );
      console.log(`Seeded/updated app: ${app.name}`);
    }
    console.log('Done');
  } catch (err) {
    console.error('Seed failed:', err.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();
