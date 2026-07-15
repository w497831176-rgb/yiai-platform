require('dotenv').config();

const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

const SALT_ROUNDS = 10;

const adminUsername = process.env.YIAI_PLATFORM_ADMIN_USERNAME;
const adminPassword = process.env.YIAI_PLATFORM_ADMIN_PASSWORD;

if (!adminUsername || !adminPassword) {
  console.error('YIAI_PLATFORM_ADMIN_USERNAME and YIAI_PLATFORM_ADMIN_PASSWORD must be set');
  process.exit(1);
}

const USERNAME_REGEX = /^[a-zA-Z0-9_]{3,32}$/;
if (!USERNAME_REGEX.test(adminUsername)) {
  console.error('Admin username must be 3-32 characters and contain only letters, numbers, and underscores');
  process.exit(1);
}

if (adminPassword.length < 6) {
  console.error('Admin password must be at least 6 characters');
  process.exit(1);
}

function getPoolConfig() {
  if (process.env.YIAI_PLATFORM_DATABASE_URL) {
    return { connectionString: process.env.YIAI_PLATFORM_DATABASE_URL };
  }
  return {
    host: process.env.YIAI_PLATFORM_DB_HOST,
    port: parseInt(process.env.YIAI_PLATFORM_DB_PORT || '5432', 10),
    user: process.env.YIAI_PLATFORM_DB_USER,
    password: process.env.YIAI_PLATFORM_DB_PASSWORD,
    database: process.env.YIAI_PLATFORM_DB_NAME,
  };
}

async function main() {
  const pool = new Pool(getPoolConfig());
  try {
    const existing = await pool.query('SELECT role FROM users WHERE username = $1', [adminUsername]);
    if (existing.rowCount && existing.rowCount > 0) {
      const role = existing.rows[0].role;
      if (role === 'admin') {
        console.log('Admin user already exists. No changes made.');
        return;
      }
      console.error('User exists but is not admin. Cannot promote to admin automatically.');
      process.exit(1);
    }

    const hash = await bcrypt.hash(adminPassword, SALT_ROUNDS);
    await pool.query('INSERT INTO users (username, password_hash, role) VALUES ($1, $2, $3)', [
      adminUsername,
      hash,
      'admin',
    ]);
    console.log('Admin user created successfully.');
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error('Failed to create admin:', err.message);
  process.exit(1);
});
