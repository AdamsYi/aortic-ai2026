CREATE TABLE IF NOT EXISTS manual_annotations (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL,
  annotator TEXT NOT NULL,
  annotation_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_manual_annotations_case_created
ON manual_annotations(case_id, created_at DESC);
