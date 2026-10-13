// OWNERS: a shop owner edits their place by chatting.
//
// "เจ้าของ · owner MD-XXXXX" names a place by its short code (mot-dang
// placecode.py; the site serves /data/codes/<first char>.json as
// {code: "cm/slug"}, code without the MD-). That makes a claim, and a claim
// is pending until a person approves it at /desk/owners with the desk token.
// Nothing about the place changes here.
//
// Once a claim is approved, what that person sends — text and photos — goes
// to the place as an owner edit instead of to their page, through the same
// screen as a page post. The mot-dang importer pulls them from /owner-edits
// with the desk token; a person there decides what reaches the site.
// "เจ้าของ ปิด · owner off" sends them back to their own page.

import { say, rate, SLOW, site, ensureName, checkedPhoto } from "./dm.js";
import { screenText } from "./screen.js";

const CODE_RE = /^MD-?([0-9ABCDEFGHJKMNPQRSTVWXYZ]{5,10})$/;
const placeLink = (env, place) => `${site(env)}/${place.split("/")[0]}/p/${place.split("/").slice(1).join("/")}.html`;

async function lookup(env, code) {
  try {
    const r = await fetch(`${site(env)}/data/codes/${code[0]}.json`, { headers: { accept: "application/json" } });
    if (!r.ok || !/json/.test(r.headers.get("content-type") || "")) return null;
    const j = await r.json();
    const place = j?.[code];
    return typeof place === "string" && /^(cm|cr)\/[\w.-]{1,200}$/.test(place) ? place : null;
  } catch {
    return null;
  }
}

export async function claim(ev, env, uid, rest) {
  const m = CODE_RE.exec(String(rest || "").trim().toUpperCase());
  if (!m) return say(env, ev, "ส่งรหัสสถานที่แบบนี้ · Send the place code like this:\nเจ้าของ · owner MD-4F2K9");
  if (!(await rate(env, uid, "owner", 5))) return say(env, ev, SLOW);
  const code = m[1];
  const had = await env.DB.prepare("SELECT * FROM owner_claims WHERE user_id = ? AND code = ?").bind(uid, "MD-" + code).first();
  if (had?.status === "approved") {
    await env.DB.prepare("UPDATE dm_users SET owner_claim = ? WHERE user_id = ?").bind(had.id, uid).run();
    return say(env, ev, `รูปและข้อความที่ส่งต่อจากนี้ไปที่ ${had.place} · What you send now goes to ${had.place} as an owner edit.\n${placeLink(env, had.place)}\nเจ้าของ ปิด · owner off`);
  }
  if (had?.status === "pending") return say(env, ev, `คำขอ MD-${code} รอคนตรวจอยู่ · The claim on MD-${code} is waiting for a person to check it.`);
  if (had?.status === "refused") return say(env, ev, `คำขอ MD-${code} ไม่ผ่าน ติดต่อ hello@motdang.net · The claim on MD-${code} was not approved. Write to hello@motdang.net.`);
  const place = await lookup(env, code);
  if (!place) return say(env, ev, `ไม่พบรหัส MD-${code} · No place has the code MD-${code}.`);
  const who = await ensureName(env, uid);
  await env.DB.prepare(
    "INSERT OR IGNORE INTO owner_claims (user_id, code, place, name, status, created_at) VALUES (?, ?, ?, ?, 'pending', ?)",
  ).bind(uid, "MD-" + code, place, who?.name || null, Date.now()).run();
  return say(env, ev, [
    `รับคำขอเป็นเจ้าของ MD-${code} แล้ว · Claim on MD-${code} received.`,
    placeLink(env, place),
    "คนของมดแดงตรวจก่อน แล้วจึงแก้ไขผ่านแชตนี้ได้ · A person at Mot Dang checks it first; after that, what you send here goes to the place.",
  ].join("\n"));
}

export async function ownerOff(ev, env, uid) {
  await env.DB.prepare("UPDATE dm_users SET owner_claim = NULL WHERE user_id = ?").bind(uid).run();
  return say(env, ev, "กลับไปที่หน้าของคุณแล้ว · What you send goes to your own page again.");
}

// The approved claim this person's posts go to, or null.
export async function activeClaim(env, row) {
  if (!row?.owner_claim) return null;
  return env.DB.prepare("SELECT * FROM owner_claims WHERE id = ? AND user_id = ? AND status = 'approved'")
    .bind(row.owner_claim, row.user_id).first();
}

const SENT = (env, c) => [
  `ส่งไปที่ ${c.place} แล้ว รอคนตรวจ · Sent to ${c.place} as an owner edit, waiting for a check.`,
  placeLink(env, c.place),
  "เจ้าของ ปิด · owner off — กลับไปโพสต์ในหน้าของคุณ · back to your own page",
].join("\n");

