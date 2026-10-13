// PINS: keep a pin set or a plan from motdang.net/map.html, and hand back the
// link that reopens it.
//
// The map writes its extras into the last slash-segment of the hash:
// `#<z>/<lat>/<lng>/<layer>/q=…&pins=lat,lng,name;…` (mapfirst_layer.py,
// pinsStr). What is kept here is what was parsed out of that, and the link
// handed back is rebuilt from it, so nothing typed survives as markup or as a
// different address.

import { say, rate, SLOW, pageLink } from "./dm.js";
import { screenText } from "./screen.js";

const MAX_SETS = 100;
const MAX_PINS = 100;
const PATH_RE = /^\/(?:[a-z0-9-]+\/)*[a-z0-9-]*(?:\.html)?$/;
const SEG_RE = /^[\w.+-]{0,32}$/;
const PLAN_RE = /^[\w:,;.-]{1,2000}$/;

const clip = (s, n) => String(s ?? "").replace(/[\u0000-\u001f\u007f<>]/g, " ").replace(/\s+/g, " ").trim().slice(0, n);

// { url, pins, q, plan } or null.
export function parseMapLink(raw) {
  let u;
  try { u = new URL(String(raw || "").trim().split(/\s/)[0]); } catch { return null; }
  if (u.protocol !== "https:" || !/^(www\.)?motdang\.net$/.test(u.hostname) || !PATH_RE.test(u.pathname)) return null;
  const segs = u.hash.replace(/^#/, "").split("/");
  const at = segs.findIndex((s) => /(^|&)(pins|q|plan)=/.test(s));
  if (at < 0) return null;
  const kv = {};
  for (const part of segs[at].split("&")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    try { kv[part.slice(0, i)] = decodeURIComponent(part.slice(i + 1)); } catch { return null; }
  }
  const pins = [];
  for (const p of String(kv.pins || "").split(";").filter(Boolean).slice(0, MAX_PINS)) {
    const [a, b, ...n] = p.split(",");
    const lat = Number(a), lng = Number(b);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) continue;
    pins.push({ lat: +lat.toFixed(5), lng: +lng.toFixed(5), n: clip(n.join(" "), 60) });
  }
  const q = clip(kv.q, 100);
  const plan = kv.plan && PLAN_RE.test(kv.plan) ? kv.plan : "";
  if (!pins.length && !plan) return null;
  const extras = [q && "q=" + encodeURIComponent(q),
    pins.length && "pins=" + encodeURIComponent(pins.map((p) => `${p.lat.toFixed(5)},${p.lng.toFixed(5)}${p.n ? "," + p.n.replace(/[;,]/g, " ") : ""}`).join(";")),
    plan && "plan=" + encodeURIComponent(plan)].filter(Boolean).join("&");
  const kept = segs.slice(0, at).filter((s) => SEG_RE.test(s));
  if (kept.length !== at) return null;
  return { url: `https://motdang.net${u.pathname}#${[...kept, extras].join("/")}`, pins, q, plan };
}

export async function savePins(ev, env, uid, kind, rest) {
  const got = parseMapLink(rest);
  if (!got) return say(env, ev, "อ่านลิงก์นี้ไม่ได้ ส่งลิงก์จากแผนที่มดแดง · That link could not be read. Send a link from the Mot Dang map.");
  if (!(await rate(env, uid, "pins", 20))) return say(env, ev, SLOW);
  const have = (await env.DB.prepare("SELECT COUNT(*) n FROM pin_sets WHERE user_id = ?").bind(uid).first())?.n ?? 0;
  if (have >= MAX_SETS) return say(env, ev, "เก็บครบ 100 ชุดแล้ว ส่ง “ลบ” เพื่อเริ่มใหม่ · 100 sets kept, the most there is room for.");
  const name = got.q || got.pins[0]?.n || (kind === "plan" ? "แผน · Plan" : "หมุด · Pins");
  const ok = (await screenText(env, name)).ok;
  await env.DB.prepare(
    `INSERT OR IGNORE INTO pin_sets (user_id, kind, name, name_ok, url, pins, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).bind(uid, kind, name, ok ? 1 : 0, got.url, JSON.stringify(got.pins), Date.now()).run();
  const n = got.pins.length;
  return say(env, ev, [
    `เก็บแล้ว · Saved: ${name}${n ? ` — ${n} หมุด · ${n} pin${n === 1 ? "" : "s"}` : ""}`,
    got.url,
    "ส่ง “หมุด · pins” เพื่อดูทั้งหมด · Send “pins” to see them all.",
  ].join("\n"));
}

export async function listPins(ev, env, uid) {
  const rows = (await env.DB.prepare(
    "SELECT name, kind, url, pins FROM pin_sets WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT 10",
  ).bind(uid).all()).results || [];
  if (!rows.length) return say(env, ev, "ยังไม่มีหมุดที่เก็บไว้ กด “เก็บไว้ใน LINE” บนแผนที่ · No pins kept yet. Tap “Keep in LINE” on the map.");
  const u = await env.DB.prepare("SELECT slug FROM dm_users WHERE user_id = ?").bind(uid).first();
  return say(env, ev, [
    "หมุดและแผนของคุณ · Your pins and plans",
    ...rows.map((r) => `\n${r.name} (${JSON.parse(r.pins).length})\n${r.url}`),
    u?.slug ? `\n${pageLink(env, u.slug)}` : "",
  ].join("\n").trim());
}

// For the page: names that passed the screen, others under a plain label.
export async function pinSetsFor(env, uid) {
  const rows = (await env.DB.prepare(
    "SELECT name, name_ok, kind, url, pins FROM pin_sets WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT 50",
  ).bind(uid).all()).results || [];
  return rows.map((r) => ({ name: r.name_ok ? r.name : (r.kind === "plan" ? "แผน · Plan" : "หมุด · Pins"),
    url: r.url, count: JSON.parse(r.pins).length }));
}
