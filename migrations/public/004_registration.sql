BEGIN;
-- Store source evidence separately from a registration state inferred from its published window.
ALTER TABLE events ADD COLUMN registration_hint INTEGER CHECK (registration_hint IN (0,1));
UPDATE events SET registration_hint = json_extract(data,'$.registration_open')
WHERE json_type(data,'$.registration_open') IN ('true','false')
  AND (json_extract(data,'$.registration_open') = 1 OR json_extract(data,'$.deadline') IS NULL);
-- A previously seen fingerprint can become current again after a reschedule.
CREATE TABLE source_versions(
 source TEXT NOT NULL, canonical_url TEXT NOT NULL, fingerprint TEXT NOT NULL,
 PRIMARY KEY(source,canonical_url)
);
PRAGMA user_version=4;
COMMIT;
