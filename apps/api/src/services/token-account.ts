import type { Pool, PoolClient } from 'pg';

export const LOGIN_STREAK_REWARD_BASE = 50_000;
export const MAX_GIFT_TOKENS = 1_000_000;
const TIMEZONE = 'Asia/Shanghai';

export interface TokenAccount {
  user_id: string;
  gift_tokens: number;
  recharge_tokens: number;
  last_gift_date: Date | null;
  last_login_reward_date: Date | null;
  login_streak_days: number;
  created_at: Date;
  updated_at: Date;
}

export interface TokenLedgerEntry {
  id: string;
  user_id: string;
  delta_tokens: number;
  bucket: 'gift' | 'recharge';
  entry_type: 'daily_gift' | 'login_streak_gift' | 'admin_recharge' | 'usage';
  usage_record_id: string | null;
  created_by_user_id: string | null;
  note: string | null;
  created_at: Date;
}

export interface AdminLedgerEntry extends TokenLedgerEntry {
  username: string;
  app_name: string | null;
  ai_reply_available: boolean;
}

interface AdminLedgerRow extends TokenLedgerEntry {
  username: string;
  app_name: string | null;
  usage_app_id: string | null;
  usage_conversation_id: string | null;
  usage_message_id: string | null;
}

export interface AdminUsageLedgerPage {
  items: AdminLedgerEntry[];
  total: number;
  page: number;
  page_size: number;
}

export interface AdminUsageReplyTarget {
  id: string;
  user_id: string;
  username: string;
  entry_type: TokenLedgerEntry['entry_type'];
  delta_tokens: number;
  created_at: Date;
  usage_record_id: string | null;
  app_name: string | null;
  api_base_url: string | null;
  api_key: string | null;
  conversation_id: string | null;
  message_id: string | null;
}

function toNumber(value: unknown): number {
  if (typeof value === 'number') {
    return value;
  }
  if (typeof value === 'string') {
    return Number(value);
  }
  return Number(value);
}

function normalizeTokenAccount(row: TokenAccount): TokenAccount {
  return {
    ...row,
    gift_tokens: toNumber(row.gift_tokens),
    recharge_tokens: toNumber(row.recharge_tokens),
    login_streak_days: toNumber(row.login_streak_days),
  };
}

function normalizeLedgerEntry(row: TokenLedgerEntry): TokenLedgerEntry {
  return {
    ...row,
    delta_tokens: toNumber(row.delta_tokens),
  };
}

function normalizeAdminLedgerEntry(row: AdminLedgerRow): AdminLedgerEntry {
  const normalized = normalizeLedgerEntry(row);
  return {
    ...normalized,
    username: row.username,
    app_name: row.app_name,
    ai_reply_available:
      row.entry_type === 'usage' &&
      row.delta_tokens < 0 &&
      row.usage_record_id !== null &&
      row.usage_app_id !== null &&
      row.usage_conversation_id !== null &&
      row.usage_message_id !== null,
  };
}

const ADMIN_LEDGER_SELECT = `
  SELECT
    e.*,
    u.username,
    a.name AS app_name,
    ur.app_id AS usage_app_id,
    ur.conversation_id AS usage_conversation_id,
    ur.message_id AS usage_message_id
  FROM token_ledger_entries e
  JOIN users u ON u.id = e.user_id
  LEFT JOIN yiai_usage_records ur ON ur.id = e.usage_record_id
  LEFT JOIN yiai_apps a ON a.id = ur.app_id
`;

export function getShanghaiDateString(date: Date): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const values = Object.fromEntries(
    parts
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value])
  );
  return `${values.year}-${values.month}-${values.day}`;
}

function toDateString(value: Date | string | null): string | null {
  if (value === null) {
    return null;
  }
  if (value instanceof Date) {
    return getShanghaiDateString(value);
  }
  return value;
}

