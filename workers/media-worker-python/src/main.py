from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI, Response, status

from src.worker import WorkerManager


def create_app(start_worker: bool = True) -> FastAPI:
    worker_manager = WorkerManager()

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        if start_worker:
            await worker_manager.start()
        yield
        if start_worker:
            await worker_manager.stop()

    app = FastAPI(title="Creative Media Worker", version="0.1.0", lifespan=lifespan)
    app.state.worker_manager = worker_manager
    app.state.start_worker = start_worker

    @app.get("/health")
    def health(response: Response) -> dict[str, str]:
        if not app.state.start_worker:
            return {"status": "ok", "service": "media-worker", "worker": "disabled"}
        if app.state.worker_manager.is_running:
            return {"status": "ok", "service": "media-worker", "worker": "running"}
        response.status_code = status.HTTP_503_SERVICE_UNAVAILABLE
        return {"status": "error", "service": "media-worker", "worker": "stopped"}

    return app


app = create_app()
