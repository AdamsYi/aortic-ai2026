import base64
import json
import os
import subprocess
import tempfile
import threading
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

import requests
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field


class CallbackSpec(BaseModel):
    url: Optional[str] = None
    header: Optional[str] = None
    secret: Optional[str] = None


class InferenceRequest(BaseModel):
    job_id: str
    study_id: str
    image_key: str
    requested_at: Optional[str] = None
    input_content_type: str = "application/octet-stream"
    input_base64: str
    callback: CallbackSpec = Field(default_factory=CallbackSpec)


class InferenceMetric(BaseModel):
    name: str
    value: float
    unit: Optional[str] = None


class InferenceResponse(BaseModel):
    status: str
    job_id: str
    provider_job_id: str
    result_json: Dict[str, Any]
    metrics: List[InferenceMetric]
    mask_base64: Optional[str] = None
    mask_filename: Optional[str] = None
    mask_content_type: Optional[str] = None


app = FastAPI(title="Aortic AI GPU Provider", version="1.0.0")


def env(name: str, default: str) -> str:
    value = os.getenv(name)
    if value is None:
        return default
    return value


def run_cmd(cmd: str) -> tuple[int, str, str, float]:
    started = time.time()
    proc = subprocess.run(cmd, shell=True, capture_output=True, text=True)
    seconds = time.time() - started
    return proc.returncode, proc.stdout or "", proc.stderr or "", seconds


def guess_input_suffix(req: InferenceRequest) -> str:
    key = (req.image_key or "").lower()
    ctype = (req.input_content_type or "").lower()
    if key.endswith(".nii.gz"):
        return ".nii.gz"
    if key.endswith(".nii"):
        return ".nii"
    if key.endswith(".zip"):
        return ".zip"
    if "dicom" in ctype:
        return ".dcm"
    if "gzip" in ctype:
        return ".nii.gz"
    return ".bin"


def build_pipeline_cmd(input_path: Path, output_mask: Path, output_json: Path, req: InferenceRequest) -> str:
    infer_cmd = os.getenv("INFER_CMD", "").strip()
    if infer_cmd:
        return infer_cmd.format(
            input_path=str(input_path),
            output_path=str(output_mask),
            output_mask=str(output_mask),
            output_json=str(output_json),
            job_id=req.job_id,
            study_id=req.study_id,
        )

    # Strict mode: no fake/stub inference allowed.
    # If INFER_CMD is not provided, use the built-in real pipeline runner.
    pipeline_py = Path(__file__).resolve().with_name("pipeline_runner.py")
    if not pipeline_py.exists():
        raise RuntimeError(
            "Real pipeline is required but pipeline_runner.py is missing. "
            "Place a real inference pipeline and configure INFER_CMD."
        )

    model_device = env("MODEL_DEVICE", "gpu")
    quality = env("PIPELINE_QUALITY", "high")
    return (
        f'python "{pipeline_py}" '
        f'--input "{input_path}" '
        f'--output-mask "{output_mask}" '
        f'--output-json "{output_json}" '
        f'--device "{model_device}" '
        f'--quality "{quality}" '
        f'--job-id "{req.job_id}" '
        f'--study-id "{req.study_id}"'
    )


