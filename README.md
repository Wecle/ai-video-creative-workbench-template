# AI Video Creative Workbench Template

面向 AI 视频创作工具的 monorepo 技术模板：React Flow 创作画布、Next.js 前端、Fastify 网关、TypeScript Agent 服务与 Python 媒体工作进程边界。无需模型密钥或数据库即可运行基础演示。

[Use this template](https://github.com/Wecle/ai-video-creative-workbench-template/generate) · [架构与扩展边界](docs/architecture.md)

## 技术栈与模板能力

| 模块           | 技术栈                                                               | 已包含的基础能力                                           |
| -------------- | -------------------------------------------------------------------- | ---------------------------------------------------------- |
| 前端           | Next.js 15、React 19、React Flow、Tailwind CSS 4、shadcn/ui 基础组件 | 节点添加、拖动、连线、删除、标题编辑、重置、JSON 导出      |
| 前端状态与表单 | TanStack Query、Zustand、React Hook Form、Zod                        | 网关健康查询、会话内画布状态、表单校验                     |
| 网关           | Fastify、Zod、Swagger/OpenAPI、Helmet、rate-limit                    | 健康检查、演示数据接口、API 文档、请求校验、进程内 IP 限流 |
| Agent          | TypeScript、Fastify、可替换 Adapter                                  | 运行/事件/工具/Skill 类型、同步 Echo 演示、独立服务入口    |
| 媒体 Worker    | Python 3.12+、FastAPI、Pydantic、uv                                  | 健康检查、任务参数校验、独立启动与测试                     |
| 数据库         | Drizzle ORM、PostgreSQL、drizzle-kit                                 | 服务端连接工厂、示例表、迁移生成与执行配置                 |
| 队列与遥测     | BullMQ、Redis、OpenTelemetry、OTLP                                   | 可选队列工厂、手动 trace span 与可选 trace 导出            |
| 工程工具       | pnpm、Turborepo、TypeScript、ESLint、Prettier、Vitest、Ruff、pytest  | 锁文件、工作区依赖、构建与 GitHub Actions 检查             |

> [!IMPORTANT]
> 这是技术脚手架。画布修改仅保存在当前页面内存，导出可保存为 JSON。Agent 演示只返回 Echo 结果；Python 接口只校验任务，不入队或执行。完整 Agent loop、上下文管理、鉴权、计费、生成供应商、持久化、协作同步、Skill/MCP 执行等属于后续产品实现。

## 快速启动

准备 Node.js 22.9+ 与 pnpm 10.13.1。在 GitHub 使用模板创建自己的仓库后：

```bash
pnpm install --frozen-lockfile
cp .env.example .env
pnpm dev
```

`pnpm dev` 启动 TypeScript 工作区中的 Web、Gateway 和 Agent Runner，Python Worker 单独启动。基础演示不依赖 Docker。

### 使用 Docker 启动完整模板

如果本机已安装 Docker Desktop 或 OrbStack，可以直接启动完整栈：

```bash
pnpm docker:up
```

首次启动会构建四个应用镜像，并启动 PostgreSQL、Redis、Web、Gateway、Agent Runner 和 Python Worker。访问地址与本地启动方式一致：

| 服务               | 地址                         |
| ------------------ | ---------------------------- |
| 创作画布           | http://localhost:3000        |
| 网关健康检查       | http://localhost:4000/health |
| 网关 API 文档      | http://localhost:4000/docs   |
| Agent 健康检查     | http://localhost:4100/health |
| Python Worker 文档 | http://localhost:4200/docs   |

停止完整栈：

```bash
pnpm docker:down
```

仅启动 PostgreSQL 和 Redis：

```bash
pnpm infra:up
```

Docker 编排文件位于 `infra/docker/docker-compose.full.yml`，应用镜像定义位于 `infra/docker/Dockerfile.node` 和 `infra/docker/Dockerfile.worker`。

| 入口           | 地址                         |
| -------------- | ---------------------------- |
| 创作画布       | http://localhost:3000        |
| 网关健康检查   | http://localhost:4000/health |
| 网关 API 文档  | http://localhost:4000/docs   |
| Agent 健康检查 | http://localhost:4100/health |

服务默认仅监听 `127.0.0.1`。Web、Gateway 与 Agent Runner 的启动脚本统一加载根目录 `.env`，shell 注入的同名环境变量优先。修改 `GATEWAY_URL` 后需重启开发服务；生产环境的代理目标在构建时确定，因此需要重新构建 Web。默认目标是 `http://127.0.0.1:4000`。Python 启动命令中的端口单独指定。

### Python Worker

准备 Python 3.12+ 与 uv（CI 使用 uv 0.8.22），在另一个终端执行：

```bash
cd workers/media-worker-python
uv sync --frozen
uv run uvicorn src.main:app --reload --host 127.0.0.1 --port 4200
```

入口为 http://localhost:4200/health 与 http://localhost:4200/docs。也可在安装依赖后从仓库根目录运行 `pnpm dev:worker`。

### 可选基础设施与数据库

```bash
pnpm infra:up
# 检查已附带的示例 SQL 与 DATABASE_URL 后，再执行迁移
pnpm db:migrate
# 修改 schema 后生成下一次迁移
pnpm db:generate
```

基础 Compose 提供 PostgreSQL 和 Redis，端口均绑定本机；凭据仅适用于开发。示例表 `template_records` 与初始 SQL 迁移用于演示数据库工具，并未接入业务接口。对象存储在接入 S3 兼容适配器后配置 `.env` 中的 `S3_*` 参数；模板尚未实现上传或创建 bucket。BullMQ 工厂没有默认消费者，Python Worker 尚未接入队列。`pnpm infra:down` 停止基础设施容器并保留数据卷。

## 项目结构

```text
apps/
  web/                     Next.js 创作画布演示
services/
  gateway/                 浏览器 API 入口
  agent-runner/            独立 Agent Adapter 服务
  control-plane/           项目/资产/任务业务边界（预留）
  realtime/                实时事件边界（预留）
  webhook-ingress/         供应商回调边界（预留）
packages/
  ui/                      共享 UI 组件与 shadcn 配置
  contracts/               浏览器安全的校验规则与协议类型
  api-client/              带响应校验和超时的 HTTP 客户端
  agent-core/              Agent 接口与 Echo Adapter
  database/                服务端 Drizzle 与迁移工具
  job-queue/               可选 BullMQ 队列工厂
  observability/           可选 OpenTelemetry trace 导出
  domain/                  领域规则（预留）
  node-registry/           节点注册（预留）
  agent-policy/            权限/预算/审批策略（预留）
  tool-runtime/            工具调用执行（预留）
  skill-runtime/           Skill 加载与执行（预留）
  mcp-adapter/              MCP 连接适配（预留）
workers/
  media-worker-python/     Python 健康检查与任务校验
skills/                    应用 Skill 定义目录（预留）
mcp-servers/               应用 MCP Server 目录（预留）
tests/                     跨服务测试目录（预留）
infra/docker/              开发基础设施
docs/                      架构与扩展说明
```

标注“预留”的目录仅包含职责说明，没有运行进程或完整实现。初期可按需要合并边界，待规模与团队职责明确后再独立部署。Drizzle 仅供服务端使用，前端通过 Gateway/API Client 访问数据。

## 检查与生产构建

```bash
pnpm lint
pnpm format:check
pnpm typecheck
pnpm test
pnpm build
```

构建后可在独立终端分别运行：

```bash
pnpm --filter @creative/web start
pnpm --filter @creative/gateway start
pnpm --filter @creative/agent-runner start
```

Python 检查在 Worker 目录运行：

```bash
uv run ruff check .
uv run ruff format --check .
uv run pytest
```

共享 TypeScript 包直接导出源码，供工作区工具使用；服务构建会打包所需工作区源码，第三方运行依赖仍需安装。可通过 `apps/web/components.json` 与 `packages/ui/components.json` 扩展共享 UI 组件。

## 进入产品开发前

当前 HTTP 服务未实现身份认证，不应直接暴露到公网。需要补齐租户授权、审计、分布式限流与并发准入、任务幂等和取消、持久化 Agent 状态、上下文预算、工具审批及 Skill/MCP 隔离。OpenTelemetry SDK 开源，Collector/存储/可视化后端需自行配置；只有配置 OTLP endpoint 才开启本模板的 trace 导出。详见[架构说明](docs/architecture.md)。
