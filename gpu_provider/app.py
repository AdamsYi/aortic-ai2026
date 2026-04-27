import base64
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

import re
import requests
from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

# Force UTF-8 encoding for Windows console
if sys.platform == "win32":
    import io
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')


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
    file_content_b64: Optional[str] = None
    download_url: Optional[str] = None
    input_url: Optional[str] = None
    skip_segmentation: bool = False
    device: Optional[str] = None   # override MODEL_DEVICE env ("cpu"/"gpu"/"mps")
    quality: Optional[str] = None  # override PIPELINE_QUALITY env ("fast"/"high")
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

# ── 中文心跳与启动信息 ──────────────────────────────────────────
import datetime as _dt

_HEARTBEAT_INTERVAL = 30  # 秒
_heartbeat_running = False

def _heartbeat_loop():
    """后台心跳线程：每隔一段时间打印中文状态，让操作者知道服务还活着。"""
    global _heartbeat_running
    _heartbeat_running = True
    beat_count = 0
    while _heartbeat_running:
        time.sleep(_HEARTBEAT_INTERVAL)
        beat_count += 1
        now = _dt.datetime.now().strftime("%H:%M:%S")
        gpu_ok = "✅ GPU可用" if shutil.which("nvidia-smi") else "❌ 无GPU"
        heart = "💓" if beat_count % 2 == 0 else "💗"
        print(f"  {heart} [{now}] 心跳 #{beat_count} | {gpu_ok} | 服务正常运行中", flush=True)

def _print_startup_banner():
    """启动时打印中文欢迎信息。"""
    now = _dt.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    gpu_ok = shutil.which("nvidia-smi") is not None
    dcm_ok = shutil.which("dcm2niix") is not None
    print("\n" + "=" * 50, flush=True)
    print("  🫀 AorticAI 主动脉智能规划系统", flush=True)
    print("=" * 50, flush=True)
    print(f"  📅 启动时间: {now}", flush=True)
    print(f"  🖥️  GPU状态: {'✅ 已检测到 NVIDIA GPU' if gpu_ok else '❌ 未检测到 GPU'}", flush=True)
    print(f"  🔧 dcm2niix: {'✅ 可用' if dcm_ok else '❌ 不可用'}", flush=True)
    print(f"  🌐 监听地址: http://0.0.0.0:8000", flush=True)
    print(f"  🔑 API密钥: 已配置", flush=True)
    print("=" * 50, flush=True)
    print("  💡 提示: 保持此窗口开启，服务将持续运行", flush=True)
    print("  💡 每30秒会显示一次心跳 💓 表示服务正常", flush=True)
    print("  💡 收到分析请求时会显示详细进度", flush=True)
    print("=" * 50 + "\n", flush=True)

@app.on_event("startup")
def on_startup():
    _print_startup_banner()
    t = threading.Thread(target=_heartbeat_loop, daemon=True)
    t.start()

@app.on_event("shutdown")
def on_shutdown():
    global _heartbeat_running
    _heartbeat_running = False
    print("\n  🛑 AorticAI 服务已停止\n", flush=True)


PROVIDER_CONFIG_PATH = Path(__file__).resolve().with_name("provider_config.json")


def env(name: str, default: str) -> str:
    value = os.getenv(name)
    if value is None:
        return default
    return value


def load_provider_config() -> Dict[str, Any]:
    try:
        if PROVIDER_CONFIG_PATH.exists():
            parsed = json.loads(PROVIDER_CONFIG_PATH.read_text(encoding="utf-8"))
            if isinstance(parsed, dict):
                return parsed
    except Exception:
        pass
    return {}


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

    model_device = req.device or env("MODEL_DEVICE", "gpu")
    quality = req.quality or env("PIPELINE_QUALITY", "high")
    safe_study_id = req.study_id or req.patient_id or "unknown-study"
    _py = sys.executable
    cmd = (
        f'"{_py}" "{pipeline_py}" '
        f'--input "{input_path}" '
        f'--output-mask "{output_mask}" '
        f'--output-json "{output_json}" '
        f'--device "{model_device}" '
        f'--quality "{quality}" '
        f'--job-id "{req.job_id}" '
        f'--study-id "{safe_study_id}"'
    )
    if req.skip_segmentation:
        cmd += " --skip-segmentation"
    return cmd


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
    detail = str(exc).strip()
    if not detail:
        detail = "unknown_error"
    return f"{exc.__class__.__name__}: {detail}"


def ensure_callback_result_json(result_json: Dict[str, Any], fallback_case_id: str) -> Dict[str, Any]:
    payload = dict(result_json or {})
    payload["result_case_id"] = str(payload.get("result_case_id") or fallback_case_id)
    if not isinstance(payload.get("measurements"), dict):
        candidate = payload.get("measurements_structured")
        if isinstance(candidate, dict):
            payload["measurements"] = candidate
    if not isinstance(payload.get("planning"), dict):
        candidate = payload.get("planning_metrics")
        if isinstance(candidate, dict):
            payload["planning"] = candidate
    if not isinstance(payload.get("coronary_detection"), dict):
        candidate = payload.get("coronary_ostia")
        if isinstance(candidate, dict):
            payload["coronary_detection"] = candidate
    if not isinstance(payload.get("risk_flags"), list):
        payload["risk_flags"] = []
    return payload


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
        result_json = ensure_callback_result_json(result_json, req.job_id)
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
    payload["status"] = "completed"
    payload["result_case_id"] = str(
        payload.get("result_case_id")
        or payload.get("result_json", {}).get("result_case_id")
        or req.job_id
    )
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
        post_simple_completion_callback(
            req,
            status="completed",
            result_case_id=str(result.result_json.get("result_case_id") or req.job_id),
        )
    except Exception as exc:
        post_stage_status(req, stage="failed", progress=100, status="failed", detail=public_error_message(exc))
        post_error_callback(req, provider_job_id, public_error_message(exc))
        post_simple_completion_callback(req, status="failed", error_message=public_error_message(exc))


@app.get("/health")
def health() -> Dict[str, Any]:
    cfg = load_provider_config()
    infer_cmd_from_env = bool(os.getenv("INFER_CMD", "").strip())
    infer_cmd_from_cfg = bool(str(cfg.get("infer_cmd", "")).strip())
    gpu_ok = bool(shutil.which("nvidia-smi"))
    dcm2niix_ok = bool(shutil.which("dcm2niix"))
    return {
        "status": "ok",
        "gpu": gpu_ok,
        "dcm2niix_available": dcm2niix_ok,
        "ok": True,
        "service": "gpu-provider",
        "provider_response_mode": env("PROVIDER_RESPONSE_MODE", "inline"),
        "model_device": env("MODEL_DEVICE", "gpu"),
        "pipeline_quality": env("PIPELINE_QUALITY", "high"),
        "infer_cmd_configured": bool(infer_cmd_from_env or infer_cmd_from_cfg),
        "no_placeholder_mode": True,
    }


def load_input_bytes(req: InferenceRequest, x_provider_secret: Optional[str]) -> bytes:
    if req.file_content_b64:
        try:
            return base64.b64decode(req.file_content_b64, validate=True)
        except Exception as exc:
            raise HTTPException(status_code=400, detail=f"invalid_file_content_b64: {exc}")
    if req.input_base64:
        try:
            return base64.b64decode(req.input_base64, validate=True)
        except Exception as exc:
            raise HTTPException(status_code=400, detail=f"invalid_input_base64: {exc}")
    if req.download_url:
        try:
            resp = requests.get(req.download_url, timeout=120)
            resp.raise_for_status()
            return resp.content
        except Exception as exc:
            raise HTTPException(status_code=502, detail=f"download_url_fetch_failed:{exc}")
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
            skip_segmentation=str(form.get("skip_segmentation") or "false").strip().lower() in {"1", "true", "yes", "on"},
            callback=CallbackSpec(),
            callback_url=str(form.get("callback_url") or ""),
            status_url=str(form.get("status_url") or ""),
        )
    else:
        payload = await request.json()
        if not isinstance(payload, dict):
            raise HTTPException(status_code=400, detail="invalid_json_payload")
        req = InferenceRequest(**payload)
        try:
            input_bytes = load_input_bytes(req, x_provider_secret)
        except Exception as exc:
            provider_job_id = f"provider-failed-{int(time.time() * 1000)}"
            if isinstance(exc, HTTPException):
                message = f"HTTPException: {exc.detail}"
            else:
                message = public_error_message(exc)
            post_stage_status(req, stage="failed", progress=100, status="failed", detail=message)
            post_error_callback(req, provider_job_id, message)
            post_simple_completion_callback(req, status="failed", error_message=message)
            return {
                "status": "failed",
                "job_id": req.job_id,
                "provider_job_id": provider_job_id,
                "error_message": message,
            }

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


