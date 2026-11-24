ALTER TABLE events ADD COLUMN end TEXT;
ALTER TABLE events ADD COLUMN registration_start TEXT;
ALTER TABLE events ADD COLUMN registration_end TEXT;
CREATE INDEX events_registration_end ON events(status,registration_end);
