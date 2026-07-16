-- 扩展 yiai_apps 图标字段，支持 image/emoji 双类型与背景色
ALTER TABLE yiai_apps
  ADD COLUMN IF NOT EXISTS icon_type VARCHAR(20),
  ADD COLUMN IF NOT EXISTS icon_background VARCHAR(100);
