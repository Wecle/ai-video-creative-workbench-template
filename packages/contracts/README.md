# @creative/contracts

浏览器与服务端共用的 Zod 模式与 TypeScript 类型契约。

- `src/internal-auth.ts`：网关与后端内部签名通信契约（`x-internal-*` 头与 HMAC 签名）。
- `src/runtime.ts`：项目、画布 API 请求与响应结构。
- `src/events.ts`：画布执行运行与节点状态事件模式（`runEventSchema`）。
- `src/tasks.ts`：媒体探测与资产元数据模式（`mediaProbeInputSchema`、`mediaProbeOutputSchema`）。
- `src/assets.ts`：资产直传与就绪状态模式。
- `src/agent.ts`：Agent Loop 运行、步骤、事件、工具提议与补丁模式：
  - `agentRunStatusSchema` / `agentRunOutcomeSchema` / `agentRunStateSchema`
  - `agentProposalSchema` / `agentApprovalDecisionSchema` / `agentApprovalPayloadSchema`
  - `agentEventSchema` / `publishableAgentEventSchema`
  - `canvasPatchSchema`（包含 `insert_node`, `update_node_config`, `remove_node`, `connect`, `remove_edge`）
  - `agentEventsChannel` / `agentEventsSeqKey`
- `src/realtime.ts`：实时票据请求与响应模式（`realtimeTicketRequestSchema`、`realtimeTicketResponseSchema`）。