# ─── /admin/run ────────────────────────────────────────────────────────────
# Mac-side remote control channel. Reuses PROVIDER_SECRET (see AGENTS §A
# decision record). Only whitelisted subcommands are executable; argv goes
# through strict validators so nothing flows unsanitised into the shell.

_ADMIN_LOCK = threading.Lock()
_ADMIN_READ_LOCK = threading.Lock()
_GPU_DIR = Path(__file__).resolve().parent
_REPO_ROOT = _GPU_DIR.parent

_CASE_IDS_RE = re.compile(r"^[0-9]+(,[0-9]+)*$")
_CASE_ID_RE = re.compile(r"^[0-9]+$")


def _validate_ingest_args(args: List[str]) -> List[str]:
    allowed: List[str] = []
    i = 0
    while i < len(args):
        tok = args[i]
        if tok == "--dry-run":
            allowed.append(tok)
            i += 1
            continue
        if tok == "--case-ids":
            if i + 1 >= len(args):
                raise HTTPException(status_code=400, detail="case-ids_missing_value")
            val = args[i + 1]
            if not _CASE_IDS_RE.match(val):
                raise HTTPException(status_code=400, detail="case-ids_invalid_format")
            allowed.extend([tok, val])
            i += 2
            continue
        if tok.startswith("--case-ids="):
            val = tok.split("=", 1)[1]
            if not _CASE_IDS_RE.match(val):
                raise HTTPException(status_code=400, detail="case-ids_invalid_format")
            allowed.append(tok)
            i += 1
            continue
        if tok in {"--max-cases", "--case-index"}:
            if i + 1 >= len(args):
                raise HTTPException(status_code=400, detail=f"{tok[2:]}_missing_value")
            val = args[i + 1]
            if not _CASE_ID_RE.match(val):
                raise HTTPException(status_code=400, detail=f"{tok[2:]}_invalid_format")
            allowed.extend([tok, val])
            i += 2
            continue
        if tok.startswith("--max-cases=") or tok.startswith("--case-index="):
            val = tok.split("=", 1)[1]
            if not _CASE_ID_RE.match(val):
                raise HTTPException(status_code=400, detail=f"{tok.split('=', 1)[0][2:]}_invalid_format")
            allowed.append(tok)
            i += 1
            continue
        raise HTTPException(status_code=400, detail=f"arg_not_whitelisted:{tok}")
    return allowed


def _cmd_status(_args: List[str]) -> tuple[List[str], Optional[Path]]:
    snippet = (
        "import platform,sys,subprocess,shutil;"
        "print('python=',sys.version.split()[0]);"
        "print('platform=',platform.platform());"
        "print('gpu=',bool(shutil.which('nvidia-smi')));"
        "print('dcm2niix=',bool(shutil.which('dcm2niix')));"
        "rb=subprocess.run(['git','rev-parse','--abbrev-ref','HEAD'],capture_output=True,text=True,encoding='utf-8',errors='replace');"
        "r1=subprocess.run(['git','rev-parse','--short','HEAD'],capture_output=True,text=True,encoding='utf-8',errors='replace');"
        "r2=subprocess.run(['git','log','-1','--pretty=%s'],capture_output=True,text=True,encoding='utf-8',errors='replace');"
        "rs=subprocess.run(['git','status','--short'],capture_output=True,text=True,encoding='utf-8',errors='replace');"
        "print('git_branch=',(rb.stdout or '').strip());"
        "print('git_head=',(r1.stdout or '').strip());"
        "print('git_subject=',(r2.stdout or '').strip());"
        "print('git_status=',(rs.stdout or '').strip() or 'clean')"
    )
    return [sys.executable, "-c", snippet], _REPO_ROOT


def _cmd_git_pull(_args: List[str]) -> tuple[List[str], Optional[Path]]:
    return ["git", "pull", "--ff-only"], _REPO_ROOT


def _cmd_git_switch(args: List[str]) -> tuple[List[str], Optional[Path]]:
    """Switch the Windows provider to a known remote branch and fast-forward it."""
    if len(args) != 1:
        raise HTTPException(status_code=400, detail="git_switch_requires_branch")
    branch = args[0].strip()
    if not re.fullmatch(r"(main|codex/[A-Za-z0-9._/-]+)", branch) or ".." in branch or branch.endswith(".lock"):
        raise HTTPException(status_code=400, detail="git_switch_invalid_branch")

    snippet = r'''
import subprocess
import sys
from pathlib import Path

branch = sys.argv[1]
repo_root = Path(r"C:\AorticAI")
tracked_provider_files = [
    "gpu_provider/app.py",
    "gpu_provider/pipeline_runner.py",
    "gpu_provider/build_real_multiclass_mask.py",
    "gpu_provider/process_mao_from_r2.py",
]

def run(cmd, check=True):
    print("$ " + " ".join(cmd), flush=True)
    result = subprocess.run(cmd, cwd=repo_root, text=True, capture_output=True, encoding="utf-8", errors="replace")
    if result.stdout:
        print(result.stdout, end="" if result.stdout.endswith("\n") else "\n")
    if result.stderr:
        print(result.stderr, end="" if result.stderr.endswith("\n") else "\n")
    if check and result.returncode != 0:
        raise SystemExit(result.returncode)
    return result

print(f"Working directory: {repo_root}")
run(["git", "status", "--short"], check=False)
for rel in tracked_provider_files:
    if (repo_root / rel).exists():
        run(["git", "restore", "--", rel], check=False)
run(["git", "fetch", "origin", branch])
switched = run(["git", "switch", branch], check=False)
if switched.returncode != 0:
    run(["git", "switch", "-c", branch, "--track", f"origin/{branch}"])
run(["git", "pull", "--ff-only"])
run(["git", "log", "-1", "--oneline"])
run(["git", "status", "--short"], check=False)
'''
    return [sys.executable, "-u", "-c", snippet, branch], _REPO_ROOT


def _cmd_ingest(args: List[str]) -> tuple[List[str], Optional[Path]]:
    clean = _validate_ingest_args(args)
    argv = [sys.executable, "-u", "-m", "gpu_provider.fetch_imagecas", *clean]
    return argv, _REPO_ROOT


def _cmd_scan_imagecas_meshqa(args: List[str]) -> tuple[List[str], Optional[Path]]:
    clean = _validate_ingest_args(args)
    if "--dry-run" in clean or any(tok.startswith("--dry-run") for tok in clean):
        raise HTTPException(status_code=400, detail="scan_imagecas_meshqa_requires_full_pipeline")
    if not any(tok == "--case-ids" or tok.startswith("--case-ids=") for tok in clean):
        raise HTTPException(status_code=400, detail="scan_imagecas_meshqa_requires_case-ids")
    argv = [sys.executable, "-u", "-m", "gpu_provider.scan_imagecas_meshqa", *clean]
    return argv, _REPO_ROOT


def _validate_ingest_zenodo_args(args: List[str]) -> List[str]:
    allowed: List[str] = []
    i = 0
    while i < len(args):
        tok = args[i]
        if tok == "--dry-run":
            allowed.append(tok)
            i += 1
            continue
        if tok in {"--max-cases", "--case-index"}:
            if i + 1 >= len(args):
                raise HTTPException(status_code=400, detail=f"{tok[2:]}_missing_value")
            val = args[i + 1]
            if not _CASE_ID_RE.match(val):
                raise HTTPException(status_code=400, detail=f"{tok[2:]}_invalid_format")
            allowed.extend([tok, val])
            i += 2
            continue
        if tok.startswith("--max-cases=") or tok.startswith("--case-index="):
            val = tok.split("=", 1)[1]
            if not _CASE_ID_RE.match(val):
                raise HTTPException(status_code=400, detail=f"{tok.split('=', 1)[0][2:]}_invalid_format")
            allowed.append(tok)
            i += 1
            continue
        raise HTTPException(status_code=400, detail=f"arg_not_whitelisted:{tok}")
    return allowed


def _cmd_ingest_zenodo(args: List[str]) -> tuple[List[str], Optional[Path]]:
    clean = _validate_ingest_zenodo_args(args)
    argv = [sys.executable, "-u", str(_GPU_DIR / "download_and_process_tavi.py"), *clean]
    return argv, _GPU_DIR


