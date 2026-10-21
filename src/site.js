// What motdang.net asks of this account for a reader signed in with LINE
// (Nan 2026-10-20: "many more personalization and convenience features that you
// can access in motdang with a LINE signin. Let's also offer some kind of
// newsletter or offer to people who opt in at signup." Her pick: the week on
// Mot Dang on LINE each Monday, and a free Gold month).
//
// The LINE Login channel (2012126176) and this account sit under one provider,
// so the user ID the site holds is the one this account pushes to. The site
// Worker reaches these through a service binding (src/entry.js, class Site);
// nothing here has a public URL.
//
//   status(uid)                 friend or not, home for alerts, pending reminders, this month's pushes
//   setHome(uid, lat, lng)      the place alerts watch (src/alerts.js); clearHome(uid)
//   toSelf(uid, text)           a page, a place, a plan sent to one's own chat
//   remind(uid, key, at, text)  one push at `at`; unremind(uid, key); runReminders(env) hourly
//   weekly(uids, issue, text)   the weekly issue, multicast; once per reader per issue
//   forget(uid)                 everything this Worker keeps about a reader
//
// Pushes are metered by LINE. SITE_PUSH "on" opens this door and nothing else;
// every push is a row in site_push, and the month's pushes here and in
// alert_log stay under PUSH_CAP (wrangler.jsonc: 500, this account's free plan) and
// under what LINE's own quota says is left.

import { month, HOUR } from "./dm.js";
import { alertsOn } from "./line.js";

const API = "https://api.line.me/v2/bot";
const SELF_PER_DAY = 20;
const REMINDERS_MAX = 50;
const MULTICAST = 500;
const auth = (env) => ({ Authorization: "Bearer " + env.LINE_CHANNEL_TOKEN });
const open = (env) => String(env.SITE_PUSH ?? "").toLowerCase() === "on";
const goodUid = (u) => /^U[0-9a-f]{32}$/.test(String(u || ""));
const clip = (s, n) => String(s || "").slice(0, n);

function chunk(text) {
  const out = [];
  let s = String(text);
  while (s.length && out.length < 5) { out.push({ type: "text", text: s.slice(0, 4900) }); s = s.slice(4900); }
  return out;
}

// Pushes so far this Bangkok month, ours and the alerts'.
export async function used(env, mo = month()) {
  const a = (await env.DB.prepare("SELECT COUNT(*) n FROM site_push WHERE month = ? AND status = 'sent'").bind(mo).first())?.n ?? 0;
  const b = (await env.DB.prepare("SELECT COUNT(*) n FROM alert_log WHERE month = ? AND status = 'sent'").bind(mo).first())?.n ?? 0;
  return a + b;
}

// What may still go out this month: our cap, and LINE's own count when it answers.
// A cap from a var; anything that does not read as a number is the default d.
export const capOf = (v, d = 300) => { const n = Number(v); return v != null && String(v).trim() !== "" && Number.isFinite(n) && n >= 0 ? n : d; };

export async function room(env) {
  const cap = capOf(env.PUSH_CAP, 500);
  let left = cap - (await used(env));
  try {
    const [q, c] = await Promise.all([
      fetch(API + "/message/quota", { headers: auth(env) }).then((r) => (r.ok ? r.json() : null)),
      fetch(API + "/message/quota/consumption", { headers: auth(env) }).then((r) => (r.ok ? r.json() : null)),
    ]);
    if (q && q.type === "limited" && c && Number.isFinite(c.totalUsage)) left = Math.min(left, q.value - c.totalUsage);
  } catch { /* LINE's count unreadable: ours stands */ }
  return Math.max(0, left);
}

