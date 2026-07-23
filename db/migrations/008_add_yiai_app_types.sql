ALTER TABLE yiai_apps
  ADD COLUMN app_type VARCHAR(16) NOT NULL DEFAULT 'chatflow';

ALTER TABLE yiai_apps
  ADD COLUMN agent_input_form JSONB NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE yiai_apps
  ADD CONSTRAINT yiai_apps_app_type_check CHECK (app_type IN ('chatflow', 'agent'));
