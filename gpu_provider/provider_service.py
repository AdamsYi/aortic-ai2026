from __future__ import annotations

import argparse
import json
import os
import signal
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

from auto_update import check_for_updates, reset_to_origin_main


BASE_DIR = Path(__file__).resolve().parent
SERVICE_PID_FILE = BASE_DIR / "provider_service.pid"
UVICORN_PID_FILE = BASE_DIR / "provider_uvicorn.pid"


def log(message: str) -> None:
    ts = time.strftime("%Y-%m-%d %H:%M:%S")
    print(f"[provider-service] {ts} {message}", flush=True)


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
    proc = subprocess.Popen(cmd, cwd=str(BASE_DIR), env=env)
    write_pid(UVICORN_PID_FILE, proc.pid)
    log(f"provider started pid={proc.pid} host={host} port={port}")
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
        log(f"provider stopped pid={proc.pid}")
    except Exception:
        try:
            proc.kill()
            proc.wait(timeout=5.0)
            log(f"provider killed pid={proc.pid}")
        except Exception:
            pass
    remove_pid(UVICORN_PID_FILE)


def health_check(url: str, timeout_seconds: float = 3.0) -> tuple[bool, dict[str, object]]:
    try:
        req = urllib.request.Request(url, headers={"cache-control": "no-store"})
        with urllib.request.urlopen(req, timeout=timeout_seconds) as resp:
            payload = json.loads(resp.read().decode("utf-8"))
        return bool(payload.get("ok")), payload if isinstance(payload, dict) else {}
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError, ValueError):
        return False, {}


def restart_self() -> None:
    os.execv(sys.executable, [sys.executable, str(Path(__file__).resolve())] + sys.argv[1:])


def ensure_repo_layout() -> None:
    required = [
        BASE_DIR / "app.py",
        BASE_DIR / "requirements.txt",
        BASE_DIR / "pipeline_runner.py",
    ]
    missing = [str(p.name) for p in required if not p.exists()]
    if missing:
        raise RuntimeError(f"provider_repo_layout_invalid:{','.join(missing)}")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--model-device", default=os.getenv("MODEL_DEVICE", "gpu"))
    parser.add_argument("--quality", default=os.getenv("PIPELINE_QUALITY", "high"))
    parser.add_argument("--response-mode", default=os.getenv("PROVIDER_RESPONSE_MODE", "callback"))
    parser.add_argument("--update-interval-seconds", type=int, default=120)
    parser.add_argument("--health-fail-threshold", type=int, default=3)
    args = parser.parse_args()

    ensure_repo_layout()
    write_pid(SERVICE_PID_FILE, os.getpid())
    log(f"service boot pid={os.getpid()} response_mode={args.response_mode} quality={args.quality}")

    provider: subprocess.Popen[str] | None = None
    env = build_env(args.model_device, args.quality, args.response_mode)
    last_update_check = 0.0
    failed_health_checks = 0
    health_url = f"http://{args.host}:{args.port}/health"

    try:
        provider = start_provider(args.host, args.port, env)
        while True:
            time.sleep(2.0)

            if provider.poll() is not None:
                log("provider process exited unexpectedly; restarting")
                provider = start_provider(args.host, args.port, env)
                failed_health_checks = 0
                continue

            healthy, payload = health_check(health_url)
            if healthy:
                failed_health_checks = 0
            else:
                failed_health_checks += 1
                log(f"health check failed count={failed_health_checks}")
                if failed_health_checks >= max(1, int(args.health_fail_threshold)):
                    log("health check threshold exceeded; restarting provider")
                    stop_provider(provider)
                    provider = start_provider(args.host, args.port, env)
                    failed_health_checks = 0
                    continue

            now = time.time()
            if now - last_update_check < max(60, int(args.update_interval_seconds)):
                continue
            last_update_check = now
            update_state = check_for_updates()
            if not bool(update_state.get("update_available")):
                continue

            log(
                "new commit detected "
                f"{update_state.get('local_head', '')[:7]} -> {update_state.get('remote_head', '')[:7]}"
            )
            stop_provider(provider)
            reset_to_origin_main(sync_deps=True, python_executable=sys.executable)
            restart_self()
    except KeyboardInterrupt:
        log("service interrupted")
    finally:
        stop_provider(provider)
        remove_pid(SERVICE_PID_FILE)


if __name__ == "__main__":
    if os.name == "nt":
        signal.signal(signal.SIGTERM, lambda *_args: sys.exit(0))
    main()
