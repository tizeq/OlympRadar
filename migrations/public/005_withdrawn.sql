BEGIN;
-- Two rows published by earlier adapters were a site resource index and a test classroom.
UPDATE events SET data=json_set(data,'$.status','withdrawn','$.updated_at',strftime('%Y-%m-%dT%H:%M:%fZ','now')),
                  updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
WHERE rtrim(json_extract(data,'$.url'),'/') IN
 ('https://ctfnews.ru/news/tools','https://www.aicrowd.com/challenges/test-p');
INSERT INTO history(event_id,changed_at,data)
 SELECT id,updated_at,data FROM events WHERE json_extract(data,'$.status')='withdrawn';
PRAGMA user_version=5;
COMMIT;
