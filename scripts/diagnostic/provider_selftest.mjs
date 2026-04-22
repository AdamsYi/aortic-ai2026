import fs from "fs";
import path from "path";
import process from "process";
import { execFileSync } from "child_process";

const LOCAL_ROOT =
  process.env.AORTICAI_LOCAL_WORK_ROOT ||
  (process.platform === "darwin" ? "/tmp/aorticai" : path.resolve("runs"));

const PROVIDER_URL = process.argv[2] || "https://gpu-api.8686668.xyz/infer";
const INPUT_PATH =
  process.argv[3] || path.resolve("data/CTACardio_root_roi.nii.gz");
const OUT_DIR =
  process.argv[4] || path.resolve(path.join(LOCAL_ROOT, `provider-selftest-${Date.now()}`));

if (process.platform === "darwin" && process.env.AORTICAI_ALLOW_LOCAL_ARTIFACTS !== "1") {
  throw new Error(
    "Refusing local provider selftest artifacts on Mac control plane. Run on the Windows GPU node or set AORTICAI_ALLOW_LOCAL_ARTIFACTS=1 to override.",
  );
}

const REQUIRED_ARTIFACTS = [
  "segmentation_mask_nifti",
  "centerline_json",
  "annulus_plane_json",
  "measurements_json",
  "aortic_root_stl",
  "planning_report_pdf",
];

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function fail(msg) {
  throw new Error(msg);
}

function reasonableSize(bytes, artifactType) {
  if (!Number.isFinite(bytes) || bytes <= 0) return false;
  if (artifactType.endsWith("_json")) return bytes >= 50;
  if (artifactType === "aortic_root_stl") return bytes >= 20;
  if (artifactType === "planning_report_pdf") return bytes >= 50;
  if (artifactType === "segmentation_mask_nifti") return bytes >= 100;
  return bytes > 0;
}

