ALTER TABLE events ADD COLUMN completion_at TEXT;
CREATE TABLE collector_runs(id INTEGER PRIMARY KEY,started_at TEXT NOT NULL,finished_at TEXT,status TEXT NOT NULL,error TEXT);
CREATE TABLE source_runs(run_id INTEGER NOT NULL REFERENCES collector_runs(id),source TEXT NOT NULL,records INTEGER NOT NULL DEFAULT 0,status TEXT NOT NULL,PRIMARY KEY(run_id,source));
-- Old collector releases incorrectly used registration deadline as event completion.
UPDATE events SET data=json_set(data,'$.status','active') WHERE json_extract(data,'$.status')='ended';
PRAGMA user_version=2;
