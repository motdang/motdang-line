// Mot Dang pages from LINE — the one-to-one side of the account.
//
// Nan, 2026-09-28: "a better line integration to offer as a free subscription
// (similar to yahoo personal sites) that's based entirely in a line app,
// changes no user behavior". Who gets one: "anyone". Later the same day, to
// the reasons to add Mot Dang on LINE: "let's do all of those, and also mae
// hong son passport".
//
// So this file reads every one-to-one event and hands it to the feature it
// belongs to. Each feature has its own var, "off" until turned on:
//
//   PAGES     a page at /u/<slug> from the photos, text and locations sent;
//             rain and flood buttons; name, delete, privacy
//   PINS      pin sets and plans from the map, kept and listed   (pins.js)
//   ASK       nearest pharmacy/fuel/toilet/hospital/7-Eleven to a shared
//             location; a question gets a search link           (ask.js)
//   ALERTS    river and dust warnings for a saved place, pushed  (alerts.js)
//   STAMPS    the nine-wat and Mae Hong Son rounds               (stamps.js)
//   OWNERS    shop owners editing their place by chat            (owners.js)
//   SPOTTERS  a count and a credit for rain and flood answers    (weather.js)
//   SAFE      mark safe, need help, the family link              (safe.js)
//
// Everything here answers with the free reply token. The only push is an
// alert, through its own door in line.js. The team group never reaches this
// file: worker.js sends only source.type "user" here.

import { screenText } from "./screen.js";
import { renderPage, notFoundPage } from "./page.js";
import {
  flag, directOn, pageLink, say, sayMany, quick, userRow, ensureUser, ensurePage, setPending, cleanName, command,
  fresh, SLUG_RE, CONFIRM_MS, HOUR, checkedPhoto, when, site,
} from "./dm.js";
import { savePins, listPins, pinSetsFor } from "./pins.js";
import { nearReply, nearKind, isQuestion, questionReply } from "./ask.js";
import { saveHome, homeAt, stopAlerts } from "./alerts.js";
import { passport, stampAt, stampReply, renderCard } from "./stamps.js";
import { claim, ownerOff, activeClaim, ownerText, ownerPhoto } from "./owners.js";
import { OBS, askObs, observe, forward, credit } from "./weather.js";
import { markSafe, needHelp, familyLocation, clearFamily, FAMILY_MS } from "./safe.js";
import { shareBits } from "./plus.js";

export { directOn };
export const pagesOn = (env) => flag(env, "PAGES");

export const LIMITS = {
  perHour: 30,      // things sent to a page in an hour
  perDay: 200,      // and in a day
  total: 1000,      // on one page, ever
  text: 1000,       // characters kept from one message
  name: 40,         // characters in a page name
};

// ── what it says ─────────────────────────────────────────────────────────────

const welcome = (link) => [
  "สวัสดีค่ะ รูป ข้อความ และตำแหน่งที่ส่งมาที่นี่ จะขึ้นในหน้าของคุณบนมดแดง หลังผ่านการตรวจ",
  "Hello. Photos, messages and locations you send here go on your Mot Dang page after a check.",
  "",
  link,
  "",
  "รูปที่มีคนอยู่ในภาพไม่ขึ้นหน้า · Photos with people in them stay off the page.",
  "ส่ง “ลบ” เพื่อลบหน้า · Send “delete” to remove it.",
].join("\n");

function help(env, row) {
  const out = [];
  if (flag(env, "PAGES")) {
    out.push(row?.slug ? `หน้าของคุณ · Your page\n${pageLink(env, row.slug)}` : "ยังไม่มีหน้า ส่งรูปมาเพื่อเริ่ม · No page yet. Send a photo to start one.", "",
      "• ส่งรูป ข้อความ หรือตำแหน่ง · Send photos, messages or a location", "• ชื่อ <ชื่อใหม่> · name <new name>");
  }
  if (flag(env, "PINS")) out.push("• หมุด · pins — หมุดและแผนที่เก็บไว้ · your kept pins and plans");
  if (flag(env, "ASK")) out.push("• ส่งตำแหน่ง · share a location — ที่ใกล้ที่สุด · what is nearest");
  if (flag(env, "ALERTS")) out.push("• บ้าน · home — เตือนภัยสำหรับที่นี้ · alerts for this place", "• หยุดเตือน · stop alerts"); // stylecheck: allow — เตือน = the opt-in alerts feature name
  if (flag(env, "STAMPS")) out.push("• พาสปอร์ต · passport — รอบประทับตรา · stamp rounds");
  if (flag(env, "OWNERS")) out.push("• เจ้าของ · owner MD-XXXXX — แก้ข้อมูลร้านของคุณ · edit your place");
  if (flag(env, "SPOTTERS")) out.push("• ชื่อบนหน้าอากาศ · credit me");
  if (flag(env, "SAFE")) out.push("• ปลอดภัย · safe", "• ต้องการความช่วยเหลือ · need help", "• ลบตำแหน่ง · clear location");
  out.push("• ความลับ · privacy", "• ลบ · delete");
  return out.join("\n");
}