def _cmd_zenodo_inspect(args: List[str]) -> tuple[List[str], Optional[Path]]:
    if args:
        raise HTTPException(status_code=400, detail="zenodo_inspect_takes_no_args")
    snippet = (
        "import hashlib, zipfile\n"
        "from pathlib import Path\n"
        "zip_path = Path(r'C:\\AorticAI\\gpu_provider\\demo_data\\tavi_data.zip')\n"
        "if not zip_path.exists():\n"
        "    raise SystemExit(f'zip_missing {zip_path}')\n"
        "size = zip_path.stat().st_size\n"
        "sha = hashlib.sha256()\n"
        "with zip_path.open('rb') as fh:\n"
        "    for chunk in iter(lambda: fh.read(1024 * 1024), b''):\n"
        "        sha.update(chunk)\n"
        "print(f'zip_path {zip_path.resolve()}')\n"
        "print(f'zip_size_bytes {size}')\n"
        "print(f'zip_sha256_prefix16 {sha.hexdigest()[:16]}')\n"
        "with zipfile.ZipFile(zip_path, 'r') as zf:\n"
        "    names = zf.namelist()\n"
        "    print(f'zip_entry_count {len(names)}')\n"
        "    for idx, name in enumerate(names[:80], start=1):\n"
        "        print(f'entry_{idx:02d} {name}')\n"
    )
    return [sys.executable, "-u", "-c", snippet], _GPU_DIR


def _cmd_tcia_probe(args: List[str]) -> tuple[List[str], Optional[Path]]:
    if args:
        raise HTTPException(status_code=400, detail="tcia_probe_takes_no_args")
    snippet = (
        "import json\n"
        "import urllib.request\n"
        "URL = 'https://services.cancerimagingarchive.net/services/v3/TCIA/query/getSeries?Collection=Coronary-CT-Angiography&format=json'\n"
        "def val(row, key):\n"
        "    value = row.get(key)\n"
        "    return '-' if value in (None, '') else str(value)\n"
        "try:\n"
        "    with urllib.request.urlopen(URL, timeout=60) as resp:\n"
        "        payload = json.load(resp)\n"
        "except Exception as exc:\n"
        "    print(str(exc))\n"
        "    raise\n"
        "print(f'series_count | {len(payload)}')\n"
        "for row in payload[:30]:\n"
        "    print(' | '.join([\n"
        "        val(row, 'SeriesInstanceUID'),\n"
        "        val(row, 'Modality'),\n"
        "        val(row, 'BodyPartExamined'),\n"
        "        val(row, 'Manufacturer'),\n"
        "        val(row, 'ImageCount'),\n"
        "        val(row, 'SliceThickness'),\n"
        "    ]))\n"
    )
    return [sys.executable, "-u", "-c", snippet], _GPU_DIR


def _cmd_imagecas_probe(args: List[str]) -> tuple[List[str], Optional[Path]]:
    if args:
        raise HTTPException(status_code=400, detail="imagecas_probe_takes_no_args")
    snippet = (
        "import csv\n"
        "import io\n"
        "import shutil\n"
        "import subprocess\n"
        "import sys\n"
        "from pathlib import Path\n"
        "dataset = 'xiaoweixumedicalai/imagecas'\n"
        "scripts_dir = Path(sys.executable).resolve().parent\n"
        "kaggle_cli = None\n"
        "for candidate in ('kaggle.exe', 'kaggle'):\n"
        "    probe = scripts_dir / candidate\n"
        "    if probe.exists():\n"
        "        kaggle_cli = str(probe)\n"
        "        break\n"
        "if kaggle_cli is None:\n"
        "    kaggle_cli = shutil.which('kaggle')\n"
        "if kaggle_cli is None:\n"
        "    raise SystemExit('kaggle_cli_not_found')\n"
        "cmd = [kaggle_cli, 'datasets', 'files', '-d', dataset, '--csv']\n"
        "print(f'dataset | {dataset}')\n"
        "print(f'kaggle_cli | {kaggle_cli}')\n"
        "try:\n"
        "    proc = subprocess.run(cmd, capture_output=True, text=True, check=True)\n"
        "except Exception as exc:\n"
        "    if isinstance(exc, subprocess.CalledProcessError):\n"
        "        if exc.stdout:\n"
        "            print(exc.stdout.strip())\n"
        "        if exc.stderr:\n"
        "            print(exc.stderr.strip())\n"
        "    print(str(exc))\n"
        "    raise\n"
        "print('raw_csv_head || ' + proc.stdout[:2000].replace('\\r', '\\\\r').replace('\\n', '\\\\n'))\n"
        "reader = csv.DictReader(io.StringIO(proc.stdout))\n"
        "print('raw_csv_columns | ' + ' | '.join(reader.fieldnames or []))\n"
        "rows = list(reader)\n"
        "print(f'archive_entry_count | {len(rows)}')\n"
        "max_case_end = None\n"
        "for row in rows:\n"
        "    name = ''\n"
        "    for key in (reader.fieldnames or []):\n"
        "        value = row.get(key) or ''\n"
        "        if '.change2zip' in value or '.z01' in value or '.z02' in value or '.z03' in value or '.z04' in value:\n"
        "            name = value\n"
        "            break\n"
        "    if '-' not in name:\n"
        "        continue\n"
        "    head = name.split('.', 1)[0]\n"
        "    if '-' not in head:\n"
        "        continue\n"
        "    start, end = head.split('-', 1)\n"
        "    if start.isdigit() and end.isdigit():\n"
        "        end_num = int(end)\n"
        "        if max_case_end is None or end_num > max_case_end:\n"
        "            max_case_end = end_num\n"
        "if max_case_end is not None:\n"
        "    print(f'inferred_case_count | {max_case_end}')\n"
        "for idx, row in enumerate(rows, start=1):\n"
        "    values = [str(row.get(key) or '-') for key in (reader.fieldnames or [])]\n"
        "    print(f'entry_{idx:02d} | ' + ' | '.join(values))\n"
    )
    return [sys.executable, "-u", "-c", snippet], _GPU_DIR


