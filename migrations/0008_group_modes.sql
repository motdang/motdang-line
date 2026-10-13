-- Two more rooms, and which room a line was said in (Nan, 2026-09-30):
-- "I want a private line group so I can send my own thoughts to a silent bot,
-- and another one where the team and I message the bots."
--
-- group_modes: one row per group the account sits in, other than the ops group
-- (state.team_group_id) and the swim group (state.cwsdpp_group_id), which keep
-- their own handling. The mode is read off the group's NAME the first time the
-- Worker sees the group, and then kept: renaming the group later changes
-- nothing. scripts/group_mode.py changes it from the Mac.
--   muted     kept nowhere, says nothing — any group nobody set up
--   thoughts  Nan's private room: every message kept, the bot never speaks
--   bots      the team talking to the bots: answers when addressed or given a command
CREATE TABLE group_modes (
  group_id TEXT PRIMARY KEY,
  mode     TEXT NOT NULL CHECK (mode IN ('muted', 'thoughts', 'bots')),
  name     TEXT,              -- the group's name when the mode was set
  source   TEXT NOT NULL,     -- 'name' (read at join or first message) | 'desk' (set from the Mac)
  set_at   INTEGER NOT NULL
);

-- Which room a row came from. The pull writes 'thoughts' to its own folder and
-- never into the ops transcript. Every row before this is the ops room.
ALTER TABLE events ADD COLUMN channel TEXT NOT NULL DEFAULT 'ops';