const GOT = (link) => `รับแล้ว · Got it.\n${link}`;

// How much this person has posted lately. Refused and held rows count as
// well, so a stream of refused photos slows down like any other.
async function overLimit(env, uid, now) {
  const n = async (sql, ...b) => (await env.DB.prepare(sql).bind(...b).first())?.n ?? 0;
  if (await n("SELECT COUNT(*) n FROM page_items WHERE user_id = ?", uid) >= LIMITS.total) return "full";
  if (await n("SELECT COUNT(*) n FROM page_items WHERE user_id = ? AND ts >= ?", uid, now - HOUR) >= LIMITS.perHour) return "slow";
  if (await n("SELECT COUNT(*) n FROM page_items WHERE user_id = ? AND ts >= ?", uid, now - 24 * HOUR) >= LIMITS.perDay) return "slow";
  return null;
}

const LIMIT_TEXT = {
  full: "หน้านี้เต็มแล้ว · This page is full.",
  slow: "ส่งเร็วไปหน่อย พักสักครู่แล้วส่งใหม่ · That is a lot at once. Wait a while and send again.",
};

// ── the events ───────────────────────────────────────────────────────────────

export async function onDirect(ev, env) {
  const uid = ev.source?.userId;
  if (!uid) return;
  if (ev.type === "follow") return flag(env, "PAGES") ? onFollow(ev, env, uid) : undefined;
  // Blocking the account ends the alerts: a push to them can only fail.
  if (ev.type === "unfollow") {
    await env.DB.prepare("DELETE FROM alert_places WHERE user_id = ?").bind(uid).run();
    return;
  }
  if (ev.type === "postback") return onPostback(ev, env, uid);
  if (ev.type !== "message") return;
  const m = ev.message || {};
  if (m.type === "text") return onText(ev, m, env, uid);
  if (m.type === "image") return onPhoto(ev, m, env, uid);
  if (m.type === "file" && /\.(jpe?g|png)$/i.test(m.fileName || "")) return onPhoto(ev, m, env, uid);
  if (m.type === "location") return onLocation(ev, m, env, uid);
  // Stickers, voice, video: kept nowhere, answered with nothing.
}

async function onFollow(ev, env, uid) {
  const row = await ensurePage(env, uid);
  await say(env, ev, welcome(pageLink(env, row.slug)));
}

const CONFIRM = /^(ลบเลย|ยืนยัน|yes|confirm|delete it)$/i;
const CANCEL = /^(เก็บไว้|ยกเลิก|ไม่|keep|no|cancel)$/i;
const HELP = /^(help|\?|ช่วย|วิธีใช้)$/i;
const MINE = /^(หน้าของฉัน|หน้าฉัน|ลิงก์|my page|page|link)$/i;
const NAME = /^(?:name|ชื่อ)\s+([\s\S]+)$/i;
const W = {
  del: ["ลบ", "delete"], privacy: ["ความลับ", "privacy"], pins: ["หมุด", "pins"], plan: ["แผน", "plan"],
  passport: ["พาสปอร์ต", "passport"], safe: ["ปลอดภัย", "safe"], helpme: ["ต้องการความช่วยเหลือ", "need help"],
  clearloc: ["ลบตำแหน่ง", "clear location"], home: ["บ้าน", "home"], stop: ["หยุดเตือน", "stop alerts"], owner: ["เจ้าของ", "owner"], // stylecheck: allow — เตือน = the opt-in alerts feature name
  credit: ["ชื่อบนหน้าอากาศ", "credit me"],
};

