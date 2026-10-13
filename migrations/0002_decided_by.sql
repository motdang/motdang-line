-- Which words actually settled a photo, as opposed to which words happened to
-- be near it. A photo sent after "Testing bot behavior" and then named by a
-- later message was filed on the later message, but the row still quoted the
-- earlier one — so the ledger disagreed with the decision, and the provenance
-- was worth nothing. Both are kept now: `text` is the context it arrived in,
-- `decided_by` is what named it.
ALTER TABLE events ADD COLUMN decided_by TEXT;

-- How the bytes arrived. LINE re-encodes anything sent as a *photo* and throws
-- the metadata away — the test image came through with a single EXIF entry and
-- no GPS tag at all — but a file sent through the paperclip arrives byte for
-- byte, EXIF included. Same picture, two routes, and only one of them can be
-- geocoded, so the row has to say which route it took.
ALTER TABLE events ADD COLUMN via TEXT;
