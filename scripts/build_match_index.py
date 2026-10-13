#!/usr/bin/env python3
"""Build the bot's place index from the site's own name index, and send it up.

    python3 scripts/build_match_index.py            # build only, report size
    python3 scripts/build_match_index.py --push     # build and PUT to the Worker

The bot can only name places the site can already show, which is the point:
docs/data/index.json is what the search box matches, so a photo the bot files
under a name lands on a record a reader can reach. Rebuild this whenever the
site's names change — after a build that added records — and the Worker picks
it up within six hours, or at once with --push.

Fields kept: id, Thai name, romanisation, English, alias, province. Nothing
else travels: no coordinates, no categories, no counts.
"""
import json
import os
import sys
import urllib.request

SITE = os.path.expanduser("~/Developer/claude code projects/mot-dang")
SRC = os.path.join(SITE, "docs", "data", "index.json")
OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "build", "match.json")
ENDPOINT = os.environ.get("LINE_DESK", "https://line.motdang.net") + "/desk/index"
TOKEN_FILE = os.path.expanduser("~/.motdang-line-pull-token")


def token():
    t = os.environ.get("PULL_TOKEN", "").strip()
    if not t and os.path.exists(TOKEN_FILE):
        t = open(TOKEN_FILE).read().strip()
    if not t:
        raise SystemExit(
            f"No desk token. It is the PULL_TOKEN secret on the Worker.\n"
            f"  printf %s 'THE_TOKEN' > {TOKEN_FILE} && chmod 600 {TOKEN_FILE}")
    return t


def build():
    if not os.path.exists(SRC):
        raise SystemExit(f"No site index at {SRC} — run the site build first.")
    rows = json.load(open(SRC, encoding="utf-8"))
    out = []
    for r in rows:
        slug = r.get("s")
        if not slug:
            continue
        rec = {"s": slug}
        for src, dst in (("n", "n"), ("r", "r"), ("e", "e"), ("a", "a"), ("p", "p")):
            v = r.get(src)
            if v:
                rec[dst] = v
        # A record with no name at all cannot be matched by name, and carrying
        # it only makes the index bigger for every lookup.
        if not any(rec.get(k) for k in ("n", "r", "e", "a")):
            continue
        # 'a' repeating 'r' verbatim is the common case and pure weight.
        if rec.get("a") and rec.get("a") == rec.get("r"):
            rec.pop("a")
        out.append(rec)
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    blob = json.dumps(out, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    open(OUT, "wb").write(blob)
    print(f"{len(out):,} places → {OUT} ({len(blob)/1e6:.2f} MB)")
    return blob


def push(blob):
    # A default urllib user-agent gets a 403 from the zone's own protection
    # before it ever reaches the Worker. Say who we are.
    req = urllib.request.Request(
        ENDPOINT, data=blob, method="PUT",
        headers={"Authorization": "Bearer " + token(),
                 "Content-Type": "application/json",
                 "User-Agent": "motdang-line-index/1.0 (+https://motdang.net)"})
    with urllib.request.urlopen(req, timeout=120) as r:
        print(f"→ {ENDPOINT}: {r.status} {r.read().decode()}")


if __name__ == "__main__":
    blob = build()
    if "--push" in sys.argv:
        push(blob)
