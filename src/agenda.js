// The morning agenda — what is on today, said once, in the room the three
// people who can see that calendar already work in.
//
// WHY THIS EXISTS. 15–16 September 2026: Michael moved a 3:30 to 3:00 inside a
// sentence addressed to Beer, the place moved from Algonquin to Bronco Kids in
// a second message, Beer confirmed, and at 2:00 the next afternoon Nan still
// held the old picture — one hour before it started. Three people, one room,
// no close-out. A calendar was not the missing piece; a calendar nobody reads
// out loud was. So this posts the day, in the room, where a wrong picture is
// visible to the person holding it.
//
// WHAT IT READS, AND WHAT IT MUST NEVER READ. One calendar: "Appointments —
// Nan & Michael", the one Beer books into and the only one all three can see.
// Nan's own calendars are shared to Beer as free/busy and stay out of here.
// ⛔ The court dates live on a different calendar and are CASE CONTENT: catalog
// rules say no case content to any external service, and LINE is an external
// service. Feeding this bot a second calendar is not a config change, it is
// that decision — do not widen CALENDAR_ICS without asking.
//
// THREE THINGS IT WILL NOT PUT IN THE ROOM:
//   · DESCRIPTION, ever. The August 12 event carries two Google Meet links in
//     its body; a meeting link pasted into a group chat is a meeting anyone
//     who scrolls can walk into, and LINE would unfurl it into a card on top.
//   · anything URL-shaped in a title or a location, for the same reason and
//     because an unfurled card buries the action items under artwork
//     (Nan, 2026-09-07).
//   · the title of an event marked private. Beer's access to this calendar is
//     "see private events as free/busy" — if the bot read a private title into
//     the room it would hand her exactly what that setting withholds.

const DAY = 86400000;

// ── reading the file ─────────────────────────────────────────────────────────

// RFC 5545 folds long lines: a CRLF followed by one space or tab continues the
// line before it. Unfold first or a SUMMARY longer than 75 octets arrives in
// pieces — which is how "Monthly Membership Meeting - Korat" would have.
function unfold(text) {
  return text.replace(/\r\n/g, "\n").replace(/\n[ \t]/g, "");
}

// NAME;PARAM=VAL;PARAM=VAL:value
function parseLine(line) {
  const colon = splitOutsideQuotes(line);
  if (colon < 0) return null;
  const head = line.slice(0, colon);
  const value = line.slice(colon + 1);
  const bits = head.split(";");
  const params = {};
  for (const b of bits.slice(1)) {
    const eq = b.indexOf("=");
    if (eq > 0) params[b.slice(0, eq).toUpperCase()] = b.slice(eq + 1).replace(/^"|"$/g, "");
  }
  return { name: bits[0].toUpperCase(), params, value };
}

// A parameter value may be quoted and may contain a colon — TZID="GMT+07:00"
// is legal. Find the separator outside the quotes or the timezone is lost.
function splitOutsideQuotes(line) {
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') q = !q;
    else if (c === ":" && !q) return i;
  }
  return -1;
}

function unescapeText(v) {
  return String(v)
    .replace(/\\n/gi, "\n")
    .replace(/\\,/g, ",")
    .replace(/\\;/g, ";")
    .replace(/\\\\/g, "\\");
}

export function parseIcs(text) {
  const events = [];
  let cur = null;
  let depth = 0;
  for (const raw of unfold(text).split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    if (line === "BEGIN:VEVENT") { cur = { props: [] }; depth = 0; continue; }
    if (line === "END:VEVENT") { if (cur) events.push(shape(cur)); cur = null; continue; }
    if (!cur) continue;
    // VALARM sits inside a VEVENT and carries its own TRIGGER/DESCRIPTION.
    // Without this its properties would be read as the event's own.
    if (line.startsWith("BEGIN:")) { depth++; continue; }
    if (line.startsWith("END:")) { depth--; continue; }
    if (depth > 0) continue;
    const p = parseLine(line);
    if (p) cur.props.push(p);
  }
  return events;
}

