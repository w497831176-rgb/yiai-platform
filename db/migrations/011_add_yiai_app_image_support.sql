-- Image attachments are an explicit per-app platform capability. Keep this
-- disabled for existing applications until an administrator enables it.
ALTER TABLE yiai_apps
  ADD COLUMN IF NOT EXISTS supports_images BOOLEAN NOT NULL DEFAULT FALSE;