export async function ownerText(ev, env, uid, c, m, text) {
  const seen = await env.DB.prepare("SELECT 1 FROM owner_edits WHERE message_id = ?").bind(m.id).first();
  if (seen) return;
  if (!(await rate(env, uid, "owner-edit", 30))) return say(env, ev, SLOW);
  const body = text.slice(0, 2000);
  const s = await screenText(env, body);
  await env.DB.prepare(
    `INSERT OR IGNORE INTO owner_edits (claim_id, user_id, place, message_id, ts, kind, text, status, why)
     VALUES (?, ?, ?, ?, ?, 'text', ?, ?, ?)`,
  ).bind(c.id, uid, c.place, m.id, ev.timestamp || Date.now(), body, s.ok ? "pending" : "held", s.why || null).run();
  return say(env, ev, SENT(env, c));
}

export async function ownerPhoto(ev, env, uid, c, m) {
  const seen = await env.DB.prepare("SELECT 1 FROM owner_edits WHERE message_id = ?").bind(m.id).first();
  if (seen) return;
  if (!(await rate(env, uid, "owner-edit", 30))) return say(env, ev, SLOW);
  const p = await checkedPhoto(env, m.id);
  if (p.refuse) return say(env, ev, p.refuse.text);
  const key = `owners/${c.place}/${m.id}.${p.ext}`;
  await env.INBOX.put(key, p.bytes, { httpMetadata: { contentType: p.type } });
  await env.DB.prepare(
    `INSERT OR IGNORE INTO owner_edits (claim_id, user_id, place, message_id, ts, kind, photo_key, photo_type, status, why)
     VALUES (?, ?, ?, ?, ?, 'photo', ?, ?, ?, ?)`,
  ).bind(c.id, uid, c.place, m.id, ev.timestamp || Date.now(), key, p.type, p.look.verdict === "ok" ? "pending" : "held", p.look.why || null).run();
  const set = m.imageSet;
  if (!set || !set.total || Number(set.index) >= Number(set.total)) return say(env, ev, SENT(env, c));
}

// ── the desk's side ──────────────────────────────────────────────────────────

const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });

// GET /desk/owners[?status=pending]  and  POST /desk/owners/<id> {"decision": "approve"|"refuse"}
export async function deskOwners(request, env, path, url) {
  const m = /^\/desk\/owners(?:\/(\d+))?$/.exec(path);
  if (!m) return null;
  if (!m[1] && request.method === "GET") {
    const status = url.searchParams.get("status") || "pending";
    const rows = await env.DB.prepare(
      "SELECT id, code, place, name, status, created_at, decided_at FROM owner_claims WHERE status = ? ORDER BY id LIMIT 200",
    ).bind(status).all();
    return json({ claims: rows.results || [] });
  }
  if (m[1] && request.method === "POST") {
    const { decision } = await request.json().catch(() => ({}));
    if (decision !== "approve" && decision !== "refuse") return json({ error: "decision is approve or refuse" }, 400);
    const c = await env.DB.prepare("SELECT * FROM owner_claims WHERE id = ?").bind(Number(m[1])).first();
    if (!c) return json({ error: "no such claim" }, 404);
    await env.DB.prepare("UPDATE owner_claims SET status = ?, decided_at = ? WHERE id = ?")
      .bind(decision === "approve" ? "approved" : "refused", Date.now(), c.id).run();
    // Approved: their next text or photo goes to the place. Refused: if it was
    // the claim their posts went to, they go back to their page.
    await env.DB.prepare(`UPDATE dm_users SET owner_claim = ${decision === "approve" ? "?" : "NULL"} WHERE user_id = ?${decision === "approve" ? "" : " AND owner_claim = ?"}`)
      .bind(...(decision === "approve" ? [c.id, c.user_id] : [c.user_id, c.id])).run();
    return json({ ok: true, id: c.id, status: decision === "approve" ? "approved" : "refused" });
  }
  return json({ error: "method" }, 405);
}

// GET /owner-edits (unpulled, oldest first) and POST /owner-edits/ack {ids}.
// Photo bytes come from /desk/photo?key=<photo_key>.
export async function ownerEdits(request, env, path, url) {
  if (path === "/owner-edits" && request.method === "GET") {
    const limit = Math.min(Number(url.searchParams.get("limit") || 200), 500);
    const rows = await env.DB.prepare(
      `SELECT e.id, e.claim_id, c.code, e.place, e.ts, e.kind, e.text, e.photo_key, e.photo_type, e.status, e.why
         FROM owner_edits e JOIN owner_claims c ON c.id = e.claim_id
        WHERE e.pulled_at IS NULL ORDER BY e.id ASC LIMIT ?`,
    ).bind(limit).all();
    return json({ rows: rows.results || [] });
  }
  if (path === "/owner-edits/ack" && request.method === "POST") {
    const { ids } = await request.json().catch(() => ({}));
    if (!Array.isArray(ids) || !ids.length) return json({ acked: 0 });
    const r = await env.DB.prepare(
      `UPDATE owner_edits SET pulled_at = ? WHERE id IN (${ids.map(() => "?").join(",")}) AND pulled_at IS NULL`,
    ).bind(Date.now(), ...ids.map(Number)).run();
    return json({ acked: r.meta.changes });
  }
  return null;
}
