CREATE TABLE IF NOT EXISTS hidden_conversations (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  app_id UUID NOT NULL REFERENCES yiai_apps(id) ON DELETE CASCADE,
  conversation_id TEXT NOT NULL,
  hidden_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, app_id, conversation_id)
);

CREATE INDEX IF NOT EXISTS idx_hidden_conversations_user_app
  ON hidden_conversations (user_id, app_id);
