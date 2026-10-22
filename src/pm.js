// PM words in a one-to-one chat. Nan, 2026-10-21: "give him access to PM
// tools in our line channels", answered "Bot DM, Michael only".
//
// Only the LINE user ids in PM_USERS reach this file. Everything it knows comes
// from the Team Wheel (pm.nanobotco.workers.dev) through its API, as Michael:
// PM_KEY is his wheel key, so a Give here is the same Give as on the wheel and
// posts in Discord as "Michael · PM". This file stores two rows per person in
// `state`: the last list shown (so "give 2 Beer" knows which 2) and one action
// waiting for its yes.
//
// It answers with reply(), not push(), so the room mute and the push cap stay as
// they are.

import { reply, replyMessages, allow } from "./line.js";

const WAIT_MS = 10 * 60 * 1000;
const STATES = { open: "Open", doing: "Doing", waiting: "Waiting", done: "Done" };
const RANKS = { first: 1, next: 2, later: 3, unorder: 0 };

export const pmUser = (env, uid) =>
  !!uid && String(env.PM_USERS || "").split(",").map((s) => s.trim()).filter(Boolean).includes(uid);

const say = (env, ev, text) => { allow(ev.replyToken); return reply(env, ev.replyToken, text); };
const ask = (env, ev, text, yes) => {
  allow(ev.replyToken);
  return replyMessages(env, ev.replyToken, [{
    type: "text", text,
    quickReply: { items: [
      { type: "action", action: { type: "message", label: yes, text: "yes" } },
      { type: "action", action: { type: "message", label: "No", text: "no" } },
    ] },
  }]);
};

async function getS(env, k) {
  const r = await env.DB.prepare("SELECT v FROM state WHERE k = ?").bind(k).first();
  return r ? r.v : null;
}
async function setS(env, k, v) {
  await env.DB.prepare(
    "INSERT INTO state (k, v, ts) VALUES (?, ?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v, ts = excluded.ts",
  ).bind(k, String(v), Date.now()).run();
}

