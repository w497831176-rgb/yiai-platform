-- 本地图标缓存：记录缓存文件名、Content-Type 与缓存时间
ALTER TABLE yiai_apps ADD COLUMN IF NOT EXISTS icon_cache_filename VARCHAR(255);
ALTER TABLE yiai_apps ADD COLUMN IF NOT EXISTS icon_cache_content_type VARCHAR(128);
ALTER TABLE yiai_apps ADD COLUMN IF NOT EXISTS icon_cached_at TIMESTAMP WITH TIME ZONE;