const logStmt = (env, uid, kind, ref, status, now = Date.now()) =>
  env.DB.prepare("INSERT INTO site_push (user_id, kind, ref, ts, month, status) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(uid, kind, ref ?? null, now, month(now), status);
async function log(env, uid, kind, ref, status, now = Date.now()) { await logStmt(env, uid, kind, ref, status, now).run(); }
// many writes in a few subrequests: D1's batch, 100 statements a call
async function batch(env, stmts) { for (let i = 0; i < stmts.length; i += 100) await env.DB.batch(stmts.slice(i, i + 100)); }

async function pushOne(env, to, text) {
  if (!open(env)) { console.log("site push held (SITE_PUSH not on):", clip(text, 200)); return false; }
  const r = await fetch(API + "/message/push", {
    method: "POST", headers: { ...auth(env), "content-type": "application/json" },
    body: JSON.stringify({ to, messages: chunk(text) }),
  });
  if (!r.ok) console.log("site push failed", r.status, clip(await r.text(), 300));
  return r.ok;
}

// A friend of the account: LINE answers a profile only for one.
export async function isFriend(env, uid) {
  if (!goodUid(uid)) return false;
  try { return (await fetch(`${API}/profile/${uid}`, { headers: auth(env) })).ok; } catch { return false; }
}

export async function status(env, uid) {
  if (!goodUid(uid)) return { error: "uid" };
  const [friend, home, rem, self] = await Promise.all([
    isFriend(env, uid),
    env.DB.prepare("SELECT lat, lng FROM alert_places WHERE user_id = ?").bind(uid).first(),
    env.DB.prepare("SELECT key, at, text FROM reminders WHERE user_id = ? AND sent IS NULL ORDER BY at").bind(uid).all(),
    env.DB.prepare("SELECT COUNT(*) n FROM site_push WHERE user_id = ? AND kind = 'self' AND ts > ? AND status IN ('sent','pending')").bind(uid, Date.now() - 24 * HOUR).first(),
  ]);
  return {
    friend, home: home ? { lat: home.lat, lng: home.lng } : null,
    alerts: alertsOn(env),
    reminders: (rem.results || []).map((r) => ({ key: r.key, at: r.at, text: r.text })),
    selfLeft: Math.max(0, SELF_PER_DAY - (self?.n ?? 0)), push: open(env),
  };
}

const r3 = (x) => Math.round(x * 1000) / 1000;
export async function setHome(env, uid, lat, lng) {
  lat = Number(lat); lng = Number(lng);
  if (!goodUid(uid) || !(Math.abs(lat) <= 90) || !(Math.abs(lng) <= 180)) return { error: "where" };
  await env.DB.prepare(`INSERT INTO alert_places (user_id, lat, lng, created_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET lat = excluded.lat, lng = excluded.lng, created_at = excluded.created_at`)
    .bind(uid, r3(lat), r3(lng), Date.now()).run();
  return { ok: true, home: { lat: r3(lat), lng: r3(lng) } };
}
export async function clearHome(env, uid) {
  await env.DB.prepare("DELETE FROM alert_places WHERE user_id = ?").bind(uid).run();
  return { ok: true };
}

export async function toSelf(env, uid, text) {
  if (!goodUid(uid) || !text) return { error: "what" };
  if ((await room(env)) < 1) { await log(env, uid, "self", null, "capped"); return { error: "month" }; }
  // the day's slot is taken in one conditional write, so two sends at once cannot both pass 20
  const now = Date.now(), since = now - 24 * HOUR;
  const take = await env.DB.prepare(`INSERT INTO site_push (user_id, kind, ref, ts, month, status)
    SELECT ?, 'self', NULL, ?, ?, 'pending'
    WHERE (SELECT COUNT(*) FROM site_push WHERE user_id = ? AND kind = 'self' AND ts > ? AND status IN ('sent','pending')) < ?`)
    .bind(uid, now, month(now), uid, since, SELF_PER_DAY).run();
  if (!take.meta?.changes) return { error: "day", left: 0 };
  const row = take.meta.last_row_id;
  const ok = await pushOne(env, uid, clip(text, 2000));
  await env.DB.prepare("UPDATE site_push SET status = ? WHERE id = ?").bind(ok ? "sent" : "failed", row).run();
  const n = (await env.DB.prepare("SELECT COUNT(*) n FROM site_push WHERE user_id = ? AND kind = 'self' AND ts > ? AND status = 'sent'")
    .bind(uid, since).first())?.n ?? 0;
  return ok ? { ok: true, left: Math.max(0, SELF_PER_DAY - n) } : { error: open(env) ? "line" : "held" };
}

export async function remind(env, uid, key, at, text) {
  at = Number(at);
  key = clip(key, 120);
  if (!goodUid(uid) || !key || !text || !Number.isFinite(at)) return { error: "what" };
  if (at < Date.now() - 5 * 60e3 || at > Date.now() + 400 * 24 * HOUR) return { error: "when" };
  const n = (await env.DB.prepare("SELECT COUNT(*) n FROM reminders WHERE user_id = ? AND sent IS NULL").bind(uid).first())?.n ?? 0;
  if (n >= REMINDERS_MAX) return { error: "many" };
  await env.DB.prepare(`INSERT INTO reminders (user_id, key, at, text, made) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(user_id, key) DO UPDATE SET at = excluded.at, text = excluded.text, sent = NULL`)
    .bind(uid, key, Math.round(at), clip(text, 1500), Date.now()).run();
  return { ok: true };
}
export async function unremind(env, uid, key) {
  await env.DB.prepare("DELETE FROM reminders WHERE user_id = ? AND key = ?").bind(uid, clip(key, 120)).run();
  return { ok: true };
}

// The hourly run at :30: reminders due before the next run goes. A reminder
// more than six hours late (the Worker was down) is marked and not sent.
export async function runReminders(env, now = Date.now()) {
  const due = (await env.DB.prepare("SELECT * FROM reminders WHERE sent IS NULL AND at <= ? ORDER BY at LIMIT 200")
    .bind(now + 30 * 60e3).all()).results || [];
  const done = { sent: 0, failed: 0, capped: 0, late: 0 };
  if (!due.length) return done;
  if (!open(env)) return { ...done, held: due.length };
  let left = await room(env);
  const writes = [];
  for (const r of due) {
    let st;
    if (r.at < now - 6 * HOUR) st = "late";
    else if (left < 1) st = "capped";
    else st = (await pushOne(env, r.user_id, r.text)) ? "sent" : "failed";
    if (st === "sent") left--;
    done[st]++;
    if (st !== "late") writes.push(logStmt(env, r.user_id, "remind", r.key, st, now));
    writes.push(env.DB.prepare("UPDATE reminders SET sent = ? WHERE user_id = ? AND key = ?").bind(now, r.user_id, r.key));
  }
  await batch(env, writes);
  return done;
}

// The weekly issue. uids come from the site's list of readers who said yes;
// a reader already sent this issue is skipped, so a second call is safe.
export async function weekly(env, uids, issue, text) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(issue || "")) || !text) return { error: "issue and text" };
  uids = [...new Set((uids || []).filter(goodUid))];
  const had = new Set(((await env.DB.prepare("SELECT user_id FROM site_push WHERE kind = 'weekly' AND ref = ? AND status = 'sent'")
    .bind(issue).all()).results || []).map((r) => r.user_id));
  const todo = uids.filter((u) => !had.has(u));
  const out = { asked: uids.length, already: uids.length - todo.length, sent: 0, failed: 0, capped: 0, held: !open(env) };
  if (!todo.length) return out;
  if (!open(env)) { console.log("weekly held (SITE_PUSH not on):", todo.length, clip(text, 200)); return out; }
  const left = await room(env);
  const go = todo.slice(0, left), over = todo.slice(left);
  await batch(env, over.map((u) => logStmt(env, u, "weekly", issue, "capped")));
  out.capped = over.length;
  for (let i = 0; i < go.length; i += MULTICAST) {
    const part = go.slice(i, i + MULTICAST);
    const r = await fetch(API + "/message/multicast", {
      method: "POST", headers: { ...auth(env), "content-type": "application/json" },
      body: JSON.stringify({ to: part, messages: chunk(text) }),
    });
    if (!r.ok) console.log("weekly multicast failed", r.status, clip(await r.text(), 300));
    await batch(env, part.map((u) => logStmt(env, u, "weekly", issue, r.ok ? "sent" : "failed")));
    out[r.ok ? "sent" : "failed"] += part.length;
  }
  return out;
}

// The reader's places and reminders go; the push logs keep their rows without the
// reader, so the month's count (PUSH_CAP, ALERT_CAP) stays what LINE counted.
export async function forget(env, uid) {
  if (!goodUid(uid)) return { error: "uid" };
  await env.DB.batch([
    env.DB.prepare("DELETE FROM alert_places WHERE user_id = ?").bind(uid),
    env.DB.prepare("DELETE FROM reminders WHERE user_id = ?").bind(uid),
    env.DB.prepare("UPDATE site_push SET user_id = 'forgotten' WHERE user_id = ?").bind(uid),
    env.DB.prepare("UPDATE alert_log SET user_id = 'forgotten', text = NULL WHERE user_id = ?").bind(uid),
  ]);
  return { ok: true };
}

export async function usage(env) {
  return { month: month(), used: await used(env), cap: capOf(env.PUSH_CAP, 500), room: await room(env) };
}
