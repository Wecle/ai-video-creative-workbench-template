# Media Worker Placeholder

FastAPI worker boundary exposing GET /health and POST /tasks/validate. Validation does not enqueue or execute a task. Run uv sync --frozen, then uv run uvicorn src.main:app --reload --host 127.0.0.1 --port 4200 from this directory. Run uv run pytest and uv run ruff check . for checks.
