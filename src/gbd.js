// The Golf Ball Drop room (Nan, 2026-10-10).
//
// The Chiang Mai International Rotary Club sells 300 numbered golf balls for its
// Golf Ball Drop on Sat 30 Jan 2027. Tickets go to club members, each member
// sells and pays in, and this room's ledger records who holds which number.
//
// What the Worker does in a gbd room:
//   * answers a line that addresses it (@nanobotco, a mention, "bot, …") and a
//     line that is only "status"; every other line returns before any lookup,
//     write or reply;
//   * keeps ledger commands and their results in gbd_tickets and gbd_log. A
//     message, photo or file from the room is not written anywhere, and nothing
//     here touches the events table the desk pull reads;
//   * posts six dated lines through pushGbd (src/line.js).
//
// Only scripts/group_mode.py sets a room to gbd; no group name does.

import { reply, allow, hush, memberName, pushGbd } from "./line.js";
import { readsAsAddress, readsAsBotsCall, withoutAddress } from "./address.js";
import { dateKeyIn } from "./agenda.js";

export const MAX_BALL = 300;
export const DEFAULT_PRICE = 1000;
const TZ = "Asia/Bangkok";
const BANGKOK_MS = 7 * 3600 * 1000; // Bangkok has no daylight saving
export const GBD_CRON = "0 2 * * *"; // 02:00 UTC = 09:00 Bangkok

const baht = (n) => Number(n).toLocaleString("en-US");

// ── ball numbers ─────────────────────────────────────────────────────────────

const DASH = "[-–—]";
const NUMS = String.raw`\d+(?:\s*${DASH}\s*\d+)?(?:\s*,\s*\d+(?:\s*${DASH}\s*\d+)?)*`;

// "5", "1-20", "5,7,9" or a mix. Returns { nums } sorted and unique, or
// { error } as one line.
export function parseBalls(spec) {
  const out = new Set();
  for (const part of String(spec).split(",")) {
    const m = new RegExp(`^\\s*(\\d+)(?:\\s*${DASH}\\s*(\\d+))?\\s*$`).exec(part);
    if (!m) return { error: "Numbers look like 5, 1-20 or 5,7,9." };
    const a = Number(m[1]);
    const b = m[2] === undefined ? a : Number(m[2]);
    for (const [raw, v] of [[m[1], a], [m[2], b]]) {
      if (raw !== undefined && (v < 1 || v > MAX_BALL)) {
        return { error: `Ball ${raw.slice(0, 6)} is outside 1-${MAX_BALL}.` };
      }
    }
    if (b < a) return { error: `${m[1]}-${m[2]} runs backwards.` };
    for (let i = a; i <= b; i++) out.add(i);
  }
  return { nums: [...out].sort((x, y) => x - y) };
}

// [1,2,3,7,9,10] -> "1-3, 7, 9-10"
export function compress(nums) {
  const parts = [];
  for (let i = 0; i < nums.length; ) {
    let j = i;
    while (j + 1 < nums.length && nums[j + 1] === nums[j] + 1) j++;
    parts.push(j > i ? `${nums[i]}-${nums[j]}` : `${nums[i]}`);
    i = j + 1;
  }
  return parts.join(", ");
}

// ── commands ─────────────────────────────────────────────────────────────────

const UNIT = String.raw`(?:\s*(?:baht|thb|บาท|฿))?`;
const RX = {
  issue: new RegExp(`^issue\\s+(${NUMS})\\s+to\\s+(.+)$`, "i"),
  sold: new RegExp(`^sold\\s+(${NUMS})(?:\\s+(?:to\\s+)?(.+))?$`, "i"),
  paid: new RegExp(`^paid\\s+(${NUMS})(?:\\s+฿?\\s*(\\d[\\d,]*)${UNIT})?$`, "i"),
  back: new RegExp(`^back\\s+(${NUMS})$`, "i"),
  who: new RegExp(`^who(?:\\s+(${NUMS}))?$`, "i"),
  price: new RegExp(`^price(?:\\s+฿?\\s*(\\d[\\d,]*)${UNIT})?$`, "i"),
};

const cleanName = (s) => String(s || "").replace(/[\t\r\n]+/g, " ").replace(/^@+/, "").replace(/\s+/g, " ").trim().slice(0, 40);

