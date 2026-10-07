# @creative/contracts

浏览器与服务端共用的 Zod 模式与 TypeScript 类型契约。

- `src/index.ts`：统一导出入口，包含核心领域模式与类型：
  - 基础认证与健康检查模式（`healthSchema`, `meResponseSchema`）
  - 既有 Echo Agent 模式（`agentRequestSchema`, `agentRunStatusSchema`, `agentRunSchema`）
  - 画布与项目模式（`canvasSnapshotSchema`, `projectNameSchema`, `createProjectRequestSchema`, `projectSummarySchema` 等）
  - 画布补丁模式（`canvasPatchOpSchema`, `canvasPatchSchema`，包含 `addNode`, `updateConfig`, `connect`）
  - Agent Loop 运行模式与状态（`agentLoopRunStatusSchema`, `agentLoopOutcomeSchema`, `agentLoopProposalStatusSchema`, `agentLoopProposalResultSchema`, `agentLoopProposalSchema`, `agentLoopStepSchema`, `agentLoopRunSchema`, `agentLoopApprovalRequestSchema`）
  - Agent Profile 与 Starter 模式（`agentStarterSchema`, `agentProfileSummarySchema`）
  - Agent 实时事件与流模式（`agentEventsChannel`, `agentEventsSeqKey`, `agentRunStatusEventSchema`, `agentStepStartedEventSchema`, `agentTextDeltaEventSchema`, `agentStepCompletedEventSchema`, `agentToolProposedEventSchema`, `agentToolDecidedEventSchema`, `agentToolResultEventSchema`, `agentEventSchema`, `agentSnapshotEventSchema`, `agentPingEventSchema`, `agentDoneEventSchema`, `agentStreamEventSchema`）
  - 实时票据模式（`realtimeTicketRequestSchema`, `realtimeTicketResponseSchema`）
- `src/internal-auth.ts`：网关与后端内部签名通信契约（`signInternalIdentity`, `verifyInternalIdentity`，`x-internal-*` 头与 HMAC 签名）。
- `src/assets.ts`：资产直传与就绪状态模式（`createDirectUploadRequestSchema`, `directUploadResponseSchema`, `createAssetRequestSchema`, `assetSummarySchema`）。
- `src/tasks.ts`：异步任务与媒体探测信封模式（`taskEnvelopeSchema`, `mediaProbeTaskInputSchema`, `mediaProbeTaskOutputSchema`）。
- `src/media.ts`：媒体元数据模式（`videoMetaSchema`, `imageMetaSchema`, `audioMetaSchema`）。
- `src/events.ts`：通用领域事件基础类型（`DomainEvent`）。
- `src/runtime.ts`：任务运行时状态类型（`TaskStatus`, `TaskHeartbeat`）。
