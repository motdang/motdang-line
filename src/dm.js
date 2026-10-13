// What every one-to-one feature shares: the flags, who is writing, how the bot
// answers, a small rate counter, distance, and reading a command off a line.
//
// The website opens LINE with a message already typed (line.me/R/oaMessage)
// and the reader taps send; mot-dang/linedoor.py holds the other end of every
// prefix read here.

import { reply, replyMessages, profile, allow, content } from "./line.js";
import { screenText } from "./screen.js";
import { clean, lookAt } from "./photo.js";

export const HOUR = 3600 * 1000;
export const CONFIRM_MS = 10 * 60 * 1000;       // a question the bot asked stays open this long
export const FRESH_LOCATION_MS = 30 * 60 * 1000; // a shared location this recent is "where you are"

// One var per feature, each "off" in wrangler.jsonc. PAGES is the first
// build; the rest are the reasons to add Mot Dang on LINE (2026-09-28).
export const FLAGS = ["PAGES", "PINS", "ASK", "ALERTS", "STAMPS", "OWNERS", "SPOTTERS", "SAFE"];
export const flag = (env, name) => String(env[name] ?? "").toLowerCase() === "on";
export const directOn = (env) => FLAGS.some((f) => flag(env, f));

const pageBase = (env) => String(env.PAGE_BASE || "https://line.motdang.net/u/").replace(/\/?$/, "/");
export const pageLink = (env, slug) => pageBase(env) + slug;
// The Worker's own origin, worked out from PAGE_BASE so the family and card
// links move with it.
export const origin = (env) => new URL(pageBase(env)).origin;
export const site = (env) => String(env.SITE || "https://motdang.net").replace(/\/$/, "");

// A one-to-one chat is a person talking to the account and nobody else, so
// every event in it is addressed. The mute in line.js answers only a token
// registered with allow(); these register the one they are answering.
export const say = (env, ev, text) => { allow(ev.replyToken); return reply(env, ev.replyToken, text); };
export const sayMany = (env, ev, messages) => { allow(ev.replyToken); return replyMessages(env, ev.replyToken, messages); };
export const quick = (text, items) => ({ type: "text", text, quickReply: { items: items.slice(0, 13).map((action) => ({ type: "action", action })) } });
export const LOCATION_BUTTON = { type: "location", label: "ตำแหน่ง · Location" };
export const askLocation = (env, ev, text) => sayMany(env, ev, [quick(
  text || "ขอตำแหน่งของคุณ แตะปุ่มด้านล่าง\nShare your location with the button below.", [LOCATION_BUTTON])]);

// ── who is writing ───────────────────────────────────────────────────────────

export async function userRow(env, uid) {
  return env.DB.prepare("SELECT * FROM dm_users WHERE user_id = ?").bind(uid).first();
}

export async function ensureUser(env, uid) {
  const now = Date.now();
  await env.DB.prepare("INSERT OR IGNORE INTO dm_users (user_id, created_at, updated_at) VALUES (?, ?, ?)")
    .bind(uid, now, now).run();
  return userRow(env, uid);
}

export async function setPending(env, uid, what, at = Date.now()) {
  await env.DB.prepare("UPDATE dm_users SET pending = ?, pending_at = ? WHERE user_id = ?")
    .bind(what, what ? at : null, uid).run();
}

