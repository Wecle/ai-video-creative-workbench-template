import asyncio
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from src.worker import WorkerManager


@pytest.mark.anyio
async def test_worker_retries_connection_with_backoff():
    manager = WorkerManager(initial_backoff_seconds=0.01, max_backoff_seconds=0.05)
    connect_calls = 0

    async def mock_connect(*args, **kwargs):
        nonlocal connect_calls
        connect_calls += 1
        if connect_calls < 3:
            raise ConnectionError("Temporal cluster unreachable")
        mock_client = AsyncMock()
        return mock_client

    mock_worker_instance = AsyncMock()
    mock_worker_instance.shutdown = MagicMock()

    async def mock_run():
        await asyncio.sleep(10)

    mock_worker_instance.run = mock_run

    with (
        patch("src.worker.Client.connect", side_effect=mock_connect),
        patch("src.worker.Worker", return_value=mock_worker_instance),
    ):
        await manager.start()

        for _ in range(50):
            if manager.is_ready:
                break
            await asyncio.sleep(0.01)

        assert manager.is_ready is True
        assert connect_calls == 3

        await manager.stop()
        assert manager.is_ready is False