function parseJsonSafe(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function measurementSnapshot(measurementsJson) {
  const m = measurementsJson?.measurements || {};
  const calcium = m?.valve_calcium_burden || {};
  return {
    annulus_diameter_mm: m.annulus_diameter_mm ?? null,
    annulus_area_mm2: m.annulus_area_mm2 ?? null,
    annulus_perimeter_mm: m.annulus_perimeter_mm ?? null,
    sinus_of_valsalva_diameter_mm:
      m.sinus_of_valsalva_diameter_mm ?? m.sinus_diameter_mm ?? null,
    stj_diameter_mm: m.stj_diameter_mm ?? null,
    ascending_aorta_diameter_mm: m.ascending_aorta_diameter_mm ?? null,
    lvot_diameter_mm: m.lvot_diameter_mm ?? null,
    coronary_height_left_mm: m.coronary_height_left_mm ?? null,
    coronary_height_right_mm: m.coronary_height_right_mm ?? null,
    calc_volume_ml: calcium.calc_volume_ml ?? null,
    calc_threshold_hu: calcium.threshold_hu ?? null,
  };
}

async function main() {
  ensureDir(OUT_DIR);

  const inputBytes = fs.readFileSync(INPUT_PATH);
  const reqBody = {
    job_id: `provider-selftest-${Date.now()}`,
    study_id: `provider-selftest-${Date.now()}`,
    image_key: path.basename(INPUT_PATH),
    input_content_type: "application/gzip",
    input_base64: inputBytes.toString("base64"),
    callback: {},
  };

  const reqPath = path.join(OUT_DIR, "provider_request.json");
  fs.writeFileSync(reqPath, JSON.stringify(reqBody));

  const t0 = Date.now();
  let text = "";
  try {
    text = execFileSync(
      "curl",
      [
        "-sS",
        "-X",
        "POST",
        PROVIDER_URL,
        "-H",
        "content-type: application/json",
        "--data-binary",
        `@${reqPath}`,
      ],
      { encoding: "utf8", maxBuffer: 1024 * 1024 * 200 },
    );
  } catch (err) {
    fail(`provider_request_failed:${String(err?.stderr || err?.message || err)}`);
  }
  fs.writeFileSync(path.join(OUT_DIR, "provider_response.json"), text);

  const payload = JSON.parse(text);
  if (payload.status !== "succeeded") {
    fail(`provider_status_${payload.status || "unknown"}`);
  }

  const totalWallSeconds = Number(((Date.now() - t0) / 1000).toFixed(3));
  const metrics = Array.isArray(payload.metrics) ? payload.metrics : [];
  const resultJson = payload.result_json || {};
  fs.writeFileSync(
    path.join(OUT_DIR, "result.json"),
    JSON.stringify(resultJson, null, 2),
  );

  const produced = new Map();

  if (payload.mask_base64) {
    const maskBytes = Buffer.from(payload.mask_base64, "base64");
    const maskName = payload.mask_filename || "segmentation_mask.nii.gz";
    const maskPath = path.join(OUT_DIR, maskName);
    fs.writeFileSync(maskPath, maskBytes);
    produced.set("segmentation_mask_nifti", {
      file: maskName,
      bytes: maskBytes.byteLength,
      path: maskPath,
    });
  }

  const artifacts = Array.isArray(payload.artifacts) ? payload.artifacts : [];
  for (const artifact of artifacts) {
    if (!artifact?.artifact_type || !artifact?.base64) continue;
    const bytes = Buffer.from(artifact.base64, "base64");
    const filename = artifact.filename || `${artifact.artifact_type}.bin`;
    const filePath = path.join(OUT_DIR, filename);
    fs.writeFileSync(filePath, bytes);
    produced.set(String(artifact.artifact_type), {
      file: filename,
      bytes: bytes.byteLength,
      path: filePath,
    });
  }

  const missing = REQUIRED_ARTIFACTS.filter((x) => !produced.has(x));
  if (missing.length) {
    fail(`missing_artifacts:${missing.join(",")}`);
  }

  for (const [artifactType, meta] of produced.entries()) {
    if (!reasonableSize(meta.bytes, artifactType)) {
      fail(`artifact_too_small:${artifactType}:${meta.bytes}`);
    }
  }

  const measurementsMeta = produced.get("measurements_json");
  const centerlineMeta = produced.get("centerline_json");
  const annulusMeta = produced.get("annulus_plane_json");
  const measurementsJson = parseJsonSafe(
    fs.readFileSync(measurementsMeta.path, "utf8"),
  );
  const centerlineJson = parseJsonSafe(
    fs.readFileSync(centerlineMeta.path, "utf8"),
  );
  const annulusJson = parseJsonSafe(
    fs.readFileSync(annulusMeta.path, "utf8"),
  );

  const snapshot = measurementSnapshot(measurementsJson);
  const hasAnyMeasurement = Object.values(snapshot).some(
    (v) => typeof v === "number" && Number.isFinite(v),
  );
  if (!hasAnyMeasurement) {
    fail("measurements_json_has_no_numeric_values");
  }

  if (!Array.isArray(centerlineJson?.points) || centerlineJson.points.length < 2) {
    fail("centerline_json_invalid");
  }
  if (
    !annulusJson ||
    !Array.isArray(annulusJson.origin_voxel) ||
    annulusJson.origin_voxel.length < 3
  ) {
    fail("annulus_plane_json_invalid");
  }

  const summary = {
    ok: true,
    provider_url: PROVIDER_URL,
    input_path: INPUT_PATH,
    out_dir: OUT_DIR,
    total_wall_seconds: totalWallSeconds,
    provider_metrics: metrics,
    runtime: resultJson.runtime || {},
    pipeline: resultJson.pipeline || {},
    centerline_method:
      resultJson.pipeline?.centerline || resultJson.centerline?.method || null,
    produced_artifacts: Object.fromEntries(produced.entries()),
    measurement_snapshot: snapshot,
  };

  fs.writeFileSync(
    path.join(OUT_DIR, "selftest_summary.json"),
    JSON.stringify(summary, null, 2),
  );
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((err) => {
  console.error(String(err?.stack || err));
  process.exit(1);
});
