PRAGMA foreign_keys = ON;

ALTER TABLE jobs ADD COLUMN patient_id TEXT;
ALTER TABLE jobs ADD COLUMN r2_key TEXT;
ALTER TABLE jobs ADD COLUMN progress INTEGER NOT NULL DEFAULT 0;
ALTER TABLE jobs ADD COLUMN result_case_id TEXT;
ALTER TABLE jobs ADD COLUMN stage TEXT;
ALTER TABLE jobs ADD COLUMN updated_at TEXT;

UPDATE jobs
SET updated_at = COALESCE(updated_at, created_at),
    progress = CASE
      WHEN status = 'queued' THEN 0
      WHEN status = 'running' THEN 45
      WHEN status = 'succeeded' THEN 100
      WHEN status = 'failed' THEN 100
      ELSE 0
    END;

CREATE INDEX IF NOT EXISTS idx_jobs_updated_at ON jobs(updated_at);
