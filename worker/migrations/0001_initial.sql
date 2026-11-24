CREATE TABLE IF NOT EXISTS events (
 id TEXT PRIMARY KEY,title TEXT NOT NULL,url TEXT,source TEXT,description TEXT,category TEXT,tags_json TEXT NOT NULL DEFAULT '[]',start TEXT,deadline TEXT,prize TEXT,format TEXT,restrictions TEXT,ai_policy TEXT,registration_url TEXT,country TEXT,age_min INTEGER,age_max INTEGER,free INTEGER,prize_amount REAL,prize_currency TEXT,difficulty TEXT,registration_open INTEGER,score REAL,status TEXT,created_at TEXT,updated_at TEXT
);
CREATE INDEX events_status_deadline ON events(status,deadline);
CREATE INDEX events_category ON events(category);
CREATE VIRTUAL TABLE events_fts USING fts5(id UNINDEXED,title,description,tags);
CREATE TRIGGER events_ai AFTER INSERT ON events BEGIN INSERT INTO events_fts(id,title,description,tags) VALUES(new.id,new.title,new.description,new.tags_json); END;
CREATE TRIGGER events_ad AFTER DELETE ON events BEGIN DELETE FROM events_fts WHERE id=old.id; END;
CREATE TRIGGER events_au AFTER UPDATE ON events BEGIN DELETE FROM events_fts WHERE id=old.id; INSERT INTO events_fts(id,title,description,tags) VALUES(new.id,new.title,new.description,new.tags_json); END;
CREATE TABLE users(telegram_id TEXT PRIMARY KEY,settings_json TEXT NOT NULL DEFAULT '{"enabled":false,"time":"09:00","timezone":"Europe/Moscow","min_score":0,"filter_ids":[],"urgent":false}',created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
CREATE TABLE favorites(user_id TEXT NOT NULL REFERENCES users(telegram_id),event_id TEXT NOT NULL,PRIMARY KEY(user_id,event_id));
CREATE TABLE saved_filters(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(telegram_id),name TEXT NOT NULL,query_json TEXT NOT NULL);
CREATE INDEX saved_filters_user ON saved_filters(user_id);
CREATE TABLE digest_deliveries(user_id TEXT NOT NULL,local_date TEXT NOT NULL,status TEXT NOT NULL,sent_at TEXT,PRIMARY KEY(user_id,local_date));
CREATE TABLE sync_state(id INTEGER PRIMARY KEY CHECK(id=1),last_sync TEXT,last_error TEXT);
CREATE TABLE request_limits(user_id TEXT PRIMARY KEY,bucket INTEGER NOT NULL,n INTEGER NOT NULL);
CREATE TABLE webhook_updates(id INTEGER PRIMARY KEY,created_at INTEGER NOT NULL);
