-- The Golf Ball Drop room (Nan, 2026-10-10): a club's group where the account
-- keeps a ticket ledger and nothing else.
--
-- group_modes gains a fourth mode, gbd. SQLite cannot change a CHECK in place,
-- so the table is rebuilt with the same columns. Only scripts/group_mode.py
-- sets gbd; no group name does.
CREATE TABLE group_modes_new (
  group_id TEXT PRIMARY KEY,
  mode     TEXT NOT NULL CHECK (mode IN ('muted', 'thoughts', 'bots', 'gbd')),
  name     TEXT,
  source   TEXT NOT NULL,
  set_at   INTEGER NOT NULL
);
INSERT INTO group_modes_new SELECT group_id, mode, name, source, set_at FROM group_modes;
DROP TABLE group_modes;
ALTER TABLE group_modes_new RENAME TO group_modes;

-- One row per numbered ball that has been issued. A ball with no row is
-- unissued; `back` deletes the row and gbd_log keeps the history.
CREATE TABLE gbd_tickets (
  group_id    TEXT    NOT NULL,
  n           INTEGER NOT NULL CHECK (n BETWEEN 1 AND 300),
  holder      TEXT    NOT NULL,
  issued_by   TEXT    NOT NULL,        -- LINE display name of the sender
  issued_at   INTEGER NOT NULL,
  sold        INTEGER NOT NULL DEFAULT 0,
  buyer       TEXT,
  sold_by     TEXT,
  sold_at     INTEGER,
  paid        INTEGER NOT NULL DEFAULT 0,
  paid_amount INTEGER,                 -- baht
  paid_by     TEXT,
  paid_at     INTEGER,
  PRIMARY KEY (group_id, n)
);

-- Every command that changes the ledger, who sent it, when, and the answer.
-- message_id is unique so a webhook LINE delivers twice is applied once.
CREATE TABLE gbd_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id   TEXT    NOT NULL,
  ts         INTEGER NOT NULL,
  user_id    TEXT,
  user_name  TEXT,
  message_id TEXT UNIQUE,
  cmd        TEXT    NOT NULL,
  text       TEXT    NOT NULL,
  result     TEXT
);

-- The dated posts already sent, one row per room and post.
CREATE TABLE gbd_posts (
  group_id TEXT    NOT NULL,
  key      TEXT    NOT NULL,
  sent_at  INTEGER NOT NULL,
  PRIMARY KEY (group_id, key)
);
