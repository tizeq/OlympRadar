CREATE TABLE IF NOT EXISTS events (
 id TEXT PRIMARY KEY, data TEXT NOT NULL, input_hash TEXT NOT NULL,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS aliases (
 alias TEXT PRIMARY KEY, event_id TEXT NOT NULL REFERENCES events(id)
);
CREATE TABLE IF NOT EXISTS history (
 id INTEGER PRIMARY KEY, event_id TEXT NOT NULL REFERENCES events(id),
 changed_at TEXT NOT NULL, data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS history_event ON history(event_id, changed_at);
CREATE TABLE IF NOT EXISTS legacy_hashes (hash TEXT PRIMARY KEY);
CREATE VIRTUAL TABLE IF NOT EXISTS events_fts USING fts5(id UNINDEXED, title, description, tags);
PRAGMA user_version = 1;
