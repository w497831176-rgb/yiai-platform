-- Token 双额度账本与防重复消费
CREATE TABLE IF NOT EXISTS token_accounts (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  gift_tokens BIGINT NOT NULL DEFAULT 0 CHECK (gift_tokens >= 0 AND gift_tokens <= 100000),
  recharge_tokens BIGINT NOT NULL DEFAULT 0,
  last_gift_date DATE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS token_ledger_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  delta_tokens BIGINT NOT NULL,
  bucket VARCHAR(16) NOT NULL CHECK (bucket IN ('gift', 'recharge')),
  entry_type VARCHAR(32) NOT NULL CHECK (entry_type IN ('daily_gift', 'admin_recharge', 'usage')),
  usage_record_id UUID REFERENCES yiai_usage_records(id) ON DELETE SET NULL,
  created_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_token_ledger_entries_user_id_created_at
  ON token_ledger_entries(user_id, created_at DESC);

-- 防止同一上游 message_end 被重复计费
CREATE UNIQUE INDEX IF NOT EXISTS idx_yiai_usage_records_message_id_unique
  ON yiai_usage_records(message_id)
  WHERE message_id IS NOT NULL;

-- 为现有用户安全创建空账户（首次读取余额时再补发当天赠送额度）
INSERT INTO token_accounts (user_id, gift_tokens, recharge_tokens, last_gift_date)
SELECT id, 0, 0, NULL FROM users
ON CONFLICT (user_id) DO NOTHING;
