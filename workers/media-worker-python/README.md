# Media Worker (Python)

FastAPI 服务与 Temporal Worker：
- `GET /health`：健康检查接口，当后台 Temporal Worker 运行时返回 200，异常或退出时返回 503。
- Temporal Worker：监听 `media` 任务队列，实现 `media.probe` activity，从媒体资产中提取元数据（类型、大小、分类与版本信息）。
- 跨语言契约：入参和出参通过 `@creative/contracts` 生成的共享 JSON Schema（`packages/contracts/schemas/media-probe.json`）严格对齐，并在单元测试中进行防漂移校验。

## 开发与测试

```bash
uv sync --frozen
# 启动媒体 Worker（单独进程）
uv run uvicorn src.main:app --reload --host 127.0.0.1 --port 4200
# 代码检查与测试
uv run ruff check .
uv run ruff format --check .
uv run pytest
```