def _cmd_imagecas_extract_first_split(args: List[str]) -> tuple[List[str], Optional[Path]]:
    if args:
        raise HTTPException(status_code=400, detail="imagecas_extract_first_split_takes_no_args")
    snippet = (
        "import os\n"
        "import shutil\n"
        "import subprocess\n"
        "import sys\n"
        "from pathlib import Path\n"
        "import nibabel as nib\n"
        "dataset = 'xiaoweixumedicalai/imagecas'\n"
        "base = Path(r'C:\\AorticAI\\gpu_provider')\n"
        "download_dir = base / 'demo_data' / 'imagecas_1-200'\n"
        "extract_dir = base / 'demo_data' / 'imagecas_1-200_extracted'\n"
        "download_dir.mkdir(parents=True, exist_ok=True)\n"
        "extract_dir.mkdir(parents=True, exist_ok=True)\n"
        "required = ['1-200.change2zip', '1-200.z01', '1-200.z02', '1-200.z03', '1-200.z04']\n"
        "free_bytes = shutil.disk_usage(str(base.drive + '\\\\' if base.drive else base)).free\n"
        "print(f'disk_free_bytes | {free_bytes}')\n"
        "if free_bytes < 20 * 1024 * 1024 * 1024:\n"
        "    raise SystemExit(f'disk_space_below_20gb | {free_bytes}')\n"
        "scripts_dir = Path(sys.executable).resolve().parent\n"
        "kaggle_cli = None\n"
        "for candidate in ('kaggle.exe', 'kaggle'):\n"
        "    probe = scripts_dir / candidate\n"
        "    if probe.exists():\n"
        "        kaggle_cli = str(probe)\n"
        "        break\n"
        "if kaggle_cli is None:\n"
        "    kaggle_cli = shutil.which('kaggle')\n"
        "if kaggle_cli is None:\n"
        "    raise SystemExit('kaggle_cli_not_found')\n"
        "seven_zip = shutil.which('7z.exe') or shutil.which('7z')\n"
        "if seven_zip is None:\n"
        "    common = [\n"
        "        Path(os.environ.get('LOCALAPPDATA', '')) / 'Programs' / '7-Zip' / '7z.exe',\n"
        "        Path(r'C:\\Program Files\\7-Zip\\7z.exe'),\n"
        "        Path(r'C:\\Program Files (x86)\\7-Zip\\7z.exe'),\n"
        "    ]\n"
        "    for candidate in common:\n"
        "        if candidate.exists():\n"
        "            seven_zip = str(candidate)\n"
        "            break\n"
        "if seven_zip is None:\n"
        "    raise SystemExit('7z_not_found')\n"
        "print(f'kaggle_cli | {kaggle_cli}')\n"
        "print(f'seven_zip | {seven_zip}')\n"
        "for filename in required:\n"
        "    target = download_dir / filename\n"
        "    if target.exists() and target.stat().st_size > 0:\n"
        "        print(f'download_skip | {filename} | {target.stat().st_size}')\n"
        "        continue\n"
        "    cmd = [kaggle_cli, 'datasets', 'download', '-d', dataset, '-f', filename, '-p', str(download_dir)]\n"
        "    print('[download] ' + ' '.join(cmd))\n"
        "    subprocess.run(cmd, check=True)\n"
        "    if not target.exists():\n"
        "        wrapper = download_dir / f'{filename}.zip'\n"
        "        if wrapper.exists():\n"
        "            import zipfile\n"
        "            with zipfile.ZipFile(wrapper) as zf:\n"
        "                names = zf.namelist()\n"
        "                if names != [filename]:\n"
        "                    raise SystemExit(f'kaggle_wrapper_unexpected | {filename} | {names}')\n"
        "                zf.extract(filename, path=download_dir)\n"
        "            wrapper.unlink()\n"
        "            print(f'download_unwrapped | {filename} | {target.stat().st_size}')\n"
        "    if not target.exists():\n"
        "        raise SystemExit(f'download_missing | {filename}')\n"
        "    print(f'download_ok | {filename} | {target.stat().st_size}')\n"
        "change_path = download_dir / '1-200.change2zip'\n"
        "zip_alias = download_dir / '1-200.zip'\n"
        "if not zip_alias.exists():\n"
        "    try:\n"
        "        os.link(change_path, zip_alias)\n"
        "        print(f'zip_alias_hardlink | {zip_alias}')\n"
        "    except Exception:\n"
        "        change_path.rename(zip_alias)\n"
        "        print(f'zip_alias_renamed | {zip_alias}')\n"
        "else:\n"
        "    print(f'zip_alias_exists | {zip_alias}')\n"
        "extract_cmd = [seven_zip, 'x', '-y', str(zip_alias), f'-o{extract_dir}']\n"
        "print('[extract] ' + ' '.join(extract_cmd))\n"
        "subprocess.run(extract_cmd, check=True)\n"
        "top = sorted(extract_dir.iterdir(), key=lambda p: p.name.lower())\n"
        "print(f'top_level_entry_count | {len(top)}')\n"
        "for idx, path in enumerate(top[:60], start=1):\n"
        "    kind = 'dir' if path.is_dir() else 'file'\n"
        "    print(f'top_{idx:02d} | {kind} | {path.name}')\n"
        "probe_dir = None\n"
        "for path in sorted(extract_dir.rglob('*')):\n"
        "    if not path.is_file():\n"
        "        continue\n"
        "    low = path.name.lower()\n"
        "    if low.endswith('.nii') or low.endswith('.nii.gz'):\n"
        "        probe_dir = path.parent\n"
        "        break\n"
        "if probe_dir is None:\n"
        "    print('patient_probe_dir | -')\n"
        "    raise SystemExit(0)\n"
        "print(f'patient_probe_dir | {probe_dir}')\n"
        "files = sorted(probe_dir.iterdir(), key=lambda p: p.name.lower())\n"
        "for idx, path in enumerate(files, start=1):\n"
        "    kind = 'dir' if path.is_dir() else 'file'\n"
        "    print(f'patient_file_{idx:02d} | {kind} | {path.name}')\n"
        "for path in files:\n"
        "    low = path.name.lower()\n"
        "    if not path.is_file() or not (low.endswith('.nii') or low.endswith('.nii.gz')):\n"
        "        continue\n"
        "    img = nib.load(str(path))\n"
        "    shape = 'x'.join(str(v) for v in img.shape)\n"
        "    spacing = 'x'.join(f'{float(v):.4f}' for v in img.header.get_zooms()[:3])\n"
        "    units = img.header.get_xyzt_units()\n"
        "    print(f'nii_header | {path.name} | shape={shape} | spacing={spacing} | units={units}')\n"
    )
    return [sys.executable, "-u", "-c", snippet], _GPU_DIR


def _cmd_install_7zip(args: List[str]) -> tuple[List[str], Optional[Path]]:
    if args:
        raise HTTPException(status_code=400, detail="install_7zip_takes_no_args")
    snippet = (
        "import os\n"
        "import shutil\n"
        "import subprocess\n"
        "import sys\n"
        "from pathlib import Path\n"
        "def find_7z():\n"
        "    for candidate in (\n"
        "        shutil.which('7z.exe'),\n"
        "        shutil.which('7z'),\n"
        "        str(Path(os.environ.get('LOCALAPPDATA', '')) / 'Programs' / '7-Zip' / '7z.exe'),\n"
        "        str(Path(r'C:\\Program Files\\7-Zip\\7z.exe')),\n"
        "        str(Path(r'C:\\Program Files (x86)\\7-Zip\\7z.exe')),\n"
        "    ):\n"
        "        if candidate and os.path.exists(candidate):\n"
        "            return candidate\n"
        "    return None\n"
        "def print_version(exe):\n"
        "    proc = subprocess.run([exe], capture_output=True, text=True)\n"
        "    first = '-'\n"
        "    for line in proc.stdout.splitlines() + proc.stderr.splitlines():\n"
        "        if line.strip():\n"
        "            first = line.strip()\n"
        "            break\n"
        "    print(f'seven_zip | {exe}')\n"
        "    print(f'seven_zip_version | {first}')\n"
        "existing = find_7z()\n"
        "if existing:\n"
        "    print_version(existing)\n"
        "    raise SystemExit(0)\n"
        "cmd = [\n"
        "    'winget',\n"
        "    'install',\n"
        "    '-e',\n"
        "    '--id',\n"
        "    '7zip.7zip',\n"
        "    '--scope',\n"
        "    'user',\n"
        "    '-h',\n"
        "    '--accept-source-agreements',\n"
        "    '--accept-package-agreements',\n"
        "]\n"
        "print('[install] $ ' + ' '.join(cmd))\n"
        "proc = subprocess.run(cmd, capture_output=True, text=True)\n"
        "if proc.stdout:\n"
        "    sys.stdout.write(proc.stdout)\n"
        "installed = find_7z()\n"
        "if proc.returncode != 0:\n"
        "    if proc.stderr:\n"
        "        sys.stderr.write(proc.stderr)\n"
        "    raise SystemExit(proc.returncode)\n"
        "if not installed:\n"
        "    if proc.stderr:\n"
        "        sys.stderr.write(proc.stderr)\n"
        "    raise SystemExit(1)\n"
        "print_version(installed)\n"
    )
    return [sys.executable, "-u", "-c", snippet], _GPU_DIR


def _cmd_pip_sync(args: List[str]) -> tuple[List[str], Optional[Path]]:
    if args:
        raise HTTPException(status_code=400, detail="pip_sync_takes_no_args")
    return [
        str(_GPU_DIR / ".venv" / "Scripts" / "pip.exe"),
        "install",
        "-r",
        str(_GPU_DIR / "requirements.txt"),
        "--disable-pip-version-check",
    ], _GPU_DIR


def _resolve_commit_case_target(case_id: str) -> tuple[str, str, str]:
    numeric_id = str(int(case_id))
    candidates = []

    zenodo_slug = f"zenodo_tavi_{numeric_id}"
    if (_REPO_ROOT / "cases" / zenodo_slug).exists():
        candidates.append(
            (
                zenodo_slug,
                f"ingest/{zenodo_slug}",
                f"feat(cases): Zenodo TAVI case {numeric_id} passing SCCT 2021 data-quality gate",
            )
        )

    imagecas_slug = f"imagecas_{int(case_id):04d}"
    if (_REPO_ROOT / "cases" / imagecas_slug).exists():
        candidates.append(
            (
                imagecas_slug,
                f"ingest/imagecas_{numeric_id}",
                f"feat(cases): ImageCAS case {numeric_id} passing SCCT 2021 data-quality gate",
            )
        )

    if not candidates:
        raise HTTPException(status_code=400, detail="case_bundle_missing")
    if len(candidates) > 1:
        raise HTTPException(status_code=400, detail="case_bundle_ambiguous")
    return candidates[0]


def _validate_commit_case_args(args: List[str]) -> tuple[str, str, str]:
    if len(args) != 2 or args[0] != "--case-id":
        raise HTTPException(status_code=400, detail="commit_case_requires_case-id")
    case_id = args[1]
    if not _CASE_ID_RE.match(case_id):
        raise HTTPException(status_code=400, detail="case-id_invalid_format")
    return _resolve_commit_case_target(case_id)