async function wheel(env, path, body) {
  const base = String(env.PM_URL || "https://pm.nanobotco.workers.dev").replace(/\/$/, "");
  const r = await fetch(base + path, {
    method: body ? "POST" : "GET",
    headers: { "x-key": env.PM_KEY || "", "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const d = await r.json().catch(() => ({ error: `The wheel answered ${r.status}.` }));
  if (!r.ok || d.error) throw new Error(d.error || `The wheel answered ${r.status}.`);
  return d;
}

// The same lists the wheel's Today page shows (pm-desk public/app.js).
const live = (B) => B.tickets.filter((x) => !x.archived || x.state !== "Done");
const sorted = (l) => [...l].sort((a, b) => (a.rank || 9) - (b.rank || 9)
  || (b.priority === "revenue") - (a.priority === "revenue") || String(a.created).localeCompare(String(b.created)));
const passed = (B) => new Set((B.log || []).filter((l) => l.act === "passed").map((l) => l.id));
export const lists = {
  check: (B) => sorted(live(B).filter((x) => x.state === "Done" && !passed(B).has(x.id))),
  give: (B) => sorted(live(B).filter((x) => !x.who.length && x.state !== "Done")),
  quiet: (B, now = Date.now()) => sorted(live(B).filter((x) => (x.state === "Doing" || x.state === "Open")
    && x.who.length && now - new Date(x.active) > 4 * 864e5)),
};

const ICON = { Open: "📥", Doing: "🔨", Waiting: "⏳", Done: "✅" };
const short = (s, n = 70) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
const row = (x, i) => `${i}. ${ICON[x.state] || ""} ${short(x.title)} · ${x.who.join(", ") || "nobody"}`;

// Repeats (the wheel's 🔁): jobs that come back to one person on chosen weekdays.
// Ticking one posts nothing in Discord, so it needs no yes; "undo" takes it back.
const mine = (B) => (B.repeats || []).filter((r) => r.whoName === B.me.name);
const DAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const dayOf = (d) => DAY[new Date(d + "T12:00:00Z").getUTCDay()];
const dayDate = (d) => `${dayOf(d)} ${+d.slice(8)} ${new Date(d + "T12:00:00Z").toLocaleDateString("en-GB", { month: "short", timeZone: "UTC" })}`;
// the word "done <word>" needs; a title with no long word uses itself (CodeRabbit, #8)
const word = (r) => (r.title.toLowerCase().match(/[a-z\u0E00-\u0E7F]{3,}/g) || []).filter((w) => !["check", "the", "and"].includes(w))[0] || r.title.toLowerCase().trim();
function repeatLines(B) {
  const due = mine(B).filter((r) => r.due);
  return due.map((r) => `${r.face || "🔁"} ${short(r.title)}${r.late ? ` · since ${dayOf(r.slot)}` : r.time ? ` · ${r.time}` : ""} → send: done ${word(r)}`);
}

// Numbers run on across the sections of one answer, and that numbering is what
// the next "give 3 …" means.
function numbered(sections) {
  const ids = [], out = [];
  for (const [head, items, empty] of sections) {
    out.push(head);
    if (!items.length && empty) out.push(empty); // no "empty" line: a section of plain lines
    for (const x of items) { ids.push(x.id); out.push(row(x, ids.length)); }
  }
  return { ids, text: out.join("\n") };
}

async function show(env, ev, uid, sections, tail = "") {
  const { ids, text } = numbered(sections);
  await setS(env, "pm_list:" + uid, JSON.stringify(ids));
  return say(env, ev, text + (tail ? "\n\n" + tail : ""));
}

const HELP = [
  "PM words · send one:",
  "today · what to check, give out, chase",
  "report · a status report to forward",
  "who Beer · what one person holds",
  "find cards · search tickets",
  "3 · open ticket 3 from the last list",
  "give 3 Beer · hand it over (add a note after)",
  "pass 3 · fail 3 what is wrong",
  "note 3 your words · posts in the ticket",
  "doing 3 · waiting 3 · done 3 · open 3",
  "first 3 · next 3 · later 3 · your order",
  "back 3 what is missing · to NaN",
  "done mailbox · tick a 🔁 repeat done (undo takes it back)",
  "link · your wheel page",
  "Anything that posts asks for a yes first.",
].join("\n");

function sitrep(B, today = new Date()) {
  const T = live(B), by = (s) => T.filter((x) => x.state === s).length;
  const tz = "Asia/Bangkok";
  const day = (d) => new Date(d).toLocaleDateString("en-GB", { timeZone: tz });
  const changes = (B.log || []).filter((l) => day(l.at) === day(today));
  const first = sorted(T.filter((x) => x.rank === 1 && x.state !== "Done"));
  const g = B.gold || {};
  return [
    `Team tickets · ${today.toLocaleDateString("en-GB", { timeZone: tz, weekday: "short", day: "numeric", month: "short" })}`,
    `Gold sold, last 30 days: ${g.paid ?? 0} · ฿${(g.baht || 0).toLocaleString("en-US")} of ฿${(g.goal || 61000).toLocaleString("en-US")}`,
    `Open ${by("Open")} · Doing ${by("Doing")} · Waiting ${by("Waiting")} · Done ${by("Done")}`,
    "Holding: " + B.holders.map((p) => `${p} ${B.load[p] ?? 0}${B.cap[p] ? "/" + B.cap[p] : ""}`).join(", "),
    first.length ? "First:\n" + first.map((x) => `- ${x.title} (${x.who.join(", ") || "nobody"})`).join("\n") : "",
    changes.length ? "Today:\n" + changes.map((l) => `- ${l.who ? l.who + " " : ""}${l.act}: ${l.title}`).join("\n") : "Today: no changes.",
    `— ${B.me.name}`,
  ].filter(Boolean).join("\n");
}

function ticketText(x, n) {
  return [
    `${n}. ${x.title}`,
    `${ICON[x.state] || ""} ${x.state} · ${x.who.join(", ") || "nobody"}${x.priority === "revenue" ? " · ฿ revenue" : ""}${x.due ? " · due " + x.due : ""}`,
    x.goal ? `Goal: ${x.goal}` : "",
    x.done ? `Done means: ${x.done}` : "",
    x.link,
  ].filter(Boolean).join("\n");
}

// Text → what it asks for. Exported for the tests.
export function parse(text) {
  const s = String(text || "").trim().replace(/\s+/g, " ");
  const low = s.toLowerCase();
  let m;
  if (/^(help|pm|\?|menu|words)$/.test(low)) return { k: "help" };
  if (/^(yes|y|ok|send)$/.test(low)) return { k: "yes" };
  if (/^(no|n|cancel|stop)$/.test(low)) return { k: "no" };
  if (/^(today|check|chase)$/.test(low)) return { k: "today" };
  if (/^(report|sitrep|status)$/.test(low)) return { k: "report" };
  if (/^(link|wheel|board)$/.test(low)) return { k: "link" };
  if (/^undo$/.test(low)) return { k: "undo" };
  // "done mailbox" ticks a repeat; "done 3" (a number) stays the ticket word below
  if ((m = s.match(/^(?:done|did)(?:\s+(?!#?\d+(?:\s|$))(.+))?$/i))) return { k: "rdone", words: (m[1] || "").trim() };
  if ((m = s.match(/^who\s+(.+)$/i))) return { k: "who", name: m[1] };
  if ((m = s.match(/^find\s+(.+)$/i))) return { k: "find", words: m[1] };
  if ((m = s.match(/^#?(\d{1,3})$/))) return { k: "open", n: +m[1] };
  if ((m = s.match(/^give\s+#?(\d{1,3})\s+(?:to\s+)?(.+)$/i))) return { k: "give", n: +m[1], rest: m[2] };
  if ((m = s.match(/^(pass|fail|note|back)\s+#?(\d{1,3})(?:\s+([\s\S]+))?$/i))) return { k: m[1].toLowerCase(), n: +m[2], note: (m[3] || "").trim() };
  if ((m = s.match(/^(open|doing|waiting|done)\s+#?(\d{1,3})(?:\s+([\s\S]+))?$/i))) return { k: "state", state: STATES[m[1].toLowerCase()], n: +m[2], note: (m[3] || "").trim() };
  if ((m = s.match(/^(first|next|later|unorder)\s+#?(\d{1,3})$/i))) return { k: "rank", rank: RANKS[m[1].toLowerCase()], n: +m[2] };
  return { k: "unknown" };
}

// "Wai Tun please start Monday" → the holder "Wai Tun" and the note after it.
export function personAndNote(rest, holders) {
  const low = rest.toLowerCase();
  const hit = [...holders].sort((a, b) => b.length - a.length)
    .find((h) => low === h.toLowerCase() || low.startsWith(h.toLowerCase() + " "));
  if (!hit) return null;
  return { who: hit, note: rest.slice(hit.length).trim() };
}

async function pick(env, uid, n, B) {
  const ids = JSON.parse((await getS(env, "pm_list:" + uid)) || "[]");
  const id = ids[n - 1];
  if (!id) return { err: ids.length ? `No ${n} on the last list (it had ${ids.length}).` : "Send today, who or find first; the numbers come from that list." };
  const x = B.tickets.find((t) => t.id === id);
  if (!x) return { err: `Ticket ${n} is gone from the board. Send today again.` };
  return { x };
}

export async function onPm(ev, env) {
  const uid = ev.source?.userId;
  if (ev.type !== "message" || ev.message?.type !== "text") return;
  const c = parse(ev.message.text);
  try {
    // Any other word drops the action waiting for its yes, so a yes only ever
    // answers the question right above it.
    if (c.k !== "yes" && c.k !== "no") await setS(env, "pm_wait:" + uid, "");
    if (c.k === "help" || c.k === "unknown") return say(env, ev, (c.k === "unknown" ? "I didn't catch that.\n\n" : "") + HELP);
    if (c.k === "link") return say(env, ev, env.PM_LINK ? `Your wheel page. Keep it to yourself.\n${env.PM_LINK}` : "The wheel link is not set here yet.");

    if (c.k === "no") {
      await setS(env, "pm_wait:" + uid, "");
      return say(env, ev, "Cancelled. Nothing posted.");
    }
    if (c.k === "yes") {
      const w = JSON.parse((await getS(env, "pm_wait:" + uid)) || "null");
      if (!w || Date.now() - w.at > WAIT_MS) return say(env, ev, "Nothing waiting for a yes.");
      await setS(env, "pm_wait:" + uid, "");
      await wheel(env, "/api/act", w.body);
      return say(env, ev, `Done: ${w.done}`);
    }

    const B = await wheel(env, "/api/board");
    if (c.k === "today") {
      const check = lists.check(B), give = lists.give(B), quiet = lists.quiet(B);
      const drafts = (B.drafts || []).length;
      const hold = "Holding: " + B.holders.map((p) => `${p} ${B.load[p] ?? 0}${B.cap[p] ? "/" + B.cap[p] : ""}`).join(", ");
      const rep = repeatLines(B);
      return show(env, ev, uid, [
        ...(rep.length ? [["🔁 Due today\n" + rep.join("\n"), [], ""]] : []),
        ["✅ To check (marked Done)", check.slice(0, 8), "Nothing to check."],
        ["👉 To give out (nobody holds it)", give.slice(0, 8), "Nothing to give out."],
        ["💤 Quiet 4+ days", quiet.slice(0, 6), "Nothing quiet."],
      ], hold + (drafts ? `\n📝 ${drafts} drafts not posted yet: post them on the wheel (send link).` : ""));
    }
    if (c.k === "report") return say(env, ev, sitrep(B));
    if (c.k === "rdone") {
      const R = mine(B);
      if (!R.length) return say(env, ev, "You have no 🔁 repeats. Make one on the wheel (send link).");
      const words = c.words.toLowerCase().split(" ").filter(Boolean);
      let hits = words.length ? R.filter((r) => words.every((w) => r.title.toLowerCase().includes(w))) : R.filter((r) => r.due);
      if (hits.length > 1) hits = hits.filter((r) => r.due).length ? hits.filter((r) => r.due) : hits;
      if (!hits.length) return say(env, ev, words.length ? `No repeat called "${c.words}". Yours: ${R.map((r) => r.title).join(", ")}` : "Nothing due today.");
      if (hits.length > 1) return say(env, ev, "Which one?\n" + hits.map((r) => `done ${word(r)} · ${r.title}`).join("\n"));
      const r = hits[0];
      if (!r.due) return say(env, ev, `${r.face || "🔁"} ${r.title} is already done. Next: ${dayDate(r.next)}.`);
      const d = await wheel(env, "/api/repeat/done", { n: r.n });
      await setS(env, "pm_undo:" + uid, JSON.stringify({ n: r.n, was: d.was ?? null, title: r.title, at: Date.now() }));
      const after = (d.repeats || []).find((x) => x.n === r.n);
      return say(env, ev, `✅ ${r.face || "🔁"} ${r.title}, done.${after?.next ? ` Next: ${dayDate(after.next)}.` : ""} Nothing posted.\n(undo takes it back)`);
    }
    if (c.k === "undo") {
      const u = JSON.parse((await getS(env, "pm_undo:" + uid)) || "null");
      if (!u || Date.now() - u.at > WAIT_MS) return say(env, ev, "Nothing to undo.");
      await wheel(env, "/api/repeat/done", { n: u.n, undo: true, was: u.was });
      await setS(env, "pm_undo:" + uid, ""); // only after the wheel took it back (CodeRabbit, #8)
      return say(env, ev, `↩︎ ${u.title} is not done again.`);
    }
    if (c.k === "who") {
      const who = personAndNote(c.name, B.holders)?.who;
      if (!who) return say(env, ev, `Who? ${B.holders.join(", ")}`);
      const held = sorted(live(B).filter((x) => x.who.includes(who) && x.state !== "Done"));
      const busy = B.load[who] ?? 0;
      return show(env, ev, uid, [[`${who}: ${busy} open or doing${B.cap[who] ? " (limit " + B.cap[who] + ")" : ""} · ${held.length} not done`, held.slice(0, 12), "Nothing open."]]);
    }
    if (c.k === "find") {
      const words = c.words.toLowerCase().split(" ").filter(Boolean);
      const hits = sorted(live(B).filter((x) => {
        const hay = [x.title, x.goal, x.done, x.body].join(" ").toLowerCase();
        return words.every((w) => hay.includes(w));
      }));
      return show(env, ev, uid, [[`Found ${hits.length}`, hits.slice(0, 12), "No ticket has those words."]]);
    }

    const { x, err } = await pick(env, uid, c.n, B);
    if (err) return say(env, ev, err);
    if (c.k === "open") return say(env, ev, ticketText(x, c.n));

    let body, q, done, yes = "Yes, post";
    const t = short(x.title, 60);
    if (c.k === "give") {
      const pn = personAndNote(c.rest, B.holders);
      if (!pn) return say(env, ev, `Give ${c.n} to whom? ${B.holders.join(", ")}`);
      const busy = B.load[pn.who] ?? 0, cap = B.cap[pn.who];
      // the wheel refuses a person who already holds the limit (Michael, 2026-10-22)
      if (cap !== undefined && busy >= cap && !x.who.includes(pn.who)) return say(env, ev, `${pn.who} holds ${busy}/${cap}, the limit. Pick someone else: ${B.holders.filter((h) => (B.load[h] ?? 0) < (B.cap[h] ?? 99)).join(", ")}`);
      body = { id: x.id, act: "give", who: pn.who, note: pn.note };
      q = `Give ${c.n} · ${t}\nto ${pn.who}${cap !== undefined ? ` (holds ${busy}/${cap})` : ""}${pn.note ? `\nNote: ${pn.note}` : ""}\nThis pings them in Discord.`;
      done = `${c.n} given to ${pn.who}.`; yes = "Yes, give";
    } else if (c.k === "pass") {
      body = { id: x.id, act: "pass", note: c.note };
      q = `Pass ${c.n} · ${t}${c.note ? `\nNote: ${c.note}` : ""}`; done = `${c.n} passed.`; yes = "Yes, pass";
    } else if (c.k === "fail") {
      if (!c.note) return say(env, ev, `Say what is wrong: fail ${c.n} the link is broken`);
      body = { id: x.id, act: "fail", note: c.note };
      q = `Fail ${c.n} · ${t}\nWhat is wrong: ${c.note}\nIt goes back to Doing.`; done = `${c.n} failed, holder pinged.`; yes = "Yes, fail";
    } else if (c.k === "back") {
      if (!c.note) return say(env, ev, `Say what it is missing: back ${c.n} no done line`);
      body = { id: x.id, act: "back", note: c.note };
      q = `Send ${c.n} back to NaN · ${t}\nMissing: ${c.note}`; done = `${c.n} sent back to NaN.`;
    } else if (c.k === "note") {
      if (!c.note) return say(env, ev, `Write the note after the number: note ${c.n} looks good`);
      body = { id: x.id, act: "note", note: c.note, ping: true };
      q = `Post in ${c.n} · ${t}\n${c.note}\nThis pings the holder.`; done = `Posted in ${c.n}.`;
    } else if (c.k === "state") {
      body = { id: x.id, act: "state", state: c.state, note: c.note };
      q = `${c.n} → ${c.state} · ${t}${c.note ? `\nNote: ${c.note}` : ""}`; done = `${c.n} is ${c.state}.`; yes = "Yes";
    } else if (c.k === "rank") {
      await wheel(env, "/api/act", { id: x.id, act: "rank", rank: c.rank });
      return say(env, ev, `${c.n} · order ${["none", "first", "next", "later"][c.rank]}. Nothing posted.`);
    }
    await setS(env, "pm_wait:" + uid, JSON.stringify({ at: Date.now(), body, done }));
    return ask(env, ev, q, yes);
  } catch (e) {
    console.log("pm failed", e.message);
    return say(env, ev, `The wheel didn't answer: ${String(e.message || e).slice(0, 200)}`);
  }
}
