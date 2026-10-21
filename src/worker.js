// The bot that sits in the Mot Dang team group.
//
// What it is for: photos Beer sends land somewhere with a name on them, bug
// reports Michael sends get a number, and neither depends on anyone
// remembering to move a file afterwards.
//
// Two things about LINE shape everything here:
//   1. A bot sees only what is sent after it joins. There is no history API,
//      so nothing said before the webhook went live can ever be recovered here.
//   2. Photo bytes expire. The binary is fetched at webhook time or not at all,
//      which is why the R2 write happens inside waitUntil on the same request
//      and never on a later sweep.
//
// The Worker keeps; the local filer (mot-dang/importers/pull_line.py) takes.
// Nothing is deleted here on a pull — /ack only stamps pulled_at — so a filer
// that dies mid-run repeats itself rather than losing a photo.

import { verify, reply, push, pushAgenda, content, memberName, allow, hush, spend, addressed, groupSummary } from "./line.js";
import { match, prepare } from "./match.js";
import { readSign, describeSign, anchorsOf } from "./sign.js";
import { buildAgenda } from "./agenda.js";
import { onDirect, directOn, servePage } from "./pages.js";
import { FLAGS, flag } from "./dm.js";
import { serveSafe } from "./safe.js";
import { spotters } from "./weather.js";
import { deskOwners, ownerEdits } from "./owners.js";
import { runAlerts, ALERT_CRON } from "./alerts.js";
import { runReminders } from "./site.js";
import { ADDRESS, BOTS_CALL, readsAsAddress, readsAsBotsCall } from "./address.js";
import { onGbd, gbdGroups, ledgerTsv, runGbdPosts, GBD_CRON } from "./gbd.js";
import { onPm, pmUser } from "./pm.js";

// Bump when what the Worker does changes in a way the desk can see.
const BUILD = "2026-10-10-gbd";

const PHOTO_CONTEXT_MS = 5 * 60 * 1000;  // a caption sent this long before its photo still counts
const ANSWER_WINDOW_MS = 60 * 60 * 1000; // how long "which place?" stays open for an answer
const LOCATION_WINDOW_MS = 10 * 60 * 1000; // a shared location and a photo this close together are one visit

// ── small helpers ────────────────────────────────────────────────────────────

const json = (o, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });

async function getState(env, k, dflt = null) {
  const r = await env.DB.prepare("SELECT v FROM state WHERE k = ?").bind(k).first();
  return r ? r.v : dflt;
}

async function setState(env, k, v) {
  await env.DB.prepare(
    "INSERT INTO state (k, v, ts) VALUES (?, ?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v, ts = excluded.ts",
  ).bind(k, String(v), Date.now()).run();
}

// The CWSDPP swim-programme group. A second room this account sits in, kept
// separate from the team group and never spoken in. It is adopted only when
// the desk has armed `adopt_next` first, so being added to a stranger's chat
// can never turn that chat into a source of programme record.
async function cwsdppGroup(env) {
  return env.CWSDPP_GROUP_ID || (await getState(env, "cwsdpp_group_id"));
}

// Hand a line from the swim group to the CWSDPP desk. Text is kept as a
// message; a photo goes in as bytes and joins the transcription queue, which
// is the whole point — the receipts arrive there as photographs.
//
// Nothing is ever said back. That group is people working, not a place for a
// bot to introduce itself, and the desk's rule is that only a known decider's
// word closes a question — a LINE display name is not that, so the desk keeps
// what is said and decides nothing from it.
async function toSwimDesk(ev, env) {
  if (ev.type !== "message") return;
  const tok = env.CWSDPP_TOKEN;
  if (!tok) { console.log("swim group: no CWSDPP_TOKEN, keeping nothing"); return; }
  const base = env.CWSDPP_BASE || "https://cwsdpp.nanobotco.workers.dev";
  const m = ev.message || {};
  const gid = ev.source.groupId || ev.source.roomId;
  const who = (await memberName(env, gid, ev.source.userId)) || "someone in the group";
  const ts = new Date(ev.timestamp || Date.now()).toISOString();

  if (m.type === "text") {
    const r = await fetch(base + "/api/line", {
      method: "POST",
      headers: { "authorization": "Bearer " + tok,
                 "content-type": "application/json" },
      body: JSON.stringify({ id: m.id, who, text: m.text, ts }),
    });
    if (!r.ok) console.log("swim desk refused a line", r.status);
    return;
  }

  if (m.type === "image" || m.type === "file") {
    const got = await content(env, m.id);
    if (!got) return;
    const name = m.fileName || (m.id + ".jpg");
    const r = await fetch(base + "/api/upload", {
      method: "POST",
      headers: { "authorization": "Bearer " + tok,
                 "content-type": got.type,
                 "x-filename": name,
                 "x-note": "LINE, from " + who },
      body: got.body,
    });
    if (!r.ok) console.log("swim desk refused a file", r.status);
  }
}

// The team group. Learned from the first join event and then fixed: the
// account is the public Mot Dang OA, so it can be added to other groups by
// anyone, and only the one group we know is treated as the team's.
async function teamGroup(env) {
  return env.TEAM_GROUP_ID || (await getState(env, "team_group_id"));
}

// ── the other rooms ──────────────────────────────────────────────────────────
// Nan, 2026-09-30: "I want a private line group so I can send my own thoughts
// to a silent bot, and another one where the team and I message the bots."
//
// Every group other than the ops room and the swim room has a mode, kept in
// group_modes by group id:
//   thoughts  her private room. Everything kept, marked channel 'thoughts'; the
//             bot never answers there, addressed or not, SPEAK or no SPEAK.
//   bots      the team and the bots. Answers what is addressed to it or is a
//             command; says nothing to people talking to each other.
//   muted     everything else. Nothing kept, nothing said: a stranger who adds
//             the public account to a chat gets what they always got.
//   gbd       the Golf Ball Drop room (src/gbd.js): a ticket ledger, answered
//             when addressed. Set only from the Mac; modeFromName never returns it.
//
// The mode comes from the group's name, read from LINE the first time the
// account meets the group (the join, or the first message if the join was
// missed), and is then kept: a rename changes nothing. The Mac can change it
// with scripts/group_mode.py, through /desk/groups.
export const MODES = ["muted", "thoughts", "bots", "gbd"];

