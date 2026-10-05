# AI Video Creative Workbench Template

面向 AI 视频创作工具的 monorepo 模板：Next.js 前端、Fastify 后端、基于 Temporal 的 Agent 执行层、媒体 Worker，以及可扩展的 Skill 能力目录（MCP 经 ToolProvider 预留）。

> [!NOTE]
> 当前仓库是技术脚手架，不包含完整业务或模型调用，Agent 使用 echo 演示实现。已接入邮箱密码登录（Better Auth）、Gateway JWT 验签、Redis 限流和 Temporal echo workflow（Backend 启动并查询，Agent Runner 作为 worker 执行），以及画布骨架：节点定义注册表（2 个示例节点）、Yjs 文档层（撤销重做、连接校验）、项目与画布的保存/读取（workspace 成员授权、乐观锁）、`/projects` 与画布路由、`en`/`zh-CN` 界面文案。节点执行、素材、协作、邮箱验证和找回密码尚未实现。

## 快速开始

环境：Node.js 22.9+、pnpm 10.13.1；Python Worker 需要 Python 3.12+ 和 uv。

```bash
pnpm bootstrap     # 检查环境、生成 .env（不覆盖已有）、安装依赖、启动 PostgreSQL/Redis/Temporal、迁移数据库；可重复执行
pnpm dev
```

`pnpm bootstrap` 等价于手动执行：

```bash
pnpm install --frozen-lockfile
cp .env.example .env
pnpm infra:up      # PostgreSQL、Redis 和 Temporal（登录、限流和 Agent 执行需要）
pnpm db:migrate    # 迁移不随服务启动，需要手动执行
```

打开 http://localhost:3000 会跳转到 `/login`，先注册账号；登录后进入 `/projects`，新建项目即可打开画布（`/p/<项目>/canvas/<画布>`，修改约 2 秒后自动保存）。界面语言跟随浏览器（`Accept-Language`），也可在页面上切换 English / 简体中文（写入 `locale` cookie）。

默认启动：Web、Gateway、Backend、Agent Runner（Temporal worker，启动时要求 Temporal 已运行，即先 `pnpm infra:up`）。媒体 Worker 单独启动：

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
scripts/smoke-p0b.sh               # 冒烟：echo workflow 经 Backend、Temporal、Agent Runner 跑通
scripts/smoke-p1.sh                # 冒烟：项目与画布的保存、409/422、跨 workspace 404（需要 curl、jq）
pnpm docker:down
```

注意：开发栈（`pnpm infra:up`，项目名 `creative-dev`）与全栈（`pnpm docker:up`，项目名 `creative-full`）是两个独立的 Compose 项目，`docker:down` 只停全栈；但两者发布相同端口（5432、6379、7233、8080），**不能同时运行**，切换前先停另一个。旧项目名 `docker` 留下的卷 `docker_postgres-data` 已孤立，可 `docker volume rm docker_postgres-data`；新开发库需要重新 `pnpm db:migrate`。

| 组件            | 地址                       |
| --------------- | -------------------------- |
| Web             | http://localhost:3000      |
| Gateway         | http://localhost:4000      |
| API 文档        | http://localhost:4000/docs |
| Backend（调试） | http://localhost:4001      |
| Temporal UI     | http://localhost:8080      |
| Temporal gRPC   | localhost:7233             |
| Media Worker    | http://localhost:4200      |

## 项目结构

标记：`[active]` 为当前运行实现，`[reserved]` 为只保留说明的扩展边界。

```text
.
├── apps/
│   └── web/                         # [active] Next.js 前端、React Flow 画布和业务界面
│       ├── app/                     # 路由、布局和全局样式
│       ├── features/                # 画布（每画布一个 store、节点渲染器）、项目列表、登录
│       └── i18n/                    # 词条（en 为唯一事实来源，zh-CN 可部分翻译）、语言解析与切换
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
│   └── agent-runner/                # [active] Temporal worker（无 HTTP 端口），运行 Agent activity
│       ├── src/                     # activity、worker 启动和 workflow 打包
│       └── test/                    # worker 与配置测试
├── workers/
│   └── media-worker-python/         # [active] Python 媒体任务接口和处理 Worker
├── packages/
│   ├── agent-core/                  # [active] Agent 内核和 Echo 演示 Adapter
│   │   └── src/
│   │       ├── context/             # [reserved] 上下文预算、压缩和快照
│   │       ├── policy/              # [reserved] 权限、预算和审批策略
│   │       ├── tools/runtime/       # [reserved] Tool Calling 生命周期
│   │       └── skills/runtime/      # [reserved] Skill 加载和执行
│   ├── api-client/                  # Web 等客户端使用的类型化 API Client
│   ├── canvas-doc/                  # [active] 画布 Yjs 文档层：操作、连接校验、快照、撤销历史（同构）
│   ├── contracts/                   # API、事件、任务、画布快照和能力声明
│   ├── database/                    # 服务端 Drizzle/PostgreSQL 连接和迁移
│   ├── domain/                      # [reserved] 跨服务领域模型和规则
│   ├── node-registry/               # [active] 画布节点定义、注册表和 JSON Schema 产物（同构）
│   ├── observability/               # OpenTelemetry 日志、指标和 Trace 支撑
│   ├── ui/                          # 共享 shadcn/ui 源码和基础组件
│   └── workflows/                   # [active] Temporal workflow（仅确定性代码和契约）
├── capabilities/
│   └── skills/                      # [reserved] 版本化 Skill 定义和元数据
├── infra/
│   └── docker/                      # 本地基础设施和完整 Docker Compose
├── docs/                            # 架构和扩展边界说明
├── tests/                           # 跨服务、契约和端到端测试位置
├── scripts/                         # 冒烟脚本（smoke-p0a.sh、smoke-p0b.sh、smoke-p1.sh）
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
services/backend ──> contracts / observability / workflows / canvas-doc / node-registry
apps/web ──> canvas-doc / node-registry（Yjs 只经 canvas-doc 使用）
packages/canvas-doc ──> node-registry / contracts
services/backend (future modules) ──> domain / database
services/agent-runner ──> agent-core / workflows / observability
workers/media-worker-python ──> contracts + Python runtime adapters

agent-core
    ├── context / policy / tools / skills
    └── capabilities/skills
```

- `apps/web` 负责用户界面；`packages/ui` 只提供共享基础组件。画布状态分三层：Document（Yjs，持久化）、Runtime（执行状态，仅类型）、UI（选中、拖拽、保存状态）；Zustand store 是 Yjs 文档的只读派生，每个打开的画布一个实例。
- `packages/node-registry` 与 `packages/canvas-doc` 是同构包（浏览器与 Node 共用，ESLint 限制导入与全局变量）；新增节点类型的步骤见 `packages/node-registry/README.md`。
- `services/gateway` 是独立发布的公网入口；`services/backend` 是独立发布的业务服务。
- `services/backend` 负责业务 API 和未来的控制面、实时、回调模块，不承担网关职责。
- `services/agent-runner` 是 Temporal worker，负责长时 Agent 执行；`packages/workflows` 只放确定性的 workflow 代码与契约；`packages/agent-core` 是可复用内核。
- `packages/contracts` 定义跨进程数据；`database`、`observability` 属于服务端基础设施。
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
