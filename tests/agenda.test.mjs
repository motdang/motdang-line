// The morning agenda.
//
// Two of these do not test a feature. `the mute still holds` tests the promise
// made to three people about a room they work in — that the bot says nothing
// unasked except the one thing that was asked for. `nothing from a description
// reaches the room` tests that a meeting link on a calendar entry cannot be
// walked into by anyone who scrolls the chat.
import { test } from "node:test";
import assert from "node:assert/strict";
import { itemsOn, render, parseIcs, scrub, buildAgenda, dateKeyIn } from "../src/agenda.js";

const TZ = "Asia/Bangkok";

const cal = (...vevents) =>
  ["BEGIN:VCALENDAR", "VERSION:2.0", "X-WR-TIMEZONE:Asia/Bangkok", ...vevents, "END:VCALENDAR"].join("\r\n");

const vevent = (lines) => ["BEGIN:VEVENT", ...lines, "END:VEVENT"].join("\r\n");

const on = (ics, day) => itemsOn(ics, day, TZ);
const titles = (r) => r.items.map((i) => i.summary);
const say = (ics, day, tomorrow = 0) => render(on(ics, day), day, TZ, tomorrow);

// ── reading the file ─────────────────────────────────────────────────────────

test("a folded line is one value, not two", () => {
  // 75 octets and the rest arrives on a continuation line. Unfold or the title
  // in the room is the first half of the title on the calendar.
  const ics = cal(vevent([
    "UID:a@g",
    "DTSTART:20260919T030000Z",
    "SUMMARY:Monthly Membership Meeting - Korat outreach\r\n  and the afternoon session",
  ]));
  assert.equal(parseIcs(ics)[0].summary, "Monthly Membership Meeting - Korat outreach and the afternoon session");
});

test("a TZID with a colon in it survives", () => {
  const ics = cal(vevent(['UID:a@g', 'DTSTART;TZID="GMT+07:00":20260919T093000', "SUMMARY:x"]));
  assert.equal(parseIcs(ics)[0].start.tz, "GMT+07:00");
});

test("an alarm inside an event is not the event", () => {
  const ics = cal(vevent([
    "UID:a@g", "DTSTART:20260919T030000Z", "SUMMARY:Dentist",
    "BEGIN:VALARM", "ACTION:DISPLAY", "DESCRIPTION:Reminder", "TRIGGER:-PT30M", "END:VALARM",
  ]));
  assert.equal(parseIcs(ics)[0].summary, "Dentist");
});

// ── the day, in Bangkok ──────────────────────────────────────────────────────

test("a UTC time lands on the Bangkok day, not the UTC one", () => {
  // 20:00 UTC on the 18th is 3am on the 19th where she is. The calendar day
  // that matters is hers.
  const ics = cal(vevent(["UID:a@g", "DTSTART:20260918T200000Z", "SUMMARY:Early start"]));
  assert.deepEqual(titles(on(ics, "2026-09-19")), ["Early start"]);
  assert.deepEqual(titles(on(ics, "2026-09-18")), []);
});

test("an all-day event stays on its own date", () => {
  // The failure this guards: turning a DATE into an instant and watching it
  // slide onto the day before.
  const ics = cal(vevent(["UID:a@g", "DTSTART;VALUE=DATE:20260919", "DTEND;VALUE=DATE:20260920", "SUMMARY:Visa run"]));
  assert.deepEqual(titles(on(ics, "2026-09-19")), ["Visa run"]);
  assert.deepEqual(titles(on(ics, "2026-09-18")), []);
  assert.equal(on(ics, "2026-09-19").items[0].allDay, true);
});

test("a cancelled event is not on the day", () => {
  const ics = cal(vevent(["UID:a@g", "DTSTART:20260919T030000Z", "STATUS:CANCELLED", "SUMMARY:Called off"]));
  assert.deepEqual(titles(on(ics, "2026-09-19")), []);
});

test("all-day items come first, then the day in order", () => {
  const ics = cal(
    vevent(["UID:c@g", "DTSTART:20260919T070000Z", "SUMMARY:Afternoon"]),
    vevent(["UID:b@g", "DTSTART:20260919T020000Z", "SUMMARY:Morning"]),
    vevent(["UID:a@g", "DTSTART;VALUE=DATE:20260919", "SUMMARY:All day"]),
  );
  assert.deepEqual(titles(on(ics, "2026-09-19")), ["All day", "Morning", "Afternoon"]);
});

// ── repeating ────────────────────────────────────────────────────────────────

test("a weekly appointment is on the right weekdays", () => {
  const ics = cal(vevent([
    "UID:a@g", "DTSTART;TZID=Asia/Bangkok:20260902T093000",
    "RRULE:FREQ=WEEKLY;BYDAY=WE,FR", "SUMMARY:Physio",
  ]));
  assert.deepEqual(titles(on(ics, "2026-09-18")), ["Physio"]);   // a Friday
  assert.deepEqual(titles(on(ics, "2026-09-19")), []);           // a Saturday
  assert.deepEqual(titles(on(ics, "2026-09-23")), ["Physio"]);   // a Wednesday
});

