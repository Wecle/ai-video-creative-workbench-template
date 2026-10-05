# Backend

产品业务后端。Gateway 负责公网入口、限流、JWT 验签和转发；Backend 只负责认证服务（Better Auth）、业务 API、领域逻辑和数据访问。

- src：Fastify 业务 API 和后端路由
- src/auth：Better Auth 配置（`auth.ts`）、`/api/auth/*` 路由桥接（`routes.ts`）和 CLI 入口（`cli.ts`，`pnpm auth:generate` 用）
- src/plugins/gateway-trust.ts：只信任带 Gateway 签名的请求
- modules/control-plane：项目、工作区和任务控制（预留）
- modules/realtime：实时事件推送（预留）
- modules/webhooks：外部回调接收（预留）
- test：后端测试

默认监听 127.0.0.1:4001，生产部署不直接暴露公网。没有 Gateway 签名的请求一律 403，`/health`、`/ready` 和 `GET /api/auth/jwks`（公钥，供 Gateway 验签）除外；有签名但匿名访问 `/api/v1/*` 返回 401。需要 DATABASE_URL、WEB_ORIGIN、BETTER_AUTH_SECRET、INTERNAL_AUTH_SECRET（见 .env.example）。
