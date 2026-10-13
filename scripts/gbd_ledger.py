#!/usr/bin/env python3
"""Write the Golf Ball Drop ledger to a TSV on the Desktop.

    python3 scripts/gbd_ledger.py                  # newest gbd room, to the default path
    python3 scripts/gbd_ledger.py --group C…       # a named room
    python3 scripts/gbd_ledger.py --out file.tsv   # somewhere else

The Worker answers GET /desk/gbd/ledger with 300 rows, one per ball: state
(unissued, issued, sold, paid), holder, buyer, baht, and who recorded each step
and when (Bangkok time).
"""
import argparse
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

DESK = os.environ.get("LINE_DESK", "https://line.motdang.net")
TOKEN_FILE = os.path.expanduser("~/.motdang-line-pull-token")
OUT = os.path.expanduser("~/Desktop/3 — Projects/CMIRC Ball Drop/GBD ledger.tsv")
UA = "motdang-desk/1.0 (+https://motdang.net)"  # the zone's bot rules refuse urllib's default


def fetch(group=None):
    tok = open(TOKEN_FILE).read().strip()
    path = "/desk/gbd/ledger" + ("?group=" + urllib.parse.quote(group, safe="") if group else "")
    req = urllib.request.Request(DESK + path, headers={"Authorization": "Bearer " + tok, "User-Agent": UA})
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.read().decode("utf-8")


def main(argv):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--group")
    ap.add_argument("--out", default=OUT)
    a = ap.parse_args(argv)
    try:
        text = fetch(a.group)
    except urllib.error.HTTPError as e:
        print(f"desk said {e.code}: {e.read().decode('utf-8', 'replace').strip()}")
        return 1
    os.makedirs(os.path.dirname(a.out), exist_ok=True)
    tmp = a.out + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(text)
    os.replace(tmp, a.out)
    rows = [r.split("\t") for r in text.splitlines()[1:]]
    held = sum(1 for r in rows if r[1] != "unissued")
    print(f"{a.out}  ({held} of {len(rows)} balls issued)")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
