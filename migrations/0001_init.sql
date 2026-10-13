-- Everything the group says that we keep, one row per event.
--
-- `status` is the whole state machine for a photo:
--   new       -> just landed, nothing decided
--   matched   -> a place was found with enough confidence to file it
--   asking    -> the bot asked the group which place, waiting
--   unmatched -> asked and got nothing usable; a human files it
-- Text and bug rows go straight to 'new' and are pulled as they are.
CREATE TABLE events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  ts            INTEGER NOT NULL,          -- LINE's own event timestamp, ms
  kind          TEXT    NOT NULL,          -- photo | text | bug | join | leave
  group_id      TEXT,
  user_id       TEXT,
  user_name     TEXT,                      -- group member profile, best effort
  text          TEXT,                      -- message text, or the bug body
  message_id    TEXT,                      -- LINE message id
  quoted_id     TEXT,                      -- message this one quoted, if any
  photo_key     TEXT,                      -- R2 key when kind='photo'
  photo_bytes   INTEGER,
  place_slug    TEXT,
  place_name    TEXT,
  confidence    REAL,                      -- 0..1 from the matcher
  status        TEXT    NOT NULL DEFAULT 'new',
  ticket        TEXT,                      -- BUG-0001 etc, when kind='bug'
  pulled_at     INTEGER                    -- set by the local filer's /ack
);
CREATE INDEX events_pull  ON events (id) WHERE pulled_at IS NULL;
CREATE INDEX events_ts    ON events (ts);
CREATE INDEX events_user  ON events (group_id, user_id, ts);
CREATE INDEX events_state ON events (status) WHERE status IN ('new','asking');

-- Small key/value: the team group id learned on join, the last summary
-- watermark, the bug counter. One row per key.
CREATE TABLE state (
  k  TEXT PRIMARY KEY,
  v  TEXT NOT NULL,
  ts INTEGER NOT NULL
);

-- LINE retries a webhook it did not hear 200 from, so the same message can
-- arrive twice. One row per LINE message id, enforced rather than hoped for.
CREATE UNIQUE INDEX events_msg ON events (message_id) WHERE message_id IS NOT NULL;
