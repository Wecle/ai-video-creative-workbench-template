# Contributing

Thank you for improving the template. Keep the starter free of provider credentials, private assets, and product-specific business logic.

Before opening a pull request, run:

```bash
pnpm lint
pnpm format:check
pnpm typecheck
pnpm test
pnpm build
```

For worker changes, run `uv sync --frozen`, `uv run ruff check .`, `uv run ruff format --check .`, and `uv run pytest` in `workers/media-worker-python`.

Keep lockfiles committed. Reserved README-only modules should remain clearly labeled until a real implementation is introduced. Do not publish `.env` files, personal planning reports, or local build artifacts.
