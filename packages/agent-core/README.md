# Agent Core

Agent 执行内核。当前包含可替换的 AgentAdapter 和 Echo 演示实现；完整 loop、持久化和工具执行仍由后续产品接入。

当前实现位于 src/index.ts。预留内部边界：

- src/loop：Agent loop、Step、Action、Observation（预留）
- src/context：上下文组装、预算、压缩和快照（预留）
- src/policy：权限、预算和审批判断（预留）
- src/tools/runtime：Tool Calling 生命周期（预留）
- src/tools/adapters/mcp：MCP Client 与 Transport（预留）
- src/skills/runtime：Skill 加载与执行（预留）

这些模块先随 Agent Core 演进；当出现独立消费者或独立生命周期时，再提取为 workspace package。
