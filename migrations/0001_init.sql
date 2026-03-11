PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS studies (
  id TEXT PRIMARY KEY,
  patient_code TEXT,
  source_dataset TEXT,
  image_key TEXT NOT NULL,
  image_format TEXT NOT NULL DEFAULT 'nifti',
  modality TEXT NOT NULL DEFAULT 'CTA',
  phase TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  study_id TEXT NOT NULL,
  job_type TEXT NOT NULL DEFAULT 'segmentation_v1',
  status TEXT NOT NULL CHECK (status IN ('queued','running','succeeded','failed')),
  model_tag TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  started_at TEXT,
  finished_at TEXT,
  FOREIGN KEY (study_id) REFERENCES studies(id)
);

CREATE INDEX IF NOT EXISTS idx_jobs_study_id ON jobs(study_id);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);

CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  artifact_type TEXT NOT NULL,
  bucket TEXT NOT NULL,
  object_key TEXT NOT NULL,
  sha256 TEXT,
  bytes INTEGER,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (job_id) REFERENCES jobs(id)
);

CREATE INDEX IF NOT EXISTS idx_artifacts_job_id ON artifacts(job_id);

CREATE TABLE IF NOT EXISTS metrics (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  metric_name TEXT NOT NULL,
  metric_value REAL NOT NULL,
  unit TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (job_id) REFERENCES jobs(id)
);

CREATE INDEX IF NOT EXISTS idx_metrics_job_id ON metrics(job_id);
CREATE INDEX IF NOT EXISTS idx_metrics_name ON metrics(metric_name);

CREATE TABLE IF NOT EXISTS upload_sessions (
  id TEXT PRIMARY KEY,
  study_id TEXT NOT NULL,
  object_key TEXT NOT NULL,
  upload_token_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (study_id) REFERENCES studies(id)
);

CREATE INDEX IF NOT EXISTS idx_upload_sessions_study_id ON upload_sessions(study_id);
CREATE INDEX IF NOT EXISTS idx_upload_sessions_expires_at ON upload_sessions(expires_at);