def _cmd_commit_case(args: List[str]) -> tuple[List[str], Optional[Path]]:
    case_slug, branch, message = _validate_commit_case_args(args)
    case_dir = f"cases/{case_slug}"
    snippet = (
        "import os, subprocess, sys\n"
        "case_dir = sys.argv[1]\n"
        "branch = sys.argv[2]\n"
        "message = sys.argv[3]\n"
        "git_env = dict(os.environ)\n"
        "git_env['GIT_TERMINAL_PROMPT'] = '0'\n"
        "git_env['GIT_PAGER'] = 'cat'\n"
        "git_env['PAGER'] = 'cat'\n"
        "commands = [\n"
        "    ['git', 'add', case_dir],\n"
        "    ['git', 'checkout', '-B', branch],\n"
        "    ['git', 'commit', '-m', message],\n"
        "    ['git', 'push', '-u', 'origin', branch],\n"
        "]\n"
        "for cmd in commands:\n"
        "    print('[admin] $ ' + ' '.join(cmd), flush=True)\n"
        "    proc = subprocess.Popen(\n"
        "        cmd,\n"
        "        stdout=subprocess.PIPE,\n"
        "        stderr=subprocess.STDOUT,\n"
        "        text=True,\n"
        "        encoding='utf-8',\n"
        "        errors='replace',\n"
        "        env=git_env,\n"
        "        bufsize=1,\n"
        "    )\n"
        "    assert proc.stdout is not None\n"
        "    for line in proc.stdout:\n"
        "        print(line.rstrip(), flush=True)\n"
        "    code = proc.wait()\n"
        "    if code != 0:\n"
        "        raise SystemExit(code)\n"
    )
    return [sys.executable, "-u", "-c", snippet, case_dir, branch, message], _REPO_ROOT


def _cmd_inspect_case(args: List[str]) -> tuple[List[str], Optional[Path]]:
    case_slug, _branch, _message = _validate_commit_case_args(args)
    snippet = (
        "import sys\n"
        "from pathlib import Path\n"
        "case_slug = sys.argv[1]\n"
        "repo_root = Path(sys.argv[2])\n"
        "case_dir = repo_root / 'cases' / case_slug\n"
        "manifest = case_dir / 'artifacts' / 'case_manifest.json'\n"
        "mesh_qa = case_dir / 'qa' / 'mesh_qa.json'\n"
        "pipeline_log = case_dir / 'pipeline.log'\n"
        "print(f'case_dir | {case_dir}')\n"
        "for label, path in [('case_manifest', manifest), ('mesh_qa', mesh_qa), ('pipeline_log', pipeline_log)]:\n"
        "    print(f'file | {label} | exists={path.exists()} | path={path}')\n"
        "if not manifest.exists():\n"
        "    raise SystemExit(2)\n"
        "print('--- case_manifest.json ---')\n"
        "print(manifest.read_text(encoding='utf-8', errors='replace'))\n"
        "if mesh_qa.exists():\n"
        "    print('--- mesh_qa.json ---')\n"
        "    print(mesh_qa.read_text(encoding='utf-8', errors='replace'))\n"
        "if pipeline_log.exists():\n"
        "    print('--- pipeline.log tail(200) ---')\n"
        "    lines = pipeline_log.read_text(encoding='utf-8', errors='replace').splitlines()\n"
        "    for line in lines[-200:]:\n"
        "        print(line)\n"
    )
    return [sys.executable, "-u", "-c", snippet, case_slug, str(_REPO_ROOT)], _REPO_ROOT


def _cmd_diagnose_nme_seam(args: List[str]) -> tuple[List[str], Optional[Path]]:
    if len(args) != 2 or args[0] != "--case-id":
        raise HTTPException(status_code=400, detail="diagnose_nme_seam_requires_case-id")
    case_id = args[1]
    if not _CASE_ID_RE.match(case_id):
        raise HTTPException(status_code=400, detail="case-id_invalid_format")
    return [sys.executable, "-u", "-m", "gpu_provider.diagnose_nme_seam", "--case-id", case_id], _REPO_ROOT


_ADMIN_WHITELIST = {
    "git_pull": _cmd_git_pull,
    "git_switch": _cmd_git_switch,
    "pip_sync": _cmd_pip_sync,
    "ingest_imagecas": _cmd_ingest,
    "scan_imagecas_meshqa": _cmd_scan_imagecas_meshqa,
    "ingest_zenodo": _cmd_ingest_zenodo,
    "zenodo_inspect": _cmd_zenodo_inspect,
    "tcia_probe": _cmd_tcia_probe,
    "imagecas_probe": _cmd_imagecas_probe,
    "imagecas_extract_first_split": _cmd_imagecas_extract_first_split,
    "install_7zip": _cmd_install_7zip,
    "commit_case": _cmd_commit_case,
}

_ADMIN_READONLY_WHITELIST = {
    "status": _cmd_status,
    "inspect_case": _cmd_inspect_case,
    "diagnose_nme_seam": _cmd_diagnose_nme_seam,
}


class AdminRunRequest(BaseModel):
    command: str
    args: List[str] = Field(default_factory=list)


def _stream_process(argv: List[str], cwd: Optional[Path], lock: threading.Lock):
    yield f"[admin] $ {' '.join(argv)}\n"
    env_over = dict(os.environ)
    env_over["PYTHONUNBUFFERED"] = "1"
    env_over["PYTHONIOENCODING"] = "utf-8"
    try:
        proc = subprocess.Popen(
            argv,
            cwd=str(cwd) if cwd else None,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            env=env_over,
            text=True,
            encoding="utf-8",
            errors="replace",
            bufsize=1,
        )
    except Exception as exc:
        yield f"[admin] spawn_failed: {exc}\n"
        return
    try:
        assert proc.stdout is not None
        for line in proc.stdout:
            yield line
        code = proc.wait()
        yield f"[admin] exit_code={code}\n"
    finally:
        lock.release()


@app.post("/admin/run")
async def admin_run(
    payload: AdminRunRequest,
    x_provider_secret: Optional[str] = Header(default=None),
) -> StreamingResponse:
    expected_secret = env("PROVIDER_SECRET", "aorticai-internal-2026").strip()
    provided_secret = (x_provider_secret or "").strip()
    if expected_secret and provided_secret != expected_secret:
        raise HTTPException(status_code=401, detail="provider_secret_mismatch")

    resolver = _ADMIN_WHITELIST.get(payload.command)
    read_only = False
    if resolver is None:
        resolver = _ADMIN_READONLY_WHITELIST.get(payload.command)
        if resolver is None:
            raise HTTPException(
                status_code=400,
                detail=f"command_not_whitelisted:{payload.command}",
            )
        read_only = True
    argv, cwd = resolver(payload.args)

    if read_only:
        if not _ADMIN_READ_LOCK.acquire(blocking=False):
            raise HTTPException(status_code=409, detail="another_readonly_admin_command_in_progress")
        return StreamingResponse(
            _stream_process(argv, cwd, _ADMIN_READ_LOCK),
            media_type="text/plain; charset=utf-8",
        )

    if not _ADMIN_LOCK.acquire(blocking=False):
        raise HTTPException(status_code=409, detail="another_admin_command_in_progress")

    return StreamingResponse(
        _stream_process(argv, cwd, _ADMIN_LOCK),
        media_type="text/plain; charset=utf-8",
    )


def _cmd_download_nifti(args: List[str]) -> tuple[List[str], Optional[Path]]:
    """Download NIfTI from URL and process it.

    Usage: download_nifti --case-id <case> --url <url>
    """
    case_id = None
    url = None
    i = 0
    while i < len(args):
        if args[i] == "--case-id" and i + 1 < len(args):
            case_id = args[i + 1]
            i += 2
        elif args[i] == "--url" and i + 1 < len(args):
            url = args[i + 1]
            i += 2
        else:
            i += 1

    if not case_id or not url:
        raise HTTPException(status_code=400, detail="download_nifti_requires_--case-id_and_--url")

    snippet = f'''
import os
import sys
import requests
from pathlib import Path

CASE_ID = "{case_id}"
URL = "{url}"
REPO_ROOT = Path(r"C:\\aortic-ai")
CASE_DIR = REPO_ROOT / "cases" / CASE_ID

print(f"Downloading NIfTI for {{CASE_ID}} from {{URL}}")

# Create directories
(CASE_DIR / "imaging_hidden").mkdir(parents=True, exist_ok=True)
(CASE_DIR / "meshes").mkdir(parents=True, exist_ok=True)
(CASE_DIR / "artifacts").mkdir(parents=True, exist_ok=True)

# Download file
dest = CASE_DIR / "imaging_hidden" / "ct_preop.nii.gz"
resp = requests.get(URL, stream=True)
resp.raise_for_status()

total = int(resp.headers.get('content-length', 0))
downloaded = 0
with open(dest, 'wb') as f:
    for chunk in resp.iter_content(chunk_size=8192):
        f.write(chunk)
        downloaded += len(chunk)
        if total > 0:
            print(f"\\rDownloading: {{downloaded / 1024 / 1024:.1f}}/{{total / 1024 / 1024:.1f}} MB", end='', flush=True)

print(f"\\nDownloaded: {{dest.stat().st_size / (1024*1024):.1f}} MB")

# Now run the processing
os.chdir(REPO_ROOT / "gpu_provider")
sys.argv = ["process_local_nifti", "--case-id", CASE_ID, "--nifti", str(dest)]
exec(open(REPO_ROOT / "gpu_provider" / "process_local_nifti.py").read())
'''

    return [sys.executable, "-u", "-c", snippet], _REPO_ROOT


