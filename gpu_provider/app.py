import base64
import json
import os
import shutil
import subprocess
import tempfile
import threading
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

import requests
from fastapi import FastAPI, Header, HTTPException, Request
from pydantic import BaseModel, Field


class CallbackSpec(BaseModel):
    url: Optional[str] = None
    header: Optional[str] = None
    secret: Optional[str] = None


class InferenceRequest(BaseModel):
    job_id: str
    study_id: Optional[str] = None
    image_key: Optional[str] = None
    r2_key: Optional[str] = None
    patient_id: Optional[str] = None
    requested_at: Optional[str] = None
    input_content_type: str = "application/octet-stream"
    input_base64: Optional[str] = None
    input_url: Optional[str] = None
    callback_url: Optional[str] = None
    status_url: Optional[str] = None
    callback: CallbackSpec = Field(default_factory=CallbackSpec)


class InferenceMetric(BaseModel):
    name: str
    value: float
    unit: Optional[str] = None


class InferenceBinaryArtifact(BaseModel):
    artifact_type: str
    filename: str
    content_type: str
    base64: str


class InferenceResponse(BaseModel):
    status: str
    job_id: str
    provider_job_id: str
    result_json: Dict[str, Any]
    metrics: List[InferenceMetric]
    mask_base64: Optional[str] = None
    mask_filename: Optional[str] = None
    mask_content_type: Optional[str] = None
    artifacts: Optional[List[InferenceBinaryArtifact]] = None


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
    safe_study_id = req.study_id or req.patient_id or "unknown-study"
    return (
        f'python "{pipeline_py}" '
        f'--input "{input_path}" '
        f'--output-mask "{output_mask}" '
        f'--output-json "{output_json}" '
        f'--device "{model_device}" '
        f'--quality "{quality}" '
        f'--job-id "{req.job_id}" '
        f'--study-id "{safe_study_id}"'
    )


def sanitize_public_result_json(obj: Dict[str, Any]) -> Dict[str, Any]:
    blocked = {
        "pipeline_cmd",
        "stdout_tail",
        "stderr_tail",
        "artifacts_manifest",
        "work_dir",
        "output_dir",
        "object_key",
        "bucket",
        "raw_payload",
    }

    def walk(value: Any) -> Any:
        if isinstance(value, list):
            return [walk(item) for item in value]
        if isinstance(value, dict):
            out: Dict[str, Any] = {}
            for key, item in value.items():
                if key in blocked:
                    continue
                out[key] = walk(item)
            return out
        return value

    return walk(obj)


def public_error_message(exc: Exception) -> str:
    raw = str(exc)
    if "invalid_input_base64" in raw:
        return raw
    if "input_too_large" in raw:
        return raw
    if "failed" in raw.lower():
        return "inference_pipeline_failed"
    return "provider_execution_error"


