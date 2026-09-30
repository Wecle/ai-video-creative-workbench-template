from fastapi import FastAPI
from pydantic import BaseModel, Field

app = FastAPI(title="Creative Media Worker", version="0.1.0")


class TaskRequest(BaseModel):
    task_id: str = Field(min_length=1)
    parameters: dict[str, object] = Field(default_factory=dict)


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok", "service": "media-worker"}


@app.post("/tasks/validate")
def validate_task(task: TaskRequest) -> dict[str, object]:
    return {"task_id": task.task_id, "valid": True, "mode": "validation-only"}