async function onText(ev, m, env, uid) {
  const text = String(m.text || "").trim();
  if (!text) return;
  const now = ev.timestamp || Date.now();
  let row = await ensureUser(env, uid);
  const is = (w, opts) => command(text, W[w], opts);
  await endFamilyAsk(env, uid, row);

  // "ลบ" was sent a moment ago and this is the answer to "are you sure?".
  if (row.pending === "delete" && now - (row.pending_at || 0) < CONFIRM_MS) {
    if (CONFIRM.test(text) || is("del") !== null) return deleteAll(ev, env, uid);
    await setPending(env, uid, null);
    if (CANCEL.test(text)) return say(env, ev, "เก็บไว้ตามเดิม · Kept as it is.");
  }

  if (is("del") !== null || /^(ลบหน้า|delete my page)$/i.test(text)) {
    if (!(await holdsAnything(env, uid, row))) return say(env, ev, "ยังไม่มีอะไรให้ลบ · There is nothing to delete.");
    await setPending(env, uid, "delete", now);
    return sayMany(env, ev, [quick(
      "ลบหน้า รูป และทุกอย่างที่เก็บไว้ของคุณ? ส่ง “ลบ” อีกครั้งเพื่อยืนยัน\nDelete your page, its photos and everything else kept for you? Send “delete” again to confirm." +
        (row.slug && flag(env, "PAGES") ? `\n${pageLink(env, row.slug)}` : ""),
      [{ type: "message", label: "ลบเลย · Delete", text: "ลบเลย" }, { type: "message", label: "เก็บไว้ · Keep", text: "เก็บไว้" }],
    )]);
  }
  if (is("privacy") !== null) return privacy(ev, env, uid, row);
  if (HELP.test(text)) return say(env, ev, help(env, row));

  if (flag(env, "PINS")) {
    const p = is("pins", { rest: true });
    if (p !== null) return p ? savePins(ev, env, uid, "pins", p) : listPins(ev, env, uid);
    const q = is("plan", { rest: true });
    if (q) return savePins(ev, env, uid, "plan", q);
  }
  if (flag(env, "STAMPS")) {
    const r = is("passport", { rest: true });
    if (r !== null) return passport(ev, env, uid, r);
  }
  if (flag(env, "SAFE")) {
    if (is("safe") !== null) return markSafe(ev, env, uid);
    if (is("helpme") !== null || /^(ช่วยด้วย|sos)$/i.test(text)) return needHelp(ev, env, uid, row);
    if (is("clearloc") !== null) return clearFamily(ev, env, uid);
  }
  if (flag(env, "ALERTS")) {
    if (is("home") !== null) return saveHome(ev, env, uid, row);
    if (is("stop") !== null) return stopAlerts(ev, env, uid);
  }
  if (flag(env, "OWNERS")) {
    const o = is("owner", { rest: true });
    if (o !== null) return /^(off|ปิด|stop)$/i.test(o) ? ownerOff(ev, env, uid) : claim(ev, env, uid, o);
  }
  if (flag(env, "SPOTTERS")) {
    if (is("credit") !== null) return credit(ev, env, uid, true);
    if (/^credit off$/i.test(text)) return credit(ev, env, uid, false);
  }
  if (flag(env, "PAGES")) {
    if (MINE.test(text)) {
      const page = await ensurePage(env, uid);
      return say(env, ev, pageLink(env, page.slug));
    }
    const named = NAME.exec(text);
    if (named) return rename(ev, env, uid, named[1]);
  }

  // An approved owner's words go to their place.
  if (flag(env, "OWNERS")) {
    const c = await activeClaim(env, row);
    if (c) return ownerText(ev, env, uid, c, m, text);
  }
  // A question is not a post: it gets a search link.
  if (flag(env, "ASK") && isQuestion(text)) return questionReply(ev, env, text);
  if (!flag(env, "PAGES")) return;

  // Anything else is a post.
  const seen = await env.DB.prepare("SELECT 1 FROM page_items WHERE message_id = ?").bind(m.id).first();
  if (seen) return;
  const limit = await overLimit(env, uid, now);
  if (limit) return say(env, ev, LIMIT_TEXT[limit]);
  const page = await ensurePage(env, uid);
  const body = text.length > LIMITS.text ? text.slice(0, LIMITS.text - 1) + "…" : text;
  const s = await screenText(env, body);
  await env.DB.prepare(
    `INSERT OR IGNORE INTO page_items (user_id, message_id, ts, kind, text, status, why)
     VALUES (?, ?, ?, 'text', ?, ?, ?)`,
  ).bind(uid, m.id, now, body, s.ok ? "shown" : "held", s.why || null).run();
  // The same words whether it showed or was held, so the screen cannot be
  // probed one message at a time.
  await say(env, ev, GOT(pageLink(env, page.slug)));
}

