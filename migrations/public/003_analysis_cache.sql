CREATE TABLE analysis_cache(
 source TEXT NOT NULL,canonical_url TEXT NOT NULL,fingerprint TEXT NOT NULL,
 result TEXT NOT NULL,event_id TEXT NOT NULL REFERENCES events(id),
 PRIMARY KEY(source,canonical_url,fingerprint)
);
ALTER TABLE events ADD COLUMN normalization_version INTEGER NOT NULL DEFAULT 0;
CREATE TABLE event_redirects(old_id TEXT PRIMARY KEY,event_id TEXT NOT NULL REFERENCES events(id));
PRAGMA user_version=3;
