PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS case_results (
  case_id TEXT PRIMARY KEY,
  job_id TEXT,
  measurements_json TEXT,
  planning_json TEXT,
  created_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_case_results_created_at ON case_results(created_at DESC);