test("a rule does not start before its first date", () => {
  const ics = cal(vevent([
    "UID:a@g", "DTSTART;TZID=Asia/Bangkok:20260916T093000",
    "RRULE:FREQ=WEEKLY;BYDAY=MO,WE", "SUMMARY:Physio",
  ]));
  assert.deepEqual(titles(on(ics, "2026-09-14")), []);           // the Monday before it begins
  assert.deepEqual(titles(on(ics, "2026-09-16")), ["Physio"]);
});

test("the second Tuesday of the month is the second Tuesday", () => {
  const ics = cal(vevent([
    "UID:a@g", "DTSTART;TZID=Asia/Bangkok:20260811T100000",
    "RRULE:FREQ=MONTHLY;BYDAY=2TU", "SUMMARY:Membership meeting",
  ]));
  assert.deepEqual(titles(on(ics, "2026-09-08")), ["Membership meeting"]);
  assert.deepEqual(titles(on(ics, "2026-09-01")), []);
  assert.deepEqual(titles(on(ics, "2026-10-13")), ["Membership meeting"]);
});

test("a monthly rule on the 31st skips the months without one", () => {
  const ics = cal(vevent([
    "UID:a@g", "DTSTART;TZID=Asia/Bangkok:20260131T090000",
    "RRULE:FREQ=MONTHLY", "SUMMARY:Rent",
  ]));
  assert.deepEqual(titles(on(ics, "2026-03-31")), ["Rent"]);
  assert.deepEqual(titles(on(ics, "2026-02-28")), []);
});

test("UNTIL and COUNT stop it", () => {
  const until = cal(vevent([
    "UID:a@g", "DTSTART;TZID=Asia/Bangkok:20260902T090000",
    "RRULE:FREQ=WEEKLY;BYDAY=WE;UNTIL=20260910T000000Z", "SUMMARY:Course",
  ]));
  assert.deepEqual(titles(on(until, "2026-09-09")), ["Course"]);
  assert.deepEqual(titles(on(until, "2026-09-16")), []);

  const count = cal(vevent([
    "UID:b@g", "DTSTART;TZID=Asia/Bangkok:20260902T090000",
    "RRULE:FREQ=DAILY;COUNT=3", "SUMMARY:Antibiotics",
  ]));
  assert.deepEqual(titles(on(count, "2026-09-04")), ["Antibiotics"]);
  assert.deepEqual(titles(on(count, "2026-09-05")), []);
});

test("a skipped date is skipped and an edited one moves", () => {
  const ics = cal(
    vevent([
      "UID:a@g", "DTSTART;TZID=Asia/Bangkok:20260902T093000",
      "RRULE:FREQ=WEEKLY;BYDAY=WE", "EXDATE;TZID=Asia/Bangkok:20260916T093000", "SUMMARY:Physio",
    ]),
    vevent([
      "UID:a@g", "RECURRENCE-ID;TZID=Asia/Bangkok:20260923T093000",
      "DTSTART;TZID=Asia/Bangkok:20260923T140000", "SUMMARY:Physio (moved)",
    ]),
  );
  assert.deepEqual(titles(on(ics, "2026-09-16")), []);
  assert.deepEqual(titles(on(ics, "2026-09-23")), ["Physio (moved)"]);
  assert.equal(say(ics, "2026-09-23").includes("2pm"), true);
});

test("a rule it cannot read is named, never guessed at", () => {
  // A date without its arithmetic is not a date. The event does not silently
  // disappear and the bot does not invent a time for it.
  const ics = cal(vevent([
    "UID:a@g", "DTSTART;TZID=Asia/Bangkok:20260902T090000",
    "RRULE:FREQ=MONTHLY;BYDAY=TU;BYSETPOS=-1", "SUMMARY:Board call",
  ]));
  const r = on(ics, "2026-09-29");
  assert.deepEqual(r.items, []);
  assert.deepEqual(r.unreadable, ["Board call"]);
  assert.match(say(ics, "2026-09-29"), /cannot read.*Board call/s);
});

// ── what does not go in the room ─────────────────────────────────────────────

test("nothing from a description reaches the room", () => {
  // The live calendar's 12 August entry carries two Google Meet links in its
  // body. A meeting link in a group chat is a meeting anyone who scrolls can
  // walk into.
  const ics = cal(vevent([
    "UID:a@g", "DTSTART:20260919T030000Z", "SUMMARY:Membership meeting",
    "DESCRIPTION:Join at https://meet.google.com/oay-scvb-wom\\n\\nMic muted please.",
  ]));
  const text = say(ics, "2026-09-19");
  assert.equal(text.includes("meet.google.com"), false);
  assert.equal(text.includes("Mic muted"), false);
  assert.match(text, /Membership meeting/);
});

