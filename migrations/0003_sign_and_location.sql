-- What the sign said, read off the photo by a vision model, as JSON:
-- {name_th, name_en, phone, hours, line_id, what_kind, other_text}, nulls
-- where the sign showed nothing. A reading, not a fact: it is offered in the
-- room for a person to confirm and it travels to the desk as a candidate.
ALTER TABLE events ADD COLUMN sign TEXT;

-- A LINE location message — somebody tapped the paperclip standing in the
-- shop. Exact, and unlike EXIF it survives however the photo was sent. Also
-- set on a photo row when a location arrives from the same person within
-- ten minutes, so the pin and the picture leave together.
ALTER TABLE events ADD COLUMN lat REAL;
ALTER TABLE events ADD COLUMN lng REAL;
ALTER TABLE events ADD COLUMN address TEXT;
