# Backend

产品业务后端。Gateway 负责公网入口、限流、JWT 验签和转发；Backend 只负责认证服务（Better Auth）、业务 API、领域逻辑和数据访问。

- src：Fastify 业务 API 和后端路由
- src/auth：Better Auth 配置（`auth.ts`）、`/api/auth/*` 路由桥接（`routes.ts`）和 CLI 入口（`cli.ts`，`pnpm auth:generate` 用）
- src/plugins/gateway-trust.ts：只信任带 Gateway 签名的请求
- modules/control-plane：工作区和任务控制（预留；项目与画布接口目前直接放在 src/routes）
- modules/realtime：实时事件推送实现（`src/realtime/run-event-bus.ts`、`src/realtime/sse-stream.ts`、`src/routes/realtime.ts`、`src/routes/realtime-agent.ts`）
- modules/webhooks：外部回调接收（`src/routes/webhooks.ts`）
- src/routes/assets.ts、src/assets/access.ts：资产管理接口（`POST /api/v1/assets/upload-url` 预签名直传申请；`POST …/:assetId/complete` 校验与就绪；`GET …/:assetId` 元数据查询；`GET …/:assetId/download-url` 预签名下载；`POST …/:assetId/probe` 触发媒体探测工作流）。受 workspace 成员权限保护，直接对接 S3 兼容存储
- src/routes/realtime.ts、src/routes/realtime-agent.ts：画布与 Agent 运行实时事件推送（`GET /api/v1/realtime/runs/:runId/events` 与 `GET /api/v1/realtime/agent/runs/:runId/events`），共用 `src/realtime/sse-stream.ts`，支持快照拉取、SSE 增量订阅、心跳保活和断连/终态退订防护
- src/routes/agent-loop.ts、src/temporal/agent-loops.ts：Agent Loop API（`POST /api/v1/agent/runs` 返回 202；`GET /api/v1/agent/runs/:runId` 查询状态；`POST /api/v1/agent/runs/:runId/approvals` 审批信号返回 202 `{accepted:true}`；`GET /api/v1/agent/profiles` 列表）。经 Temporal Client 启动并通知 `agentLoopWorkflow`；严格通过 `findAccessibleCanvas` 授权，未授权与不存在同为 404；`canvasVersion` 冲突 409
- src/routes/agent-runs.ts、src/temporal/agent-runs.ts：既有 Agent run API（`POST /api/v1/agent-runs` 返回 202，`GET /api/v1/agent-runs/:runId` 查询）。经 Temporal Client 启动并查询 `echoWorkflow`；owner 只取自网关签名身份，workflowId 为 `agent-run:<userId>:<runId>`，别人的 runId 一律 404。请求里的 `projectId`/`canvasId` 仍只是透传的不透明字符串；任何用它们读写画布数据的代码必须先调用 `findAccessibleCanvas`，查不到按 404 处理
- src/routes/projects.ts、src/routes/canvases.ts、src/canvas/access.ts：项目与画布接口（`GET/POST /api/v1/projects`；`GET /api/v1/projects/:projectId/canvases/:canvasId`；`PUT …/state`，body 为 `{ baseVersion, state }`，state 是 base64 的 Yjs 文档状态；`GET …/snapshot`）。`findAccessibleCanvas` 是画布授权的唯一入口：必须是画布所属 workspace 的成员且画布属于 URL 中的项目，否则一律 404（不区分不存在与无权限，不用 403）。保存时先授权、再解码并校验状态（`@creative/canvas-doc` 的 `inspectState` + node-registry），再用一条带 `version = baseVersion` 与成员条件的 UPDATE 写入：旧版本 409（带 `currentVersion`）、非法状态 422（只返回错误码和路径，不回显 config）、body 超过 1 MB 为 413。JSON 快照由服务端从状态生成，不接受客户端上传。`buildApp` 的 `registry` 选项可注入自定义节点定义（测试用）
- test：后端测试（Temporal 相关用例用 `TestWorkflowEnvironment.createLocal()`，首次运行需联网下载固定版本的 Temporal CLI；离线时设置 `TEMPORAL_CLI_PATH`）

默认监听 127.0.0.1:4001，生产部署不直接暴露公网。没有 Gateway 签名的请求一律 403，`/health`、`/ready` 和 `GET /api/auth/jwks`（公钥，供 Gateway 验签）除外；有签名但匿名访问 `/api/v1/*` 返回 401。需要 DATABASE_URL、WEB_ORIGIN、BETTER_AUTH_SECRET、INTERNAL_AUTH_SECRET（见 .env.example）；`TEMPORAL_ADDRESS`（开发默认 `localhost:7233`，生产必填）、`TEMPORAL_NAMESPACE`（默认 `default`）；`S3_*`（对象存储配置，生产必填）；`REDIS_URL`（实时流与事件总线，生产必填）。Temporal 不可用时 Agent run 与探测接口返回 503（每次调用 3 秒截止），`/ready` 的 `dependencies.temporal` 反映连通性，`/health` 不受影响。
