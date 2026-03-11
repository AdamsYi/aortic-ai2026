"""
Zero-dollar demo for Colab:
- download open-source CT sample
- submit to Cloudflare Worker
- poll until finished

Usage in Colab:
  !python zero_dollar_demo.py
"""

from __future__ import annotations

import json
import time
from pathlib import Path

import requests


BASE_URL = "https://aortic-ai-api.we085197.workers.dev"
DATA_URL = "https://raw.githubusercontent.com/wasserth/TotalSegmentator/master/tests/reference_files/example_ct.nii.gz"


def main() -> None:
    ts = int(time.time())
    study_id = f"colab-openct-{ts}"
    out_dir = Path("run_outputs") / study_id
    out_dir.mkdir(parents=True, exist_ok=True)

    input_path = out_dir / f"{study_id}.nii.gz"
    print("[1/5] Downloading open-source CT sample...")
    with requests.get(DATA_URL, timeout=60, stream=True) as r:
        r.raise_for_status()
        with input_path.open("wb") as f:
            for chunk in r.iter_content(chunk_size=1024 * 1024):
                if chunk:
                    f.write(chunk)

    print(f"Downloaded: {input_path} ({input_path.stat().st_size} bytes)")

    print("[2/5] Creating upload session...")
    upload_resp = requests.post(
        f"{BASE_URL}/upload-url",
        headers={"content-type": "application/json"},
        json={
            "study_id": study_id,
            "filename": input_path.name,
            "source_dataset": "TotalSegmentator-tests",
            "patient_code": f"anon-{study_id}",
            "image_format": "nifti",
            "phase": "unknown",
        },
        timeout=30,
    )
    upload_resp.raise_for_status()
    upload_json = upload_resp.json()
    (out_dir / "upload_response.json").write_text(json.dumps(upload_json, indent=2), encoding="utf-8")

    upload_url = upload_json["upload_url"]

    print("[3/5] Uploading file...")
    with input_path.open("rb") as f:
        put_resp = requests.put(
            f"{BASE_URL}{upload_url}",
            headers={"content-type": "application/octet-stream"},
            data=f,
            timeout=120,
        )
    put_resp.raise_for_status()
    (out_dir / "upload_done.json").write_text(json.dumps(put_resp.json(), indent=2), encoding="utf-8")

    print("[4/5] Creating job...")
    job_resp = requests.post(
        f"{BASE_URL}/jobs",
        headers={"content-type": "application/json"},
        json={"study_id": study_id, "job_type": "segmentation_v1", "model_tag": "colab-openct-demo"},
        timeout=30,
    )
    job_resp.raise_for_status()
    job_json = job_resp.json()
    (out_dir / "job_create_response.json").write_text(json.dumps(job_json, indent=2), encoding="utf-8")

    job_id = job_json["job_id"]
    print(f"Job created: {job_id}")

    print("[5/5] Polling job...")
    final = None
    for i in range(1, 50):
        resp = requests.get(f"{BASE_URL}/jobs/{job_id}", timeout=30)
        resp.raise_for_status()
        body = resp.json()
        status = body.get("status", "")
        print(f"  [{i:02d}] status={status}")
        (out_dir / "job_status_latest.json").write_text(json.dumps(body, indent=2), encoding="utf-8")
        if status in ("succeeded", "failed"):
            final = body
            break
        time.sleep(3)

    if final is None:
        raise RuntimeError(f"Timed out waiting for job {job_id}")

    (out_dir / "job_result.json").write_text(json.dumps(final, indent=2), encoding="utf-8")
    print("Done")
    print(f"study_id={study_id}")
    print(f"job_id={job_id}")
    print(f"status={final.get('status')}")
    print(f"result_file={out_dir / 'job_result.json'}")


if __name__ == "__main__":
    main()