def run_model(input_bytes: bytes, req: InferenceRequest, provider_job_id: Optional[str] = None) -> InferenceResponse:
    started = time.time()
    if not provider_job_id:
        provider_job_id = f"provider-{int(started * 1000)}"

    with tempfile.TemporaryDirectory(prefix="aortic-provider-") as td:
        td_path = Path(td)
        suffix = guess_input_suffix(req)
        input_path = td_path / f"input{suffix}"
        output_mask = td_path / "segmentation_mask.nii.gz"
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
        extra_artifacts: list[InferenceBinaryArtifact] = []

        # Prefer explicit manifest from pipeline output.
        manifest = result_json.get("artifacts_manifest")
        if isinstance(manifest, list):
            for item in manifest:
                if not isinstance(item, dict):
                    continue
                path_s = str(item.get("path") or "").strip()
                if not path_s:
                    continue
                p = Path(path_s)
                if not p.exists() or not p.is_file():
                    continue
                artifact_type = str(item.get("artifact_type") or p.stem).strip() or p.stem
                content_type = str(item.get("content_type") or "application/octet-stream").strip() or "application/octet-stream"
                filename = str(item.get("filename") or p.name).strip() or p.name
                data = p.read_bytes()
                extra_artifacts.append(
                    InferenceBinaryArtifact(
                        artifact_type=artifact_type,
                        filename=filename,
                        content_type=content_type,
                        base64=base64.b64encode(data).decode("ascii"),
                    )
                )
        else:
            # Fallback for fixed-known artifacts in output folder.
            known = [
                ("measurements_json", "measurements.json", "application/json"),
                ("planning_report_pdf", "planning_report.pdf", "application/pdf"),
                ("aortic_root_stl", "aortic_root.stl", "model/stl"),
                ("centerline_json", "centerline.json", "application/json"),
                ("annulus_plane_json", "annulus_plane.json", "application/json"),
            ]
            for artifact_type, fname, ctype in known:
                p = output_json.parent / fname
                if not p.exists() or not p.is_file():
                    continue
                data = p.read_bytes()
                extra_artifacts.append(
                    InferenceBinaryArtifact(
                        artifact_type=artifact_type,
                        filename=fname,
                        content_type=ctype,
                        base64=base64.b64encode(data).decode("ascii"),
                    )
                )

        total_seconds = time.time() - started
        metrics = [
            InferenceMetric(name="provider_inference_seconds", value=round(infer_seconds, 4), unit="s"),
            InferenceMetric(name="provider_total_seconds", value=round(total_seconds, 4), unit="s"),
        ]

        result_json.setdefault("runtime", {})
        result_json["runtime"]["generated_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        result_json = sanitize_public_result_json(result_json)

        return InferenceResponse(
            status="succeeded",
            job_id=req.job_id,
            provider_job_id=provider_job_id,
            result_json=result_json,
            metrics=metrics,
            mask_base64=base64.b64encode(mask_bytes).decode("ascii"),
            mask_filename=output_mask.name,
            mask_content_type="application/gzip",
            artifacts=extra_artifacts or None,
        )


def post_callback(req: InferenceRequest, result: InferenceResponse) -> None:
    callback_url = req.callback.url or req.callback_url
    if not callback_url:
        return

    headers = {"content-type": "application/json"}
    if req.callback.header and req.callback.secret:
        headers[req.callback.header] = req.callback.secret

    timeout = float(env("CALLBACK_TIMEOUT_SECONDS", "20"))
    payload = result.model_dump(exclude_none=True)
    try:
        resp = requests.post(callback_url, headers=headers, json=payload, timeout=timeout)
        resp.raise_for_status()
    except Exception as exc:
        print(f"[callback] failed for job={req.job_id}: {exc}")


def post_stage_status(req: InferenceRequest, stage: str, progress: int, status: str = "running", detail: Optional[str] = None) -> None:
    status_url = req.status_url
    if not status_url:
        return
    headers = {"content-type": "application/json"}
    if req.callback.header and req.callback.secret:
        headers[req.callback.header] = req.callback.secret
    payload: Dict[str, Any] = {
        "job_id": req.job_id,
        "status": status,
        "stage": stage,
        "progress": int(max(0, min(100, progress))),
    }
    if detail:
        payload["detail"] = detail
    try:
        requests.post(status_url, headers=headers, json=payload, timeout=10).raise_for_status()
    except Exception as exc:
        print(f"[status] failed for job={req.job_id}, stage={stage}: {exc}")


def post_simple_completion_callback(req: InferenceRequest, status: str, result_case_id: Optional[str] = None, error_message: Optional[str] = None) -> None:
    callback_url = req.callback_url
    if not callback_url:
        return
    headers = {"content-type": "application/json"}
    if req.callback.header and req.callback.secret:
        headers[req.callback.header] = req.callback.secret
    payload: Dict[str, Any] = {
        "job_id": req.job_id,
        "status": status,
    }
    if result_case_id:
        payload["result_case_id"] = result_case_id
    if error_message:
        payload["error_message"] = error_message
    try:
        requests.post(callback_url, headers=headers, json=payload, timeout=10).raise_for_status()
    except Exception as exc:
        print(f"[simple-callback] failed for job={req.job_id}: {exc}")


def post_error_callback(req: InferenceRequest, provider_job_id: str, message: str) -> None:
    callback_url = req.callback.url or req.callback_url
    if not callback_url:
        return
    headers = {"content-type": "application/json"}
    if req.callback.header and req.callback.secret:
        headers[req.callback.header] = req.callback.secret
    payload = {
        "status": "failed",
        "job_id": req.job_id,
        "provider_job_id": provider_job_id,
        "error_message": message,
    }
    try:
        requests.post(callback_url, headers=headers, json=payload, timeout=10).raise_for_status()
    except Exception as exc:
        print(f"[callback] failed to post error for job={req.job_id}: {exc}")


def run_model_and_callback(req: InferenceRequest, input_bytes: bytes, provider_job_id: str) -> None:
    try:
        post_stage_status(req, stage="segmentation", progress=25, status="running")
        result = run_model(input_bytes, req, provider_job_id=provider_job_id)
        post_stage_status(req, stage="centerline", progress=55, status="running")
        post_stage_status(req, stage="measurements", progress=80, status="running")
        post_callback(req, result)
        post_stage_status(req, stage="completed", progress=100, status="completed")
        post_simple_completion_callback(req, status="completed", result_case_id=req.job_id)
    except Exception as exc:
        post_stage_status(req, stage="failed", progress=100, status="failed", detail=public_error_message(exc))
        post_error_callback(req, provider_job_id, public_error_message(exc))
        post_simple_completion_callback(req, status="failed", error_message=public_error_message(exc))


@app.get("/health")
def health() -> Dict[str, Any]:
    gpu_ok = bool(shutil.which("nvidia-smi"))
    return {
        "status": "ok",
        "gpu": gpu_ok,
        "ok": True,
        "service": "gpu-provider",
        "provider_response_mode": env("PROVIDER_RESPONSE_MODE", "inline"),
        "model_device": env("MODEL_DEVICE", "gpu"),
        "pipeline_quality": env("PIPELINE_QUALITY", "high"),
        "infer_cmd_configured": bool(os.getenv("INFER_CMD", "").strip()),
        "no_placeholder_mode": True,
    }


def load_input_bytes(req: InferenceRequest, x_provider_secret: Optional[str]) -> bytes:
    if req.input_base64:
        try:
            return base64.b64decode(req.input_base64, validate=True)
        except Exception as exc:
            raise HTTPException(status_code=400, detail=f"invalid_input_base64: {exc}")
    if req.input_url:
        headers: Dict[str, str] = {}
        expected_secret = env("PROVIDER_SECRET", "aorticai-internal-2026").strip()
        if expected_secret:
            headers["x-provider-secret"] = x_provider_secret or expected_secret
        try:
            resp = requests.get(req.input_url, headers=headers, timeout=120)
            resp.raise_for_status()
            return resp.content
        except Exception as exc:
            raise HTTPException(status_code=502, detail=f"input_download_failed:{exc}")
    raise HTTPException(status_code=400, detail="missing_input_payload")


@app.post("/infer")
async def infer(request: Request, x_provider_secret: Optional[str] = Header(default=None)) -> Dict[str, Any]:
    expected_secret = env("PROVIDER_SECRET", "aorticai-internal-2026").strip()
    provided_secret = (x_provider_secret or "").strip()
    if expected_secret and provided_secret != expected_secret:
        raise HTTPException(status_code=401, detail="provider_secret_mismatch")

    content_type = (request.headers.get("content-type") or "").lower()
    if content_type.startswith("multipart/form-data"):
        form = await request.form()
        upload = form.get("file")
        if upload is None or not hasattr(upload, "read"):
            raise HTTPException(status_code=400, detail="missing_file")
        input_bytes = await upload.read()  # type: ignore[attr-defined]
        req = InferenceRequest(
            job_id=str(form.get("job_id") or f"provider-manual-{int(time.time() * 1000)}"),
            study_id=str(form.get("study_id") or "manual-study"),
            image_key=str(getattr(upload, "filename", "upload.nii.gz")),
            r2_key=str(form.get("r2_key") or ""),
            patient_id=str(form.get("patient_id") or ""),
            input_content_type=str(getattr(upload, "content_type", "application/octet-stream")),
            callback=CallbackSpec(),
            callback_url=str(form.get("callback_url") or ""),
            status_url=str(form.get("status_url") or ""),
        )
    else:
        payload = await request.json()
        if not isinstance(payload, dict):
            raise HTTPException(status_code=400, detail="invalid_json_payload")
        req = InferenceRequest(**payload)
        input_bytes = load_input_bytes(req, x_provider_secret)

    max_input_bytes = int(env("MAX_INPUT_BYTES", str(900 * 1024 * 1024)))
    if len(input_bytes) > max_input_bytes:
        raise HTTPException(status_code=413, detail=f"input_too_large:{len(input_bytes)}")

    mode = env("PROVIDER_RESPONSE_MODE", "inline").strip().lower()
    if mode == "callback":
        if not (req.callback.url or req.callback_url):
            raise HTTPException(status_code=400, detail="callback_url_required_for_callback_mode")
        provider_job_id = f"provider-{int(time.time() * 1000)}"
        t = threading.Thread(target=run_model_and_callback, args=(req, input_bytes, provider_job_id), daemon=True)
        t.start()
        return {
            "status": "accepted",
            "job_id": req.job_id,
            "provider_job_id": provider_job_id,
            "r2_key": req.r2_key,
            "patient_id": req.patient_id,
        }

    try:
        post_stage_status(req, stage="segmentation", progress=25, status="running")
        result = run_model(input_bytes, req)
        post_stage_status(req, stage="centerline", progress=55, status="running")
        post_stage_status(req, stage="measurements", progress=80, status="running")
    except Exception as exc:
        provider_job_id = f"provider-failed-{int(time.time() * 1000)}"
        message = public_error_message(exc)
        error_payload = {
            "status": "failed",
            "job_id": req.job_id,
            "provider_job_id": provider_job_id,
            "error_message": message,
        }
        post_stage_status(req, stage="failed", progress=100, status="failed", detail=message)
        post_error_callback(req, provider_job_id, message)
        post_simple_completion_callback(req, status="failed", error_message=message)
        return error_payload

    post_stage_status(req, stage="completed", progress=100, status="completed")
    post_simple_completion_callback(req, status="completed", result_case_id=req.job_id)
    return result.model_dump(exclude_none=True)
