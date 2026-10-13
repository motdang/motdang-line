-- The reasons to add Mot Dang on LINE. Nan, 2026-09-28: "let's do all of
-- those, and also mae hong son passport". Each one sits behind its own var in
-- wrangler.jsonc, all "off"; these tables are empty until one is turned on.

-- PINS: a pin set or a plan from the map, kept per person.
CREATE TABLE pin_sets (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     TEXT    NOT NULL,
  kind        TEXT    NOT NULL,          -- pins | plan
  name        TEXT,                      -- q=, or the first pin's name
  name_ok     INTEGER NOT NULL DEFAULT 0, -- 1 when the screen passed the name for the page
  url         TEXT    NOT NULL,          -- rebuilt from what was parsed, not the text as sent
  pins        TEXT    NOT NULL,          -- JSON [{lat, lng, n}]
  created_at  INTEGER NOT NULL,
  UNIQUE (user_id, url)
);

-- ALERTS: the one place a person asked to be warned about, to about 100 m.
CREATE TABLE alert_places (
  user_id     TEXT PRIMARY KEY,
  lat         REAL    NOT NULL,
  lng         REAL    NOT NULL,
  created_at  INTEGER NOT NULL
);

-- Every alert push, sent or not. `status` is sent | failed | capped. The
-- twelve-hour spacing and the monthly cap are both counted from here.
CREATE TABLE alert_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     TEXT    NOT NULL,
  kind        TEXT    NOT NULL,          -- flood | dust
  subject     TEXT,                      -- station id or city id
  ts          INTEGER NOT NULL,
  month       TEXT    NOT NULL,          -- YYYY-MM, Bangkok
  status      TEXT    NOT NULL,
  text        TEXT
);
CREATE INDEX alert_log_user ON alert_log (user_id, kind, ts);
CREATE INDEX alert_log_month ON alert_log (month, status);

-- STAMPS: a round somebody started, and each stop they stood at.
CREATE TABLE rounds_started (
  user_id       TEXT    NOT NULL,
  round         TEXT    NOT NULL,
  started_at    INTEGER NOT NULL,
  completed_at  INTEGER,
  PRIMARY KEY (user_id, round)
);
CREATE TABLE stamps (
  user_id     TEXT    NOT NULL,
  round       TEXT    NOT NULL,
  stop        TEXT    NOT NULL,
  ts          INTEGER NOT NULL,
  PRIMARY KEY (user_id, round, stop)
);

-- OWNERS: a claim on a place by its short code, held until a person decides.
CREATE TABLE owner_claims (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     TEXT    NOT NULL,
  code        TEXT    NOT NULL,          -- MD-XXXXX as sent, upper case
  place       TEXT,                      -- "cm/slug" from motdang.net/data/codes
  name        TEXT,                      -- the claimant's LINE display name, for the person deciding
  status      TEXT    NOT NULL DEFAULT 'pending', -- pending | approved | refused
  created_at  INTEGER NOT NULL,
  decided_at  INTEGER,
  UNIQUE (user_id, code)
);
-- What an approved owner sent for their place. Pending for a person in the
-- mot-dang importer; `held` when the screen held it.
CREATE TABLE owner_edits (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  claim_id    INTEGER NOT NULL,
  user_id     TEXT    NOT NULL,
  place       TEXT    NOT NULL,
  message_id  TEXT    UNIQUE,
  ts          INTEGER NOT NULL,
  kind        TEXT    NOT NULL,          -- text | photo
  text        TEXT,
  photo_key   TEXT,
  photo_type  TEXT,
  status      TEXT    NOT NULL,          -- pending | held
  why         TEXT,
  pulled_at   INTEGER
);
CREATE INDEX owner_edits_pull ON owner_edits (id) WHERE pulled_at IS NULL;

-- SPOTTERS: each rain or flood answer mot-dang-claims accepted, for the count.
CREATE TABLE weather_reports (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     TEXT    NOT NULL,
  kind        TEXT    NOT NULL,
  answer      TEXT    NOT NULL,
  ts          INTEGER NOT NULL,
  month       TEXT    NOT NULL
);
CREATE INDEX weather_reports_user ON weather_reports (user_id, month);

-- SAFE: the family links. The token is shown once, in the reply; only its
-- sha256 is kept. Every link a person was given shows their latest mark.
CREATE TABLE safe_links (
  token_hash  TEXT PRIMARY KEY,
  user_id     TEXT    NOT NULL,
  created_at  INTEGER NOT NULL
);

-- A small per-person counter for everything that costs a subrequest or a
-- model call: bucket is the feature, hour the clock hour it counts in.
CREATE TABLE dm_rate (
  user_id     TEXT    NOT NULL,
  bucket      TEXT    NOT NULL,
  hour        INTEGER NOT NULL,
  n           INTEGER NOT NULL,
  PRIMARY KEY (user_id, bucket)
);

ALTER TABLE dm_users ADD COLUMN owner_claim INTEGER;   -- the approved claim their posts go to
ALTER TABLE dm_users ADD COLUMN credit INTEGER NOT NULL DEFAULT 0; -- 1: name shown on /spotters
ALTER TABLE dm_users ADD COLUMN safe_state TEXT;       -- safe | help
ALTER TABLE dm_users ADD COLUMN safe_at INTEGER;
