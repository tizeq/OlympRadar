CREATE TABLE chat_sessions (
  user_id TEXT PRIMARY KEY REFERENCES users(telegram_id),
  state_json TEXT NOT NULL
);