def _cmd_run_module(args: List[str]) -> tuple[List[str], Optional[Path]]:
    """Run a Python module by name.

    Usage: run_module <module_name>
    Example: run_module gpu_provider.process_mao_from_r2
    """
    if len(args) != 1:
        raise HTTPException(status_code=400, detail="run_module_requires_exactly_one_module_name")

    module_name = args[0]
    if not all(c.isalnum() or c == '.' or c == '_' for c in module_name):
        raise HTTPException(status_code=400, detail="run_module_invalid_module_name")

    argv = [sys.executable, "-u", "-m", module_name]
    return argv, _REPO_ROOT


_ADMIN_WHITELIST["download_nifti"] = _cmd_download_nifti
_ADMIN_WHITELIST["run_module"] = _cmd_run_module


def _cmd_list_case_files(args: List[str]) -> tuple[List[str], Optional[Path]]:
    """List files in a case directory.

    Usage: list_case_files --case-id <case>
    """
    if len(args) != 2 or args[0] != "--case-id":
        raise HTTPException(status_code=400, detail="list_case_files_requires_--case-id")

    case_id = args[1]
    # Map numeric ID to case slug
    case_slug = f"mao_mianqiang_preop" if case_id == "999" else f"case_{case_id}"

    snippet = rf'''
import os
from pathlib import Path

case_slug = "{case_slug}"
for candidate in [r"C:\AorticAI", r"C:\aortic-ai"]:
    if Path(candidate).exists():
        repo_root = Path(candidate)
        break
else:
    repo_root = Path(r"C:\AorticAI")

case_dir = repo_root / "cases" / case_slug
print(f"case_dir | {{case_dir}}")
print(f"case_dir_exists | {{case_dir.exists()}}")

for subdir in ["meshes", "artifacts", "imaging_hidden", "qa"]:
    subdir_path = case_dir / subdir
    if subdir_path.exists():
        files = list(subdir_path.iterdir())
        print(f"{{subdir}}_count | {{len(files)}}")
        for f in files[:20]:
            print(f"{{subdir}}_file | {{f.name}} | {{f.stat().st_size}}")
    else:
        print(f"{{subdir}}_exists | False")
'''
    return [sys.executable, "-u", "-c", snippet], _REPO_ROOT


_ADMIN_READONLY_WHITELIST["list_case_files"] = _cmd_list_case_files


def _cmd_diagnose_lumen(args: List[str]) -> tuple[List[str], Optional[Path]]:
    """Diagnose lumen extraction for mao_mianqiang_preop case.

    This command is decoupled from the lumen_mesh.py 修复 code:
    - Section 1 (label diagnosis): Uses only nibabel + numpy, always works
    - Section 2 (extract_lumen_mask): Optional, failure doesn't abort Section 1
    """
    if args:
        raise HTTPException(status_code=400, detail="diagnose_lumen_takes_no_args")

    snippet = '''
import nibabel as nib
import numpy as np
from scipy import ndimage
from pathlib import Path

case_dir = Path(r"C:\\AorticAI\\cases\\mao_mianqiang_preop")
seg_path = case_dir / "meshes" / "segmentation.nii.gz"

print("=" * 60)
print("SEGMENTATION DIAGNOSIS (Decoupled)")
print("=" * 60)

if not seg_path.exists():
    print("ERROR: segmentation.nii.gz NOT FOUND")
    raise SystemExit(1)

nii = nib.load(str(seg_path))
seg = nii.get_fdata().astype(np.uint8)
spacing = tuple(float(x) for x in nii.header.get_zooms()[:3])

print(f"Shape: {seg.shape}")
print(f"Spacing: {spacing}")
print(f"Unique labels: {np.unique(seg)}")
print()

# ===== SECTION 1: Label Diagnosis (always runs) =====
print("=== LABEL ANALYSIS (nibabel only) ===")
for label in [0, 1, 2, 3]:
    count = np.sum(seg == label)
    pct = 100.0 * count / seg.size if seg.size > 0 else 0
    label_name = {0: "background", 1: "aortic_root", 2: "valve_leaflets", 3: "ascending_aorta"}.get(label, "unknown")
    print(f"Label {label} ({label_name}): {int(count):>10} voxels ({pct:6.3f}%)")

print()
lumen_direct = np.isin(seg, [1, 3])
print(f"Direct Lumen (labels 1+3): {int(np.sum(lumen_direct)):>10} voxels")

# Check connectivity
print()
print("=== CONNECTIVITY ANALYSIS ===")
root_mask = seg == 1
asc_mask = seg == 3
print(f"Root (label 1) raw voxels: {int(np.sum(root_mask))}")
print(f"Ascending (label 3) raw voxels: {int(np.sum(asc_mask))}")

if np.any(root_mask):
    root_lab, root_num = ndimage.label(root_mask)
    print(f"  Root connected components: {root_num}")
    if root_num > 0:
        root_counts = np.bincount(root_lab.ravel())
        root_counts[0] = 0
        print(f"  Root largest component: {int(np.max(root_counts))} voxels")

if np.any(asc_mask):
    asc_lab, asc_num = ndimage.label(asc_mask)
    print(f"  Ascending connected components: {asc_num}")
    if asc_num > 0:
        asc_counts = np.bincount(asc_lab.ravel())
        asc_counts[0] = 0
        print(f"  Ascending largest component: {int(np.max(asc_counts))} voxels")

combined = root_mask | asc_mask
if np.any(combined):
    combined_lab, combined_num = ndimage.label(combined)
    print(f"  Combined (1+3) connected components: {combined_num}")

# ===== SECTION 2: extract_lumen_mask (optional, failure tolerated) =====
print()
print("=== EXTRACT_LUMEN_MASK (optional check) ===")
try:
    import sys
    sys.path.insert(0, r"C:\\AorticAI\\gpu_provider")
    from geometry.lumen_mesh import extract_lumen_mask
    lumen_mask = extract_lumen_mask(seg, spacing)
    print(f"Result lumen voxels: {int(np.sum(lumen_mask))}")
    if not np.any(lumen_mask):
        print("WARNING: Lumen mask is EMPTY!")
        print("NOTE: This may indicate a problem with the lumen extraction fix.")
except ImportError as e:
    print(f"INFO: Could not import extract_lumen_mask: {e}")
    print("      This is OK - label diagnosis above is still valid.")
except Exception as e:
    print(f"ERROR during extraction: {e}")
    import traceback
    traceback.print_exc()
    print("NOTE: Label diagnosis (Section 1) is still valid.")

# ===== SECTION 3: Existing lumen_mask.nii.gz check =====
print()
print("=== EXISTING LUMEN_MASK.NII.GZ CHECK ===")
lumen_path = case_dir / "meshes" / "lumen_mask.nii.gz"
if lumen_path.exists():
    try:
        lumen_existing = nib.load(str(lumen_path)).get_fdata()
        print(f"Existing lumen_mask.nii.gz: {int(np.count_nonzero(lumen_existing)):,} voxels")
    except Exception as e:
        print(f"Could not read existing lumen_mask.nii.gz: {e}")
else:
    print("lumen_mask.nii.gz: NOT FOUND (expected before pipeline runs)")
'''
    return [sys.executable, "-u", "-c", snippet], Path(r"C:\AorticAI")


_ADMIN_READONLY_WHITELIST["diagnose_lumen"] = _cmd_diagnose_lumen


