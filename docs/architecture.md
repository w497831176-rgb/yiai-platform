# YIAI Platform 架构说明

## 总体架构

```
浏览器
  │
  ▼
Nginx（静态前端 + 反向代理）
  │
  ▼
Fastify API
  │
  ├── PostgreSQL（业务数据）
  │
  └── Dify（外部 Chatflow/Agent/Chat Assistant 服务）
```

## 数据流说明

1. 浏览器访问 YIAI Platform 前端页面。
2. Nginx 提供前端静态资源；对 `/api/*` 请求反向代理到 Fastify API。
3. Fastify API 处理业务逻辑，将持久化数据写入 PostgreSQL。
4. 未来需要调用 Dify 时，由 Fastify API 使用后端保存的 Dify API Key 发起调用，浏览器不直接接触 Key。

## 当前 V0 范围

- 仅实现工程基础设施：Monorepo、前端基础页、后端健康检查、数据库迁移、Docker Compose、文档。
- 不实现：登录、注册、聊天、图片上传、Token 账本、Token 扣减、admin 后台、Workflow、真实 Dify 连接。

## 未来 Token 结算原则

- **结算依据**：Token 以 Dify 最终返回的 `total_tokens` 为唯一结算依据。
- **兑换比例**：1 Token 就是 1 Token，不做积分兑换。
- **收费模式**：不采用固定单次收费，按实际 Token 消耗结算。
- **在线支付**：不实现在线支付功能。
- **管理员能力**：未来由 admin 管理赠送 Token、充值 Token、应用配置和完整 Token 账本。
- **普通用户能力**：普通用户只能查看自己的余额、自己的会话和自己的本次实际 Token 消耗。

## 安全原则

- Dify API Key 永远只能由后端调用。
- 浏览器端不得保存、展示、请求或接触 Dify API Key。
