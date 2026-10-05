# Backend

产品业务后端。Gateway 负责公网入口、限流、JWT 验签和转发；Backend 只负责认证服务（Better Auth）、业务 API、领域逻辑和数据访问。

- src：Fastify 业务 API 和后端路由
- src/auth：Better Auth 配置（`auth.ts`）、`/api/auth/*` 路由桥接（`routes.ts`）和 CLI 入口（`cli.ts`，`pnpm auth:generate` 用）
- src/plugins/gateway-trust.ts：只信任带 Gateway 签名的请求
- modules/control-plane：项目、工作区和任务控制（预留）
- modules/realtime：实时事件推送（预留）
- modules/webhooks：外部回调接收（预留）
- src/routes/agent-runs.ts、src/temporal/agent-runs.ts：Agent run API（`POST /api/v1/agent-runs` 返回 202，`GET /api/v1/agent-runs/:runId` 查询）。经 Temporal Client 启动并查询 `echoWorkflow`；owner 只取自网关签名身份，workflowId 为 `agent-run:<userId>:<runId>`，别人的 runId 一律 404
- test：后端测试（Temporal 相关用例用 `TestWorkflowEnvironment.createLocal()`，首次运行需联网下载固定版本的 Temporal CLI；离线时设置 `TEMPORAL_CLI_PATH`）

默认监听 127.0.0.1:4001，生产部署不直接暴露公网。没有 Gateway 签名的请求一律 403，`/health`、`/ready` 和 `GET /api/auth/jwks`（公钥，供 Gateway 验签）除外；有签名但匿名访问 `/api/v1/*` 返回 401。需要 DATABASE_URL、WEB_ORIGIN、BETTER_AUTH_SECRET、INTERNAL_AUTH_SECRET（见 .env.example）；`TEMPORAL_ADDRESS`（开发默认 `localhost:7233`，生产必填）、`TEMPORAL_NAMESPACE`（默认 `default`）。Temporal 不可用时 Agent run 接口返回 503（每次调用 3 秒截止），`/ready` 的 `dependencies.temporal` 反映连通性，`/health` 不受影响。