def _cmd_diagnose_segmentation(args: List[str]) -> tuple[List[str], Optional[Path]]:
    """Diagnose segmentation mask for mao_mianqiang_preop case."""
    snippet = '''
import nibabel as nib
import numpy as np
from pathlib import Path

case_dir = Path(r"C:\\AorticAI\\cases\\mao_mianqiang_preop")
seg_path = case_dir / "meshes" / "segmentation.nii.gz"
lumen_path = case_dir / "artifacts" / "lumen_mask.nii.gz"

print("=== Segmentation Diagnosis ===")

if seg_path.exists():
    seg = nib.load(str(seg_path)).get_fdata()
    print(f"segmentation.nii.gz: {seg.shape}, dtype={seg.dtype}")
    unique, counts = np.unique(seg, return_counts=True)
    for v, c in zip(unique, counts):
        if c > 0:
            print(f"  Label {int(v)}: {int(c)} voxels")
    print(f"  Label 1 exists: {bool(np.any(seg == 1))}")
    print(f"  Label 3 exists: {bool(np.any(seg == 3))}")
else:
    print("segmentation.nii.gz: NOT FOUND")

if lumen_path.exists():
    lumen = nib.load(str(lumen_path)).get_fdata()
    print(f"lumen_mask.nii.gz: {lumen.shape}, nonzero={np.count_nonzero(lumen)}")
else:
    print("lumen_mask.nii.gz: NOT FOUND")
'''
    return [sys.executable, "-u", "-c", snippet], _REPO_ROOT


_ADMIN_READONLY_WHITELIST["diagnose_segmentation"] = _cmd_diagnose_segmentation


def _cmd_tail_mao_log(args: List[str]) -> tuple[List[str], Optional[Path]]:
    if len(args) not in {0, 2}:
        raise HTTPException(status_code=400, detail="tail_mao_log_usage:--lines N")
    clean: list[str] = ["tail-log"]
    if args:
        if args[0] != "--lines" or not _CASE_ID_RE.match(args[1]):
            raise HTTPException(status_code=400, detail="tail_mao_log_usage:--lines N")
        clean.extend(["--lines", args[1]])
    return [sys.executable, "-u", "-m", "gpu_provider.admin_mao_tools", *clean], _REPO_ROOT


def _cmd_run_mao_segmentation_only(args: List[str]) -> tuple[List[str], Optional[Path]]:
    if args:
        raise HTTPException(status_code=400, detail="run_mao_segmentation_only_takes_no_args")
    return [sys.executable, "-u", "-m", "gpu_provider.admin_mao_tools", "segmentation-only"], _REPO_ROOT


def _cmd_start_mao_segmentation_only(args: List[str]) -> tuple[List[str], Optional[Path]]:
    if args:
        raise HTTPException(status_code=400, detail="start_mao_segmentation_only_takes_no_args")
    return [sys.executable, "-u", "-m", "gpu_provider.admin_mao_tools", "start-segmentation-only"], _REPO_ROOT


_ADMIN_READONLY_WHITELIST["tail_mao_log"] = _cmd_tail_mao_log
_ADMIN_WHITELIST["run_mao_segmentation_only"] = _cmd_run_mao_segmentation_only
_ADMIN_WHITELIST["start_mao_segmentation_only"] = _cmd_start_mao_segmentation_only


def _cmd_run_mao_pipeline(args: List[str]) -> tuple[List[str], Optional[Path]]:
    """Run mao_mianqiang_preop pipeline with fixed parameters.

    This is a narrow, single-case pipeline runner:
    - Input: C:\\AorticAI\\cases\\mao_mianqiang_preop\\imaging_hidden\\ct_preop.nii.gz
    - Output: meshes/ and artifacts/ in the same case directory
    - Fixed: --device gpu --quality high
    - No arguments accepted

    Features:
    - Outputs STL triangle counts for quality gate verification
    - Automatic rollback on failure (restores from _backup_ directory)
    """
    if args:
        raise HTTPException(status_code=400, detail="run_mao_pipeline_takes_no_args")

    snippet = '''
import sys
import time
import json
import shutil
import os
from pathlib import Path

# Fixed paths for mao_mianqiang_preop
CASE_DIR = Path(r"C:\\AorticAI\\cases\\mao_mianqiang_preop")
INPUT_CT = CASE_DIR / "imaging_hidden" / "ct_preop.nii.gz"
OUTPUT_MASK = CASE_DIR / "meshes" / "segmentation.nii.gz"
OUTPUT_JSON = CASE_DIR / "artifacts" / "pipeline_result.json"
OUTPUT_DIR = CASE_DIR / "meshes"
LOG_FILE = CASE_DIR / "pipeline.log"

DEVICE = os.getenv("AORTICAI_MAO_DEVICE", "gpu")
QUALITY = os.getenv("AORTICAI_MAO_QUALITY", "high")

# Backup existing outputs
BACKUP_DIR = CASE_DIR / "meshes" / ("_backup_" + time.strftime("%Y%m%d_%H%M%S"))
BACKUP_DIR.mkdir(parents=True, exist_ok=True)

backup_files = [
    CASE_DIR / "meshes" / "lumen_mask.nii.gz",
    CASE_DIR / "meshes" / "aortic_root.stl",
    CASE_DIR / "meshes" / "ascending_aorta.stl",
    CASE_DIR / "meshes" / "leaflet_L.stl",
    CASE_DIR / "meshes" / "leaflet_N.stl",
    CASE_DIR / "meshes" / "leaflet_R.stl",
    CASE_DIR / "meshes" / "annulus_ring.stl",
    CASE_DIR / "artifacts" / "pipeline_result.json",
    CASE_DIR / "pipeline.log",
]

for src in backup_files:
    if src.exists():
        dst = BACKUP_DIR / src.name
        shutil.copy2(src, dst)
        print(f"Backed up: {src.name} -> {dst}")

# Verify input exists
if not INPUT_CT.exists():
    raise FileNotFoundError(f"Input CT not found: {INPUT_CT}")

print(f"Input CT: {INPUT_CT} ({INPUT_CT.stat().st_size / (1024*1024):.1f} MB)")
print(f"Output dir: {OUTPUT_DIR}")
print(f"Log file: {LOG_FILE}")
print()

# Build pipeline command
pipeline_py = Path(r"C:\\AorticAI\\gpu_provider\\pipeline_runner.py")
cmd = [
    sys.executable,
    str(pipeline_py),
    "--input", str(INPUT_CT),
    "--output-mask", str(OUTPUT_MASK),
    "--output-json", str(OUTPUT_JSON),
    "--output-dir", str(OUTPUT_DIR),
    "--device", DEVICE,
    "--quality", QUALITY,
    "--job-id", "mao_mianqiang_preop",
    "--study-id", "mao_mianqiang_preop",
]

print("Running pipeline:")
print(" ".join(cmd))
print()

# Track if we started writing outputs (determines if rollback is needed)
outputs_written = False

# Run with output to log file
import subprocess
pipeline_failed = False
try:
    with open(LOG_FILE, "w", encoding="utf-8", errors="replace") as log_f:
        proc = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
            encoding="utf-8",
            errors="replace",
        )
        for line in proc.stdout:
            print(line.rstrip())
            log_f.write(line)
            log_f.flush()
        code = proc.wait()
        log_f.write(f"\\n[PIPELINE EXIT CODE: {code}]\\n")

        # Check if outputs were written (for rollback decision)
        if OUTPUT_DIR.exists():
            for stl_file in OUTPUT_DIR.glob("*.stl"):
                outputs_written = True
                break

        if code != 0:
            pipeline_failed = True
            raise SystemExit(f"Pipeline exited with code {code}")

except SystemExit as e:
    if pipeline_failed or "Pipeline" in str(e):
        print(f"\\nPipeline failed: {e}")
    else:
        raise
except Exception as e:
    pipeline_failed = True
    print(f"\\nPipeline error: {e}")

# Handle failure with rollback
if pipeline_failed or "code" in dir() and code != 0:
    print(f"\\n=== ROLLBACK INITIATED ===")
    print(f"Log written to: {LOG_FILE}")

    # Check if we need to rollback (outputs were written before failure)
    need_rollback = False
    if outputs_written:
        # Check if any output files exist and are potentially corrupted
        for f in [OUTPUT_MASK, OUTPUT_DIR / "lumen_mask.nii.gz"]:
            if f.exists() and f.stat().st_size > 0:
                need_rollback = True
                break

    if need_rollback:
        print("Attempting to restore backup files...")
        restored_count = 0
        failed_count = 0
        for backup_file in BACKUP_DIR.iterdir():
            if backup_file.is_file():
                original = CASE_DIR / "meshes" / backup_file.name if backup_file.name != "pipeline_result.json" else CASE_DIR / "artifacts" / backup_file.name
                if backup_file.name == "pipeline.log":
                    original = CASE_DIR / "pipeline.log"
                try:
                    shutil.copy2(backup_file, original)
                    print(f"Restored: {backup_file.name}")
                    restored_count += 1
                except Exception as restore_err:
                    print(f"Failed to restore {backup_file.name}: {restore_err}")
                    failed_count += 1

        if failed_count == 0 and restored_count > 0:
            print("Rollback status: 已回滚 (all backup files restored)")
        elif restored_count > 0:
            print(f"Rollback status: 部分回滚 ({restored_count} restored, {failed_count} failed)")
        else:
            print("Rollback status: 回滚失败 (no files could be restored)")
    else:
        print("No outputs were written before failure - no rollback needed")

    print(f"Backup directory: {BACKUP_DIR}")
    raise SystemExit(f"Pipeline failed - see {LOG_FILE} for details")

print(f"\\nPipeline completed successfully")
print(f"Result JSON: {OUTPUT_JSON}")
print(f"Log file: {LOG_FILE}")

# Verify outputs
print("\\n=== OUTPUT VERIFICATION ===")
required_files = [
    OUTPUT_MASK,
    OUTPUT_DIR / "lumen_mask.nii.gz",
    OUTPUT_DIR / "aortic_root.stl",
    OUTPUT_DIR / "ascending_aorta.stl",
    OUTPUT_DIR / "leaflet_L.stl",
    OUTPUT_DIR / "leaflet_N.stl",
    OUTPUT_DIR / "leaflet_R.stl",
]

all_ok = True
for f in required_files:
    if f.exists():
        size_kb = f.stat().st_size / 1024
        print(f"OK: {f.name} ({size_kb:.1f} KB)")
    else:
        print(f"MISSING: {f.name}")
        all_ok = False

if not all_ok:
    print("Required output files missing - initiating rollback...")
    # Rollback for missing files
    restored_count = 0
    for backup_file in BACKUP_DIR.iterdir():
        if backup_file.is_file():
            original = CASE_DIR / "meshes" / backup_file.name if backup_file.name != "pipeline_result.json" else CASE_DIR / "artifacts" / backup_file.name
            if backup_file.name == "pipeline.log":
                original = CASE_DIR / "pipeline.log"
            try:
                shutil.copy2(backup_file, original)
                restored_count += 1
            except:
                pass
    if restored_count > 0:
        print("Rollback status: 已回滚")
    else:
        print("Rollback status: 回滚失败")
    raise SystemExit("Required output files missing")

# Verify lumen mask not empty
import nibabel as nib
import numpy as np

lumen_path = OUTPUT_DIR / "lumen_mask.nii.gz"
lumen = nib.load(str(lumen_path)).get_fdata()
lumen_voxels = int(np.count_nonzero(lumen))
print(f"\\nLumen mask voxels: {lumen_voxels:,}")

if lumen_voxels == 0:
    print("ERROR: Lumen mask is empty - initiating rollback...")
    # Quick rollback attempt
    for backup_file in BACKUP_DIR.iterdir():
        if backup_file.is_file():
            original = CASE_DIR / "meshes" / backup_file.name
            try:
                shutil.copy2(backup_file, original)
            except:
                pass
    print("Rollback status: 已回滚")
    raise SystemExit("FAIL: Lumen mask is empty")

# Verify segmentation labels
seg = nib.load(str(OUTPUT_MASK)).get_fdata()
print(f"Label 1 (root): {int((seg==1).sum()):,} voxels")
print(f"Label 3 (ascending): {int((seg==3).sum()):,} voxels")
print(f"Lumen (1+3): {int(np.isin(seg, [1,3]).sum()):,} voxels")

# Check for centerline failure in log
log_content = LOG_FILE.read_text(encoding="utf-8", errors="replace")
if "geometry_centerline_failed" in log_content:
    print("ERROR: Centerline failed - initiating rollback...")
    for backup_file in BACKUP_DIR.iterdir():
        if backup_file.is_file():
            original = CASE_DIR / "meshes" / backup_file.name
            try:
                shutil.copy2(backup_file, original)
            except:
                pass
    print("Rollback status: 已回滚")
    raise SystemExit("FAIL: Centerline computation failed")

# Output STL triangle counts for quality gate verification
print("\\n=== STL TRIANGLE COUNTS ===")
try:
    import trimesh
    stl_files = {
        "aortic_root.stl": OUTPUT_DIR / "aortic_root.stl",
        "ascending_aorta.stl": OUTPUT_DIR / "ascending_aorta.stl",
        "leaflet_L.stl": OUTPUT_DIR / "leaflet_L.stl",
        "leaflet_N.stl": OUTPUT_DIR / "leaflet_N.stl",
        "leaflet_R.stl": OUTPUT_DIR / "leaflet_R.stl",
    }

    for name, path in stl_files.items():
        if path.exists():
            mesh = trimesh.load(str(path))
            tri_count = len(mesh.faces)
            print(f"{name}: {tri_count:,} tris")
        else:
            print(f"{name}: FILE NOT FOUND")
except ImportError:
    print("WARNING: trimesh not available - cannot count triangles")
except Exception as e:
    print(f"WARNING: Error reading STL files: {e}")

print("\\n=== ALL VERIFICATIONS PASSED ===")
'''
    return [sys.executable, "-u", "-c", snippet], Path(r"C:\AorticAI")


