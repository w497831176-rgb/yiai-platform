CREATE TABLE IF NOT EXISTS yiai_apps (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug VARCHAR(100) NOT NULL UNIQUE,
  name VARCHAR(255) NOT NULL,
  description TEXT,
  icon VARCHAR(500),
  api_base_url VARCHAR(500) NOT NULL,
  api_key VARCHAR(500) NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT true,
  sort_order INT NOT NULL DEFAULT 0,
  requires_new_conversation_inputs BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_yiai_apps_slug ON yiai_apps(slug);
CREATE INDEX IF NOT EXISTS idx_yiai_apps_enabled_sort ON yiai_apps(enabled, sort_order);

CREATE TABLE IF NOT EXISTS yiai_usage_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  app_id UUID NOT NULL REFERENCES yiai_apps(id) ON DELETE CASCADE,
  conversation_id VARCHAR(255),
  message_id VARCHAR(255),
  task_id VARCHAR(255),
  total_tokens INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_yiai_usage_records_user_app ON yiai_usage_records(user_id, app_id);
CREATE INDEX IF NOT EXISTS idx_yiai_usage_records_created_at ON yiai_usage_records(created_at);
