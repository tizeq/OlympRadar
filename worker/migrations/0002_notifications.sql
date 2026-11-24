ALTER TABLE users ADD COLUMN notification_since TEXT;
UPDATE users SET notification_since=updated_at;
ALTER TABLE saved_filters ADD COLUMN created_at TEXT;
UPDATE saved_filters SET created_at=strftime('%Y-%m-%dT%H:%M:%fZ','now');
CREATE TRIGGER saved_filters_created AFTER INSERT ON saved_filters WHEN new.created_at IS NULL BEGIN
 UPDATE saved_filters SET created_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=new.id;
END;
CREATE TRIGGER users_notification_enable AFTER UPDATE OF settings_json ON users
WHEN coalesce(json_extract(old.settings_json,'$.enabled'),0)=0 AND json_extract(new.settings_json,'$.enabled')=1 BEGIN
 UPDATE users SET notification_since=new.updated_at WHERE telegram_id=new.telegram_id;
END;
ALTER TABLE digest_deliveries ADD COLUMN cutoff TEXT;
CREATE TABLE urgent_deliveries(user_id TEXT NOT NULL,event_id TEXT NOT NULL,deadline TEXT NOT NULL,reserved_at TEXT NOT NULL,PRIMARY KEY(user_id,event_id,deadline));
CREATE TABLE notification_cursor(id INTEGER PRIMARY KEY CHECK(id=1),after_user TEXT NOT NULL DEFAULT '');
INSERT INTO notification_cursor(id,after_user) VALUES(1,'');
CREATE INDEX events_created ON events(created_at);
