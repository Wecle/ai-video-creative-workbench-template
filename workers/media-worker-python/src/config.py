import os

from pydantic import BaseModel


class Config(BaseModel):
    temporal_address: str = "localhost:7233"
    temporal_namespace: str = "default"
    media_task_queue: str = "media"


def get_config() -> Config:
    return Config(
        temporal_address=os.environ.get("TEMPORAL_ADDRESS", "localhost:7233"),
        temporal_namespace=os.environ.get("TEMPORAL_NAMESPACE", "default"),
        media_task_queue=os.environ.get("MEDIA_TASK_QUEUE", "media"),
    )