// The text of a line, with the address already taken off, as a command.
// kind "unknown" is a line that is none of them.
export function parseCommand(body) {
  const t = String(body || "").trim();
  if (!t) return { kind: "status" };
  const first = (/^\S+/.exec(t)?.[0] || "").toLowerCase().replace(/[.!?]+$/, "");
  if (first === "status") return { kind: "status" };
  if (first === "help" || first === "?") return { kind: "help" };
  let m;
  if ((m = RX.issue.exec(t))) {
    const name = cleanName(m[2]);
    return name ? { kind: "issue", spec: m[1], name } : { kind: "unknown" };
  }
  if ((m = RX.sold.exec(t))) {
    const buyer = cleanName(m[2]);
    if (m[2] !== undefined && (!buyer || /^[\d\s,.\-–—]+$/.test(buyer))) return { kind: "unknown" };
    return { kind: "sold", spec: m[1], buyer: buyer || null };
  }
  if ((m = RX.paid.exec(t))) {
    return { kind: "paid", spec: m[1], amount: m[2] === undefined ? null : Number(m[2].replace(/,/g, "")) };
  }
  if ((m = RX.back.exec(t))) return { kind: "back", spec: m[1] };
  if ((m = RX.who.exec(t))) return m[1] ? { kind: "who", spec: m[1] } : { kind: "unknown" };
  if ((m = RX.price.exec(t))) return { kind: "price", amount: m[1] === undefined ? null : Number(m[1].replace(/,/g, "")) };
  return { kind: "unknown" };
}

const MUTATES = new Set(["issue", "sold", "paid", "back", "price"]);

export const HELP = [
  `Ball numbers 1-${MAX_BALL}: 5, 1-20 or 5,7,9.`,
  "issue 1-20 to <name>",
  "sold 5 [buyer]",
  "paid 1-20 [total baht]",
  "back 15-20",
  "who 17",
  "price [baht]",
  "status",
  "Start a line with @nanobotco or bot, ; status also works on its own.",
].join("\n");

// ── the ledger ───────────────────────────────────────────────────────────────

async function tickets(env, gid) {
  const r = await env.DB.prepare("SELECT * FROM gbd_tickets WHERE group_id = ?").bind(gid).all();
  return new Map((r.results || []).map((t) => [t.n, t]));
}

export async function getPrice(env, gid) {
  const r = await env.DB.prepare("SELECT v FROM state WHERE k = ?").bind("gbd_price:" + gid).first();
  const n = r ? Number(r.v) : NaN;
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_PRICE;
}

async function setPrice(env, gid, n) {
  await env.DB.prepare(
    "INSERT INTO state (k, v, ts) VALUES (?, ?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v, ts = excluded.ts",
  ).bind("gbd_price:" + gid, String(n), Date.now()).run();
}

// The first problem in ball order, and how many more there are.
function refusal(problems, tail = "") {
  problems.sort((a, b) => a.n - b.n);
  const first = problems[0].msg;
  return (problems.length > 1 ? `${first.replace(/\.$/, "")} (+${problems.length - 1} more).` : first) + tail;
}

const NONE = " Nothing recorded.";
const RACE = "Some balls changed while saving; who shows where they stand.";

async function doIssue(env, gid, c, who, ts) {
  const p = parseBalls(c.spec);
  if (p.error) return p.error;
  const have = await tickets(env, gid);
  const problems = p.nums.filter((n) => have.has(n)).map((n) => ({ n, msg: `Ball ${n} is already with ${have.get(n).holder}.` }));
  if (problems.length) return refusal(problems, NONE);
  await env.DB.prepare(
    "INSERT INTO gbd_tickets (group_id, n, holder, issued_by, issued_at) SELECT ?, value, ?, ?, ? FROM json_each(?)",
  ).bind(gid, c.name, who, ts, JSON.stringify(p.nums)).run();
  return `Issued ${compress(p.nums)} to ${c.name} (${p.nums.length}).`;
}

