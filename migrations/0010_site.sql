-- Signed in on motdang.net with LINE (Nan 2026-10-20: "many more personalization
-- and convenience features that you can access in motdang with a LINE signin",
-- and the week on Mot Dang for people who opt in). The site's account and this
-- account share a provider, so a reader's LINE user ID is the same in both, and
-- the site asks this Worker for the pushes (src/site.js).

-- Every push the site asked for: a link sent to one's own LINE, a reminder,
-- the weekly issue. `status` is sent | failed | capped. The monthly count
-- (with alert_log's) is held under PUSH_CAP.
CREATE TABLE site_push (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id   TEXT    NOT NULL,
  kind      TEXT    NOT NULL,            -- self | remind | weekly
  ref       TEXT,                        -- the reminder's key, the issue's date
  ts        INTEGER NOT NULL,
  month     TEXT    NOT NULL,            -- YYYY-MM, Bangkok
  status    TEXT    NOT NULL
);
CREATE INDEX site_push_month ON site_push (month, status);
CREATE INDEX site_push_user ON site_push (user_id, kind, ts);

-- "Remind me on LINE" on an event: one push at `at` (ms), within the hourly run.
CREATE TABLE reminders (
  user_id   TEXT    NOT NULL,
  key       TEXT    NOT NULL,            -- the event's key and the chosen time
  at        INTEGER NOT NULL,
  text      TEXT    NOT NULL,
  made      INTEGER NOT NULL,
  sent      INTEGER,                     -- when it went, or the run that gave up
  PRIMARY KEY (user_id, key)
);
CREATE INDEX reminders_due ON reminders (sent, at);
