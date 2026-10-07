import json
from pathlib import Path

import jsonschema
import pytest
from pydantic import ValidationError

from src.activities import ProbeInput, ProbeOutput


def load_shared_schema() -> dict:
    schema_path = (
        Path(__file__).resolve().parent.parent.parent.parent
        / "packages"
        / "contracts"
        / "schemas"
        / "media-probe.json"
    )
    assert schema_path.is_file(), f"Shared schema file not found at {schema_path}"
    return json.loads(schema_path.read_text(encoding="utf-8"))


def test_schema_properties_and_required_alignment():
    shared = load_shared_schema()
    input_schema = shared["input"]
    output_schema = shared["output"]

    # ProbeInput vs input_schema
    probe_input_schema = ProbeInput.model_json_schema(by_alias=True)
    assert set(probe_input_schema["properties"].keys()) == set(input_schema["properties"].keys())
    assert set(probe_input_schema.get("required", [])) == set(input_schema.get("required", []))

    # ProbeOutput vs output_schema
    probe_output_schema = ProbeOutput.model_json_schema(by_alias=True)
    assert set(probe_output_schema["properties"].keys()) == set(output_schema["properties"].keys())
    assert set(probe_output_schema.get("required", [])) == set(output_schema.get("required", []))


def test_sample_payloads_validate_against_shared_schema():
    shared = load_shared_schema()

    sample_input = {
        "assetKey": "workspaces/ws-1/assets/test-1",
        "contentType": "image/png",
        "sizeBytes": 1024,
    }
    jsonschema.validate(instance=sample_input, schema=shared["input"])

    sample_output = {
        "assetKey": "workspaces/ws-1/assets/test-1",
        "kind": "image",
        "contentType": "image/png",
        "sizeBytes": 1024,
        "probedBy": "media-worker-python",
        "pythonVersion": "3.12.0",
    }
    jsonschema.validate(instance=sample_output, schema=shared["output"])


def test_extra_fields_rejected_by_models():
    # Input rejects extra fields
    with pytest.raises(ValidationError):
        ProbeInput.model_validate(
            {
                "assetKey": "key",
                "contentType": "image/png",
                "sizeBytes": 100,
                "extraField": "not-allowed",
            }
        )

    # Output rejects extra fields
    with pytest.raises(ValidationError):
        ProbeOutput.model_validate(
            {
                "assetKey": "key",
                "kind": "image",
                "contentType": "image/png",
                "sizeBytes": 100,
                "probedBy": "media-worker-python",
                "pythonVersion": "3.12.0",
                "extraField": "not-allowed",
            }
        )