async function doSold(env, gid, c, who, ts) {
  const p = parseBalls(c.spec);
  if (p.error) return p.error;
  const have = await tickets(env, gid);
  const problems = [];
  for (const n of p.nums) {
    const t = have.get(n);
    if (!t) problems.push({ n, msg: `Ball ${n} is not issued.` });
    else if (t.sold) problems.push({ n, msg: `Ball ${n} is already sold${t.buyer ? " to " + t.buyer : ""}.` });
  }
  if (problems.length) return refusal(problems, NONE);
  const r = await env.DB.prepare(
    "UPDATE gbd_tickets SET sold = 1, buyer = ?, sold_by = ?, sold_at = ? WHERE group_id = ? AND sold = 0 AND n IN (SELECT value FROM json_each(?))",
  ).bind(c.buyer, who, ts, gid, JSON.stringify(p.nums)).run();
  if (r.meta.changes !== p.nums.length) return RACE;
  return `Sold ${compress(p.nums)}${c.buyer ? " to " + c.buyer : ""}.`;
}

async function doPaid(env, gid, c, who, ts) {
  const p = parseBalls(c.spec);
  if (p.error) return p.error;
  const have = await tickets(env, gid);
  const problems = [];
  for (const n of p.nums) {
    const t = have.get(n);
    if (!t) problems.push({ n, msg: `Ball ${n} is not issued.` });
    else if (t.paid) problems.push({ n, msg: `Ball ${n} is already paid.` });
  }
  if (problems.length) return refusal(problems, NONE);
  const total = c.amount ?? (await getPrice(env, gid)) * p.nums.length;
  if (!Number.isSafeInteger(total) || total < 1 || total > 10_000_000) return "The amount is not a usable number of baht." + NONE;
  // A total that does not divide evenly puts the odd baht on the lowest numbers.
  const base = Math.floor(total / p.nums.length);
  const extra = total - base * p.nums.length;
  const pairs = JSON.stringify(p.nums.map((n, i) => [n, base + (i < extra ? 1 : 0)]));
  const implied = p.nums.filter((n) => !have.get(n).sold).length;
  const r = await env.DB.prepare(
    `UPDATE gbd_tickets SET paid = 1,
       paid_amount = (SELECT json_extract(j.value, '$[1]') FROM json_each(?) j WHERE json_extract(j.value, '$[0]') = gbd_tickets.n),
       paid_by = ?, paid_at = ?,
       sold = 1,
       sold_by = CASE WHEN sold = 1 THEN sold_by ELSE ? END,
       sold_at = CASE WHEN sold = 1 THEN sold_at ELSE ? END
     WHERE group_id = ? AND paid = 0 AND n IN (SELECT json_extract(value, '$[0]') FROM json_each(?))`,
  ).bind(pairs, who, ts, who, ts, gid, pairs).run();
  if (r.meta.changes !== p.nums.length) return RACE;
  return `Paid ${compress(p.nums)}: ${baht(total)} baht.${implied ? ` ${implied} also marked sold.` : ""}`;
}

async function doBack(env, gid, c) {
  const p = parseBalls(c.spec);
  if (p.error) return p.error;
  const have = await tickets(env, gid);
  const problems = [];
  for (const n of p.nums) {
    const t = have.get(n);
    if (!t) problems.push({ n, msg: `Ball ${n} is not issued.` });
    else if (t.sold) problems.push({ n, msg: `Ball ${n} is ${t.paid ? "paid" : "sold"} and cannot go back.` });
  }
  if (problems.length) return refusal(problems, NONE);
  const holders = [...new Set(p.nums.map((n) => have.get(n).holder))];
  const r = await env.DB.prepare(
    "DELETE FROM gbd_tickets WHERE group_id = ? AND sold = 0 AND n IN (SELECT value FROM json_each(?))",
  ).bind(gid, JSON.stringify(p.nums)).run();
  if (r.meta.changes !== p.nums.length) return RACE;
  return `Back ${compress(p.nums)}${holders.length === 1 ? " from " + holders[0] : ""}; unissued again.`;
}

async function doWho(env, gid, c) {
  const p = parseBalls(c.spec);
  if (p.error) return p.error;
  if (p.nums.length > 10) return "who takes up to 10 balls.";
  const have = await tickets(env, gid);
  return p.nums.map((n) => {
    const t = have.get(n);
    if (!t) return `${n} is unissued.`;
    const sold = t.sold ? `Sold${t.buyer ? " to " + t.buyer : ""}.` : "Not sold.";
    const paid = t.paid ? `Paid ${baht(t.paid_amount ?? 0)} baht.` : "Not paid.";
    return `${n} is with ${t.holder}. ${sold} ${paid}`;
  }).join("\n");
}