export function cleanName(s, max = 40) {
  return String(s ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

// Their LINE display name, screened for anywhere public, stored on first use.
export async function ensureName(env, uid) {
  const row = await ensureUser(env, uid);
  if (row.name) return row;
  const name = cleanName(await profile(env, uid));
  if (!name) return row;
  const ok = (await screenText(env, name)).ok;
  await env.DB.prepare("UPDATE dm_users SET name = ?, name_ok = ?, updated_at = ? WHERE user_id = ?")
    .bind(name, ok ? 1 : 0, Date.now(), uid).run();
  return userRow(env, uid);
}

// Ten characters from an alphabet with no look-alikes. Random, so a page's
// address says nothing about the LINE account behind it.
const SLUG_CHARS = "abcdefghijkmnpqrstuvwxyz23456789";
export const SLUG_RE = /^[a-z2-9]{10}$/;
function newSlug() {
  return Array.from(crypto.getRandomValues(new Uint8Array(10)), (x) => SLUG_CHARS[x % SLUG_CHARS.length]).join("");
}

// A slug for this person, made the first time one is needed: their page, or
// a stamp card.
export async function ensurePage(env, uid) {
  const row = await ensureName(env, uid);
  if (row.slug) return row;
  for (let tries = 0; tries < 3; tries++) {
    try {
      await env.DB.prepare("UPDATE dm_users SET slug = ?, updated_at = ? WHERE user_id = ? AND slug IS NULL")
        .bind(newSlug(), Date.now(), uid).run();
      break;
    } catch (e) {
      if (!/UNIQUE/i.test(String(e?.message))) throw e;
    }
  }
  return userRow(env, uid);
}

export const fresh = (row, now, ms = FRESH_LOCATION_MS) =>
  !!(row && row.last_loc_at && row.last_lat != null && now - row.last_loc_at < ms);

// ── limits ───────────────────────────────────────────────────────────────────

// Per person, per feature, per clock hour. True when this one is allowed.
export async function rate(env, uid, bucket, max) {
  const hour = Math.floor(Date.now() / HOUR);
  const r = await env.DB.prepare("SELECT hour, n FROM dm_rate WHERE user_id = ? AND bucket = ?").bind(uid, bucket).first();
  const n = r && r.hour === hour ? r.n : 0;
  if (n >= max) return false;
  await env.DB.prepare(
    `INSERT INTO dm_rate (user_id, bucket, hour, n) VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id, bucket) DO UPDATE SET hour = excluded.hour, n = excluded.n`,
  ).bind(uid, bucket, hour, n + 1).run();
  return true;
}

export const SLOW = "ส่งเร็วไปหน่อย พักสักครู่แล้วส่งใหม่ · That is a lot at once. Wait a while and send again.";

// ── small sums ───────────────────────────────────────────────────────────────

export function metres(aLat, aLng, bLat, bLng) {
  const r = Math.PI / 180;
  const d = Math.sin(((bLat - aLat) * r) / 2) ** 2 +
    Math.cos(aLat * r) * Math.cos(bLat * r) * Math.sin(((bLng - aLng) * r) / 2) ** 2;
  return 6371000 * 2 * Math.asin(Math.sqrt(d));
}

export const distance = (m) => (m < 950 ? `${Math.round(m / 10) * 10} ม. · m` : `${(m / 1000).toFixed(1)} กม. · km`);

// YYYY-MM on Bangkok's clock.
export const month = (ts = Date.now()) => new Date(ts + 7 * HOUR).toISOString().slice(0, 7);

export function when(ts) {
  const d = new Date(ts);
  const o = { timeZone: "Asia/Bangkok", day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" };
  return `${d.toLocaleString("th-TH", o)} · ${d.toLocaleString("en-GB", o)}`;
}

export async function sha256hex(s) {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, "0")).join("");
}

export function randomHex(bytes = 24) {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (x) => x.toString(16).padStart(2, "0")).join("");
}

// ── reading a command ────────────────────────────────────────────────────────

// "หมุด · pins https://…", "หมุด https://…" and "pins https://…" are one
// command. `words` is [thai, english]; the answer is the rest of the line, ""
// when there is none, or null when the line is not this command.
export function command(text, words, { rest = false } = {}) {
  const t = String(text || "").trim().replace(/\s*·\s*/, " · ");
  const low = t.toLowerCase();
  const [th, en] = words;
  const forms = [`${th} · ${en}`, th, en].filter(Boolean).sort((a, b) => b.length - a.length);
  for (const f of forms) {
    const fl = f.toLowerCase();
    if (low === fl) return "";
    if (rest && low.startsWith(fl) && /\s/.test(low[fl.length] || "")) return t.slice(f.length).trim();
  }
  return null;
}

// ── a photo, checked ─────────────────────────────────────────────────────────

// The bytes from LINE, cleaned and looked at. { refuse: {why, text} } or
// { bytes, kind, gps, type, ext, look }.
export async function checkedPhoto(env, messageId) {
  const got = await content(env, messageId);
  if (!got) return { refuse: { why: "no-bytes", text: "รูปนี้ส่งมาไม่ถึง ลองส่งใหม่ · That photo did not come through. Send it again?", keep: false } };
  const c = clean(got.body);
  if (c.error === "size") return { refuse: { why: "size", text: "รูปใหญ่เกินไป ส่งเป็นรูปภาพแทนไฟล์ · That file is too large. Send it as a photo instead." } };
  if (c.error) return { refuse: { why: c.error, text: "เปิดรูปนี้ไม่ได้ ส่งเป็นรูปภาพ JPEG หรือ PNG · That file could not be read. Send it as a JPEG or PNG photo." } };
  const look = await lookAt(env, c.bytes, c.kind);
  if (look.verdict === "refuse") {
    return { refuse: { why: look.why, text: look.why === "person" || look.why === "sexual"
      ? "รูปนี้ไม่ขึ้นหน้า หน้าในมดแดงแสดงสถานที่ อาหาร และสิ่งของ ไม่แสดงคน · This photo stays off the page. Pages show places, food and things, not people."
      : "ตรวจรูปนี้ไม่สำเร็จ ลองส่งใหม่ · This photo could not be checked. Send it again?" } };
  }
  return { ...c, look, type: c.kind === "png" ? "image/png" : "image/jpeg", ext: c.kind === "png" ? "png" : "jpg" };
}
