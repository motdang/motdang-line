-- Mot Dang pages from LINE. A person who chats with the account one-to-one
-- gets a page at /u/<slug>, built from what they send. Nan, 2026-09-28: "a
-- better line integration to offer as a free subscription (similar to yahoo
-- personal sites) that's based entirely in a line app, changes no user
-- behavior". Who gets one: "anyone".
--
-- Kept apart from `events` on purpose. `events` is the team room's ledger and
-- /desk/pull carries every row of it down to the repo; a reader's page is not
-- operations and does not ride that pull.

-- One row per LINE user who has written to the account one-to-one.
--
-- `slug` is null for somebody who has only used the rain or flood buttons, or
-- who deleted their page. The last location is private: it answers the rain
-- and flood questions and is never drawn on the page.
CREATE TABLE dm_users (
  user_id      TEXT PRIMARY KEY,
  slug         TEXT UNIQUE,
  name         TEXT,                      -- LINE display name, or what `name …` set
  name_ok      INTEGER NOT NULL DEFAULT 0, -- 1 when the screen passed it for the page
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  last_lat     REAL,
  last_lng     REAL,
  last_loc_at  INTEGER,
  pending      TEXT,                      -- 'delete' | 'rain:<answer>' | 'flood:<answer>'
  pending_at   INTEGER,
  obs_hour     INTEGER,                   -- rain/flood reports forwarded this hour
  obs_count    INTEGER NOT NULL DEFAULT 0
);

-- What they sent, one row per LINE message.
--
--   status  shown    on the page
--           held     the screen held it; kept, not shown
--           refused  a photo of a person, or one the model could not read;
--                    no bytes kept, the row stays so it counts toward the limit
--   why     the screen's reasons, for the operator; not sent to the sender
--
-- lat/lng on a location row is what they shared and is drawn on the page map,
-- rounded. On a photo row it came out of the file's EXIF and stays private:
-- the public copy of the photo has its metadata stripped.
CREATE TABLE page_items (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      TEXT    NOT NULL,
  message_id   TEXT    UNIQUE,
  ts           INTEGER NOT NULL,
  kind         TEXT    NOT NULL,          -- photo | text | location
  text         TEXT,
  photo_key    TEXT,                      -- R2 key of the stripped copy
  photo_type   TEXT,                      -- image/jpeg | image/png
  photo_bytes  INTEGER,
  lat          REAL,
  lng          REAL,
  status       TEXT    NOT NULL DEFAULT 'held',
  why          TEXT
);
CREATE INDEX page_items_user ON page_items (user_id, ts);