async function doPrice(env, gid, c) {
  if (c.amount === null) return `Price ${baht(await getPrice(env, gid))} baht a ball.`;
  if (!Number.isSafeInteger(c.amount) || c.amount < 1 || c.amount > 100000) return "The price is not a usable number of baht." + NONE;
  await setPrice(env, gid, c.amount);
  return `Price ${baht(c.amount)} baht a ball.`;
}

// ── status ───────────────────────────────────────────────────────────────────

// "Issued 120 · sold 80 · paid 60 · unissued 180 · baht in 60,000"
export async function statusCounts(env, gid) {
  const t = await env.DB.prepare(
    "SELECT COUNT(*) issued, COALESCE(SUM(sold), 0) sold, COALESCE(SUM(paid), 0) paid, COALESCE(SUM(paid_amount), 0) baht FROM gbd_tickets WHERE group_id = ?",
  ).bind(gid).first();
  return `Issued ${t.issued} · sold ${t.sold} · paid ${t.paid} · unissued ${MAX_BALL - t.issued} · baht in ${baht(t.baht)}`;
}

const MEMBER_LINES_MAX = 12;

export async function statusText(env, gid) {
  const lines = [await statusCounts(env, gid)];
  const r = await env.DB.prepare(
    `SELECT MIN(holder) holder, COUNT(*) issued, SUM(sold) sold, SUM(paid) paid FROM gbd_tickets
      WHERE group_id = ? GROUP BY holder COLLATE NOCASE ORDER BY MIN(n)`,
  ).bind(gid).all();
  const holders = r.results || [];
  if (holders.length && holders.length <= MEMBER_LINES_MAX) {
    for (const h of holders) lines.push(`${h.holder}: ${h.issued} issued, ${h.sold} sold, ${h.paid} paid`);
  } else if (holders.length) {
    lines.push(`${holders.length} members hold balls.`);
  }
  return lines.join("\n");
}

// ── the room's event ─────────────────────────────────────────────────────────

const STATUS_ALONE = /^status[.!?]*$/i;

async function senderName(env, gid, uid) {
  return (await memberName(env, gid, uid)) || (uid ? "member " + uid.slice(-4) : "someone");
}

