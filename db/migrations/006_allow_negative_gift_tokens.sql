-- V1.8: 允许赠送余额在单笔消息消费后临时为负，仅保留每日赠送上限约束
-- PostgreSQL 与 pg-mem 对 CHECK 约束的自动命名不同，使用 IF EXISTS 安全删除两种可能名称
ALTER TABLE token_accounts DROP CONSTRAINT IF EXISTS token_accounts_gift_tokens_check;
ALTER TABLE token_accounts DROP CONSTRAINT IF EXISTS token_accounts_constraint_1;
ALTER TABLE token_accounts ADD CONSTRAINT token_accounts_gift_tokens_check CHECK (gift_tokens <= 100000);
