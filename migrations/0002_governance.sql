PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS study_repository (
  study_id TEXT PRIMARY KEY,
  raw_filename TEXT,
  image_bytes INTEGER,
  image_sha256 TEXT,
  ingestion_format TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (study_id) REFERENCES studies(id)
);

CREATE INDEX IF NOT EXISTS idx_study_repository_updated_at ON study_repository(updated_at);

CREATE TABLE IF NOT EXISTS pipeline_runs (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL UNIQUE,
  study_id TEXT NOT NULL,
  provider_job_id TEXT,
  source_mode TEXT,
  pipeline_version TEXT,
  build_version TEXT,
  computational_model TEXT,
  centerline_method TEXT,
  measurement_method TEXT,
  input_kind TEXT,
  reported_phase TEXT,
  selected_phase TEXT,
  runtime_seconds REAL,
  stage_timings_json TEXT,
  run_summary_json TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (job_id) REFERENCES jobs(id),
  FOREIGN KEY (study_id) REFERENCES studies(id)
);

CREATE INDEX IF NOT EXISTS idx_pipeline_runs_study_id ON pipeline_runs(study_id);
CREATE INDEX IF NOT EXISTS idx_pipeline_runs_updated_at ON pipeline_runs(updated_at);

CREATE TABLE IF NOT EXISTS artifact_access_audit (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  study_id TEXT,
  job_id TEXT,
  artifact_type TEXT,
  access_mode TEXT NOT NULL,
  client_ip TEXT,
  user_agent TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (study_id) REFERENCES studies(id),
  FOREIGN KEY (job_id) REFERENCES jobs(id)
);

CREATE INDEX IF NOT EXISTS idx_artifact_access_audit_job_id ON artifact_access_audit(job_id);
CREATE INDEX IF NOT EXISTS idx_artifact_access_audit_study_id ON artifact_access_audit(study_id);
CREATE INDEX IF NOT EXISTS idx_artifact_access_audit_created_at ON artifact_access_audit(created_at);