function shape(cur) {
  const get = (n) => cur.props.find((p) => p.name === n);
  const all = (n) => cur.props.filter((p) => p.name === n);
  const dtstart = get("DTSTART");
  const dtend = get("DTEND");
  return {
    uid: get("UID")?.value || null,
    summary: unescapeText(get("SUMMARY")?.value || ""),
    location: unescapeText(get("LOCATION")?.value || ""),
    status: (get("STATUS")?.value || "").toUpperCase(),
    class: (get("CLASS")?.value || "").toUpperCase(),
    transp: (get("TRANSP")?.value || "").toUpperCase(),
    start: dtstart ? timeOf(dtstart) : null,
    end: dtend ? timeOf(dtend) : null,
    rrule: get("RRULE")?.value || null,
    // EXDATE may appear more than once and may list several dates in one line.
    exdate: all("EXDATE").flatMap((p) =>
      p.value.split(",").map((v) => timeOf({ params: p.params, value: v })),
    ),
    // A single edited instance of a repeating event arrives as its own VEVENT
    // carrying RECURRENCE-ID: the occurrence it replaces.
    recurrenceId: get("RECURRENCE-ID") ? timeOf(get("RECURRENCE-ID")) : null,
  };
}

// Two kinds of time live in an ICS and they do not compare to each other.
// An all-day event is a DATE with no instant attached: it is "the 19th" in
// whatever place you are standing, and turning it into an instant is how an
// all-day item slides onto the day before. It stays a date string here and is
// compared as one. Everything else resolves to a real instant.
function timeOf(p) {
  const v = String(p.value).trim();
  if (p.params?.VALUE === "DATE" || /^\d{8}$/.test(v)) {
    return { date: `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}` };
  }
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/.exec(v);
  if (!m) return null;
  const [, y, mo, d, h, mi, s, z] = m;
  if (z) return { ms: Date.UTC(+y, +mo - 1, +d, +h, +mi, +s), tz: "UTC" };
  // No Z and no TZID is a "floating" time — legal, and it means local time
  // wherever it is read. We read it in the calendar's zone, which is what a
  // person who typed it into that calendar meant.
  return { local: [+y, +mo - 1, +d, +h, +mi, +s], tz: p.params?.TZID || null };
}

// ── zones ────────────────────────────────────────────────────────────────────
// Workers ship full ICU, so the tz database is available through Intl and
// nothing has to be bundled. There is no API that converts a wall-clock time in
// a named zone to an instant, so this does it the standard way: guess, ask what
// that instant looks like in the zone, correct by the difference, once more for
// the hour a DST change moves. Bangkok has had no DST since 1952 — the second
// pass is here so the code does not quietly become wrong if this is ever
// pointed at a zone that does.

function partsIn(ms, tz) {
  const f = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const o = {};
  for (const p of f.formatToParts(new Date(ms))) o[p.type] = p.value;
  return o;
}

function offsetAt(ms, tz) {
  const p = partsIn(ms, tz);
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - ms;
}

export function instantOf(local, tz) {
  const [y, mo, d, h, mi, s] = local;
  const naive = Date.UTC(y, mo, d, h, mi, s);
  let ms = naive - offsetAt(naive, tz);
  ms = naive - offsetAt(ms, tz);
  return ms;
}

export function dateKeyIn(ms, tz) {
  const p = partsIn(ms, tz);
  return `${p.year}-${p.month}-${p.day}`;
}

// The instant a time resolves to, for sorting and for the window test.
function instant(t, tz) {
  if (!t) return null;
  if (t.ms !== undefined) return t.ms;
  if (t.local) return instantOf(t.local, t.tz || tz);
  if (t.date) {
    const [y, m, d] = t.date.split("-").map(Number);
    return instantOf([y, m - 1, d, 0, 0, 0], tz);
  }
  return null;
}

// ── recurrence ───────────────────────────────────────────────────────────────
// Only what a calendar of appointments actually contains. Anything outside this
// is not guessed at: the event goes on the `unreadable` list and the message
// says so by name, because an appointment that vanishes silently is worse than
// one the bot admits it cannot read, and a made-up time is worse than both.
//
// Supported: FREQ DAILY/WEEKLY/MONTHLY/YEARLY, INTERVAL, COUNT, UNTIL,
// BYDAY (plain for WEEKLY, with or without an ordinal for MONTHLY), BYMONTHDAY,
// EXDATE, and a RECURRENCE-ID instance that overrides or cancels one date.
// Not supported: BYSETPOS, BYWEEKNO, BYYEARDAY, BYMONTH, BYHOUR and friends.

const WD = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };
const KNOWN = new Set(["FREQ", "INTERVAL", "COUNT", "UNTIL", "WKST", "BYDAY", "BYMONTHDAY"]);

function parseRule(rrule) {
  const r = {};
  for (const part of rrule.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    r[part.slice(0, eq).toUpperCase()] = part.slice(eq + 1);
  }
  return r;
}

