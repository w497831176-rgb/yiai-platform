CREATE TABLE IF NOT EXISTS feedbacks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  screenshot_filename TEXT,
  screenshot_content_type VARCHAR(64),
  screenshot_size_bytes INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (screenshot_filename IS NOT NULL OR (screenshot_content_type IS NULL AND screenshot_size_bytes IS NULL)),
  CHECK (screenshot_filename IS NULL OR (screenshot_content_type IS NOT NULL AND screenshot_size_bytes IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_feedbacks_created_at ON feedbacks(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_feedbacks_user_id_created_at ON feedbacks(user_id, created_at DESC);
