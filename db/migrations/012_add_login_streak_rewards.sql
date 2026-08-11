-- 连续登录奖励：仅在成功登录时写入赠送账户，不再由读余额、聊天或后台浏览触发。
ALTER TABLE token_accounts DROP CONSTRAINT IF EXISTS token_accounts_gift_tokens_check;
ALTER TABLE token_accounts DROP CONSTRAINT IF EXISTS token_accounts_constraint_1;
ALTER TABLE token_accounts ADD CONSTRAINT token_accounts_gift_tokens_check CHECK (gift_tokens <= 1000000);

ALTER TABLE token_accounts
  ADD COLUMN IF NOT EXISTS last_login_reward_date DATE,
  ADD COLUMN IF NOT EXISTS login_streak_days INTEGER NOT NULL DEFAULT 0 CHECK (login_streak_days >= 0);

-- 部署当天已经领过旧版“每日赠送”的用户，不再额外发一笔新规则首日奖励。
UPDATE token_accounts
SET last_login_reward_date = CURRENT_DATE,
    login_streak_days = 1
WHERE last_login_reward_date IS NULL
  AND last_gift_date = CURRENT_DATE;

ALTER TABLE token_ledger_entries DROP CONSTRAINT IF EXISTS token_ledger_entries_entry_type_check;
ALTER TABLE token_ledger_entries DROP CONSTRAINT IF EXISTS token_ledger_entries_constraint_3;
ALTER TABLE token_ledger_entries DROP CONSTRAINT IF EXISTS token_ledger_entries_constraint_2;
ALTER TABLE token_ledger_entries
  ADD CONSTRAINT token_ledger_entries_entry_type_check
  CHECK (entry_type IN ('daily_gift', 'login_streak_gift', 'admin_recharge', 'usage'));
