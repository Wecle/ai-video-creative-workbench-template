# Agent Core

Provider-independent AgentAdapter contract plus a deterministic EchoAgentAdapter for verifying service wiring. The example completes synchronously, keeps no run history, and calls no model or tool.

Extend this boundary with a bounded loop, context/token budget, cancellation, checkpoint persistence and tool-result handling. Tool, Skill and MCP runtime directories document the related boundaries; they are not implemented orchestration engines.
