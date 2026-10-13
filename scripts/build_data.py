#!/usr/bin/env python3
"""The small data files the Worker bundles, made from the projects that own them.

    python3 scripts/build_data.py

  rounds/wats.json        every wat on the ไหว้พระ ๙ วัด rounds    <- mot-dang/data/wats.json
  rounds/mhs.json         the Mae Hong Son loop passport stops     <- mhs-loop/data/passport_stops.json
  data/ping_stations.json where the ten Ping gauges stand         <- weather-north thaiwater sample
  data/rescue.json        rescue units with a phone and a point   <- safety-north/rescue.json + mot-dang geojson

Each file carries a `source` line naming where its rows came from. Re-run it
after any of those change; the Worker reads the files at build time, so a
change reaches LINE on the next deploy.
"""

import glob
import json
from pathlib import Path

HERE = Path(__file__).resolve().parent.parent
PROJ = HERE.parent
MD = PROJ / "mot-dang"


def write(rel, obj):
    p = HERE / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(obj, ensure_ascii=False, indent=1) + "\n")
    n = len(obj.get("stops") or obj.get("stations") or obj.get("units") or [])
    print(f"{rel}: {n}")


def wats():
    """Any nine distinct wats from the rounds' stop lists. /wats on motdang.net
    offers several rounds of nine; a stamp at any wat on any of them counts."""
    src = json.loads((MD / "data" / "wats.json").read_text())
    # The short place IDs (MD-XXXXX), so a stamp can be shared as the place.
    codes = json.loads((MD / "data" / "curated" / "place_codes.json").read_text())
    seen, stops = set(), []
    for r in src["rounds"]:
        for s in r["stops"]:
            if s["id"] in seen:
                continue
            seen.add(s["id"])
            th = s.get("nameTh") or (s["name"] if any("\u0e00" <= c <= "\u0e7f" for c in s["name"]) else None)
            stops.append({"id": s["id"], "th": th or s.get("nameEn") or s["name"],
                          "en": s.get("nameEn") or s["name"],
                          "lat": round(s["lat"], 6), "lng": round(s["lng"], 6), "radius_m": 150,
                          **({"code": codes[s["id"]]} if s["id"] in codes else {})})
    write("rounds/wats.json", {
        "id": "wats", "need": 9,
        "th": "ไหว้พระ ๙ วัด", "en": "Nine wats",
        "link": "https://motdang.net/wats/",
        "source": "mot-dang/data/wats.json (importers/build_wats.py): every stop on its "
                  f"{len(src['rounds'])} rounds of nine, deduplicated by record id. "
                  "Any nine of them completes the round. `code` is the short place ID "
                  "from mot-dang/data/curated/place_codes.json.",
        "stops": stops,
    })


def mhs():
    """The passport page's own stop list, as it is: mhs-loop/data/passport_stops.json.
    Chiang Mai is stamped once and stands for both start and end; either
    direction round the loop completes it, so the stops are not ordered for
    stamping. Mae Chaem sits on the 1263 cut and is not a stop."""
    src = json.loads((PROJ / "mhs-loop" / "data" / "passport_stops.json").read_text())
    stops = [{"id": s["id"], "th": s["th"], "en": s["name"], "lat": s["lat"], "lng": s["lon"], "radius_m": 1500}
             for s in sorted(src["stops"], key=lambda s: s["n"])]
    write("rounds/mhs.json", {
        "id": "mhs", "need": len(stops),
        "th": src["th"], "en": src["name"],
        "link": "https://motdang.net/loop/",
        "source": f"mhs-loop/data/passport_stops.json (updated {src.get('updated')}), in its own order. "
                  "Points are town-precision, so the radius is 1,500 m.",
        "stops": stops,
    })


def stations():
    """ping.json names its gauges but carries no coordinates. The national
    thaiwater feed does, keyed by the same old code (tele_station_oldcode)."""
    want = [s["id"] for s in json.loads((MD / "docs" / "data" / "ping.json").read_text())["stations"]]
    feed = json.loads((PROJ / "weather-north" / "data" / "samples" / "tw_waterlevel_load.json").read_text())
    got = {}

    def walk(o):
        if isinstance(o, dict):
            c = o.get("tele_station_oldcode")
            if c in want and c not in got and o.get("tele_station_lat"):
                got[c] = {"id": c, "th": (o.get("tele_station_name") or {}).get("th"),
                          "lat": o["tele_station_lat"], "lng": o["tele_station_long"]}
            for v in o.values():
                walk(v)
        elif isinstance(o, list):
            for v in o:
                walk(v)
    walk(feed)
    write("data/ping_stations.json", {
        "source": "weather-north/data/samples/tw_waterlevel_load.json (thaiwater.net), "
                  "matched on tele_station_oldcode to the ids in motdang.net/data/ping.json. "
                  "Two names differ between the feeds (P.103, P.21); the codes match.",
        "stations": [got[c] for c in want if c in got],
    })


def rescue():
    """safety-north's list has phones but no points; the site's own geojson
    has the points, by the same record id."""
    units = json.loads((PROJ / "safety-north" / "rescue.json").read_text())
    ids = {u["id"] for k in units for u in units[k]}
    at = {}
    for f in glob.glob(str(MD / "docs" / "data" / "c[mr]-*.geojson")):
        try:
            g = json.loads(Path(f).read_text())
        except ValueError:
            continue
        for ft in g.get("features", []):
            i = (ft.get("properties") or {}).get("id") or ft.get("id")
            if i in ids and i not in at:
                c = ft["geometry"]["coordinates"]
                at[i] = (round(c[1], 6), round(c[0], 6))
    out = []
    for k in units:
        for u in units[k]:
            if u["id"] in at and u.get("phone"):
                out.append({"th": u["th"], "en": u["en"], "phone": u["phone"],
                            "lat": at[u["id"]][0], "lng": at[u["id"]][1],
                            "url": "https://motdang.net" + u["href"] if u.get("href") else None})
    write("data/rescue.json", {
        "source": f"safety-north/rescue.json ({len(ids)} units), placed from mot-dang "
                  f"docs/data/*.geojson by record id; {len(ids) - len(out)} without a point or phone left out.",
        "units": out,
    })


if __name__ == "__main__":
    wats()
    mhs()
    stations()
    rescue()
