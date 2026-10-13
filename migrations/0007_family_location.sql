-- The family location. Nan, 2026-09-28: "family safe page seems too
-- intrusive, but location sharing is awesome." So the family page no longer
-- draws an area from whatever location came in last; it shows only a location
-- sent in answer to "ส่งตำแหน่งให้ครอบครัว · Share my location with family",
-- exact, with its time. src/safe.js clears it on the next "safe", on a new
-- one, on "ลบตำแหน่ง · clear location", and stops showing it after 24 hours.
ALTER TABLE dm_users ADD COLUMN family_lat REAL;
ALTER TABLE dm_users ADD COLUMN family_lng REAL;
ALTER TABLE dm_users ADD COLUMN family_at INTEGER;
