// ALERTS: a warning for the one place a person saved with "บ้าน · home".
//
//   river  a Ping gauge within 15 km, straight-line, at or over its own alert
//          level (`limit` in motdang.net/data/ping.json, which comes with the
//          station's readings, not a number Mot Dang chose)
//   dust   PM2.5 over 75 µg/m³ in the air.json city nearest the place,
//          if one is within 40 km
//
// ping.json carries no coordinates, so data/ping_stations.json holds them,
// matched by station code (scripts/build_data.py says from where).
//
// These are pushes, which LINE meters. At most one attempt per person per
// kind in 12 hours (a failed one waits too, so a person who blocked the
// account is not retried every hour), at most ALERT_CAP a month across
// everyone (default 300), at most RUN_MAX in one hourly run, and every attempt
// is a row in alert_log.

import stations from "../data/ping_stations.json" with { type: "json" };
import { pushAlert } from "./line.js";
import { sayMany, quick, fresh, setPending, askLocation, metres, month, site, HOUR } from "./dm.js";
import { shareBits } from "./plus.js";

const RIVER_KM = 15;
const DUST_LIMIT = 75;
const CITY_KM = 40;
const SPACING_MS = 12 * HOUR;
const RUN_MAX = 40;
export const ALERT_CRON = "30 * * * *";

const STATION_AT = Object.fromEntries(stations.stations.map((s) => [s.id, s]));
const round3 = (x) => Math.round(x * 1000) / 1000;

// "บ้าน · home": the last location shared, if it is recent; otherwise ask.
export async function saveHome(ev, env, uid, row) {
  const now = ev.timestamp || Date.now();
  if (!fresh(row, now)) {
    await setPending(env, uid, "home", now);
    return askLocation(env, ev, "ส่งตำแหน่งของที่ที่ต้องการให้เตือน\nShare the location of the place for alerts."); // stylecheck: allow — เตือน = the opt-in alerts the reader subscribed to; ระดับเตือนภัย = the gauge's official alert level
  }
  return homeAt(ev, env, uid, row.last_lat, row.last_lng);
}

export async function homeAt(ev, env, uid, lat, lng) {
  await env.DB.prepare(
    `INSERT INTO alert_places (user_id, lat, lng, created_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET lat = excluded.lat, lng = excluded.lng, created_at = excluded.created_at`,
  ).bind(uid, round3(lat), round3(lng), Date.now()).run();
  const share = shareBits(env, { lat: round3(lat), lng: round3(lng) });
  return sayMany(env, ev, [quick([
    "บันทึกที่นี้แล้ว (ราว 100 ม.) · Saved this place, to about 100 m.",
    `เตือนเมื่อสถานีวัดน้ำในรัศมี ${RIVER_KM} กม. ถึงระดับเตือนภัย หรือฝุ่น PM2.5 เกิน ${DUST_LIMIT} · ` + // stylecheck: allow — เตือน = the opt-in alerts the reader subscribed to; ระดับเตือนภัย = the gauge's official alert level
      `Alerts come when a river gauge within ${RIVER_KM} km reaches its alert level, or PM2.5 dust passes ${DUST_LIMIT} µg/m³.`,
    "หยุดเตือน · stop alerts", // stylecheck: allow — เตือน = the opt-in alerts the reader subscribed to; ระดับเตือนภัย = the gauge's official alert level
    "",
    ...share.lines,
  ].join("\n"), [share.action])]);
}

export async function stopAlerts(ev, env, uid) {
  await env.DB.prepare("DELETE FROM alert_places WHERE user_id = ?").bind(uid).run();
  return sayMany(env, ev, [{ type: "text", text: "หยุดเตือนแล้ว และลบที่ที่บันทึกไว้ · Alerts stopped, and the saved place removed." }]); // stylecheck: allow — เตือน = the opt-in alerts the reader subscribed to; ระดับเตือนภัย = the gauge's official alert level
}

async function getJson(env, path) {
  try {
    const r = await fetch(site(env) + path, { headers: { accept: "application/json" } });
    return r.ok ? await r.json() : null;
  } catch (e) {
    console.log("alerts fetch failed", path, e.message);
    return null;
  }
}

