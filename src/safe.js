// SAFE: "ปลอดภัย · safe" marks a person safe, with the time, and gives them a
// private link to send their family. "ต้องการความช่วยเหลือ · need help"
// answers at once with 1784 (ปภ., disaster prevention) and 1669 (emergency
// medical) as buttons that dial, and the nearest rescue units; it marks the
// family page "needs help".
//
// Nan, 2026-09-28: "family safe page seems too intrusive, but location
// sharing is awesome." So the family page carries a location only when the
// person sends one for it: both replies end with a location button, "ส่ง
// ตำแหน่งให้ครอบครัว · Share my location with family", and a location sent
// within ten minutes of that, while it is the latest thing the bot asked
// for, is the family location — exact, with its time. A location sent for
// anything else (the nearest places, a stamp, home, a page pin) does not
// reach the family page.
//
// The family location shows until the next "safe", a new family location,
// "ลบตำแหน่ง · clear location", or 24 hours, whichever comes first. The link's
// token appears once, in the reply; the table keeps its sha256. There is no
// list of marks anywhere.

import units from "../data/rescue.json" with { type: "json" };
import { say, sayMany, quick, rate, SLOW, ensureName, origin, metres, distance, fresh, setPending, sha256hex, randomHex, when, HOUR } from "./dm.js";
import { esc, tileMap } from "./page.js";
import { shareBits } from "./plus.js";

export const FAMILY_MS = 24 * HOUR;
const CALL = [
  { type: "uri", label: "โทร 1784 ปภ.", uri: "tel:1784" },
  { type: "uri", label: "โทร 1669", uri: "tel:1669" },
];
// A quick-reply label holds 20 characters; the full words go in the message.
const FAMILY_BUTTON = { type: "location", label: "ให้ครอบครัว · Family" };
const FAMILY_ASK = [
  "ส่งตำแหน่งให้ครอบครัว · Share my location with family:",
  "ตำแหน่งที่ส่งภายใน 10 นาทีขึ้นที่ลิงก์ครอบครัว พร้อมแผนที่และเวลา อยู่ 24 ชั่วโมง หรือจนกว่าจะส่ง “ปลอดภัย” อีกครั้ง ส่งตำแหน่งใหม่ หรือส่ง “ลบตำแหน่ง”",
  "A location sent in the next 10 minutes shows on the family link with a map and its time, for 24 hours, or until you mark safe again, send a new one, or send “ลบตำแหน่ง · clear location”.",
].join("\n");

async function familyLink(env, uid) {
  const token = randomHex(24);
  await env.DB.prepare("INSERT INTO safe_links (token_hash, user_id, created_at) VALUES (?, ?, ?)")
    .bind(await sha256hex(token), uid, Date.now()).run();
  return `${origin(env)}/safe/${token}`;
}

async function mark(env, uid, state, now) {
  await ensureName(env, uid);
  // A new "safe" ends the family location; "need help" leaves it standing.
  const clear = state === "safe" ? ", family_lat = NULL, family_lng = NULL, family_at = NULL" : "";
  await env.DB.prepare(`UPDATE dm_users SET safe_state = ?, safe_at = ?, updated_at = ?${clear} WHERE user_id = ?`)
    .bind(state, now, now, uid).run();
  await setPending(env, uid, state === "help" ? "family:help" : "family", now);
}

export async function markSafe(ev, env, uid) {
  if (!(await rate(env, uid, "safe", 10))) return say(env, ev, SLOW);
  const now = ev.timestamp || Date.now();
  await mark(env, uid, "safe", now);
  const link = await familyLink(env, uid);
  return sayMany(env, ev, [quick([
    "บันทึกว่าปลอดภัยแล้ว · Marked safe",
    when(now),
    "",
    "ลิงก์สำหรับครอบครัว · Link for your family",
    link,
    "หน้านี้แสดงชื่อ สถานะนี้ และเวลา · It shows your name, this mark and its time.",
    "",
    FAMILY_ASK,
  ].join("\n"), [FAMILY_BUTTON])]);
}

export async function needHelp(ev, env, uid, row) {
  const now = ev.timestamp || Date.now();
  await mark(env, uid, "help", now);
  // The numbers go out every time; a new family link, up to ten an hour.
  const link = (await rate(env, uid, "help", 10)) ? await familyLink(env, uid) : null;
  const lines = [
    "โทร 1784 ปภ. (ภัยพิบัติ) หรือ 1669 (เจ็บป่วยฉุกเฉิน)",
    "Call 1784 (disaster prevention) or 1669 (medical emergency).",
    "",
  ];
  if (fresh(row, now)) lines.push(...rescueLines(row.last_lat, row.last_lng));
  lines.push("ครอบครัวเห็นว่า “ต้องการความช่วยเหลือ” ที่ลิงก์ครอบครัว · Your family link shows “needs help”.");
  if (link) lines.push(link);
  lines.push("", FAMILY_ASK, "ตำแหน่งนี้ยังใช้หาหน่วยกู้ภัยที่ใกล้ที่สุดด้วย · It also finds the nearest rescue units.");
  return sayMany(env, ev, [quick(lines.join("\n"), [...CALL, FAMILY_BUTTON])]);
}

function rescueLines(lat, lng) {
  const near = units.units.map((u) => ({ ...u, m: metres(lat, lng, u.lat, u.lng) }))
    .sort((a, b) => a.m - b.m).slice(0, 3);
  return ["หน่วยกู้ภัยใกล้ที่สุด · Nearest rescue units (ระยะตรง · straight-line)",
    ...near.map((u) => `${u.th} — ${distance(u.m)}\n${u.phone}`), ""];
}

