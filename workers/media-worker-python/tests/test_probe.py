import asyncio

import pytest
from temporalio.exceptions import ApplicationError
from temporalio.testing import ActivityEnvironment

from src.activities import probe


def test_probe_valid_input():
    env = ActivityEnvironment()
    raw = {
        "assetKey": "workspaces/ws-1/assets/asset-1",
        "contentType": "image/png",
        "sizeBytes": 2048,
    }
    result = asyncio.run(env.run(probe, raw))
    assert result["assetKey"] == "workspaces/ws-1/assets/asset-1"
    assert result["kind"] == "image"
    assert result["contentType"] == "image/png"
    assert result["sizeBytes"] == 2048
    assert result["probedBy"] == "media-worker-python"
    assert isinstance(result["pythonVersion"], str)
    assert len(result["pythonVersion"]) > 0


def test_probe_video_content_type():
    env = ActivityEnvironment()
    raw = {
        "assetKey": "workspaces/ws-1/assets/video-1",
        "contentType": "video/mp4",
        "sizeBytes": 1048576,
    }
    result = asyncio.run(env.run(probe, raw))
    assert result["kind"] == "video"
    assert result["contentType"] == "video/mp4"


def test_probe_audio_content_type():
    env = ActivityEnvironment()
    raw = {
        "assetKey": "workspaces/ws-1/assets/audio-1",
        "contentType": "audio/wav",
        "sizeBytes": 512,
    }
    result = asyncio.run(env.run(probe, raw))
    assert result["kind"] == "audio"


def test_probe_invalid_input_missing_fields():
    env = ActivityEnvironment()
    raw = {
        "assetKey": "workspaces/ws-1/assets/asset-1",
    }
    with pytest.raises(ApplicationError) as exc_info:
        asyncio.run(env.run(probe, raw))
    assert exc_info.value.type == "InvalidInput"
    assert exc_info.value.non_retryable is True


def test_probe_invalid_input_extra_field():
    env = ActivityEnvironment()
    raw = {
        "assetKey": "workspaces/ws-1/assets/asset-1",
        "contentType": "image/png",
        "sizeBytes": 2048,
        "unexpectedField": "bad",
    }
    with pytest.raises(ApplicationError) as exc_info:
        asyncio.run(env.run(probe, raw))
    assert exc_info.value.type == "InvalidInput"
    assert exc_info.value.non_retryable is True


def test_probe_invalid_input_negative_size():
    env = ActivityEnvironment()
    raw = {
        "assetKey": "workspaces/ws-1/assets/asset-1",
        "contentType": "image/png",
        "sizeBytes": -10,
    }
    with pytest.raises(ApplicationError) as exc_info:
        asyncio.run(env.run(probe, raw))
    assert exc_info.value.type == "InvalidInput"
    assert exc_info.value.non_retryable is True