// What would be said to one place right now: [{kind, subject, text}].
export function findAlerts(place, ping, air) {
  const out = [];
  let worst = null;
  for (const s of ping?.stations || []) {
    const at = STATION_AT[s.id];
    const level = Number(s.level), limit = Number(s.limit);
    if (!at || !Number.isFinite(level) || !Number.isFinite(limit) || level < limit) continue;
    const m = metres(place.lat, place.lng, at.lat, at.lng);
    if (m > RIVER_KM * 1000) continue;
    if (!worst || level - limit > worst.level - worst.limit) worst = { ...s, level, limit, m };
  }
  if (worst) {
    const km = (worst.m / 1000).toFixed(1);
    out.push({ kind: "flood", subject: worst.id, text: [
      "เตือนระดับน้ำ · River alert", // stylecheck: allow — เตือน = the opt-in alerts the reader subscribed to; ระดับเตือนภัย = the gauge's official alert level
      `${worst.th} (${worst.id}) ${worst.level.toFixed(2)} ม. ถึงระดับเตือนภัยของสถานี ${worst.limit.toFixed(2)} ม.`, // stylecheck: allow — เตือน = the opt-in alerts the reader subscribed to; ระดับเตือนภัย = the gauge's official alert level
      `${worst.en} (${worst.id}) is at ${worst.level.toFixed(2)} m, at or over its own alert level of ${worst.limit.toFixed(2)} m.`,
      `ห่างจากที่ของคุณ ${km} กม. · ${km} km from your place, straight-line.`,
      worst.observed ? `วัดเมื่อ · Read at ${worst.observed}` : "",
      "https://motdang.net/nam.html",
      "หยุดเตือน · stop alerts", // stylecheck: allow — เตือน = the opt-in alerts the reader subscribed to; ระดับเตือนภัย = the gauge's official alert level
    ].filter(Boolean).join("\n") });
  }
  let city = null;
  for (const p of air?.places || []) {
    const m = metres(place.lat, place.lng, Number(p.lat), Number(p.lng));
    if (m <= CITY_KM * 1000 && (!city || m < city.m)) city = { ...p, m };
  }
  if (city && Number(city.pm25) > DUST_LIMIT) {
    out.push({ kind: "dust", subject: city.id, text: [
      `ฝุ่น PM2.5 ${city.th} ${Number(city.pm25).toFixed(0)} µg/m³ เกิน ${DUST_LIMIT}`,
      `PM2.5 dust in ${city.en}: ${Number(city.pm25).toFixed(0)} µg/m³, over ${DUST_LIMIT}.`,
      "ค่าจากแบบจำลอง CAMS ไม่ใช่เครื่องวัดริมถนน · Modelled (CAMS), not a street-level monitor.",
      "หยุดเตือน · stop alerts", // stylecheck: allow — เตือน = the opt-in alerts the reader subscribed to; ระดับเตือนภัย = the gauge's official alert level
    ].join("\n") });
  }
  return out;
}

// The hourly run. Returns what it did, for /desk/alerts and the tests.
export async function runAlerts(env) {
  if (String(env.ALERTS ?? "").toLowerCase() !== "on") return { why: "ALERTS not on" };
  const places = (await env.DB.prepare("SELECT * FROM alert_places").all()).results || [];
  if (!places.length) return { why: "no places" };
  const [ping, air] = await Promise.all([getJson(env, "/data/ping.json"), getJson(env, "/data/air.json")]);
  const cap = Number(env.ALERT_CAP ?? 300);
  const now = Date.now(), mo = month(now);
  let used = (await env.DB.prepare("SELECT COUNT(*) n FROM alert_log WHERE month = ? AND status = 'sent'").bind(mo).first())?.n ?? 0;
  const done = { sent: 0, capped: 0, failed: 0, spaced: 0, held: 0 };
  for (const place of places) {
    for (const a of findAlerts(place, ping, air)) {
      const recent = await env.DB.prepare(
        "SELECT 1 FROM alert_log WHERE user_id = ? AND kind = ? AND status IN ('sent','capped','failed') AND ts > ? LIMIT 1",
      ).bind(place.user_id, a.kind, now - SPACING_MS).first();
      if (recent) { done.spaced++; continue; }
      if (done.sent + done.failed >= RUN_MAX) { done.held++; continue; }
      let status;
      if (!(used < cap)) status = "capped";
      else status = (await pushAlert(env, place.user_id, a.text)) ? "sent" : "failed";
      if (status === "sent") used++;
      done[status]++;
      await env.DB.prepare(
        "INSERT INTO alert_log (user_id, kind, subject, ts, month, status, text) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).bind(place.user_id, a.kind, a.subject, now, mo, status, a.text).run();
    }
  }
  return { ...done, month: mo, used, cap };
}