export async function onGbd(ev, env, gid) {
  // Anything that is not a line of text: no read, no write, no reply.
  if (ev.type !== "message" || ev.message?.type !== "text") return void hush(ev.replyToken);
  const m = ev.message;
  const raw = String(m.text || "").trim();
  const addressed = readsAsAddress(m) || readsAsBotsCall(raw);
  if (!addressed && !STATUS_ALONE.test(raw)) return void hush(ev.replyToken);

  const body = addressed ? withoutAddress(m) : "status";
  const c = parseCommand(body);
  allow(ev.replyToken);
  const say = (text) => reply(env, ev.replyToken, text);

  if (c.kind === "status") return say(await statusText(env, gid));
  if (c.kind === "help") return say(HELP);
  if (c.kind === "unknown") return say("Not a ledger command.\n" + HELP);
  if (c.kind === "who") return say(await doWho(env, gid, c));
  if (c.kind === "price" && c.amount === null) return say(await doPrice(env, gid, c));

  if (!MUTATES.has(c.kind)) return;
  const uid = ev.source.userId || null;
  const ts = ev.timestamp || Date.now();
  const who = await senderName(env, gid, uid);
  // The command is written down first. LINE delivers some webhooks twice, and
  // the second delivery stops here.
  const claim = await env.DB.prepare(
    "INSERT OR IGNORE INTO gbd_log (group_id, ts, user_id, user_name, message_id, cmd, text) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).bind(gid, ts, uid, who, m.id || null, c.kind, body.slice(0, 300)).run();
  if (!claim.meta.changes) return void hush(ev.replyToken);

  let out;
  try {
    out = await { issue: doIssue, sold: doSold, paid: doPaid, back: doBack, price: doPrice }[c.kind](env, gid, c, who, ts);
  } catch (e) {
    console.log("gbd command failed", c.kind, e.stack || e.message);
    out = "That write failed.";
  }
  await env.DB.prepare("UPDATE gbd_log SET result = ? WHERE id = ?").bind(out, claim.meta.last_row_id).run();
  return say(out);
}

// ── the desk's ledger ────────────────────────────────────────────────────────

export async function gbdGroups(env) {
  const r = await env.DB.prepare("SELECT group_id FROM group_modes WHERE mode = 'gbd' ORDER BY set_at DESC").all();
  return (r.results || []).map((x) => x.group_id);
}

const stamp = (ms) => (ms ? new Date(ms + BANGKOK_MS).toISOString().slice(0, 19) + "+07:00" : "");
const cell = (v) => String(v ?? "").replace(/[\t\r\n]+/g, " ");

export const LEDGER_HEAD = ["ball", "state", "holder", "buyer", "paid_baht", "issued_by", "issued_at", "sold_by", "sold_at", "paid_by", "paid_at"];

// All 300 balls, one row each, as tab-separated text.
export async function ledgerTsv(env, gid) {
  const have = await tickets(env, gid);
  const rows = [LEDGER_HEAD];
  for (let n = 1; n <= MAX_BALL; n++) {
    const t = have.get(n);
    if (!t) { rows.push([n, "unissued", "", "", "", "", "", "", "", "", ""]); continue; }
    rows.push([n, t.paid ? "paid" : t.sold ? "sold" : "issued", t.holder, t.buyer, t.paid ? t.paid_amount : "",
      t.issued_by, stamp(t.issued_at), t.sold_by, stamp(t.sold_at), t.paid_by, stamp(t.paid_at)]);
  }
  return rows.map((r) => r.map(cell).join("\t")).join("\n") + "\n";
}

// ── the dated posts ──────────────────────────────────────────────────────────
// Bangkok time, 09:00. Each is one or two short lines and the current counts.

export const SOP = [
  { date: "2026-10-25", text: "Tickets go out to members on 1 Nov." },
  { date: "2026-11-01", text: "Ticket handout starts today. To record numbers taken: @nanobotco issue 1-20 to <name>" },
  { date: "2026-12-01", text: "Volunteer roles to confirm: golf ball sellers, balloon ride sellers, balloon area posts and tape, parking monitor." },
  { date: "2027-01-10", text: "Tickets and money are due back today." },
  { date: "2027-01-23", text: "One week to the drop, Sat 30 Jan." },
  { date: "2027-02-16", text: "Final accounting with the treasurer." },
];

// What goes out in a room on a date: [{ key, text }]. The counts are read at
// the moment of the call.
export async function postsOn(env, gid, dateKey) {
  const out = [];
  for (const p of SOP.filter((x) => x.date === dateKey)) {
    out.push({ key: p.date, text: `${p.text}\n${await statusCounts(env, gid)}` });
  }
  return out;
}

// The cron entry. Sends a room's post once, on its date, from 09:00 Bangkok.
// The hourly cron calls it too, so a post that failed at 09:00 is tried again
// that day. `dry` builds the text and sends nothing.
export async function runGbdPosts(env, { now = Date.now(), date = null, dry = false } = {}) {
  const dateKey = date || dateKeyIn(now, TZ);
  const hour = new Date(now + BANGKOK_MS).getUTCHours();
  const armed = String(env.GBD_POSTS ?? "").toLowerCase() === "on";
  const results = [];
  if (!dry && !armed) return { armed, date: dateKey, results };
  if (!dry && hour < 9) return { armed, date: dateKey, results };
  for (const gid of await gbdGroups(env)) {
    for (const p of await postsOn(env, gid, dateKey)) {
      const done = await env.DB.prepare("SELECT sent_at FROM gbd_posts WHERE group_id = ? AND key = ?").bind(gid, p.key).first();
      const row = { group: gid, key: p.key, text: p.text, sent: !!done };
      if (!dry && !done) {
        row.sent = await pushGbd(env, gid, p.text);
        if (row.sent) {
          await env.DB.prepare("INSERT OR IGNORE INTO gbd_posts (group_id, key, sent_at) VALUES (?, ?, ?)").bind(gid, p.key, Date.now()).run();
        }
      }
      results.push(row);
    }
  }
  return { armed, date: dateKey, results };
}