test("a link in a title or a location is taken out, and the line says so", () => {
  const ics = cal(vevent([
    "UID:a@g", "DTSTART:20260919T030000Z",
    "SUMMARY:Call", "LOCATION:https://meet.google.com/abc-defg-hij",
  ]));
  const text = say(ics, "2026-09-19");
  assert.equal(/meet\.google\.com/.test(text), false);
  assert.match(text, /link on the calendar/);
  assert.equal(scrub("Ram Hospital, Suthep"), "Ram Hospital, Suthep");
});

test("a private event is busy, with no title and no place", () => {
  // Beer's access to this calendar is "see private events as free/busy".
  // Reading a private title into the room hands her what that setting withholds.
  const ics = cal(vevent([
    "UID:a@g", "DTSTART:20260919T030000Z", "CLASS:PRIVATE",
    "SUMMARY:Oncology follow-up", "LOCATION:Chiang Mai Ram",
  ]));
  const text = say(ics, "2026-09-19");
  assert.equal(text.includes("Oncology"), false);
  assert.equal(text.includes("Chiang Mai Ram"), false);
  assert.match(text, /10am {2}busy/);
});

// ── the message ──────────────────────────────────────────────────────────────

test("a quiet day says nothing at all", () => {
  const ics = cal(vevent(["UID:a@g", "DTSTART:20260812T030000Z", "SUMMARY:Long ago"]));
  assert.equal(say(ics, "2026-09-19"), null);
});

test("the message names the day, the time and the place", () => {
  const ics = cal(vevent([
    "UID:a@g", "DTSTART;TZID=Asia/Bangkok:20260919T150000",
    "DTEND;TZID=Asia/Bangkok:20260919T160000",
    "SUMMARY:Medals to Bronco Kids", "LOCATION:Bronco Kids Sport Club",
  ]));
  const text = say(ics, "2026-09-19", 2);
  assert.match(text, /^วันนี้ — today, Saturday 19 September$/m);
  assert.match(text, /• 3pm {2}Medals to Bronco Kids/);
  assert.match(text, /ที่ \/ where: Bronco Kids Sport Club/);
  assert.match(text, /พรุ่งนี้ — tomorrow: 2 items/);
});

// ── the mute ─────────────────────────────────────────────────────────────────

test("the mute still holds: nothing is sent unless AGENDA is on", async () => {
  const ics = cal(vevent(["UID:a@g", "DTSTART;VALUE=DATE:20260919", "SUMMARY:Visa run"]));
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push(String(url));
    if (String(url).includes("/message/push")) return new Response("{}", { status: 200 });
    return new Response(ics, { status: 200 });
  };
  const { pushAgenda } = await import("../src/line.js");
  const env = { CALENDAR_ICS: "https://cal/feed.ics", AGENDA_TZ: TZ, LINE_CHANNEL_TOKEN: "t" };
  const at = Date.parse("2026-09-19T05:00:00Z");

  for (const flag of [undefined, "off", "", "no", "true", "yes"]) {
    const e = { ...env };
    if (flag !== undefined) e.AGENDA = flag;
    const a = await buildAgenda(e, at);
    assert.ok(a.text, `built the text under AGENDA=${flag}`);
    assert.equal(await pushAgenda(e, "Cteam", a.text), false, `spoke under AGENDA=${flag}`);
  }
  assert.equal(calls.some((u) => u.includes("/message/push")), false);

  const armed = { ...env, AGENDA: "on" };
  const a = await buildAgenda(armed, at);
  assert.equal(await pushAgenda(armed, "Cteam", a.text), true);
  assert.equal(calls.filter((u) => u.includes("/message/push")).length, 1);
});

test("no feed configured means no message, not a crash", async () => {
  const a = await buildAgenda({ AGENDA: "on" }, Date.now());
  assert.equal(a.text, null);
  assert.match(a.why, /CALENDAR_ICS/);
});

test("a feed that will not answer is silent", async () => {
  globalThis.fetch = async () => new Response("no", { status: 503 });
  const a = await buildAgenda({ AGENDA: "on", CALENDAR_ICS: "https://cal/feed.ics" }, Date.now());
  assert.equal(a.text, null);
  assert.match(a.why, /503/);
});

test("today is today in Bangkok, not wherever the Worker woke up", () => {
  // 00:00 UTC is when the cron fires; in Bangkok that is 7am the same morning.
  assert.equal(dateKeyIn(Date.parse("2026-09-19T00:00:00Z"), TZ), "2026-09-19");
  assert.equal(dateKeyIn(Date.parse("2026-09-18T23:00:00Z"), TZ), "2026-09-19");
});
