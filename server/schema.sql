-- Chattrix schema (PostgreSQL / Supabase).
-- The server runs this automatically on start-up, so you do NOT have to paste it manually.
-- (You may also paste it in Supabase -> SQL Editor -> Run. It is safe to run many times.)

CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  username      TEXT NOT NULL,
  display_name  TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  avatar        TEXT,
  status        TEXT NOT NULL DEFAULT 'Hey there! I am using Chattrix',
  last_seen     BIGINT,
  created_at    BIGINT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS users_username_lower ON users (lower(username));

CREATE TABLE IF NOT EXISTS conversations (
  id               SERIAL PRIMARY KEY,
  type             TEXT NOT NULL,                 -- direct | group | channel
  name             TEXT,
  description      TEXT,
  avatar           TEXT,
  created_by       INTEGER,
  created_at       BIGINT NOT NULL,
  invite_code      TEXT UNIQUE,
  only_admins_send INTEGER NOT NULL DEFAULT 0,
  is_public        INTEGER NOT NULL DEFAULT 0,
  direct_key       TEXT UNIQUE
);

CREATE TABLE IF NOT EXISTS members (
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role            TEXT NOT NULL DEFAULT 'member',  -- owner | admin | member
  joined_at       BIGINT NOT NULL,
  last_read_id    INTEGER NOT NULL DEFAULT 0,
  muted           INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (conversation_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_members_user ON members(user_id);

CREATE TABLE IF NOT EXISTS messages (
  id              SERIAL PRIMARY KEY,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender_id       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  type            TEXT NOT NULL DEFAULT 'text',    -- text | file | poll | system
  text            TEXT,
  file_url        TEXT,
  file_name       TEXT,
  file_size       BIGINT,
  file_mime       TEXT,
  reply_to        INTEGER,
  edited_at       BIGINT,
  deleted         INTEGER NOT NULL DEFAULT 0,
  pinned_at       BIGINT,
  pinned_by       INTEGER,
  created_at      BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_msg_conv ON messages(conversation_id, id);

CREATE TABLE IF NOT EXISTS message_reactions (
  message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  emoji      TEXT NOT NULL,
  PRIMARY KEY (message_id, user_id)
);

CREATE TABLE IF NOT EXISTS message_deletions (            -- "delete for me"
  message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL,
  PRIMARY KEY (message_id, user_id)
);

CREATE TABLE IF NOT EXISTS polls (
  message_id INTEGER PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  multiple   INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS poll_options (
  id         SERIAL PRIMARY KEY,
  message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  text       TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS poll_votes (
  option_id  INTEGER NOT NULL REFERENCES poll_options(id) ON DELETE CASCADE,
  message_id INTEGER NOT NULL,
  user_id    INTEGER NOT NULL,
  PRIMARY KEY (option_id, user_id)
);

CREATE TABLE IF NOT EXISTS drafts (
  user_id         INTEGER NOT NULL,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  text            TEXT NOT NULL,
  PRIMARY KEY (user_id, conversation_id)
);

-- Security: Supabase exposes the "public" schema through its REST API. Our server connects with the
-- database password (which bypasses RLS), so we turn RLS ON with no policies = nobody can read these
-- tables through the public API key. (Password hashes live in "users".)
ALTER TABLE meta               ENABLE ROW LEVEL SECURITY;
ALTER TABLE users              ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversations      ENABLE ROW LEVEL SECURITY;
ALTER TABLE members            ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages           ENABLE ROW LEVEL SECURITY;
ALTER TABLE message_reactions  ENABLE ROW LEVEL SECURITY;
ALTER TABLE message_deletions  ENABLE ROW LEVEL SECURITY;
ALTER TABLE polls              ENABLE ROW LEVEL SECURITY;
ALTER TABLE poll_options       ENABLE ROW LEVEL SECURITY;
ALTER TABLE poll_votes         ENABLE ROW LEVEL SECURITY;
ALTER TABLE drafts             ENABLE ROW LEVEL SECURITY;
