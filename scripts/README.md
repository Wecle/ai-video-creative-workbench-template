# Scripts

工程、生成和验证脚本目录。临时命令不应提交到这里。

- `smoke-p0a.sh`：Gateway 验签、Backend 信任边界与登录流程冒烟（需要运行中的栈）
- `smoke-p0b.sh`：echo workflow 经 Backend、Temporal、Agent Runner 跑通的冒烟（需要运行中的栈；可选地停启 `temporal` 容器检查 503 与恢复）
- `smoke-p1.sh`：项目与画布冒烟：保存、409 版本冲突、422 非法状态、快照不含 status/viewport、约 800 KB 状态经 Gateway 与 Web rewrite 保存、其他用户一律 404（需要运行中的栈、curl、jq 和 Node 22/pnpm，状态由 `packages/canvas-doc/scripts/make-state.ts` 生成）
- `bootstrap.sh`：`pnpm bootstrap`，一条命令初始化本地环境（可重复执行，不覆盖已有 `.env`）。脚本名不用 `setup`，因为 `pnpm setup` 是 pnpm 内置命令
