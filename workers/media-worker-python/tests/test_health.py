import asyncio

from fastapi.testclient import TestClient

from src.main import create_app


def test_health_worker_disabled():
    app = create_app(start_worker=False)
    client = TestClient(app)
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json() == {
        "status": "ok",
        "service": "media-worker",
        "worker": "disabled",
    }


def test_health_worker_running():
    app = create_app(start_worker=True)

    async def dummy_loop():
        await asyncio.sleep(100)

    loop = asyncio.new_event_loop()
    task = loop.create_task(dummy_loop())
    app.state.worker_manager.task = task

    client = TestClient(app)
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json() == {
        "status": "ok",
        "service": "media-worker",
        "worker": "running",
    }

    task.cancel()
    loop.run_until_complete(asyncio.gather(task, return_exceptions=True))
    loop.close()


def test_health_worker_failed_or_stopped():
    app = create_app(start_worker=True)
    client = TestClient(app)
    response = client.get("/health")
    assert response.status_code == 503
    assert response.json() == {
        "status": "error",
        "service": "media-worker",
        "worker": "stopped",
    }
