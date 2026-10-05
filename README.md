# AI Video Creative Workbench Template

面向 AI 视频创作工具的 monorepo 模板：Next.js 前端、Fastify 后端、Agent Runner、媒体 Worker，以及可扩展的 Skill 和 MCP 能力目录。

> [!NOTE]
> 当前仓库是技术脚手架。画布和 Agent 使用演示实现，不包含完整业务或模型调用。已接入邮箱密码登录（Better Auth）、Gateway JWT 验签和 Redis 限流；邮箱验证、找回密码和租户授权尚未实现。

## 快速开始

环境：Node.js 22.9+、pnpm 10.13.1；Python Worker 需要 Python 3.12+ 和 uv。

```bash
pnpm install --frozen-lockfile
cp .env.example .env
pnpm infra:up      # PostgreSQL 和 Redis（登录与限流需要）
pnpm db:migrate    # 迁移不随服务启动，需要手动执行
pnpm dev
```

打开 http://localhost:3000 会跳转到 `/login`，先注册账号。

默认启动：Web、Gateway、Backend、Agent Runner。媒体 Worker 单独启动：

```bash
pnpm dev:worker
```

完整 Docker 栈：

```bash
# 镜像以 NODE_ENV=production 运行，会拒绝 "dev-only" 占位密钥：先在 .env 里换成真实值
#   openssl rand -base64 32   （BETTER_AUTH_SECRET 与 INTERNAL_AUTH_SECRET 各生成一个）
pnpm infra:up && pnpm db:migrate   # 首次或升级后
pnpm docker:up
scripts/smoke-p0a.sh               # 冒烟：Gateway 验签与 Backend 信任边界
pnpm docker:down
```

注意：`docker:down` 与 `infra:down` 使用同一个 Compose 项目，`docker:down` 也会移除 postgres 和 redis 容器（数据卷保留）；之后需要再执行 `pnpm infra:up`。

| 组件            | 地址                       |
| --------------- | -------------------------- |
| Web             | http://localhost:3000      |
| Gateway         | http://localhost:4000      |
| API 文档        | http://localhost:4000/docs |
| Backend（调试） | http://localhost:4001      |
| Agent Runner    | http://localhost:4100      |
| Media Worker    | http://localhost:4200      |

## 项目结构

标记：`[active]` 为当前运行实现，`[reserved]` 为只保留说明的扩展边界。

```text
.
├── apps/
│   └── web/                         # [active] Next.js 前端、React Flow 画布和业务界面
│       ├── app/                     # 路由、布局和全局样式
│       └── features/                # 画布、工作区等前端功能
├── services/
│   ├── gateway/                      # [active] 独立公网入口、限流和 Backend 代理
│   │   ├── src/                      # Gateway 路由、代理和服务启动
│   │   └── test/                     # Gateway 测试
│   ├── backend/                     # [active] 产品后端和业务 API
│   │   ├── src/                     # Fastify 路由、校验和服务启动
│   │   ├── modules/
│   │   │   ├── control-plane/       # [reserved] 项目、工作区和任务控制
│   │   │   ├── realtime/            # [reserved] SSE/WebSocket 和运行事件推送
│   │   │   └── webhooks/            # [reserved] 外部供应商回调
│   │   └── test/                    # 后端测试
│   └── agent-runner/                # [active] Agent 执行宿主
│       ├── src/                     # Agent 请求、执行和服务启动
│       └── test/                    # Agent 服务测试
├── workers/
│   └── media-worker-python/         # [active] Python 媒体任务接口和处理 Worker
├── packages/
│   ├── agent-core/                  # [active] Agent 内核和 Echo 演示 Adapter
│   │   └── src/
│   │       ├── context/             # [reserved] 上下文预算、压缩和快照
│   │       ├── policy/              # [reserved] 权限、预算和审批策略
│   │       ├── tools/runtime/       # [reserved] Tool Calling 生命周期
│   │       ├── tools/adapters/mcp/  # [reserved] MCP Client 和传输适配
│   │       └── skills/runtime/      # [reserved] Skill 加载和执行
│   ├── api-client/                  # Web 等客户端使用的类型化 API Client
│   ├── contracts/                   # API、事件、任务和能力声明
│   ├── database/                    # 服务端 Drizzle/PostgreSQL 连接和迁移
│   ├── domain/                      # [reserved] 跨服务领域模型和规则
│   ├── job-queue/                   # BullMQ 队列工厂和任务基础设施
│   ├── node-registry/               # [reserved] 画布节点定义和配置注册
│   ├── observability/               # OpenTelemetry 日志、指标和 Trace 支撑
│   └── ui/                          # 共享 shadcn/ui 源码和基础组件
├── capabilities/
│   ├── skills/                      # [reserved] 版本化 Skill 定义和元数据
│   ├── mcp-servers/                 # [reserved] 具体 MCP Server
│   └── tool-manifests/              # [reserved] Tool、权限和传输声明
├── infra/
│   └── docker/                      # 本地基础设施和完整 Docker Compose
├── docs/                            # 架构和扩展边界说明
├── tests/                           # 跨服务、契约和端到端测试位置
├── scripts/                         # [reserved] 工程和验证脚本位置
├── .env.example                     # 本地环境变量模板
├── package.json                     # 根脚本和工具依赖
├── pnpm-workspace.yaml              # pnpm workspace 范围
├── turbo.json                       # Turborepo 任务配置
└── tsconfig.json                    # TypeScript 基础配置
```

## 依赖边界

```text
apps/web ──> gateway ──> backend
    └── api-client / ui / contracts

services/gateway ──> contracts / observability
services/backend ──> contracts / observability
services/backend (future modules) ──> domain / database / job-queue
services/agent-runner ──> agent-core / contracts / observability
workers/media-worker-python ──> contracts + Python runtime adapters

agent-core
    ├── context / policy / tools / skills
    └── capabilities/skills + capabilities/mcp-servers
```

- `apps/web` 负责用户界面；`packages/ui` 只提供共享基础组件。
- `services/gateway` 是独立发布的公网入口；`services/backend` 是独立发布的业务服务。
- `services/backend` 负责业务 API 和未来的控制面、实时、回调模块，不承担网关职责。
- `services/agent-runner` 负责长时 Agent 执行；`packages/agent-core` 是可复用内核。
- `packages/contracts` 定义跨进程数据；`database`、`job-queue`、`observability` 属于服务端基础设施。
- `capabilities/` 存放可加载或独立运行的能力资产，不等同于 Agent Runtime。

## 检查命令

```bash
pnpm lint
pnpm format:check
pnpm typecheck
pnpm test
pnpm build
```

Python Worker：

```bash
cd workers/media-worker-python
uv run ruff check .
uv run ruff format --check .
uv run pytest
```

更多架构边界见 [docs/architecture.md](docs/architecture.md)。