_ADMIN_WHITELIST["run_mao_pipeline"] = _cmd_run_mao_pipeline


def _cmd_run_mao_pipeline_guarded(args: List[str]) -> tuple[List[str], Optional[Path]]:
    if args:
        raise HTTPException(status_code=400, detail="run_mao_pipeline_takes_no_args")
    return [sys.executable, "-u", "-m", "gpu_provider.admin_mao_tools", "run-pipeline"], _REPO_ROOT


def _cmd_start_mao_pipeline(args: List[str]) -> tuple[List[str], Optional[Path]]:
    if args:
        raise HTTPException(status_code=400, detail="start_mao_pipeline_takes_no_args")
    return [sys.executable, "-u", "-m", "gpu_provider.admin_mao_tools", "start-pipeline"], _REPO_ROOT


def _cmd_run_mao_pears_visual(args: List[str]) -> tuple[List[str], Optional[Path]]:
    if args:
        raise HTTPException(status_code=400, detail="run_mao_pears_visual_takes_no_args")
    return [sys.executable, "-u", "-m", "gpu_provider.admin_mao_tools", "build-pears-visual"], _REPO_ROOT


_ADMIN_WHITELIST["run_mao_pipeline"] = _cmd_run_mao_pipeline_guarded
_ADMIN_WHITELIST["start_mao_pipeline"] = _cmd_start_mao_pipeline
_ADMIN_WHITELIST["run_mao_pears_visual"] = _cmd_run_mao_pears_visual


def _cmd_git_reset(args: List[str]) -> tuple[List[str], Optional[Path]]:
    """Reset local git changes and pull latest on Windows.

    Usage: Call this when git pull fails due to local modifications.
    Discards local changes in gpu_provider/ directory and pulls upstream.
    """
    if args:
        raise HTTPException(status_code=400, detail="git_reset_takes_no_args")

    snippet = '''
import subprocess
import sys
from pathlib import Path

repo_root = Path(r"C:\\AorticAI")
print(f"Working directory: {repo_root}")

# Check current status
print("\\n=== Git Status ===")
subprocess.run(["git", "status", "--short"], cwd=repo_root)

# Discard local changes in gpu_provider/
print("\\n=== Discarding local changes in gpu_provider/ ===")
files_to_reset = [
    "gpu_provider/app.py",
    "gpu_provider/pipeline_runner.py",
    "gpu_provider/build_real_multiclass_mask.py",
    "gpu_provider/process_mao_from_r2.py",
]
for f in files_to_reset:
    full_path = repo_root / f
    if full_path.exists():
        result = subprocess.run(["git", "checkout", "--", f], cwd=repo_root, capture_output=True, text=True)
        if result.returncode == 0:
            print(f"Reset: {f}")
        else:
            print(f"Failed to reset {f}: {result.stderr}")

# Pull latest
print("\\n=== Git Pull ===")
result = subprocess.run(["git", "pull", "--ff-only"], cwd=repo_root, capture_output=True, text=True)
print(result.stdout)
if result.stderr:
    print(result.stderr)

if result.returncode != 0:
    raise SystemExit(result.returncode)

# Verify new commit
print("\\n=== Git Log ===")
subprocess.run(["git", "log", "-1", "--oneline"], cwd=repo_root)
'''
    return [sys.executable, "-u", "-c", snippet], Path(r"C:\AorticAI")


_ADMIN_WHITELIST["git_reset"] = _cmd_git_reset
