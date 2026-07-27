CREATE TABLE IF NOT EXISTS conversation_display_names (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  app_id UUID NOT NULL REFERENCES yiai_apps(id) ON DELETE CASCADE,
  conversation_id TEXT NOT NULL,
  display_name VARCHAR(80) NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, app_id, conversation_id)
);

CREATE INDEX IF NOT EXISTS idx_conversation_display_names_user_app
  ON conversation_display_names (user_id, app_id);
