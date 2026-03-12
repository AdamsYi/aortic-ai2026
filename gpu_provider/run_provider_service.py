from __future__ import annotations

import argparse
import os
import signal
import subprocess
import sys
import time
from pathlib import Path

from auto_update import check_for_updates, reset_to_origin_main


BASE_DIR = Path(__file__).resolve().parent
SERVICE_PID_FILE = BASE_DIR / "provider_service.pid"
UVICORN_PID_FILE = BASE_DIR / "provider_uvicorn.pid"


def write_pid(path: Path, pid: int) -> None:
    path.write_text(str(pid), encoding="utf-8")


def remove_pid(path: Path) -> None:
    try:
        path.unlink(missing_ok=True)
    except Exception:
        pass


def build_env(model_device: str, quality: str, response_mode: str) -> dict[str, str]:
    env = os.environ.copy()
    env["MODEL_DEVICE"] = model_device
    env["PIPELINE_QUALITY"] = quality
    env["PROVIDER_RESPONSE_MODE"] = response_mode
    env["PYTHONUNBUFFERED"] = "1"
    return env


def start_provider(host: str, port: int, env: dict[str, str]) -> subprocess.Popen[str]:
    cmd = [
        sys.executable,
        "-m",
        "uvicorn",
        "app:app",
        "--host",
        host,
        "--port",
        str(port),
    ]
    proc = subprocess.Popen(
        cmd,
        cwd=str(BASE_DIR),
        env=env,
    )
    write_pid(UVICORN_PID_FILE, proc.pid)
    return proc


def stop_provider(proc: subprocess.Popen[str] | None, timeout: float = 15.0) -> None:
    if proc is None:
        remove_pid(UVICORN_PID_FILE)
        return
    if proc.poll() is not None:
        remove_pid(UVICORN_PID_FILE)
        return
    try:
        proc.terminate()
        proc.wait(timeout=timeout)
    except Exception:
        try:
            proc.kill()
            proc.wait(timeout=5.0)
        except Exception:
            pass
    remove_pid(UVICORN_PID_FILE)


def restart_self(argv: list[str]) -> None:
    os.execv(sys.executable, [sys.executable, str(Path(__file__).resolve())] + argv)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--model-device", default=os.getenv("MODEL_DEVICE", "gpu"))
    parser.add_argument("--quality", default=os.getenv("PIPELINE_QUALITY", "high"))
    parser.add_argument("--response-mode", default=os.getenv("PROVIDER_RESPONSE_MODE", "callback"))
    parser.add_argument("--update-interval-seconds", type=int, default=600)
    args = parser.parse_args()

    write_pid(SERVICE_PID_FILE, os.getpid())
    service_argv = sys.argv[1:]
    provider = None
    try:
        env = build_env(args.model_device, args.quality, args.response_mode)
        provider = start_provider(args.host, args.port, env)
        last_check = 0.0
        while True:
            time.sleep(2.0)
            if provider.poll() is not None:
                provider = start_provider(args.host, args.port, env)
            now = time.time()
            if now - last_check < max(60, int(args.update_interval_seconds)):
                continue
            last_check = now
            update_state = check_for_updates()
            if not bool(update_state.get("update_available")):
                continue
            stop_provider(provider)
            reset_to_origin_main(sync_deps=True, python_executable=sys.executable)
            restart_self(service_argv)
    except KeyboardInterrupt:
        pass
    finally:
        stop_provider(provider)
        remove_pid(SERVICE_PID_FILE)


if __name__ == "__main__":
    if os.name == "nt":
        signal.signal(signal.SIGTERM, lambda *_args: sys.exit(0))
    main()
