import asyncio
import logging
from datetime import timedelta

from temporalio.client import Client
from temporalio.worker import Worker

from src.activities import probe
from src.config import get_config

logger = logging.getLogger("media-worker")


class WorkerManager:
    def __init__(self) -> None:
        self.worker: Worker | None = None
        self.task: asyncio.Task | None = None

    @property
    def is_running(self) -> bool:
        return self.task is not None and not self.task.done()

    async def start(self) -> None:
        self.task = asyncio.create_task(self._run())

    async def _run(self) -> None:
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
            await self.worker.run()
        except asyncio.CancelledError:
            logger.info("Media worker task cancelled")
        except Exception:
            logger.exception("Media worker task failed")
            raise

    async def stop(self) -> None:
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
