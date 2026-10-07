# Scripts

工程、生成和验证脚本目录。临时命令不应提交到这里。

- `smoke-p0a.sh`：Gateway 验签、Backend 信任边界与登录流程冒烟（需要运行中的栈）
- `smoke-p0b.sh`：echo workflow 经 Backend、Temporal、Agent Runner 跑通的冒烟（需要运行中的栈；可选地停启 `temporal` 容器检查 503 与恢复）
- `smoke-p1.sh`：项目与画布冒烟：保存、409 版本冲突、422 非法状态、快照不含 status/viewport、约 800 KB 状态经 Gateway 与 Web rewrite 保存、其他用户一律 404（需要运行中的栈、curl、jq 和 Node 22/pnpm，状态由 `packages/canvas-doc/scripts/make-state.ts` 生成）
- `smoke-p2a.sh`：画布执行链路冒烟：DAG 工作流、Mock 提供商、轮询与回调双模式、Webhook 验签与防重放
- `smoke-p2b.sh`：实时流、存储与媒体探测冒烟：单次票据授权、SSE 事件推送与心跳、S3 预签名直传与完整性校验、Temporal Python media.probe 探测执行
- `smoke-p3.sh`：Agent Loop 与实时流冒烟：Agent run 启动、单次票据跨资源隔离、SSE 事件流推送、工具提案生成、人工审批与拒绝、Skill 载入、心跳保活与 worker 重启（需要运行中的栈、curl、jq 和 Node 22/pnpm）
- `bootstrap.sh`：`pnpm bootstrap`，一条命令初始化本地环境（可重复执行，不覆盖已有 `.env`）。脚本名不用 `setup`，因为 `pnpm setup` 是 pnpm 内置命令