export function modeFromName(name) {
  const n = String(name || "").toLowerCase();
  if (/thought|ความคิด/.test(n)) return "thoughts"; // checked first: the silent one wins a tie
  if (/(^|[^a-z])bots?([^a-z]|$)|บอท/.test(n)) return "bots";
  return "muted";
}

async function storedMode(env, gid) {
  return env.DB.prepare("SELECT mode FROM group_modes WHERE group_id = ?").bind(gid).first();
}

async function setMode(env, gid, mode, name, source) {
  await env.DB.prepare(
    `INSERT INTO group_modes (group_id, mode, name, source, set_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(group_id) DO UPDATE SET mode = excluded.mode, name = COALESCE(excluded.name, group_modes.name),
       source = excluded.source, set_at = excluded.set_at`,
  ).bind(gid, mode, name, source, Date.now()).run();
}

// The mode of a group, deciding it from the name if this is the first time.
// A name LINE would not give is not a decision: muted for now, asked again next
// time. A room (no group id, no name) is muted.
async function groupMode(env, gid, src) {
  if (!src.groupId) return "muted";
  const row = await storedMode(env, gid);
  if (row) return row.mode;
  const name = await groupSummary(env, gid);
  if (name === null) return "muted";
  const mode = modeFromName(name);
  await setMode(env, gid, mode, name, "name");
  return mode;
}

// Only the people in the ops room count in the other two. The account is public
// and anyone can make a group called "bots" or "thoughts" and add it; what a
// stranger says there returns before any insert or reply. Somebody who spoke in
// the ops room is known from the ledger; anyone else is asked of LINE, which
// answers a member profile only for a member of that group.
async function isTeam(env, uid) {
  const team = await teamGroup(env);
  if (!team || !uid) return false;
  const seen = await env.DB.prepare("SELECT 1 FROM events WHERE group_id = ? AND user_id = ? LIMIT 1").bind(team, uid).first();
  if (seen) return true;
  return !!(await memberName(env, team, uid));
}

