ALTER TABLE yiai_apps
  ADD COLUMN token_multiplier INT NOT NULL DEFAULT 1,
  ADD CONSTRAINT yiai_apps_token_multiplier_range CHECK (token_multiplier BETWEEN 1 AND 1000000);

ALTER TABLE yiai_usage_records
  ALTER COLUMN total_tokens TYPE BIGINT;
