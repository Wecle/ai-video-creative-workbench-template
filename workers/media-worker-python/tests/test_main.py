from fastapi.testclient import TestClient

from src.main import app

client = TestClient(app)


def test_health():
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json()["service"] == "media-worker"


def test_validate_task():
    response = client.post("/tasks/validate", json={"task_id": "example"})
    assert response.status_code == 200
    assert response.json() == {"task_id": "example", "valid": True, "mode": "validation-only"}


def test_reject_empty_task_id():
    assert client.post("/tasks/validate", json={"task_id": ""}).status_code == 422
