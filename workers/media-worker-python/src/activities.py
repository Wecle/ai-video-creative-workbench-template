import platform

from pydantic import BaseModel, ConfigDict, Field, ValidationError
from temporalio import activity
from temporalio.exceptions import ApplicationError


class ProbeInput(BaseModel):
    asset_key: str = Field(alias="assetKey", min_length=1)
    content_type: str = Field(alias="contentType", min_length=1)
    size_bytes: int = Field(alias="sizeBytes", ge=0)
    download_url: str | None = Field(default=None, alias="downloadUrl")

    model_config = ConfigDict(
        populate_by_name=True,
        extra="forbid",
    )


class ProbeOutput(BaseModel):
    asset_key: str = Field(alias="assetKey", min_length=1)
    kind: str = Field(min_length=1)
    content_type: str = Field(alias="contentType", min_length=1)
    size_bytes: int = Field(alias="sizeBytes", ge=0)
    probed_by: str = Field(alias="probedBy", min_length=1)
    python_version: str = Field(alias="pythonVersion", min_length=1)

    model_config = ConfigDict(
        populate_by_name=True,
        extra="forbid",
    )


@activity.defn(name="media.probe")
async def probe(raw: dict) -> dict:
    if not isinstance(raw, dict):
        raise ApplicationError(
            "Invalid input: payload must be a dict",
            type="InvalidInput",
            non_retryable=True,
        )
    try:
        data = ProbeInput.model_validate(raw)
    except ValidationError as exc:
        raise ApplicationError(
            f"Invalid input: {exc}",
            type="InvalidInput",
            non_retryable=True,
        ) from exc

    kind = data.content_type.split("/")[0] if "/" in data.content_type else data.content_type
    result = ProbeOutput(
        asset_key=data.asset_key,
        kind=kind,
        content_type=data.content_type,
        size_bytes=data.size_bytes,
        probed_by="media-worker-python",
        python_version=platform.python_version(),
    )
    return result.model_dump(by_alias=True)