// A location sent in answer to the family button. `help` when it followed
// "need help": then it also gets the nearest rescue units.
export async function familyLocation(ev, env, uid, lat, lng, help) {
  const now = ev.timestamp || Date.now();
  await env.DB.prepare("UPDATE dm_users SET family_lat = ?, family_lng = ?, family_at = ?, updated_at = ? WHERE user_id = ?")
    .bind(lat, lng, now, now, uid).run();
  const lines = [
    "ลิงก์ครอบครัวแสดงตำแหน่งนี้แล้ว · Your family link shows this location now.",
    "แสดง 24 ชั่วโมง หรือจนกว่าจะส่ง “ปลอดภัย” อีกครั้ง ส่งตำแหน่งใหม่ หรือส่ง “ลบตำแหน่ง”",
    "It shows for 24 hours, or until you mark safe again, send a new one, or send “ลบตำแหน่ง · clear location”.",
  ];
  if (help) lines.push("", ...rescueLines(lat, lng));
  const share = shareBits(env, { lat, lng });
  lines.push("", ...share.lines);
  return sayMany(env, ev, [quick(lines.join("\n").trim(), help ? [...CALL, share.action] : [share.action, FAMILY_BUTTON])]);
}

export async function clearFamily(ev, env, uid) {
  await env.DB.prepare("UPDATE dm_users SET family_lat = NULL, family_lng = NULL, family_at = NULL WHERE user_id = ?").bind(uid).run();
  return say(env, ev, "ลบตำแหน่งออกจากลิงก์ครอบครัวแล้ว · The family link no longer shows a location.");
}

// ── the family page ──────────────────────────────────────────────────────────

const STYLE = `
*{box-sizing:border-box}
body{margin:0;background:#fffdf6;color:#1d1b16;font:19px/1.6 system-ui,-apple-system,"Noto Sans Thai","Sarabun",sans-serif}
main{max-width:560px;margin:0 auto;padding:28px 16px}
.k{margin:0;font-size:15px;font-weight:700;color:#d62828}
h1{margin:8px 0;font-size:30px;overflow-wrap:anywhere}
h2{margin:0 0 8px;font-size:22px}
.state{font-size:28px;font-weight:700;padding:14px 16px;border-radius:14px;margin:16px 0}
.safe{background:#e3f4e1;color:#1d5b1a}
.help{background:#fde2e0;color:#8a1410}
.where{margin:16px 0;padding:14px;border:2px solid #d62828;border-radius:14px}
.map{margin:0 0 10px}
.tiles{position:relative;width:320px;max-width:100%;height:200px;overflow:hidden;border-radius:12px;background:#e8e4da}
.tiles img{position:absolute}
.tiles svg{position:absolute;left:0;top:0}
.small{font-size:14px;color:#6b6457}
.open a{display:inline-block;margin:4px 12px 4px 0}
.en{color:#6b6457}
a{color:#d62828}
`;

function whereBlock(u) {
  const lat = Number(u.family_lat), lng = Number(u.family_lng);
  const ll = `${lat},${lng}`;
  return `<section class="where">
<h2>ตำแหน่งที่ส่งให้ครอบครัว <span class="en">· Location shared with family</span></h2>
${tileMap([{ lat, lng }])}
<p>${esc(when(u.family_at))}</p>
<p class="open">เปิดใน · open in<br>
<a href="https://www.openstreetmap.org/?mlat=${lat}&amp;mlon=${lng}#map=17/${lat}/${lng}" rel="noreferrer">OpenStreetMap</a>
<a href="https://www.google.com/maps/search/?api=1&amp;query=${ll}" rel="noreferrer">Google Maps</a>
<a href="https://maps.apple.com/?ll=${ll}&amp;q=${ll}" rel="noreferrer">Apple Maps</a>
<a href="geo:${ll}">geo:</a></p>
</section>`;
}

export async function serveSafe(request, env, path) {
  const m = /^\/safe\/([0-9a-f]{48})\/?$/.exec(path);
  const headers = {
    "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex",
    "referrer-policy": "no-referrer", "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'none'; img-src https://tile.openstreetmap.org; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'", // stylecheck: allow — CSP keyword
  };
  const page = (body, status = 200) => new Response(`<!doctype html>
<html lang="th"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>มดแดง · Mot Dang</title><style>${STYLE}</style></head>
<body><main><p class="k">มดแดง · Mot Dang</p>${body}</main></body></html>`, { status, headers });
  const gone = () => page(`<h1>ไม่พบลิงก์นี้ <span class="en">· No such link</span></h1>`, 404);
  if (!m) return gone();
  const link = await env.DB.prepare("SELECT user_id FROM safe_links WHERE token_hash = ?").bind(await sha256hex(m[1])).first();
  const u = link && (await env.DB.prepare("SELECT * FROM dm_users WHERE user_id = ?").bind(link.user_id).first());
  if (!u || !u.safe_state) return gone();
  const help = u.safe_state === "help";
  const where = u.family_at && Date.now() - u.family_at < FAMILY_MS && u.family_lat != null ? whereBlock(u) : "";
  const state = help
    ? `<p class="state help">ต้องการความช่วยเหลือ<br><span>needs help</span></p>`
    : `<p class="state safe">ปลอดภัย<br><span>safe</span></p>`;
  const name = `<h1>${esc(u.name || "ผู้ใช้ LINE · A LINE user")}</h1>`;
  const time = `<p>${esc(when(u.safe_at))}</p>`;
  // Asking for help puts where they are first.
  return page(`${help ? state + where + name + time : name + state + time + where}
<p class="en">ในเหตุฉุกเฉินโทร 1784 หรือ 1669 · In an emergency call 1784 or 1669.</p>`);
}