function ruleReadable(r) {
  for (const k of Object.keys(r)) if (!KNOWN.has(k)) return false;
  const freq = (r.FREQ || "").toUpperCase();
  if (!["DAILY", "WEEKLY", "MONTHLY", "YEARLY"].includes(freq)) return false;
  // An ordinal weekday only means something monthly. BYDAY=2TU on a WEEKLY
  // rule is not something to interpret.
  if (r.BYDAY && freq === "WEEKLY" && /[-\d]/.test(r.BYDAY)) return false;
  if (r.BYDAY && (freq === "DAILY" || freq === "YEARLY")) return false;
  if (r.BYMONTHDAY && freq !== "MONTHLY") return false;
  return true;
}

// Every occurrence that starts inside [from, to], as local date+time pieces.
// Walks from DTSTART. The caps are not optimisation: they are the promise that
// a malformed rule cannot spin a Worker until it is killed.
function occurrences(ev, r, from, to, tz) {
  const t = ev.start;
  const allDay = !!t.date;
  const base = allDay
    ? (() => { const [y, m, d] = t.date.split("-").map(Number); return [y, m - 1, d, 0, 0, 0]; })()
    : (t.local ? t.local.slice() : (() => { const p = partsIn(t.ms, t.tz === "UTC" ? tz : (t.tz || tz)); return [+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second]; })());
  const zone = allDay ? tz : (t.tz && t.tz !== "UTC" ? t.tz : tz);

  const interval = Math.max(1, parseInt(r.INTERVAL || "1", 10) || 1);
  const count = r.COUNT ? parseInt(r.COUNT, 10) : null;
  const untilT = r.UNTIL ? timeOf({ params: /^\d{8}$/.test(r.UNTIL) ? { VALUE: "DATE" } : {}, value: r.UNTIL }) : null;
  const until = untilT ? instant(untilT, zone) : null;
  const freq = r.FREQ.toUpperCase();
  const byday = r.BYDAY ? r.BYDAY.split(",").map((s) => s.trim().toUpperCase()) : null;

  const out = [];
  let emitted = 0;
  const push = (y, mo, d) => {
    const piece = [y, mo, d, base[3], base[4], base[5]];
    const ms = allDay ? instantOf([y, mo, d, 0, 0, 0], zone) : instantOf(piece, zone);
    if (until !== null && ms > until) return "stop";
    emitted++;
    if (count !== null && emitted > count) return "stop";
    if (ms > to) return "past";
    if (ms >= from - DAY) out.push(allDay ? { date: keyOf(y, mo, d) } : { local: piece, tz: zone });
    return "go";
  };

  const CAP = 4000;
  if (freq === "DAILY") {
    for (let i = 0, d = new Date(Date.UTC(base[0], base[1], base[2])); i < CAP; i++, d = new Date(d.getTime() + interval * DAY)) {
      const s = push(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
      if (s === "stop" || s === "past") break;
    }
  } else if (freq === "WEEKLY") {
    const days = byday ? byday.map((x) => WD[x]).filter((x) => x !== undefined) : [new Date(Date.UTC(base[0], base[1], base[2])).getUTCDay()];
    // Weeks are stepped from the week DTSTART falls in; inside a week the
    // listed days are emitted in order, which is what COUNT counts.
    let week = new Date(Date.UTC(base[0], base[1], base[2]));
    week = new Date(week.getTime() - week.getUTCDay() * DAY);
    const startMs = Date.UTC(base[0], base[1], base[2]);
    outer: for (let i = 0; i < CAP; i++, week = new Date(week.getTime() + interval * 7 * DAY)) {
      for (const wd of [...days].sort((a, b) => a - b)) {
        const d = new Date(week.getTime() + wd * DAY);
        if (d.getTime() < startMs) continue;
        const s = push(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
        if (s === "stop" || s === "past") break outer;
      }
    }
  } else if (freq === "MONTHLY") {
    for (let i = 0; i < CAP; i++) {
      const y = base[0] + Math.floor((base[1] + i * interval) / 12);
      const mo = (base[1] + i * interval) % 12;
      let dates;
      if (byday) dates = monthlyByDay(y, mo, byday);
      else if (r.BYMONTHDAY) dates = r.BYMONTHDAY.split(",").map((n) => monthDay(y, mo, parseInt(n, 10))).filter(Boolean);
      else dates = [monthDay(y, mo, base[2])].filter(Boolean);
      let done = false;
      for (const d of dates.sort((a, b) => a - b)) {
        if (Date.UTC(y, mo, d) < Date.UTC(base[0], base[1], base[2])) continue;
        const s = push(y, mo, d);
        if (s === "stop" || s === "past") { done = true; break; }
      }
      if (done) break;
    }
  } else { // YEARLY
    for (let i = 0; i < 200; i++) {
      const y = base[0] + i * interval;
      const d = monthDay(y, base[1], base[2]);
      if (!d) continue;
      const s = push(y, base[1], d);
      if (s === "stop" || s === "past") break;
    }
  }
  return out;
}

// A day number only if that month has it: Feb 30 is not a date, and a monthly
// rule on the 31st simply has no occurrence in the short months.
function monthDay(y, mo, day) {
  const last = new Date(Date.UTC(y, mo + 1, 0)).getUTCDate();
  const d = day < 0 ? last + day + 1 : day;
  return d >= 1 && d <= last ? d : null;
}

// BYDAY on a monthly rule: 2TU is the second Tuesday, -1FR the last Friday,
// a bare TU every Tuesday of the month.
function monthlyByDay(y, mo, byday) {
  const last = new Date(Date.UTC(y, mo + 1, 0)).getUTCDate();
  const out = [];
  for (const token of byday) {
    const m = /^(-?\d+)?(SU|MO|TU|WE|TH|FR|SA)$/.exec(token);
    if (!m) continue;
    const wd = WD[m[2]];
    const hits = [];
    for (let d = 1; d <= last; d++) if (new Date(Date.UTC(y, mo, d)).getUTCDay() === wd) hits.push(d);
    if (!m[1]) out.push(...hits);
    else {
      const n = parseInt(m[1], 10);
      const pick = n > 0 ? hits[n - 1] : hits[hits.length + n];
      if (pick) out.push(pick);
    }
  }
  return [...new Set(out)];
}

const keyOf = (y, mo, d) =>
  `${y}-${String(mo + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;

// ── what is on a given day ───────────────────────────────────────────────────

export function itemsOn(icsText, dayKey, tz) {
  const raw = parseIcs(icsText);

  // Edited and cancelled single instances, keyed by the occurrence they replace.
  const overrides = new Map();
  for (const e of raw) {
    if (!e.recurrenceId || !e.uid) continue;
    const k = e.uid + "|" + (e.recurrenceId.date || instant(e.recurrenceId, tz));
    overrides.set(k, e);
  }

  const items = [];
  const unreadable = [];

  const consider = (e, when) => {
    if (e.status === "CANCELLED") return;
    const key = when.date || dateKeyIn(instant(when, tz), tz);
    if (key !== dayKey) return;
    items.push({
      allDay: !!when.date,
      at: when.date ? null : instant(when, tz),
      minutes: durationMinutes(e, tz),
      summary: e.summary,
      location: e.location,
      private: e.class === "PRIVATE" || e.class === "CONFIDENTIAL",
    });
  };

  for (const e of raw) {
    if (!e.start) continue;
    if (e.recurrenceId) { consider(e, e.start); continue; }

    if (!e.rrule) { consider(e, e.start); continue; }

    const r = parseRule(e.rrule);
    if (!ruleReadable(r)) { unreadable.push(e.summary || "an untitled repeating event"); continue; }

    const dayStartMs = instantOf([...dayKey.split("-").map(Number).map((n, i) => (i === 1 ? n - 1 : n)), 0, 0, 0], tz);
    const occ = occurrences(e, r, dayStartMs - DAY, dayStartMs + 2 * DAY, tz);
    for (const when of occ) {
      const k = e.uid + "|" + (when.date || instant(when, tz));
      const o = overrides.get(k);
      if (o) continue;                                   // handled as its own VEVENT
      if (e.exdate.some((x) => sameMoment(x, when, tz))) continue;
      consider(e, when);
    }
  }

  items.sort((a, b) => (a.allDay === b.allDay ? (a.at || 0) - (b.at || 0) : a.allDay ? -1 : 1));
  return { items, unreadable };
}

function sameMoment(a, b, tz) {
  if (!a || !b) return false;
  if (a.date || b.date) return (a.date || dateKeyIn(instant(a, tz), tz)) === (b.date || dateKeyIn(instant(b, tz), tz));
  return instant(a, tz) === instant(b, tz);
}

function durationMinutes(e, tz) {
  if (!e.start || !e.end || e.start.date) return null;
  const a = instant(e.start, tz);
  const b = instant(e.end, tz);
  return a && b && b > a ? Math.round((b - a) / 60000) : null;
}

// ── saying it ────────────────────────────────────────────────────────────────

// Anything that would unfurl into a card, or hand the room a link that lets a
// stranger into a meeting, is taken out before the text is built. The event
// still appears; what is dropped is the link, and the line says so.
const URLISH = /\b(?:https?:\/\/|www\.)\S+|\b[a-z0-9-]+\.(?:com|net|org|me|co|io|th|app|link)\b\S*/gi;

export function scrub(s) {
  if (!s) return "";
  const cleaned = String(s).replace(URLISH, "").replace(/\s{2,}/g, " ").replace(/[\s,;·|-]+$/, "").trim();
  return cleaned !== String(s).trim() ? (cleaned ? cleaned + " (link on the calendar)" : "(link on the calendar)") : cleaned;
}

function clock(ms, tz) {
  const p = partsIn(ms, tz);
  const h = +p.hour;
  const suffix = h < 12 ? "am" : "pm";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return p.minute === "00" ? `${h12}${suffix}` : `${h12}:${p.minute}${suffix}`;
}

export function render({ items, unreadable }, dayKey, tz, tomorrowCount = 0) {
  if (!items.length && !unreadable.length) return null;

  const [y, m, d] = dayKey.split("-").map(Number);
  const head = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz, weekday: "long", day: "numeric", month: "long",
  }).format(new Date(instantOf([y, m - 1, d, 12, 0, 0], tz)));

  const lines = [`วันนี้ — today, ${head}`];
  for (const it of items) {
    const title = it.private ? "busy" : (scrub(it.summary) || "(no title)");
    const when = it.allDay ? "all day" : clock(it.at, tz);
    let line = `• ${when}  ${title}`;
    const where = it.private ? "" : scrub(it.location);
    if (where) line += `\n   ที่ / where: ${where}`;
    lines.push(line);
  }
  if (unreadable.length) {
    lines.push(
      `• ${unreadable.length} repeating event${unreadable.length === 1 ? "" : "s"} I cannot read — ` +
        `${unreadable.map((u) => scrub(u) || "untitled").join(", ")}. Check the calendar for ${
          unreadable.length === 1 ? "it" : "them"}.`,
    );
  }
  if (tomorrowCount) {
    lines.push(`พรุ่งนี้ — tomorrow: ${tomorrowCount} item${tomorrowCount === 1 ? "" : "s"}.`);
  }
  return lines.join("\n");
}

// ── the job ──────────────────────────────────────────────────────────────────

export async function buildAgenda(env, now = Date.now()) {
  const url = env.CALENDAR_ICS;
  if (!url) return { text: null, why: "no CALENDAR_ICS" };
  const tz = env.AGENDA_TZ || "Asia/Bangkok";

  // The feed answers `cache-control: no-cache, no-store` (measured
  // 2026-09-19), so what comes back is what the calendar says right now and a
  // booking made last night is in it. cacheTtl:0 says the same thing from this
  // side. The standard `cache: "no-store"` init field belongs here too and was
  // tried first: workerd threw on it and the endpoint answered 1101, so it is
  // deliberately absent rather than forgotten.
  //
  // Nothing in here may throw. This runs on a cron with no one watching, and a
  // calendar that is slow, moved or reset must make the morning quiet — not
  // kill the scheduled event.
  let ics;
  try {
    const r = await fetch(url, { cf: { cacheTtl: 0 } });
    if (!r.ok) return { text: null, why: `feed ${r.status}` };
    ics = await r.text();
  } catch (e) {
    return { text: null, why: "feed unreachable: " + (e?.message || e) };
  }

  try {
    const today = dateKeyIn(now, tz);
    const tomorrow = dateKeyIn(now + DAY, tz);
    const on = itemsOn(ics, today, tz);
    const next = itemsOn(ics, tomorrow, tz);
    return {
      text: render(on, today, tz, next.items.length),
      why: on.items.length || on.unreadable.length ? "posted" : "nothing on today",
      count: on.items.length,
    };
  } catch (e) {
    // A calendar entry this cannot parse is a bug to fix, not a reason for the
    // morning to fail silently-but-loudly in a log nobody reads. It stays quiet
    // in the room and says why to whoever asks /desk/agenda.
    return { text: null, why: "could not read the feed: " + (e?.message || e) };
  }
}
