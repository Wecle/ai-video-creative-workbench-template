# Realtime

后端实时事件推送实现位于：

- `src/realtime/run-event-bus.ts`：Redis pub/sub 泛化订阅总线与引用计数管理。
- `src/realtime/sse-stream.ts`：共用的 SSE 运行流封装（快照分发、事件订阅、心跳保活、连接清理与泄漏防护）。
- `src/routes/realtime.ts`：`GET /api/v1/realtime/runs/:runId/events` 画布节点执行实时推送。
- `src/routes/realtime-agent.ts`：`GET /api/v1/realtime/agent/runs/:runId/events` Agent 循环实时推送。

通过 Gateway 实时票据（`ticket` 身份）或 Bearer JWT 进行认证与授权。
