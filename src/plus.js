// A shared point, handed back so it can travel. Nan, 2026-09-28: "you should
// be able to use motdang/line to send your location to anyone on LINE or
// other map apps, just like any placeid".
//
// Every reply to a shared location carries the point's full Plus Code and a
// motdang.net/map.html?go= link, which opens the point and offers
// OpenStreetMap, Organic Maps, OsmAnd, Google, Apple, Waze and geo:. When the
// point is a place with a short code (MD-XXXXX), the link carries the code
// instead. A "ส่งให้เพื่อน · Share" button opens LINE's own share sheet with the
// link in it; that goes out from the reader's phone, not as a push.

import { site } from "./dm.js";

// Open Location Code, the ten-digit encoder only. Ported from
// mot-dang/coords_layer.py (olcEncode), which follows the spec at
// github.com/google/open-location-code.
const OLC = "23456789CFGHJMPQRVWX";
const LAT_PREC = 8000 * 3125, LNG_PREC = 8000 * 1024;

export function plusCode(lat, lng) {
  // Integer grid first, so float noise cannot move a point across a cell edge.
  let latV = Math.floor(Math.round(lat * LAT_PREC * 1e6) / 1e6) + 90 * LAT_PREC;
  if (latV < 0) latV = 0; else if (latV >= 180 * LAT_PREC) latV = 180 * LAT_PREC - 1;
  let lngV = Math.floor(Math.round(lng * LNG_PREC * 1e6) / 1e6) + 180 * LNG_PREC;
  const span = 360 * LNG_PREC;
  lngV = ((lngV % span) + span) % span;
  latV = Math.floor(latV / 3125);
  lngV = Math.floor(lngV / 1024);
  let code = "";
  for (let i = 0; i < 5; i++) {
    code = OLC[latV % 20] + OLC[lngV % 20] + code;
    latV = Math.floor(latV / 20);
    lngV = Math.floor(lngV / 20);
  }
  return code.slice(0, 8) + "+" + code.slice(8);
}

// { lines, action } for a point: {lat, lng, name?, code?} where code is a
// place's short code with or without "MD-".
export function shareBits(env, p) {
  const code = p.code ? "MD-" + String(p.code).replace(/^MD-/i, "") : null;
  const plus = plusCode(p.lat, p.lng);
  const link = `${site(env)}/map.html?go=${encodeURIComponent(code || plus)}`;
  const text = "📍 " + (p.name || "ตำแหน่งของฉัน · my location") + " " + link;
  return {
    lines: [code ? `รหัสสถานที่ · Place ID: ${code}` : `Plus Code: ${plus}`, link],
    action: { type: "uri", label: "ส่งให้เพื่อน · Share", uri: "https://line.me/R/share?text=" + encodeURIComponent(text) },
  };
}