// THE THOUGHTS ROOM. Kept, never answered. Nothing here calls reply(), and the
// token is hushed first anyway, so a handler added later cannot speak here
// either. Nothing is read, matched or filed against a place; the rows go to the
// desk marked 'thoughts' and the pull writes them to their own folder.
async function keepThought(ev, env, gid) {
  hush(ev.replyToken);
  if (ev.type !== "message") return;
  const uid = ev.source.userId || null;
  if (!(await isTeam(env, uid))) return;
  const m = ev.message || {};
  const ts = ev.timestamp || Date.now();
  const name = await memberName(env, gid, uid);
  const row = (kind, extra = {}) => {
    const cols = { ts, kind, group_id: gid, user_id: uid, user_name: name, message_id: m.id || null,
      quoted_id: m.quotedMessageId || null, status: "new", channel: "thoughts", ...extra };
    const k = Object.keys(cols);
    return env.DB.prepare(`INSERT OR IGNORE INTO events (${k.join(", ")}) VALUES (${k.map(() => "?").join(", ")})`)
      .bind(...k.map((x) => cols[x])).run();
  };

  if (m.type === "text") return row("text", { text: m.text || "" });
  if (m.type === "location") {
    const lat = Number(m.latitude), lng = Number(m.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
    return row("location", { text: m.title || null, lat, lng, address: m.address || null });
  }
  // A photo, a file, a voice note, a video: the bytes, now, for the same reason
  // as in the ops room — LINE drops them after a while.
  if (["image", "file", "audio", "video"].includes(m.type)) {
    const got = await content(env, m.id);
    if (!got) return;
    const d = new Date(ts).toISOString().slice(0, 10).replace(/-/g, "/");
    const fromName = (m.fileName || "").split(".").pop()?.toLowerCase();
    const ext = m.fileName && /^[a-z0-9]{2,5}$/.test(fromName || "") ? fromName
      : { image: "jpg", audio: "m4a", video: "mp4" }[m.type]
        || (got.type.split("/")[1] || "bin").split("+")[0].replace("jpeg", "jpg");
    const key = `thoughts/${d}/${m.id}.${ext}`;
    await env.INBOX.put(key, got.body, {
      httpMetadata: { contentType: got.type },
      customMetadata: { messageId: m.id, groupId: gid, userId: uid || "", userName: name || "", channel: "thoughts" },
    });
    return row(m.type === "image" ? "photo" : "file", {
      text: m.fileName || null, photo_key: key, photo_bytes: got.body.byteLength, via: m.type });
  }
}

// ── the place index ──────────────────────────────────────────────────────────
// Built from the site's own name index by scripts/build_match_index.py and
// parked in R2. Held in the isolate between requests; re-read every six hours
// so a rebuilt index reaches the bot without a deploy.

let INDEX = null;
let INDEX_AT = 0;

async function placeIndex(env) {
  if (INDEX && Date.now() - INDEX_AT < 6 * 3600 * 1000) return INDEX;
  const obj = await env.INBOX.get("index/match.json");
  if (!obj) return INDEX || [];
  try {
    // Folded once, here, and read thousands of times after: normalising the
    // names on every message would cost about 100 ms of CPU a photo.
    INDEX = prepare(await obj.json());
    INDEX_AT = Date.now();
  } catch (e) {
    console.log("index parse failed", e.message);
  }
  return INDEX || [];
}

// ── what the bot says ────────────────────────────────────────────────────────

const HELP = [
  "มดจดให้ — this room is the ops channel, so I keep all of it:",
  "",
  "• Every message. Opening times, a place that has closed, what we saw today, who is doing what — it is read and filed, whether or not it is addressed to me.",
  "• Photos. Say which place and I file the picture under it; if I cannot tell, I ask.",
  "• “bug …” gets a number, so it can be referred to out loud later.",
  "• “status” — what I am holding right now. “help” — this.",
  "",
  "I am quiet unless there is something to answer. Quiet means kept, not missed.",
  "",
  "• I read the sign off every photo and say what I read — a reading for you to confirm, never a fact on its own.",
  "• Share your LOCATION from the paperclip while you are at the place: it pins the photo exactly. (Sending a picture as a photo strips where it was taken; as a file it keeps it.)",
  "",
  "I only keep what is sent after I joined, and I cannot see the album or Keep — things have to come into the chat itself.",
].join("\n");

function placeLabel(p) {
  const bits = [p.n, p.r || p.e].filter(Boolean);
  const seen = new Set();
  return bits.filter((b) => !seen.has(b) && seen.add(b)).join(" · ");
}

// ── event handling ───────────────────────────────────────────────────────────

async function handleEvent(ev, env) {
  const src = ev.source || {};
  const gid = src.groupId || src.roomId || null;

  // The bot joined a chat. The first group it is added to becomes the team
  // group; anything after that is a stranger's group and gets left alone.
  if (ev.type === "join") {
    const known = await teamGroup(env);
    if (!known && gid) {
      await setState(env, "team_group_id", gid);
      await reply(env, ev.replyToken, "มดจดให้ — I keep what is said in here. Type help if you want the list; otherwise I stay quiet unless I need an answer.");
      return;
    }
    // A room the desk was told to expect. Adopted without a word: the last
    // time this account was added to the swim group it announced that it only
    // works in the Mot Dang chat, which reads like a wrong number, and it was
    // removed within the hour.
    const armed = await getState(env, "adopt_next");
    if (armed === "cwsdpp" && gid && gid !== known) {
      await setState(env, "cwsdpp_group_id", gid);
      await setState(env, "adopt_next", "");
      return;
    }
    if (known && gid !== known && gid !== (await cwsdppGroup(env))) {
      const mode = await groupMode(env, gid, src);
      // Her private room: not a word, not even with SPEAK on.
      if (mode === "thoughts" || mode === "gbd") return void hush(ev.replyToken);
      // The bots room: one short hello, answering the join itself.
      if (mode === "bots") {
        allow(ev.replyToken);
        await reply(env, ev.replyToken, "สวัสดีค่ะ — บอทอยู่ในห้องนี้แล้ว เรียก @bot หรือพิมพ์ help · Bots here. Say @bot, or send help, status or bug …; I keep out of your own talk.");
        return;
      }
      await reply(env, ev.replyToken, "สวัสดีค่ะ — this account answers at motdang.net; I only do work in the Mot Dang team chat.");
    }
    return;
  }

  // One-to-one: somebody chatting with the account on their own. With every
  // one-to-one feature off these are left to the Official Account's own
  // replies in OA Manager, as they always were — answering here as well would
  // send every reader two answers. With any of them on (PAGES, PINS, ASK,
  // ALERTS, STAMPS, OWNERS, SPOTTERS, SAFE) src/pages.js reads them, and each
  // feature checks its own flag. Either way nothing below this line sees a
  // one-to-one event, so the team room's handling is the same whatever the
  // flags say.
  if (src.type === "user") {
    // Michael's PM words (src/pm.js). His text goes there; his photos and
    // everything from anyone else take the path below, unchanged.
    if (pmUser(env, src.userId) && ev.type === "message" && ev.message?.type === "text") return onPm(ev, env);
    if (directOn(env)) return onDirect(ev, env);
    return;
  }
  if (!gid) return;
  const team = await teamGroup(env);
  let ch = "ops";
  if (!team || gid !== team) {
    const swim = await cwsdppGroup(env);
    if (swim && gid === swim) return toSwimDesk(ev, env);
    if (!team) return;
    const mode = await groupMode(env, gid, src);
    if (mode === "thoughts") return keepThought(ev, env, gid);
    if (mode === "gbd") return onGbd(ev, env, gid);
    if (mode !== "bots") return;
    if (ev.type !== "message" || !(await isTeam(env, src.userId))) return;
    ch = "bots";
  }

  if (ev.type !== "message") return;
  const m = ev.message || {};
  if (m.type === "image") return onPhoto(ev, m, env, "photo", ch);
  // A picture sent through the paperclip arrives as a file, unre-encoded, with
  // its EXIF — including where it was taken — still on it. Same handling, and
  // the row remembers which way it came so the desk knows whether to look.
  if (m.type === "file") {
    const name = m.fileName || "";
    if (/\.(jpe?g|png|heic|heif|tiff?|webp)$/i.test(name)) return onPhoto(ev, m, env, "file", ch);
    return onFile(ev, m, env, ch);
  }
  if (m.type === "text") return onText(ev, m, env, ch);
  // The paperclip's "Location": somebody standing in the shop, sharing where.
  // Exact, and unlike EXIF it survives however the photo was sent.
  if (m.type === "location") return onLocation(ev, m, env, ch);
}

// Where somebody is standing. Kept on its own row, and copied onto the last
// photo the same person sent within the window, so the pin and the picture
// leave together. A photo that comes AFTER the location picks it up in onPhoto.
async function onLocation(ev, m, env, ch = "ops") {
  const uid = ev.source.userId || null;
  const gid = ev.source.groupId || ev.source.roomId;
  const ts = ev.timestamp || Date.now();
  const lat = Number(m.latitude), lng = Number(m.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
  const name = await memberName(env, gid, uid);
  const ins = await env.DB.prepare(
    `INSERT OR IGNORE INTO events (ts, kind, group_id, user_id, user_name, message_id, text, lat, lng, address, status, channel)
     VALUES (?, 'location', ?, ?, ?, ?, ?, ?, ?, ?, 'new', ?)`,
  ).bind(ts, gid, uid, name, m.id, m.title || null, lat, lng, m.address || null, ch).run();
  if (!ins.meta.changes) return;

  const photo = uid && (await env.DB.prepare(
    `SELECT id, message_id, place_name FROM events WHERE group_id = ? AND user_id = ? AND kind = 'photo'
       AND ts >= ? AND ts <= ? AND lat IS NULL ORDER BY ts DESC LIMIT 1`,
  ).bind(gid, uid, ts - LOCATION_WINDOW_MS, ts).first());
  // No reply. A pin lands on the photo's row, the desk carries it, and the
  // person who shared it already knows where they are standing.
  if (photo) {
    await env.DB.prepare("UPDATE events SET lat = ?, lng = ?, address = ? WHERE id = ?")
      .bind(lat, lng, m.address || null, photo.id).run();
  }
}

// Anything else somebody attaches — a menu as a PDF, a spreadsheet of prices.
// Kept and carried down; the desk reads it, this does not try to.
async function onFile(ev, m, env, ch = "ops") {
  const uid = ev.source.userId || null;
  const gid = ev.source.groupId || ev.source.roomId;
  const got = await content(env, m.id);
  if (!got) return;
  const key = `files/${new Date(ev.timestamp || Date.now()).toISOString().slice(0, 10)}/${m.id}-${(m.fileName || "file").replace(/[^\w.\-]+/g, "_")}`;
  await env.INBOX.put(key, got.body, { httpMetadata: { contentType: got.type } });
  const ins = await env.DB.prepare(
    `INSERT OR IGNORE INTO events (ts, kind, group_id, user_id, user_name, message_id, text, photo_key, photo_bytes, via, status, channel)
     VALUES (?, 'file', ?, ?, ?, ?, ?, ?, ?, 'file', 'new', ?)`,
  ).bind(ev.timestamp || Date.now(), gid, uid, await memberName(env, gid, uid), m.id,
         m.fileName || null, key, got.body.byteLength, ch).run();
  // Kept without a word — it shows in the nightly line.
}

async function onPhoto(ev, m, env, via, ch = "ops") {
  const uid = ev.source.userId || null;
  const gid = ev.source.groupId || ev.source.roomId;
  const name = await memberName(env, gid, uid);

  // Bytes first, and before anything that could fail: LINE drops message
  // content after a while and this is the only chance at it.
  const got = await content(env, m.id);
  if (!got) {
    await reply(env, ev.replyToken, "That photo did not come through to me — send it again?");
    return;
  }
  const d = new Date(ev.timestamp || Date.now());
  const ext = (m.fileName || "").split(".").pop()?.toLowerCase().match(/^[a-z0-9]{2,5}$/)
    ? m.fileName.split(".").pop().toLowerCase()
    : (got.type.split("/")[1] || "jpg").split("+")[0].replace("jpeg", "jpg");
  const key = `photos/${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, "0")}/${String(d.getUTCDate()).padStart(2, "0")}/${m.id}.${ext}`;
  await env.INBOX.put(key, got.body, {
    httpMetadata: { contentType: got.type },
    customMetadata: { messageId: m.id, groupId: gid, userId: uid || "", userName: name || "" },
  });

  const ins = await env.DB.prepare(
    `INSERT OR IGNORE INTO events (ts, kind, group_id, user_id, user_name, message_id, quoted_id, photo_key, photo_bytes, via, status, channel)
     VALUES (?, 'photo', ?, ?, ?, ?, ?, ?, ?, ?, 'new', ?)`,
  ).bind(ev.timestamp || Date.now(), gid, uid, name, m.id, m.quotedMessageId || null, key,
         got.body.byteLength, via || "photo", ch).run();
  if (!ins.meta.changes) return; // a retry of a photo already kept

  // What does the sign say? A reading the person can confirm at a glance,
  // and — when nobody typed a name — the only clue there is to the place.
  const sign = await readSign(env, got.body, got.type);
  if (sign) {
    // The neighbours travel with the reading. They are what lets the desk
    // pin a photo that arrived with no EXIF — see migrations/0004_anchors.sql.
    const anchors = anchorsOf(sign);
    await env.DB.prepare("UPDATE events SET sign = ?, anchors = ? WHERE message_id = ?")
      .bind(JSON.stringify(sign), anchors.length ? JSON.stringify(anchors) : null, m.id).run();
  }

  // A location shared by the same person just before the photo is its pin.
  const pin = uid && (await env.DB.prepare(
    `SELECT lat, lng, address FROM events WHERE group_id = ? AND user_id = ? AND kind = 'location'
       AND ts >= ? AND ts <= ? ORDER BY ts DESC LIMIT 1`,
  ).bind(gid, uid, (ev.timestamp || Date.now()) - LOCATION_WINDOW_MS, ev.timestamp || Date.now()).first());
  if (pin) {
    await env.DB.prepare("UPDATE events SET lat = ?, lng = ?, address = ? WHERE message_id = ?")
      .bind(pin.lat, pin.lng, pin.address, m.id).run();
  }

  // What did they say it was? A quoted message is the person pointing at it
  // outright; otherwise the last thing they typed, if it was recent enough.
  let ctx = null;
  if (m.quotedMessageId) {
    const q = await env.DB.prepare("SELECT text FROM events WHERE message_id = ?").bind(m.quotedMessageId).first();
    ctx = q?.text || null;
  }
  if (!ctx && uid) {
    const prev = await env.DB.prepare(
      `SELECT text FROM events WHERE group_id = ? AND user_id = ? AND kind = 'text' AND ts >= ?
       ORDER BY ts DESC LIMIT 1`,
    ).bind(gid, uid, (ev.timestamp || Date.now()) - PHOTO_CONTEXT_MS).first();
    ctx = prev?.text || null;
  }

  // Nobody typed a name but the sign carries one: match on that, and say so.
  const fromSign = !ctx && sign && (sign.name_th || sign.name_en);
  if (fromSign) ctx = [sign.name_th, sign.name_en].filter(Boolean).join(" ");

  await resolve(env, m.id, ctx, ev.replyToken, { silentOnAsk: false, sign, pinned: !!pin });
}

// Put a photo against a place and say so. The one place a place_slug is set.
async function fileAs(env, rowId, place, score, text, replyToken, tail = "", { speak = false } = {}) {
  await env.DB.prepare(
    `UPDATE events SET place_slug = ?, place_name = ?, confidence = ?, status = 'matched',
       text = COALESCE(text, ?), decided_by = ? WHERE id = ?`,
  ).bind(place.s, placeLabel(place), score, text || null, text || null, rowId).run();
  // Quiet by default. Nan, 2026-09-07: "the autoreply from the bot is
  // intrusive and annoying." A photo it could place is filed without a word;
  // the nightly line says how many. It speaks only when answering a person —
  // a numbered pick, a link, a correction — because then silence reads as
  // ignored, which is worse than a line.
  if (speak) await reply(env, replyToken, `เก็บแล้ว — ${placeLabel(place)}.${tail ? " " + tail : ""}`);
}

// Settle a photo against a piece of text: file it, or ask.
async function resolve(env, messageId, text, replyToken, { silentOnAsk, sign = null, pinned = false }) {
  const row = await env.DB.prepare("SELECT * FROM events WHERE message_id = ?").bind(messageId).first();
  if (!row) return false;

  const idx = await placeIndex(env);
  const r = text ? match(text, idx) : { status: "none", score: 0, options: [] };
  const read = describeSign(sign);
  const tail = [read ? `Sign reads: ${read}.` : "", pinned ? "Pinned from your location." : ""]
    .filter(Boolean).join(" ");

  if (r.status === "matched") {
    // silentOnAsk is true exactly when a person just answered the question.
    await fileAs(env, row.id, r.place, r.score, text, replyToken, tail, { speak: silentOnAsk });
    return true;
  }

  // Not sure. Say so, and offer what there is: numbered, so an answer can be
  // one character. An open question when there is nothing worth offering.
  await env.DB.prepare(
    "UPDATE events SET status = 'asking', text = COALESCE(?, text), confidence = ? WHERE id = ?",
  ).bind(text || null, r.score || null, row.id).run();

  if (silentOnAsk) return false;
  const lines = [tail ? `${tail} Which place?` : "Which place?"];
  r.options.forEach((o, i) => lines.push(`${i + 1}. ${placeLabel(o)}`));
  await reply(env, replyToken, lines.join("\n"));
  return false;
}

async function onText(ev, m, env, ch = "ops") {
  const uid = ev.source.userId || null;
  const gid = ev.source.groupId || ev.source.roomId;
  const raw = (m.text || "").trim();
  // In the bots room "bot, …" or "บอท…" is also talking to it, @ or no @.
  const bots = ch === "bots";
  const spokenTo = readsAsAddress(m) || (bots && readsAsBotsCall(raw));
  // Addressed, so this one event may be answered. Registered before any handler
  // runs, because several of them reply and none of them should have to know.
  if (spokenTo) allow(ev.replyToken);
  // The bots room also answers a line that is a command on its own ("status",
  // "bug the map is wrong") — that is somebody talking to the bot, not to a
  // person. The ops room does not: there the address is the only way in.
  const voice = () => { if (bots) allow(ev.replyToken); };
  const text = spokenTo ? raw.replace(ADDRESS, " ").replace(BOTS_CALL, "").trim() : raw;
  const ts = ev.timestamp || Date.now();
  const lower = text.toLowerCase();
  const name = await memberName(env, gid, uid);

  // Keep every line: it is the context a photo sent a moment later needs.
  const ins = await env.DB.prepare(
    `INSERT OR IGNORE INTO events (ts, kind, group_id, user_id, user_name, message_id, quoted_id, text, status, channel)
     VALUES (?, 'text', ?, ?, ?, ?, ?, ?, 'new', ?)`,
  ).bind(ts, gid, uid, name, m.id, m.quotedMessageId || null, raw, ch).run();
  if (!ins.meta.changes) return;

  // "@bot" on its own is somebody getting its attention with nothing to ask.
  // Say what is being held, which is the only thing it knows that they do not.
  if (spokenTo && !text) {
    await reply(env, ev.replyToken, await statusText(env, gid));
    return;
  }

  // Unaddressed, a command has to be the WHOLE line — otherwise "what's the
  // status of the medals" would have set the bot off, which is the behaviour
  // that got it removed. Addressed, the person is plainly talking to it, so the
  // word only has to be in there: "ok @nanobotco status please" is a request.
  const cmd = (w) => (spokenTo
    ? new RegExp(`(^|\\s)${w}(\\s|$)`).test(lower)
    : lower === w);

  if (cmd("help") || cmd("\\?") || cmd("ช่วย")) {
    voice();
    await reply(env, ev.replyToken, HELP);
    return;
  }
  if (cmd("status") || cmd("สถานะ")) {
    voice();
    await reply(env, ev.replyToken, await statusText(env, gid));
    return;
  }

  // A bug report keeps its own counter so it can be referred to out loud.
  // "bug …" and a bare "bug" are unambiguous and act at once. A bare "wrong"
  // waits until after the pending-question handling below.
  const call = readsAsReport(text);
  if (call.kind === "explicit" || call.kind === "call") {
    // In the bots room the ticket number goes back to whoever reported it.
    voice();
    await fileBug(env, ev, m, gid, ts, name, call.body);
    return;
  }


  // Is this the answer to a "which place?" the bot is still waiting on? The
  // person's own oldest open photo goes first, so several in a row settle in
  // the order they were sent.
  const pending = await env.DB.prepare(
    `SELECT * FROM events WHERE group_id = ? AND kind = 'photo' AND status = 'asking' AND ts >= ?
     ${uid ? "AND user_id = ?" : ""} ORDER BY ts ASC LIMIT 1`,
  ).bind(...(uid ? [gid, ts - ANSWER_WINDOW_MS, uid] : [gid, ts - ANSWER_WINDOW_MS])).first();

  if (pending) {
    // \b is an ASCII word boundary and there is none between two Thai
    // characters, so the Thai answers here never matched at all until
    // 2026-09-07. Latin keeps the boundary; Thai is anchored instead.
    if (/^(none|no|nope)\b/i.test(lower) || /^(ไม่ใช่|ไม่ถูก|ไม่)/.test(text.trim())) {
      await env.DB.prepare("UPDATE events SET status = 'unmatched' WHERE id = ?").bind(pending.id).run();
      await reply(env, ev.replyToken, "Noted — I will leave that one for a person to file.");
      return;
    }
    // "2" answers the numbered list the bot offered. The number picks that
    // record and files it — the reason the bot asked was that two places share
    // a name, so putting the name back through the matcher only asks again.
    const pick = /^([1-3])$/.exec(text);
    if (pick) {
      const idx = await placeIndex(env);
      const chosen = match(pending.text || "", idx).options[Number(pick[1]) - 1];
      if (chosen) {
        await fileAs(env, pending.id, chosen, 1, pending.text, ev.replyToken, "", { speak: true });
        return;
      }
    }
    const settled = await resolve(env, pending.message_id, text, ev.replyToken, { silentOnAsk: true });
    if (!settled) {
      await reply(env, ev.replyToken, "I still cannot place that one — send me a motdang.net link for it and I will file it.");
    }
    return;
  }

  // "yes" to the question below, within a few minutes of it being asked.
  if (/^(y|yes|yep|yeah|yup|ใช่|ครับ|ค่ะ)[\s.!?！？。]*$/i.test(text)) {
    const offer = await getState(env, "bug_offer:" + gid);
    if (offer) {
      const at = Number(offer.split("|")[1]);
      if (ts - at < 10 * 60 * 1000) {
        await setState(env, "bug_offer:" + gid, "");
        await fileBug(env, ev, m, gid, ts, name, "");
        return;
      }
    }
  }

  // The word turned up inside a sentence rather than as a call. Nan,
  // 2026-09-07: "I might be talking about hypothetical bugs, not expecting bot
  // behaviour to change. If it's in a long sentence or not clearly in response
  // to bot output, disambiguate subtly." So: file nothing, undo nothing, ask
  // once, lightly, and only when there is something of mine it could be about.
  // Ignored, it stays an ordinary line in the transcript, which is where a
  // hypothetical bug belonged anyway.
  if (call.kind === "wrong") {
    await fileBug(env, ev, m, gid, ts, name, "");
    return;
  }

  if (call.kind === "mentioned") {
    const recent = await lastAction(env, gid, ts, 10 * 60 * 1000);
    if (recent) {
      await setState(env, "bug_offer:" + gid, `${recent.message_id}|${ts}`);
      await reply(env, ev.replyToken,
        `(was that one for me? say yes and I will take that photo back off ${recent.place_name || "where I put it"}.)`);
    }
    if (!(bots && spokenTo)) return;
  }

  // A bare place name, or a link, right after a photo that was filed silently:
  // nothing to do. Text is kept and the next photo will read it.
  //
  // In the bots room, somebody who addressed the bot gets an answer rather than
  // silence, even when it has no command for what they said.
  if (bots && spokenTo && addressed(ev.replyToken)) {
    await reply(env, ev.replyToken, "เก็บไว้แล้ว · Kept. I answer help, status and bug …, and I file photos against a place.");
  }
  spend(ev.replyToken);
}

// Is this a report about something I did, or somebody talking about bugs?
//
//   "bug the toilets page shows 0"   explicit   — the convention, file it
//   "bug." / "bug!" / "wrong"        standalone — about the last thing I did
//   "we should file a bug for that"  mentioned  — ask, do not act
//
// The line between the last two is length and position: the gesture is short
// and leads with the word. Anything longer is somebody talking about bugs, and
// acting on that would undo a correct filing because of a passing remark.
const BUG_WORD = /(bugs?|บั๊ก|บัก)/i;
const WRONG_WORD = /^(that'?s?\s+)?(wrong|not right|incorrect|no+pe?|nah|bad|ผิด|ไม่ถูก|ไม่ใช่)[\s.!?！？。]*$/i;

export function readsAsReport(text) {
  const t = (text || "").trim();
  const lead = /^(bugs?|บั๊ก|บัก)\b[\s:：.!?！？。]*/i.exec(t);
  if (lead) {
    const body = t.slice(lead[0].length).trim();
    return body ? { kind: "explicit", body } : { kind: "call", body: "" };
  }
  // Deliberately a different kind from the two above: "ไม่ใช่" is also how you
  // answer "which place is it?" with none of those, so a bare wrongness word
  // only becomes a report once no question of mine is open.
  if (WRONG_WORD.test(t)) return { kind: "wrong", body: "" };
  if (BUG_WORD.test(t)) return { kind: "mentioned", body: "" };
  return { kind: null, body: "" };
}

// The most recent photo I decided something about, if it was recent enough to
// be what somebody means by "that".
async function lastAction(env, gid, ts, within) {
  return env.DB.prepare(
    `SELECT * FROM events WHERE group_id = ? AND kind = 'photo' AND ts <= ? AND ts >= ?
       AND status IN ('matched','asking','unmatched') ORDER BY ts DESC LIMIT 1`,
  ).bind(gid, ts, ts - within).first();
}

// A bug report, however it was phrased. An empty body means "the last thing you
// did" — the bot goes and looks at what that was rather than asking the person
// to write out what it already knows.
async function fileBug(env, ev, m, gid, ts, name, body) {

  // "bug." on its own is a report about the last thing I did. Nan, 2026-09-07:
  // "I said 'bug.' because the last thing you did was wrong." It is the
  // obvious gesture and the bot used to answer it by asking her to write the
  // report out again — so now it goes and finds what it just did, and the
  // report is about that, with my own decision attached as the evidence.
  let about = null;
  if (!body) {
    about = await lastAction(env, gid, ts, ANSWER_WINDOW_MS);
    if (!about) {
      await reply(env, ev.replyToken,
        "I cannot see what I did wrong — I have not done anything in here recently. Tell me in the same message: bug the toilets page shows 0 in Hang Dong");
      return;
    }
    body = about.place_name
      ? `the photo I filed under ${about.place_name}${about.confidence ? ` (${Math.round(about.confidence * 100)}% sure)` : ""} was filed wrong`
      : "the last photo I handled was handled wrong";
  }

  const n = Number(await getState(env, "bug_seq", "0")) + 1;
  const ticket = "BUG-" + String(n).padStart(4, "0");
  await setState(env, "bug_seq", n);
  await env.DB.prepare("UPDATE events SET kind = 'bug', ticket = ?, text = ?, quoted_id = COALESCE(quoted_id, ?) WHERE message_id = ?")
    .bind(ticket, body, about?.message_id || null, m.id).run();

  // A report about a filing is also a statement that the filing is wrong, so
  // stop standing behind it: the photo goes back to waiting for a name.
  if (about?.id) {
    await env.DB.prepare(
      "UPDATE events SET status = 'asking', place_slug = NULL, place_name = NULL, confidence = NULL WHERE id = ?",
    ).bind(about.id).run();
    await reply(env, ev.replyToken,
      `${ticket} — kept, and I have taken that photo back off ${about.place_name || "the place I put it under"}. Which place is it?`);
    return;
  }
  await reply(env, ev.replyToken, `${ticket} — kept. ${name ? name + ", t" : "T"}hanks.`);
  return;
}

async function statusText(env, gid) {
  const q = async (sql, ...b) => (await env.DB.prepare(sql).bind(...b).first())?.n ?? 0;
  const waiting = await q("SELECT COUNT(*) n FROM events WHERE group_id = ? AND kind = 'photo' AND status = 'asking'", gid);
  const unmatched = await q("SELECT COUNT(*) n FROM events WHERE group_id = ? AND kind = 'photo' AND status = 'unmatched'", gid);
  const held = await q("SELECT COUNT(*) n FROM events WHERE group_id = ? AND kind = 'photo' AND pulled_at IS NULL", gid);
  const photos = await q("SELECT COUNT(*) n FROM events WHERE group_id = ? AND kind = 'photo'", gid);
  const bugs = await q("SELECT COUNT(*) n FROM events WHERE group_id = ? AND kind = 'bug'", gid);
  const filed = await q("SELECT COUNT(*) n FROM events WHERE group_id = ? AND kind = 'bug' AND pulled_at IS NOT NULL", gid);
  return [
    `${photos} photo${photos === 1 ? "" : "s"} since I joined — ${waiting} waiting on a name, ${unmatched} for a person to file.`,
    `${bugs} bug report${bugs === 1 ? "" : "s"}, ${filed} already carried over.`,
    held ? `${held} not yet picked up by the desk.` : "Everything has been picked up by the desk.",
  ].join("\n");
}

// ── the nightly summary ──────────────────────────────────────────────────────
// The one push this Worker sends. Silent on a quiet day: a bot that says
// "nothing happened" every night at eight gets muted, and then it is not a
// bot anyone reads.

async function nightly(env) {
  const gid = await teamGroup(env);
  if (!gid) return;
  const since = Date.now() - 24 * 3600 * 1000;
  const rows = await env.DB.prepare(
    "SELECT kind, status, COUNT(*) n FROM events WHERE group_id = ? AND ts >= ? GROUP BY kind, status",
  ).bind(gid, since).all();
  const c = {};
  for (const r of rows.results || []) c[`${r.kind}:${r.status}`] = r.n;
  const filed = c["photo:matched"] || 0;
  const asking = c["photo:asking"] || 0;
  const loose = c["photo:unmatched"] || 0;
  const bugs = (c["bug:new"] || 0) + (c["bug:matched"] || 0);
  if (!filed && !asking && !loose && !bugs && !(c["location:new"] || 0)) return;

  const lines = ["วันนี้ — today in here:"];
  if (filed) lines.push(`• ${filed} photo${filed === 1 ? "" : "s"} filed under a place`);
  if (asking) lines.push(`• ${asking} still waiting on a name — say the place and I will catch up`);
  if (loose) lines.push(`• ${loose} left for a person to file`);
  if (bugs) lines.push(`• ${bugs} bug report${bugs === 1 ? "" : "s"} kept`);
  const pins = c["location:new"] || 0;
  if (pins) lines.push(`• ${pins} location${pins === 1 ? "" : "s"} pinned`);
  await push(env, gid, lines.join("\n"));
}

// ── the morning agenda ───────────────────────────────────────────────────────
// The second thing this Worker says without being spoken to, and the only one
// the mute lets through (src/line.js, pushAgenda). It reads one Google Calendar
// — the one all three people in the room can already see — and posts what is on
// today. Quiet on a day with nothing on it, for the same reason the nightly
// summary is: a bot that says "nothing" every morning is a bot nobody reads.

async function morning(env) {
  const gid = await teamGroup(env);
  if (!gid) return { why: "no team group" };
  const a = await buildAgenda(env);
  if (!a.text) return a;
  const sent = await pushAgenda(env, gid, a.text);
  return { ...a, sent };
}

// ── the desk's side ──────────────────────────────────────────────────────────

function deskOk(request, env) {
  const h = request.headers.get("authorization") || "";
  return env.PULL_TOKEN && h === "Bearer " + env.PULL_TOKEN;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    // Says what is actually running, not just that something is. Without this
    // there is no way to tell a deployed fix from an undeployed one from
    // outside, and "is the sign step live?" cost an afternoon on 2026-09-07.
    if (path === "/health") {
      return json({ ok: true, service: "motdang-line", build: BUILD, reads_sign: true, reads_neighbours: true,
        pages: flag(env, "PAGES"), flags: Object.fromEntries(FLAGS.map((f) => [f.toLowerCase(), flag(env, f)])) });
    }

    // A LINE friend's page, its photos and stamp cards. Public, read-only, no script.
    if (path.startsWith("/u/")) {
      const page = await servePage(request, env, path);
      if (page) return page;
    }
    // A family link from "ปลอดภัย · safe". Private by its token.
    if (path.startsWith("/safe/") && flag(env, "SAFE")) return serveSafe(request, env, path);
    if (path === "/spotters" && request.method === "GET" && flag(env, "SPOTTERS")) return spotters(env);
    // Owner edits for the mot-dang importer, behind the desk token.
    if (path.startsWith("/owner-edits") && flag(env, "OWNERS")) {
      if (!deskOk(request, env)) return new Response("no", { status: 401 });
      const r = await ownerEdits(request, env, path, url);
      if (r) return r;
    }

    if (path === "/line/webhook") {
      if (request.method !== "POST") return new Response("POST only", { status: 405 });
      const raw = await request.arrayBuffer();
      const ok = await verify(raw, request.headers.get("x-line-signature"), env.LINE_CHANNEL_SECRET);
      if (!ok) return new Response("bad signature", { status: 401 });
      let body;
      try {
        body = JSON.parse(new TextDecoder().decode(raw));
      } catch {
        return new Response("bad json", { status: 400 });
      }
      // LINE's own "Verify" button sends an empty event list and wants a 200.
      const events = body.events || [];
      ctx.waitUntil(
        (async () => {
          for (const ev of events) {
            try {
              await handleEvent(ev, env);
            } catch (e) {
              console.log("event failed", ev.type, e.stack || e.message);
            }
          }
        })(),
      );
      return new Response("ok");
    }

    // Everything below is the local filer talking, never a person.
    if (path.startsWith("/desk/")) {
      if (!deskOk(request, env)) return new Response("no", { status: 401 });

      if (path === "/desk/pull") {
        // Everything said in the room, not only the photos and the bugs.
        // Nan, 2026-09-07: "whether it's about Beer's hours or pictures from
        // someplace we visited today, if it's in the channel it's because it's
        // an action item for motdang." A line about a shop's new opening time
        // is a fact about a record; the desk is what reads it as one, so the
        // desk has to be given the line.
        const limit = Math.min(Number(url.searchParams.get("limit") || 200), 500);
        const rows = await env.DB.prepare(
          "SELECT * FROM events WHERE pulled_at IS NULL AND kind IN ('photo','bug','text','file','location') ORDER BY id ASC LIMIT ?",
        ).bind(limit).all();
        return json({ rows: rows.results || [] });
      }

      if (path === "/desk/photo") {
        const key = url.searchParams.get("key");
        if (!key) return new Response("key?", { status: 400 });
        const obj = await env.INBOX.get(key);
        if (!obj) return new Response("gone", { status: 404 });
        return new Response(obj.body, {
          headers: { "content-type": obj.httpMetadata?.contentType || "application/octet-stream" },
        });
      }

      if (path === "/desk/ack" && request.method === "POST") {
        const { ids } = await request.json().catch(() => ({}));
        if (!Array.isArray(ids) || !ids.length) return json({ acked: 0 });
        const now = Date.now();
        const marks = ids.map(() => "?").join(",");
        const r = await env.DB.prepare(
          `UPDATE events SET pulled_at = ? WHERE id IN (${marks}) AND pulled_at IS NULL`,
        ).bind(now, ...ids.map(Number)).run();
        return json({ acked: r.meta.changes });
      }

      // The match index, replaced whenever the site's names change.
      if (path === "/desk/index" && request.method === "PUT") {
        await env.INBOX.put("index/match.json", request.body, {
          httpMetadata: { contentType: "application/json" },
        });
        INDEX = null;
        return json({ ok: true });
      }

      // What the agenda WOULD say, built from the live feed and sent nowhere.
      // The whole point of having it: the morning message can be checked
      // without waiting until morning and without speaking in the room.
      if (path === "/desk/agenda") {
        const a = await buildAgenda(env);
        return json({ ok: true, armed: String(env.AGENDA ?? "").toLowerCase() === "on", ...a });
      }

      // Owner claims: the list, and a person's approve or refuse.
      if (path.startsWith("/desk/owners") && flag(env, "OWNERS")) {
        const r = await deskOwners(request, env, path, url);
        if (r) return r;
      }

      // What the alert run would do now. Sends only when ALERTS is on.
      if (path === "/desk/alerts" && request.method === "POST") {
        return json(await runAlerts(env));
      }

      // The Golf Ball Drop ledger as TSV, and what the dated posts would say
      // on a day (sent nowhere). ?group= picks a room; the default is the
      // newest gbd room.
      if (path === "/desk/gbd/ledger" && request.method === "GET") {
        const gid = url.searchParams.get("group") || (await gbdGroups(env))[0];
        if (!gid) return new Response("no gbd room\n", { status: 404 });
        return new Response(await ledgerTsv(env, gid), { headers: { "content-type": "text/tab-separated-values; charset=utf-8" } });
      }
      if (path === "/desk/gbd/posts" && request.method === "GET") {
        const date = url.searchParams.get("date");
        if (date && !/^\d{4}-\d\d-\d\d$/.test(date)) return json({ ok: false, why: "date is YYYY-MM-DD" }, 400);
        return json({ ok: true, ...(await runGbdPosts(env, { date, dry: true })) });
      }

      // The rooms and their modes; and setting one from the Mac
      // (scripts/group_mode.py). The ops room and the swim room are not in
      // this table and cannot be put in it.
      if (path === "/desk/groups" && request.method === "GET") {
        const r = await env.DB.prepare("SELECT * FROM group_modes ORDER BY set_at DESC").all();
        return json({ team_group_id: await teamGroup(env), cwsdpp_group_id: await cwsdppGroup(env), groups: r.results || [] });
      }
      if (path.startsWith("/desk/groups/") && request.method === "POST") {
        const gid = decodeURIComponent(path.slice("/desk/groups/".length));
        const { mode } = await request.json().catch(() => ({}));
        if (!MODES.includes(mode)) return json({ ok: false, why: "mode is one of " + MODES.join(", ") }, 400);
        if (!/^C[\w-]{4,64}$/.test(gid)) return json({ ok: false, why: "not a group id" }, 400);
        if (gid === (await teamGroup(env)) || gid === (await cwsdppGroup(env))) {
          return json({ ok: false, why: "the ops room and the swim room keep their own handling" }, 400);
        }
        await setMode(env, gid, mode, await groupSummary(env, gid), "desk");
        return json({ ok: true, group: await env.DB.prepare("SELECT * FROM group_modes WHERE group_id = ?").bind(gid).first() });
      }

      if (path === "/desk/state") {
        return json({
          team_group_id: await teamGroup(env),
          bug_seq: Number(await getState(env, "bug_seq", "0")),
          index_loaded: !!INDEX,
        });
      }
    }

    return new Response("not here", { status: 404 });
  },

  // Two crons, and which one fired is the whole difference between the two
  // jobs: 00:00 UTC is 07:00 in Bangkok and posts the day; 13:00 UTC is 20:00
  // and closes it. A handler that ran both on either trigger would say the
  // agenda twice a day, which is how a thing people read becomes a thing they
  // mute.
  //
  // The third, hourly at half past, is the alerts run (src/alerts.js). It is
  // matched first and by its whole string, so the two above keep the branches
  // they had. It also sends the reminders readers set on motdang.net
  // (src/site.js) and runs the Golf Ball Drop posts, which retries a post that
  // failed at 09:00 the same day. The fourth, 02:00 UTC = 09:00 Bangkok, is
  // those posts' own (src/gbd.js).
  async scheduled(event, env, ctx) {
    const cron = event?.cron || "";
    if (cron === ALERT_CRON) {
      // One job to the runtime; the alerts result is what it resolves to.
      ctx.waitUntil((async () => {
        const [alerts] = await Promise.allSettled([runAlerts(env), runGbdPosts(env).catch((e) => console.log("gbd posts failed", e.message)),
          runReminders(env).catch((e) => console.log("reminders failed", e.message))]);
        if (alerts.status === "rejected") throw alerts.reason;
        return alerts.value;
      })());
    } else if (cron === GBD_CRON) ctx.waitUntil(runGbdPosts(env));
    else if (cron.startsWith("0 0 ")) ctx.waitUntil(morning(env));
    else ctx.waitUntil(nightly(env));
  },
};
