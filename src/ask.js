// ASK: a shared location gets the nearest pharmacy, fuel, toilet, hospital
// and 7-Eleven from motdang.net's own search API, straight-line; a question
// typed as text gets a search link.
//
// Each kind is asked with the filter that finds it. The free-text words
// ("fuel", "toilet", "hospital") were tried on 2026-09-28 against the live
// API from Tha Phae Gate and came back with a café, a printing shop and a
// vet; the category filters came back with petrol stations, toilets and
// hospitals.
//
// The reader assistant (ask.motdang.net, on the white-label-ai Worker) has no
// server-to-server question endpoint: a chat needs a reader session from
// POST /api/session, is limited per caller address, can be gated by
// Turnstile, and streams its answer. So a question gets a link to the site's
// search page and to the assistant, and is not forwarded.

import { say, sayMany, quick, rate, SLOW, site, metres, distance, fresh, askLocation, setPending, LOCATION_BUTTON } from "./dm.js";
import { shareBits } from "./plus.js";

export const KINDS = {
  pharmacy: { q: "sub=pharmacy", label: "ร้านยา · Pharmacy" },
  fuel: { q: "sub=fuel", label: "ปั๊มน้ำมัน · Fuel" },
  toilet: { q: "facet=toilet", label: "ห้องน้ำ · Toilet" },
  hospital: { q: "sub=hospital", label: "โรงพยาบาล · Hospital" },
  seven: { q: "tag=7-eleven", label: "เซเว่น · 7-Eleven" },
};

// Up to `limit` of one kind, nearest first, each with its straight-line metres.
export async function nearest(env, lat, lng, kind, limit = 3) {
  const k = KINDS[kind];
  if (!k) return [];
  const url = `${site(env)}/api/v1/search?${k.q}&near=${lat.toFixed(5)},${lng.toFixed(5)}&radius=3000&limit=3`;
  try {
    const r = await fetch(url, { headers: { accept: "application/json" } });
    if (!r.ok) return [];
    const j = await r.json();
    return (j.results || [])
      .filter((x) => Number.isFinite(x.lat) && Number.isFinite(x.lng) && /^https:\/\/motdang\.net\//.test(x.url || ""))
      // A result that carries its short place ID links to it on the map.
      .map((x) => ({ name: String(x.name || x.nameEn || "").slice(0, 80), m: metres(lat, lng, x.lat, x.lng),
        url: /^(MD-)?[0-9A-HJKMNP-TV-Z]{5,10}$/.test(x.code || "")
          ? `${site(env)}/map.html?go=${encodeURIComponent("MD-" + x.code.replace(/^MD-/, ""))}` : x.url }))
      .sort((a, b) => a.m - b.m)
      .slice(0, limit);
  } catch (e) {
    console.log("nearest failed", kind, e.message);
    return [];
  }
}

const buttons = (withPin, share) => [
  ...Object.entries(KINDS).map(([k, v]) => ({ type: "postback", label: v.label, data: `a=near&k=${k}`, displayText: v.label })),
  ...(withPin ? [{ type: "postback", label: "ปักหมุดในหน้า · Pin", data: "a=pin", displayText: "ปักหมุดในหน้า · Pin" }] : []),
  ...(share ? [share] : []),
  LOCATION_BUTTON,
];

export async function nearReply(ev, env, uid, lat, lng, { pin = false } = {}) {
  if (!(await rate(env, uid, "near", 20))) return say(env, ev, SLOW);
  const all = await Promise.all(Object.keys(KINDS).map((k) => nearest(env, lat, lng, k, 1)));
  const lines = ["ใกล้คุณที่สุด · Nearest to you", "ระยะตรง · straight-line", ""];
  Object.values(KINDS).forEach((v, i) => {
    const x = all[i][0];
    lines.push(x ? `${v.label}: ${x.name} — ${distance(x.m)}\n${x.url}` : `${v.label}: ไม่พบใน 3 กม. · none within 3 km`);
  });
  const here = shareBits(env, { lat, lng });
  lines.push("", "ตำแหน่งของคุณ · Where you are", ...here.lines);
  return sayMany(env, ev, [quick(lines.join("\n"), buttons(pin, here.action))]);
}

export async function nearKind(ev, env, uid, row, kind) {
  const now = ev.timestamp || Date.now();
  if (!KINDS[kind]) return;
  if (!fresh(row, now)) {
    await setPending(env, uid, "near", now);
    return askLocation(env, ev);
  }
  if (!(await rate(env, uid, "near", 20))) return say(env, ev, SLOW);
  const got = await nearest(env, row.last_lat, row.last_lng, kind, 3);
  const lines = [`${KINDS[kind].label} — ระยะตรง · straight-line`, ""];
  if (!got.length) lines.push("ไม่พบใน 3 กม. · None within 3 km.");
  for (const x of got) lines.push(`${x.name} — ${distance(x.m)}\n${x.url}`);
  return sayMany(env, ev, [quick(lines.join("\n"), buttons(false))]);
}

// Text that reads as a question: a question mark, or a Thai question word at
// the end, or an English question word at the start.
export function isQuestion(text) {
  const t = String(text || "").trim();
  if (!t || t.length > 300) return false;
  if (/[?？]$/.test(t)) return true;
  if (/(ไหม|มั้ย|หรือเปล่า|หรือยัง|อะไร|ที่ไหน|ตรงไหน|ยังไง|อย่างไร|เท่าไร|เท่าไหร่|กี่โมง|กี่บาท)\s*(ครับ|คะ|ค่ะ|คับ|จ๊ะ|จ้ะ|นะ)?$/.test(t)) return true;
  return /^(where|what|how|when|which|who|is there|are there|can i|does|do you)\b/i.test(t);
}

export function questionReply(ev, env, text) {
  const q = encodeURIComponent(String(text).trim().slice(0, 200));
  return say(env, ev, [
    "ค้นในมดแดง · Search Mot Dang",
    `${site(env)}/search.html?q=${q}`,
    "",
    "คุยกับมด · Chat with the ants",
    "https://ask.motdang.net/",
  ].join("\n"));
}
