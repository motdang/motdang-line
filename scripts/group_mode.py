#!/usr/bin/env python3
"""The rooms the LINE account sits in, and each one's mode.

    python3 scripts/group_mode.py                      # list them
    python3 scripts/group_mode.py <group> thoughts     # Nan's private room: keeps all, never speaks
    python3 scripts/group_mode.py <group> bots         # the team and the bots: answers when addressed
    python3 scripts/group_mode.py <group> muted        # keeps nothing, says nothing
    python3 scripts/group_mode.py <group> gbd          # Golf Ball Drop room: ticket ledger, answers when addressed

<group> is the group id (C…), or a piece of the group's name as the list shows
it. The Worker sets the mode from the name when it first meets a group; this is
for changing it after, and the only way to give a room gbd. The ops room and the swim room keep their own handling
and the Worker refuses to give them a mode.
"""
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

DESK = os.environ.get("LINE_DESK", "https://line.motdang.net")
TOKEN_FILE = os.path.expanduser("~/.motdang-line-pull-token")
UA = "motdang-desk/1.0 (+https://motdang.net)"  # the zone's bot rules refuse urllib's default


def call(path, body=None):
    tok = open(TOKEN_FILE).read().strip()
    req = urllib.request.Request(
        DESK + path, method="POST" if body else "GET",
        data=json.dumps(body).encode() if body else None,
        headers={"Authorization": "Bearer " + tok, "User-Agent": UA,
                 **({"Content-Type": "application/json"} if body else {})})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        return json.loads(e.read() or b"{}")


def main(argv):
    listing = call("/desk/groups")
    groups = listing.get("groups", [])
    if len(argv) < 2:
        print(f"ops room   {listing.get('team_group_id')}")
        if listing.get("cwsdpp_group_id"):
            print(f"swim room  {listing['cwsdpp_group_id']}")
        for g in groups:
            print(f"{g['mode']:<9}  {g['group_id']}  {g.get('name') or '(no name)'}  [{g['source']}]")
        if not groups:
            print("no other rooms yet — they appear once the account is added to a group")
        return 0
    who, mode = argv[0], argv[1]
    if who.startswith("C") and len(who) > 20:
        gid = who
    else:
        hits = [g for g in groups if who.lower() in (g.get("name") or "").lower()]
        if len(hits) != 1:
            print(f"{len(hits)} rooms match {who!r}; give the group id instead")
            return 1
        gid = hits[0]["group_id"]
    out = call("/desk/groups/" + urllib.parse.quote(gid, safe=""), {"mode": mode})
    if not out.get("ok"):
        print("refused:", out.get("why"))
        return 1
    g = out["group"]
    print(f"{g['mode']:<9}  {g['group_id']}  {g.get('name') or '(no name)'}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
