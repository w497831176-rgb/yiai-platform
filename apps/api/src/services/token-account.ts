import type { Pool, PoolClient } from 'pg';

export const DAILY_GIFT_AMOUNT = 50_000;
export const MAX_GIFT_TOKENS = 100_000;
const TIMEZONE = 'Asia/Shanghai';

export interface TokenAccount {
  user_id: string;
  gift_tokens: number;
  recharge_tokens: number;
  last_gift_date: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface TokenLedgerEntry {
  id: string;
  user_id: string;
  delta_tokens: number;
  bucket: 'gift' | 'recharge';
  entry_type: 'daily_gift' | 'admin_recharge' | 'usage';
  usage_record_id: string | null;
  created_by_user_id: string | null;
  note: string | null;
  created_at: Date;
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
  };
}

function normalizeLedgerEntry(row: TokenLedgerEntry): TokenLedgerEntry {
  return {
    ...row,
    delta_tokens: toNumber(row.delta_tokens),
  };
}

export function getShanghaiDateString(date: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
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

function diffCalendarDays(start: Date | string | null, end: Date | string): number {
  if (start === null) {
    return 1;
  }
  const startStr = toDateString(start);
  if (startStr === null) {
    return 1;
  }
  const startDate = parseDateAtMidnightUTC(startStr);
  const endStr = toDateString(end);
  if (endStr === null) {
    return 0;
  }
  const endDate = parseDateAtMidnightUTC(endStr);
  const diff = Math.floor((endDate.getTime() - startDate.getTime()) / 86_400_000);
  return Math.max(0, diff);
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

export async function ensureDailyGift(pool: Pool, userId: string, now = new Date()): Promise<TokenAccount> {
  const account = await getOrCreateTokenAccount(pool, userId);
  const todayStr = getShanghaiDateString(now);

  if (toDateString(account.last_gift_date) === todayStr) {
    return account;
  }

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

    const lockedAccount = lockResult.rows[0];
    const lastGiftDate = lockedAccount.last_gift_date;
    const daysToGrant = diffCalendarDays(lastGiftDate, todayStr);

    let currentGift = lockedAccount.gift_tokens;

    for (let day = 0; day < daysToGrant; day++) {
      const remainingCapacity = MAX_GIFT_TOKENS - currentGift;
      if (remainingCapacity <= 0) {
        break;
      }
      const delta = Math.min(DAILY_GIFT_AMOUNT, remainingCapacity);
      currentGift += delta;

      await client.query(
        'UPDATE token_accounts SET gift_tokens = gift_tokens + $2, updated_at = NOW() WHERE user_id = $1',
        [userId, delta]
      );

      await client.query(
        `
          INSERT INTO token_ledger_entries (user_id, delta_tokens, bucket, entry_type, note)
          VALUES ($1, $2, 'gift', 'daily_gift', $3)
        `,
        [userId, delta, `每日赠送额度（${todayStr}）`]
      );
    }

    await client.query(
      'UPDATE token_accounts SET last_gift_date = $2, updated_at = NOW() WHERE user_id = $1',
      [userId, todayStr]
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
  const giftDeduction = Math.min(totalTokens, account.gift_tokens);
  const rechargeDeduction = totalTokens - giftDeduction;

  const newGift = Math.max(0, account.gift_tokens - giftDeduction);
  const newRecharge = account.recharge_tokens - rechargeDeduction;

  await client.query(
    'UPDATE token_accounts SET gift_tokens = $2, recharge_tokens = $3, updated_at = NOW() WHERE user_id = $1',
    [userId, newGift, newRecharge]
  );

  if (giftDeduction > 0) {
    await client.query(
      `
        INSERT INTO token_ledger_entries (user_id, delta_tokens, bucket, entry_type, usage_record_id, note)
        VALUES ($1, $2, 'gift', 'usage', $3, $4)
      `,
      [userId, -giftDeduction, usageRecordId, note ?? '使用消耗']
    );
  }

  if (rechargeDeduction > 0) {
    await client.query(
      `
        INSERT INTO token_ledger_entries (user_id, delta_tokens, bucket, entry_type, usage_record_id, note)
        VALUES ($1, $2, 'recharge', 'usage', $3, $4)
      `,
      [userId, -rechargeDeduction, usageRecordId, note ?? '使用消耗']
    );
  }
}

export async function getTokenAccount(pool: Pool, userId: string, now = new Date()): Promise<TokenAccount> {
  return ensureDailyGift(pool, userId, now);
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