async function rename(ev, env, uid, wanted) {
  const name = cleanName(wanted, LIMITS.name);
  const page = await ensurePage(env, uid);
  if (!name) return say(env, ev, help(env, page));
  const s = await screenText(env, name);
  await env.DB.prepare("UPDATE dm_users SET name = ?, name_ok = ?, updated_at = ? WHERE user_id = ?")
    .bind(name, s.ok ? 1 : 0, Date.now(), uid).run();
  await say(env, ev, GOT(pageLink(env, page.slug)));
}

async function onPhoto(ev, m, env, uid) {
  const row = await ensureUser(env, uid);
  if (flag(env, "OWNERS")) {
    const c = await activeClaim(env, row);
    if (c) return ownerPhoto(ev, env, uid, c, m);
  }
  if (!flag(env, "PAGES")) return;
  const now = ev.timestamp || Date.now();
  const seen = await env.DB.prepare("SELECT 1 FROM page_items WHERE message_id = ?").bind(m.id).first();
  if (seen) return;
  const limit = await overLimit(env, uid, now);
  if (limit) return say(env, ev, LIMIT_TEXT[limit]);
  const page = await ensurePage(env, uid);
  // Several photos sent together arrive as an image set, one event each. Only
  // the last one says "got it"; a refusal speaks whenever it happens.
  const set = m.imageSet;
  const last = !set || !set.total || Number(set.index) >= Number(set.total);

  const p = await checkedPhoto(env, m.id);
  if (p.refuse) {
    if (p.refuse.keep !== false) {
      await env.DB.prepare(
        `INSERT OR IGNORE INTO page_items (user_id, message_id, ts, kind, status, why) VALUES (?, ?, ?, 'photo', 'refused', ?)`,
      ).bind(uid, m.id, now, p.refuse.why).run();
    }
    return say(env, ev, p.refuse.text);
  }
  const key = `pages/${page.slug}/${m.id}.${p.ext}`;
  await env.INBOX.put(key, p.bytes, { httpMetadata: { contentType: p.type } });
  await env.DB.prepare(
    `INSERT OR IGNORE INTO page_items (user_id, message_id, ts, kind, photo_key, photo_type, photo_bytes, lat, lng, status, why)
     VALUES (?, ?, ?, 'photo', ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(uid, m.id, now, key, p.type, p.bytes.byteLength, p.gps?.lat ?? null, p.gps?.lng ?? null,
         p.look.verdict === "ok" ? "shown" : "held", p.look.why || null).run();
  if (last) await say(env, ev, GOT(pageLink(env, page.slug)));
}

// A location from the paperclip. Kept privately as the last place this person
// stood. Whatever the bot last asked a location for gets it first; then a
// stamp; then the nearest places; then, with only PAGES on, a pin on the page.
async function onLocation(ev, m, env, uid) {
  const lat = Number(m.latitude), lng = Number(m.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return;
  const now = ev.timestamp || Date.now();
  const row = await ensureUser(env, uid);
  await env.DB.prepare("UPDATE dm_users SET last_lat = ?, last_lng = ?, last_loc_at = ?, updated_at = ? WHERE user_id = ?")
    .bind(lat, lng, now, now, uid).run();

  const waiting = row.pending && now - (row.pending_at || 0) < CONFIRM_MS ? row.pending : null;
  if (waiting && waiting !== "delete") {
    await setPending(env, uid, null);
    const obs = /^(rain|flood):(\w+)$/.exec(waiting);
    if (obs) return forward(ev, env, uid, obs[1], obs[2], lat, lng);
    // Only a location sent for the family button reaches the family page.
    if (waiting.startsWith("family") && flag(env, "SAFE")) return familyLocation(ev, env, uid, lat, lng, waiting === "family:help");
    if (waiting === "home" && flag(env, "ALERTS")) return homeAt(ev, env, uid, lat, lng);
    if (waiting === "near" && flag(env, "ASK")) return nearReply(ev, env, uid, lat, lng, { pin: flag(env, "PAGES") });
  }
  if (flag(env, "STAMPS")) {
    const got = await stampAt(env, uid, lat, lng, now);
    if (got.length) return stampReply(ev, env, uid, got);
  }
  if (flag(env, "ASK")) return nearReply(ev, env, uid, lat, lng, { pin: flag(env, "PAGES") });
  if (flag(env, "PAGES")) return pinHere(ev, env, uid, m.id, lat, lng, now);
}

async function pinHere(ev, env, uid, messageId, lat, lng, now) {
  const seen = await env.DB.prepare("SELECT 1 FROM page_items WHERE message_id = ?").bind(messageId).first();
  if (seen) return;
  const limit = await overLimit(env, uid, now);
  if (limit) return say(env, ev, LIMIT_TEXT[limit]);
  const page = await ensurePage(env, uid);
  await env.DB.prepare(
    `INSERT OR IGNORE INTO page_items (user_id, message_id, ts, kind, lat, lng, status) VALUES (?, ?, ?, 'location', ?, ?, 'shown')`,
  ).bind(uid, messageId, now, lat, lng).run();
  const share = shareBits(env, { lat, lng });
  await sayMany(env, ev, [quick([`ปักหมุดบนแผนที่ในหน้าแล้ว · Pinned on your page map.`, pageLink(env, page.slug), "",
    ...share.lines].join("\n"), [share.action])]);
}

// ── the rich-menu buttons and quick replies ──────────────────────────────────

// The family button counts only while it is the latest thing the bot asked:
// any text or button after it ends it, so a location sent later for a stamp
// or the nearest places does not reach the family page.
async function endFamilyAsk(env, uid, row) {
  if (row?.pending && row.pending.startsWith("family")) {
    await setPending(env, uid, null);
    row.pending = null;
  }
}

async function onPostback(ev, env, uid) {
  await endFamilyAsk(env, uid, await userRow(env, uid));
  const p = new URLSearchParams(String(ev.postback?.data || "").slice(0, 300));
  const a = p.get("a");
  const now = ev.timestamp || Date.now();
  const weather = flag(env, "PAGES") || flag(env, "SPOTTERS");
  if (a === "page" && flag(env, "PAGES")) {
    const page = await ensurePage(env, uid);
    return say(env, ev, pageLink(env, page.slug));
  }
  if ((a === "rain" || a === "flood") && weather) return askObs(ev, env, a);
  if (a === "near") {
    const row = await ensureUser(env, uid);
    if (!flag(env, "ASK")) return flag(env, "PAGES") ? say(env, ev, `${site(env)}/here.html`) : undefined;
    if (p.get("k")) return nearKind(ev, env, uid, row, p.get("k"));
    if (fresh(row, now)) return nearReply(ev, env, uid, row.last_lat, row.last_lng, { pin: flag(env, "PAGES") });
    await setPending(env, uid, "near", now);
    return sayMany(env, ev, [quick("ส่งตำแหน่งเพื่อดูที่ใกล้ที่สุด\nShare your location to see what is nearest.", [{ type: "location", label: "ตำแหน่ง · Location" }])]);
  }
  if (a === "pin" && flag(env, "PAGES")) {
    const row = await ensureUser(env, uid);
    if (!fresh(row, now)) return say(env, ev, "ส่งตำแหน่งก่อน · Share a location first.");
    return pinHere(ev, env, uid, `pin-${uid}-${row.last_loc_at}`, row.last_lat, row.last_lng, now);
  }
  if (a === "safe" && flag(env, "SAFE")) {
    return sayMany(env, ev, [quick("ปลอดภัย หรือ ต้องการความช่วยเหลือ?\nSafe, or do you need help?", [
      { type: "message", label: "ปลอดภัย · Safe", text: "ปลอดภัย · safe" },
      { type: "message", label: "ช่วยด้วย · Help", text: "ต้องการความช่วยเหลือ · need help" },
    ])]);
  }
  if (a === "passport" && flag(env, "STAMPS")) return passport(ev, env, uid, "");
  if (!weather) return;
  for (const kind of ["rain", "flood"]) {
    const answer = p.get(kind);
    if (answer && Object.hasOwn(OBS[kind], answer)) return observe(ev, env, uid, await ensureUser(env, uid), kind, answer);
  }
}

// ── privacy and delete ───────────────────────────────────────────────────────

const count = async (env, sql, ...b) => (await env.DB.prepare(sql).bind(...b).first())?.n ?? 0;

async function holdsAnything(env, uid, row) {
  if (row.slug || row.last_loc_at || row.name || row.safe_state) return true;
  for (const t of ["page_items", "pin_sets", "alert_places", "stamps", "owner_claims", "weather_reports", "safe_links"]) {
    if (await count(env, `SELECT COUNT(*) n FROM ${t} WHERE user_id = ?`, uid)) return true;
  }
  return false;
}

// What this bot holds for this person, read from the tables, in plain words.
async function privacy(ev, env, uid, row) {
  const c = (t, extra = "") => count(env, `SELECT COUNT(*) n FROM ${t} WHERE user_id = ?${extra}`, uid);
  const lines = ["ความลับ · Privacy", "สิ่งที่บอทนี้เก็บไว้ของคุณตอนนี้ · What this bot holds for you now:", ""];
  lines.push("• รหัสผู้ใช้ LINE ของคุณ ผูกกับทุกอย่างข้างล่าง · Your LINE user id, kept with everything below");
  if (row.name) lines.push(`• ชื่อ · Name: ${row.name} (จากโปรไฟล์ LINE หรือคำสั่ง ชื่อ · from your LINE profile or “name”)`);
  if (row.slug) {
    const posts = await c("page_items", " AND kind = 'text'"), photos = await c("page_items", " AND kind = 'photo'"), pins = await c("page_items", " AND kind = 'location'");
    lines.push(`• หน้า · Page: ${pageLink(env, row.slug)}`,
      `  ข้อความ ${posts} รูป ${photos} หมุด ${pins} (รวมที่ถูกกักไว้) · ${posts} messages, ${photos} photos, ${pins} map pins, held ones included`,
      "  ตำแหน่งในไฟล์รูปเก็บไว้ ไม่แสดงบนหน้า · A photo file's own location is kept and not shown on the page");
  }
  if (row.last_loc_at) lines.push(`• ตำแหน่งล่าสุดที่ส่งมา · Last location you shared: ${when(row.last_loc_at)} (ไม่แสดงบนหน้าหรือลิงก์ครอบครัว · not on your page or a family link)`);
  const pinSets = await c("pin_sets");
  if (pinSets) lines.push(`• หมุดและแผน · Pin sets and plans: ${pinSets}`);
  if (await c("alert_places")) lines.push("• ที่สำหรับเตือนภัย ราว 100 ม. · Your alert place, to about 100 m, and a log of alerts sent to you"); // stylecheck: allow — เตือน = the opt-in alerts feature name
  const st = await c("stamps");
  if (st) lines.push(`• ตราประทับ · Stamps: ${st}`);
  const oc = await c("owner_claims"), oe = await c("owner_edits", " AND pulled_at IS NULL");
  if (oc) lines.push(`• คำขอเป็นเจ้าของ · Owner claims: ${oc}; รอส่ง · edits not yet taken: ${oe}`);
  const wr = await c("weather_reports");
  if (wr) lines.push(`• รายงานฝนและน้ำ · Rain and flood reports counted: ${wr}${row.credit ? " (ชื่ออยู่ใน /spotters · your name is on /spotters)" : ""}`);
  if (row.safe_state) {
    lines.push(`• สถานะ · Mark: ${row.safe_state === "help" ? "ต้องการความช่วยเหลือ · need help" : "ปลอดภัย · safe"}, ${when(row.safe_at)}; ลิงก์ครอบครัว · family links: ${await c("safe_links")}`,
      "  ลิงก์ครอบครัวแสดงชื่อ สถานะ และเวลา · A family link shows your name, the mark and its time");
  }
  if (row.family_at && Date.now() - row.family_at < FAMILY_MS) {
    lines.push(`• ตำแหน่งที่ส่งให้ครอบครัว · Location shared with family: ${when(row.family_at)}, ตรงตามที่ส่ง · exact, as sent`,
      "  แสดงที่ลิงก์ครอบครัว 24 ชั่วโมง หรือจนกว่าจะส่ง “ปลอดภัย” ตำแหน่งใหม่ หรือ “ลบตำแหน่ง” · It shows on family links for 24 hours, or until your next “safe”, a new one, or “ลบตำแหน่ง · clear location”");
  }
  lines.push("",
    "ส่ง “ลบ · delete” สองครั้ง: ลบทุกอย่างข้างบน รวมทั้งรูป",
    "Send “delete” twice: that removes everything above, the photos included.",
    "รายงานฝนและน้ำที่ส่งไปแผนที่อากาศแล้ว อยู่ที่นั่นด้วยรหัสที่ทำจากรหัส LINE ไม่ใช่ตัวรหัส · Rain and flood answers already sent to the weather map stay there under a code made from your LINE id, not the id itself.",
    "ข้อมูลจากเจ้าของร้านที่คนของมดแดงรับไปแล้ว อยู่กับสถานที่นั้น · Owner edits a person at Mot Dang has already taken stay with the place.");
  return say(env, ev, lines.join("\n"));
}

// Everything with this user id on it, photos in R2 included.
async function deleteAll(ev, env, uid) {
  const keys = [
    ...((await env.DB.prepare("SELECT photo_key FROM page_items WHERE user_id = ? AND photo_key IS NOT NULL").bind(uid).all()).results || []),
    ...((await env.DB.prepare("SELECT photo_key FROM owner_edits WHERE user_id = ? AND photo_key IS NOT NULL AND pulled_at IS NULL").bind(uid).all()).results || []),
  ];
  for (const r of keys) await env.INBOX.delete(r.photo_key);
  for (const t of ["page_items", "pin_sets", "alert_places", "alert_log", "rounds_started", "stamps", "owner_edits",
    "owner_claims", "weather_reports", "safe_links", "dm_rate", "dm_users"]) {
    await env.DB.prepare(`DELETE FROM ${t} WHERE user_id = ?`).bind(uid).run();
  }
  await say(env, ev, "ลบหน้า รูป และทุกอย่างที่เก็บไว้ของคุณแล้ว\nYour page, its photos and everything else kept for you are deleted.");
}

// ── serving the page ─────────────────────────────────────────────────────────

const PAGE_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "public, max-age=60",
  "content-security-policy": "default-src 'none'; img-src 'self' https://tile.openstreetmap.org; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'", // stylecheck: allow — CSP keyword
  "x-content-type-options": "nosniff",
  "x-robots-tag": "noindex",
};

// GET /u/<slug>, /u/<slug>/<id>.jpg|png and /u/<slug>/card/<round>.
// Returns null for any other path.
export async function servePage(request, env, path) {
  const m = /^\/u\/([^/]+)(?:\/(\d{1,12})\.(jpg|png)|\/card\/([a-z0-9-]{1,20}))?\/?$/.exec(path);
  if (!m) return null;
  if (request.method !== "GET" && request.method !== "HEAD") return new Response("GET only", { status: 405 });
  const [, slug, id, , round] = m;
  const missing = () => new Response(notFoundPage(), { status: 404, headers: PAGE_HEADERS });
  if (!SLUG_RE.test(slug)) return missing();
  const user = await env.DB.prepare("SELECT * FROM dm_users WHERE slug = ?").bind(slug).first();
  if (!user) return missing();

  if (round) {
    if (!flag(env, "STAMPS")) return missing();
    const html = await renderCard(env, user, round);
    return html ? new Response(html, { headers: PAGE_HEADERS }) : missing();
  }
  if (!flag(env, "PAGES")) return missing();

  if (id) {
    const item = await env.DB.prepare(
      "SELECT * FROM page_items WHERE id = ? AND user_id = ? AND kind = 'photo' AND status = 'shown'",
    ).bind(Number(id), user.user_id).first();
    const obj = item && (await env.INBOX.get(item.photo_key));
    if (!obj) return new Response("not here", { status: 404 });
    return new Response(obj.body, { headers: {
      "content-type": item.photo_type === "image/png" ? "image/png" : "image/jpeg",
      "cache-control": "public, max-age=300",
      "x-content-type-options": "nosniff",
      "x-robots-tag": "noindex",
    } });
  }

  // A photo's own lat/lng came out of its EXIF and is not read here.
  const items = await env.DB.prepare(
    `SELECT id, ts, kind, text, photo_type,
            CASE WHEN kind = 'location' THEN lat END AS lat, CASE WHEN kind = 'location' THEN lng END AS lng
       FROM page_items WHERE user_id = ? AND status = 'shown' ORDER BY ts DESC, id DESC LIMIT 300`,
  ).bind(user.user_id).all();
  const sets = flag(env, "PINS") ? await pinSetsFor(env, user.user_id) : [];
  return new Response(renderPage(user, items.results || [], { sets }), { headers: PAGE_HEADERS });
}

export { userRow };
