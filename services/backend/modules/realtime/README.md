# Realtime

后端实时事件推送实现位于：

- `src/realtime/run-event-bus.ts`：Redis pub/sub 订阅总线与引用计数管理。
- `src/routes/realtime.ts`：`GET /api/v1/realtime/runs/:runId/events` SSE 推送接口与快照自愈逻辑。

通过 Gateway 实时票据（`ticket` 身份）或 Bearer JWT 进行认证与授权。
