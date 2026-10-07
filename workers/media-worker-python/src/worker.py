import asyncio
import logging
from datetime import timedelta

from temporalio.client import Client
from temporalio.worker import Worker

from src.activities import probe
from src.config import get_config

logger = logging.getLogger("media-worker")


class WorkerManager:
    def __init__(
        self,
        initial_backoff_seconds: float = 1.0,
        max_backoff_seconds: float = 30.0,
    ) -> None:
        self.worker: Worker | None = None
        self.task: asyncio.Task | None = None
        self.is_connected: bool = False
        self._stopping: bool = False
        self.initial_backoff_seconds = initial_backoff_seconds
        self.max_backoff_seconds = max_backoff_seconds

    @property
    def is_ready(self) -> bool:
        return (
            self.is_connected
            and self.task is not None
            and not self.task.done()
            and not self._stopping
        )

    @property
    def is_running(self) -> bool:
        return self.is_ready

    async def start(self) -> None:
        self._stopping = False
        self.task = asyncio.create_task(self._run())

    async def _run(self) -> None:
        backoff = self.initial_backoff_seconds
        while not self._stopping:
            try:
                config = get_config()
                client = await Client.connect(
                    config.temporal_address,
                    namespace=config.temporal_namespace,
                )
                self.worker = Worker(
                    client,
                    task_queue=config.media_task_queue,
                    activities=[probe],
                    graceful_shutdown_timeout=timedelta(seconds=10),
                )
                self.is_connected = True
                backoff = self.initial_backoff_seconds
                logger.info("Connected to Temporal, running media worker...")
                await self.worker.run()
            except asyncio.CancelledError:
                self.is_connected = False
                logger.info("Media worker task cancelled")
                break
            except Exception as exc:  # noqa: BLE001
                self.is_connected = False
                if self._stopping:
                    break
                logger.warning(
                    "Media worker failed to connect or run (%s), retrying in %.1fs...",
                    exc,
                    backoff,
                )
                try:
                    await asyncio.sleep(backoff)
                except asyncio.CancelledError:
                    break
                backoff = min(backoff * 2.0, self.max_backoff_seconds)
            finally:
                self.is_connected = False

    async def stop(self) -> None:
        self._stopping = True
        self.is_connected = False
        if self.worker is not None:
            self.worker.shutdown()
        if self.task is not None:
            try:
                await asyncio.wait_for(self.task, timeout=12.0)
            except (TimeoutError, asyncio.CancelledError):
                self.task.cancel()
                try:
                    await self.task
                except asyncio.CancelledError:
                    logger.debug("Worker task successfully cancelled")
