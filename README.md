# YIAI Platform

YIAI Platform 是面向 C 端用户的 Dify Chatflow 聚合平台。当前 V0 版本仅搭建工程基础设施，尚未实现业务功能。

## 当前支持范围

- 支持的 Dify 聊天类应用：Chatflow、Agent、Chat Assistant
- 不支持的类型：Workflow（尚未实现）
- 不实现的功能：登录、注册、聊天、图片上传、Token 账本、Token 扣减、admin 后台、在线支付、真实 Dify 连接

## 技术栈

- Monorepo：npm workspaces
- 前端：React + Vite + TypeScript
- 后端：Node.js 22 + Fastify + TypeScript
- 数据库：PostgreSQL 16
- 前端静态服务与反向代理：Nginx
- 测试：Vitest
- 代码质量：ESLint + TypeScript strict
- 容器化：Docker Compose

## 目录结构

```
apps/
  web/            # React + Vite 前端
  api/            # Fastify 后端
packages/
  shared/         # 共享类型与工具
infra/
  nginx/          # Nginx 配置
db/
  migrations/     # 数据库迁移脚本
docs/
  architecture.md # 架构与未来 Token 结算说明
```

## 本地开发

### 环境准备

1. 安装 Node.js 22+ 和 npm 10+
2. 复制环境变量示例文件：

```bash
cp .env.example .env
```

3. 安装依赖：

```bash
npm install
```

### 常用命令

| 命令 | 用途 |
|------|------|
| `npm run lint` | 全仓库 ESLint 检查 |
| `npm run typecheck` | 全仓库 TypeScript 类型检查（strict） |
| `npm run test` | 运行 Vitest 自动化测试 |
| `npm run build` | 构建 shared、web、api |
| `npm run dev:web` | 本地启动前端开发服务器 |
| `npm run dev:api` | 本地启动后端开发服务器 |

### 数据库迁移

确保 `.env` 中已配置数据库连接信息，然后执行：

```bash
npm run db:migrate
```

迁移脚本位于 `db/migrations/`，会按文件名顺序执行未应用的 `.sql` 文件，并记录到 `migrations` 表。

## Docker Compose

### 测试环境

```bash
# 启动
docker compose -f compose.test.yml up -d

# 停止
docker compose -f compose.test.yml down

# 查看配置
docker compose -f compose.test.yml config
```

### 生产环境

```bash
# 启动
docker compose -f compose.prod.yml up -d

# 停止
docker compose -f compose.prod.yml down

# 查看配置
docker compose -f compose.prod.yml config
```

## 容器与网络命名

### 测试环境

- Compose project：`yiai-platform-test`
- 前端容器：`yiai-platform-test-web`
- 后端容器：`yiai-platform-test-api`
- 数据库容器：`yiai-platform-test-db`
- Docker 网络：`yiai-platform-test-net`
- 前端宿主机端口：`18111`

### 生产环境

- Compose project：`yiai-platform-prod`
- 前端容器：`yiai-platform-prod-web`
- 后端容器：`yiai-platform-prod-api`
- 数据库容器：`yiai-platform-prod-db`
- Docker 网络：`yiai-platform-prod-net`
- 前端宿主机端口：`18113`

## NAS 部署路径

YIAI Platform 的所有 NAS 代码、bind mount 数据和备份路径均位于 `/volume3`：

- 测试代码目录：`/volume3/docker/yiai-platform-test`
- 测试数据目录：`/volume3/docker/volumes/yiai-platform-test`
- 测试备份目录：`/volume3/docker/backups/yiai-platform-test`
- 生产代码目录：`/volume3/docker/yiai-platform-prod`
- 生产数据目录：`/volume3/docker/volumes/yiai-platform-prod`
- 生产备份目录：`/volume3/docker/backups/yiai-platform-prod`

严禁使用 `/volume1/docker/*` 路径。

## 安全约定

- Dify API Key 永远只能由后端调用，浏览器端不得保存、展示、请求或接触 Dify API Key。
- `.env.example` 仅包含安全占位符，请勿提交真实密码、Key 或 Token。

## 状态说明

- 当前未初始化 Git、未推送 Git、未部署 NAS、未连接 Dify。
- 当前未实现登录、聊天、Token 账本和 admin 后台。
