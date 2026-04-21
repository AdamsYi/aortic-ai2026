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
        raise HTTPException(status_code=400, detail=f"arg_not_whitelisted:{tok}")
    return allowed


def _cmd_status(_args: List[str]) -> tuple[List[str], Optional[Path]]:
    snippet = (
        "import platform,sys,subprocess,shutil;"
        "print('python=',sys.version.split()[0]);"
        "print('platform=',platform.platform());"
        "print('gpu=',bool(shutil.which('nvidia-smi')));"
        "print('dcm2niix=',bool(shutil.which('dcm2niix')));"
        "r=subprocess.run(['git','log','-1','--oneline'],capture_output=True,text=True);"
        "print('git=',r.stdout.strip())"
    )
    return [sys.executable, "-c", snippet], _REPO_ROOT


def _cmd_git_pull(_args: List[str]) -> tuple[List[str], Optional[Path]]:
    return ["git", "pull", "--ff-only"], _REPO_ROOT


def _cmd_ingest(args: List[str]) -> tuple[List[str], Optional[Path]]:
    clean = _validate_ingest_args(args)
    argv = [sys.executable, "-u", str(_GPU_DIR / "fetch_imagecas.py"), *clean]
    return argv, _GPU_DIR


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
                f"ingest/imagecas-{numeric_id}",
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
        "import subprocess, sys\n"
        "case_dir = sys.argv[1]\n"
        "branch = sys.argv[2]\n"
        "message = sys.argv[3]\n"
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


_ADMIN_WHITELIST = {
    "status": _cmd_status,
    "git_pull": _cmd_git_pull,
    "pip_sync": _cmd_pip_sync,
    "ingest_imagecas": _cmd_ingest,
    "ingest_zenodo": _cmd_ingest_zenodo,
    "zenodo_inspect": _cmd_zenodo_inspect,
    "tcia_probe": _cmd_tcia_probe,
    "imagecas_probe": _cmd_imagecas_probe,
    "imagecas_extract_first_split": _cmd_imagecas_extract_first_split,
    "install_7zip": _cmd_install_7zip,
    "commit_case": _cmd_commit_case,
}


class AdminRunRequest(BaseModel):
    command: str
    args: List[str] = Field(default_factory=list)


def _stream_process(argv: List[str], cwd: Optional[Path]):
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
        _ADMIN_LOCK.release()


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
    if resolver is None:
        raise HTTPException(
            status_code=400,
            detail=f"command_not_whitelisted:{payload.command}",
        )
    argv, cwd = resolver(payload.args)

    if not _ADMIN_LOCK.acquire(blocking=False):
        raise HTTPException(status_code=409, detail="another_admin_command_in_progress")

    return StreamingResponse(
        _stream_process(argv, cwd),
        media_type="text/plain; charset=utf-8",
    )
