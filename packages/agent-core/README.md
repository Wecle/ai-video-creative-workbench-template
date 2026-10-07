# Agent Core

Agent 执行内核与策略层，包含子路径设计与类型守卫：

- `@creative/agent-core/pure`：纯策略、消息类型、上下文构建、路由与工具名称映射。零外部运行时依赖，供 Temporal workflow、worker、backend 共享。
- `@creative/agent-core`：根入口，包含 AgentProfile、Skill manifest、ToolProvider 接口与工具注册表，以及既有 EchoAgentAdapter。
- `@creative/agent-core/runtime`：运行期能力（LLM 调用、无状态 Mock 模型、模型解析器、Skill 磁盘加载器），仅供 `agent-runner` 引用。

## 目录结构

- `src/pure.ts`：聚合导出 pure 子路径模块
- `src/policy/`：风险等级（Risk）、审批判定（decideToolCall）、预算估算与上限
- `src/loop/`：消息结构（AgentMessage）、步骤定义与消息构建辅助函数
- `src/context/`：提示词拼接纯函数（buildContext），注入画布紧凑摘要与 Skill 目录
- `src/router/`：意图路由器（IntentRouter），包含规则路由（RuleRouter）与测试 Mock 路由
- `src/profiles/`：AgentProfile 定义、schema 校验与示例配置（creative-assistant）
- `src/tools/`：ToolProvider 接口、名称规范化（toModelToolName / fromModelToolName）与 ToolRegistry
- `src/skills/`：Skill 清单（manifest.json）schema 校验
- `src/runtime/`：运行时 LLM step、Mock 模型与 ModelResolver