function parseDateAtMidnightUTC(dateStr: string): Date {
  const [year, month, day] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

function addCalendarDays(dateStr: string, days: number): string {
  const date = parseDateAtMidnightUTC(dateStr);
  return getShanghaiDateString(new Date(date.getTime() + days * 86_400_000));
}

export async function getOrCreateTokenAccount(pool: Pool, userId: string): Promise<TokenAccount> {
  const result = await pool.query<TokenAccount>(
    `
      INSERT INTO token_accounts (user_id, gift_tokens, recharge_tokens, last_gift_date)
      VALUES ($1, 0, 0, NULL)
      ON CONFLICT (user_id) DO UPDATE SET updated_at = NOW()
      RETURNING *
    `,
    [userId]
  );
  return normalizeTokenAccount(result.rows[0]);
}

export interface LoginStreakReward {
  account: TokenAccount;
  streak_days: number;
  reward_tokens: number;
  granted_tokens: number;
}

export async function awardLoginStreakReward(
  pool: Pool,
  userId: string,
  now = new Date()
): Promise<LoginStreakReward> {
  await getOrCreateTokenAccount(pool, userId);
  const todayStr = getShanghaiDateString(now);
  const yesterdayStr = addCalendarDays(todayStr, -1);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const lockResult = await client.query<TokenAccount>(
      'SELECT * FROM token_accounts WHERE user_id = $1 FOR UPDATE',
      [userId]
    );

    if (lockResult.rowCount === 0) {
      throw new Error(`Token account not found for user ${userId}`);
    }

    const lockedAccount = normalizeTokenAccount(lockResult.rows[0]);
    const lastLoginDate = toDateString(lockedAccount.last_login_reward_date);
    if (lastLoginDate === todayStr || (lastLoginDate !== null && lastLoginDate > todayStr)) {
      await client.query('COMMIT');
      return {
        account: lockedAccount,
        streak_days: lockedAccount.login_streak_days,
        reward_tokens: 0,
        granted_tokens: 0,
      };
    }

    const streakDays = lastLoginDate === yesterdayStr ? lockedAccount.login_streak_days + 1 : 1;
    const rewardTokens = LOGIN_STREAK_REWARD_BASE * streakDays;
    const grantedTokens = Math.max(0, Math.min(rewardTokens, MAX_GIFT_TOKENS - lockedAccount.gift_tokens));

    await client.query(
      `UPDATE token_accounts
       SET gift_tokens = gift_tokens + $2,
           last_login_reward_date = $3,
           login_streak_days = $4,
           updated_at = NOW()
       WHERE user_id = $1`,
      [userId, grantedTokens, todayStr, streakDays]
    );

    if (grantedTokens > 0) {
      await client.query(
        `
          INSERT INTO token_ledger_entries (user_id, delta_tokens, bucket, entry_type, note)
          VALUES ($1, $2, 'gift', 'login_streak_gift', $3)
        `,
        [userId, grantedTokens, `连续登录第 ${String(streakDays)} 天赠送额度（${todayStr}）`]
      );
    }

    await client.query('COMMIT');

    const refreshed = await pool.query<TokenAccount>('SELECT * FROM token_accounts WHERE user_id = $1', [userId]);
    return {
      account: normalizeTokenAccount(refreshed.rows[0]),
      streak_days: streakDays,
      reward_tokens: rewardTokens,
      granted_tokens: grantedTokens,
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function rechargeTokens(
  pool: Pool,
  userId: string,
  amount: number,
  adminUserId: string,
  note?: string
): Promise<TokenAccount> {
  if (!Number.isInteger(amount) || amount <= 0) {
    throw new Error('充值额度必须为正整数');
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(
      'UPDATE token_accounts SET recharge_tokens = recharge_tokens + $2, updated_at = NOW() WHERE user_id = $1',
      [userId, amount]
    );

    await client.query(
      `
        INSERT INTO token_ledger_entries (user_id, delta_tokens, bucket, entry_type, created_by_user_id, note)
        VALUES ($1, $2, 'recharge', 'admin_recharge', $3, $4)
      `,
      [userId, amount, adminUserId, note ?? '管理员充值额度']
    );

    await client.query('COMMIT');

    const refreshed = await pool.query<TokenAccount>('SELECT * FROM token_accounts WHERE user_id = $1', [userId]);
    return normalizeTokenAccount(refreshed.rows[0]);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function deductForUsage(
  client: PoolClient,
  userId: string,
  totalTokens: number,
  usageRecordId: string,
  note?: string
): Promise<void> {
  if (totalTokens <= 0) {
    return;
  }

  const accountResult = await client.query<TokenAccount>(
    'SELECT * FROM token_accounts WHERE user_id = $1 FOR UPDATE',
    [userId]
  );

  if (accountResult.rowCount === 0) {
    throw new Error(`Token account not found for user ${userId}`);
  }

  const account = normalizeTokenAccount(accountResult.rows[0]);

  // 单桶扣减：赠送余额大于 0 时全部从赠送扣（可扣至负数）；否则从充值扣（可扣至负数）
  let newGift = account.gift_tokens;
  let newRecharge = account.recharge_tokens;
  let bucket: 'gift' | 'recharge';

  if (account.gift_tokens > 0) {
    bucket = 'gift';
    newGift = account.gift_tokens - totalTokens;
  } else {
    bucket = 'recharge';
    newRecharge = account.recharge_tokens - totalTokens;
  }

  await client.query(
    'UPDATE token_accounts SET gift_tokens = $2, recharge_tokens = $3, updated_at = NOW() WHERE user_id = $1',
    [userId, newGift, newRecharge]
  );

  await client.query(
    `
      INSERT INTO token_ledger_entries (user_id, delta_tokens, bucket, entry_type, usage_record_id, note)
      VALUES ($1, $2, $3, 'usage', $4, $5)
    `,
    [userId, -totalTokens, bucket, usageRecordId, note ?? '使用消耗']
  );
}

export async function getTokenAccount(pool: Pool, userId: string): Promise<TokenAccount> {
  return getOrCreateTokenAccount(pool, userId);
}

export async function getLedgerEntries(pool: Pool, userId: string): Promise<TokenLedgerEntry[]> {
  const result = await pool.query<TokenLedgerEntry>(
    `
      SELECT *
      FROM token_ledger_entries
      WHERE user_id = $1
      ORDER BY created_at DESC
    `,
    [userId]
  );
  return result.rows.map(normalizeLedgerEntry);
}

export async function getAdminLedgerEntries(pool: Pool, userId: string): Promise<AdminLedgerEntry[]> {
  const result = await pool.query<AdminLedgerRow>(
    `${ADMIN_LEDGER_SELECT}
     WHERE e.user_id = $1
     ORDER BY e.created_at DESC, e.id DESC`,
    [userId]
  );
  return result.rows.map(normalizeAdminLedgerEntry);
}

export async function getAllUsageLedgerEntries(
  pool: Pool,
  page: number,
  pageSize: number
): Promise<AdminUsageLedgerPage> {
  const offset = (page - 1) * pageSize;
  const [entriesResult, countResult] = await Promise.all([
    pool.query<AdminLedgerRow>(
      `${ADMIN_LEDGER_SELECT}
       WHERE e.entry_type = 'usage' AND e.delta_tokens < 0
       ORDER BY e.created_at DESC, e.id DESC
       LIMIT $1 OFFSET $2`,
      [pageSize, offset]
    ),
    pool.query<{ total: string | number }>(
      `SELECT COUNT(*) AS total
       FROM token_ledger_entries
       WHERE entry_type = 'usage' AND delta_tokens < 0`
    ),
  ]);

  return {
    items: entriesResult.rows.map(normalizeAdminLedgerEntry),
    total: toNumber(countResult.rows[0]?.total ?? 0),
    page,
    page_size: pageSize,
  };
}

export async function getAdminUsageReplyTarget(
  pool: Pool,
  ledgerEntryId: string
): Promise<AdminUsageReplyTarget | undefined> {
  const result = await pool.query<AdminUsageReplyTarget>(
    `SELECT
       e.id,
       e.user_id,
       u.username,
       e.entry_type,
       e.delta_tokens,
       e.created_at,
       e.usage_record_id,
       a.name AS app_name,
       a.api_base_url,
       a.api_key,
       ur.conversation_id,
       ur.message_id
     FROM token_ledger_entries e
     JOIN users u ON u.id = e.user_id
     LEFT JOIN yiai_usage_records ur ON ur.id = e.usage_record_id
     LEFT JOIN yiai_apps a ON a.id = ur.app_id
     WHERE e.id = $1`,
    [ledgerEntryId]
  );
  const row = result.rows.at(0);
  if (!row) return undefined;
  return { ...row, delta_tokens: toNumber(row.delta_tokens) };
}

export async function getAllUserAccounts(
  pool: Pool
): Promise<Array<{ id: string; username: string; role: string; created_at: string; gift_tokens: number; recharge_tokens: number }>> {
  const result = await pool.query<
    {
      id: string;
      username: string;
      role: string;
      created_at: string;
      gift_tokens: number;
      recharge_tokens: number;
    }
  >(
    `
      SELECT
        u.id,
        u.username,
        u.role,
        u.created_at,
        COALESCE(t.gift_tokens, 0) AS gift_tokens,
        COALESCE(t.recharge_tokens, 0) AS recharge_tokens
      FROM users u
      LEFT JOIN token_accounts t ON t.user_id = u.id
      ORDER BY u.created_at DESC
    `
  );
  return result.rows.map((row) => ({
    ...row,
    gift_tokens: toNumber(row.gift_tokens),
    recharge_tokens: toNumber(row.recharge_tokens),
  }));
}