def run_model(input_bytes: bytes, req: InferenceRequest) -> InferenceResponse:
    started = time.time()
    provider_job_id = f"provider-{int(started * 1000)}"

    with tempfile.TemporaryDirectory(prefix="aortic-provider-") as td:
        td_path = Path(td)
        suffix = guess_input_suffix(req)
        input_path = td_path / f"input{suffix}"
        output_mask = td_path / "mask_multiclass.nii.gz"
        output_json = td_path / "result.json"
        input_path.write_bytes(input_bytes)

        cmd = build_pipeline_cmd(input_path, output_mask, output_json, req)
        code, stdout, stderr, infer_seconds = run_cmd(cmd)
        if code != 0:
            raise RuntimeError(
                "Real inference pipeline failed. "
                f"cmd={cmd}\n"
                f"stderr_tail={stderr[-1200:]}"
            )

        if not output_mask.exists():
            raise RuntimeError("Real inference did not produce output mask.")
        if not output_json.exists():
            raise RuntimeError("Real inference did not produce output result json.")

        mask_bytes = output_mask.read_bytes()
        result_json = json.loads(output_json.read_text(encoding="utf-8"))

        total_seconds = time.time() - started
        metrics = [
            InferenceMetric(name="provider_inference_seconds", value=round(infer_seconds, 4), unit="s"),
            InferenceMetric(name="provider_total_seconds", value=round(total_seconds, 4), unit="s"),
        ]

        # Attach short command tails for traceability (research reproducibility).
        result_json.setdefault("runtime", {})
        result_json["runtime"]["pipeline_cmd"] = cmd
        result_json["runtime"]["stdout_tail"] = stdout[-1000:]
        result_json["runtime"]["stderr_tail"] = stderr[-1000:]
        result_json["runtime"]["generated_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())

        return InferenceResponse(
            status="succeeded",
            job_id=req.job_id,
            provider_job_id=provider_job_id,
            result_json=result_json,
            metrics=metrics,
            mask_base64=base64.b64encode(mask_bytes).decode("ascii"),
            mask_filename="mask_multiclass.nii.gz",
            mask_content_type="application/gzip",
        )


def post_callback(req: InferenceRequest, result: InferenceResponse) -> None:
    if not req.callback.url:
        return

    headers = {"content-type": "application/json"}
    if req.callback.header and req.callback.secret:
        headers[req.callback.header] = req.callback.secret

    timeout = float(env("CALLBACK_TIMEOUT_SECONDS", "20"))
    payload = result.model_dump(exclude_none=True)
    try:
        resp = requests.post(req.callback.url, headers=headers, json=payload, timeout=timeout)
        resp.raise_for_status()
    except Exception as exc:
        print(f"[callback] failed for job={req.job_id}: {exc}")


@app.get("/health")
def health() -> Dict[str, Any]:
    return {
        "ok": True,
        "service": "gpu-provider",
        "provider_response_mode": env("PROVIDER_RESPONSE_MODE", "inline"),
        "model_device": env("MODEL_DEVICE", "gpu"),
        "pipeline_quality": env("PIPELINE_QUALITY", "high"),
        "infer_cmd_configured": bool(os.getenv("INFER_CMD", "").strip()),
        "no_placeholder_mode": True,
    }


@app.post("/infer")
def infer(req: InferenceRequest) -> Dict[str, Any]:
    try:
        input_bytes = base64.b64decode(req.input_base64, validate=True)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"invalid_input_base64: {exc}")

    max_input_bytes = int(env("MAX_INPUT_BYTES", str(900 * 1024 * 1024)))
    if len(input_bytes) > max_input_bytes:
        raise HTTPException(status_code=413, detail=f"input_too_large:{len(input_bytes)}")

    try:
        result = run_model(input_bytes, req)
    except Exception as exc:
        error_payload = {
            "status": "failed",
            "job_id": req.job_id,
            "provider_job_id": f"provider-failed-{int(time.time() * 1000)}",
            "error_message": str(exc),
        }
        if req.callback.url:
            headers = {"content-type": "application/json"}
            if req.callback.header and req.callback.secret:
                headers[req.callback.header] = req.callback.secret
            try:
                requests.post(req.callback.url, headers=headers, json=error_payload, timeout=10)
            except Exception:
                pass
        return error_payload

    mode = env("PROVIDER_RESPONSE_MODE", "inline").strip().lower()
    if mode == "callback":
        t = threading.Thread(target=post_callback, args=(req, result), daemon=True)
        t.start()
        return {
            "status": "accepted",
            "job_id": req.job_id,
            "provider_job_id": result.provider_job_id,
        }

    return result.model_dump(exclude_none=True)
