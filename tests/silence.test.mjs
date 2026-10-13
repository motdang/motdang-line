// SILENT UNLESS SPOKEN TO — the condition of this account being in the room.
//
// Nan removed the bot from the team group because it would not stop talking, and
// let it back on one term (2026-09-18): *"please mute nanobotco. I will say @bot
// if I want to talk to it or @nanobotco"*. So this file does not test a feature.
// It tests a promise made to three people about a room they work in.
//
// Three properties, and the third is the one that is easy to lose:
//   1. an unaddressed message gets no answer, whatever it says;
//   2. an addressed one does;
//   3. being addressed once does NOT open the mouth for what comes after it.
//
// The other test files run with SPEAK:"on" so they can assert what the bot says.
// This one runs it the way it deploys.
import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/worker.js";
import { makeEnv, stubLine, deliver, ev } from "./harness.mjs";

const GROUP = "Cteam";
const BEER = "Ubeer";
const INDEX = [
  { s: "thapae-gate-1017379824", n: "ประตูท่าแพ", e: "Thapae Gate" },
  { s: "warorot-1", n: "ตลาดวโรรส", e: "Warorot Market" },
];

// The deployed environment. SPEAK unset must mean the same as SPEAK:"off":
// a mute that depends on somebody remembering to set a variable is not a mute.
function room({ flag } = {}) {
  const env = makeEnv(INDEX);
  if (flag === undefined) delete env.SPEAK;
  else env.SPEAK = flag;
  return env;
}
const rows = (env, sql, ...a) => env._db.prepare(sql).all(...a);

// A real LINE @-mention: the client sends it structured, with isSelf set.
const mentioned = (text) => ({ mention: { mentionees: [{ index: 0, length: 4, type: "user", isSelf: true }] }, text });

for (const flag of [undefined, "off", "OFF", "", "no", "yes", "true"]) {
  test(`SPEAK=${JSON.stringify(flag)} — nobody addressed it, so it says nothing`, async () => {
    const env = room({ flag });
    const said = stubLine();
    await deliver(worker, env, [
      ev.join(GROUP),
      ev.text(GROUP, BEER, "hello"),
      ev.text(GROUP, BEER, "help"),
      ev.text(GROUP, BEER, "status"),
      ev.text(GROUP, BEER, "bug the map is wrong"),
      ev.image(GROUP, BEER),
      ev.text(GROUP, BEER, "ตลาดวโรรส"),
      ev.location(GROUP, BEER, 18.7891, 99.0457),
    ]);
    assert.deepEqual(said.replies, [], "every reply dropped before the API");
    assert.deepEqual(said.pushes, [], "every push dropped before the API");
  });
}

test("silent, and still keeping everything — the reason it is in the room", async () => {
  const env = room();
  const said = stubLine();
  await deliver(worker, env, [
    ev.join(GROUP),
    ev.text(GROUP, BEER, "Lucky carpark near the airport"),
    ev.image(GROUP, BEER),
    ev.text(GROUP, BEER, "bug the pin is in the river"),
  ]);
  assert.deepEqual(said.replies, []);
  assert.ok(rows(env, "SELECT * FROM events WHERE kind='text'").length >= 1);
  assert.equal(rows(env, "SELECT * FROM events WHERE kind='photo'").length, 1);
  assert.equal(rows(env, "SELECT * FROM events WHERE kind='bug'").length, 1);
  assert.match(rows(env, "SELECT ticket FROM events WHERE kind='bug'")[0].ticket, /^BUG-\d{4}$/,
    "a bug is still numbered even though nobody was told the number");
  assert.ok([...env.INBOX.store.keys()].some((k) => k.startsWith("photo")),
    "photo bytes still reach R2 — they expire at LINE and there is no backfill");
});

for (const addr of ["@bot", "@nanobotco", "@NaNoBotCo", "@nanobot", "@มด"]) {
  test(`"${addr} status" is spoken to, and answers`, async () => {
    const env = room();
    const said = stubLine();
    await deliver(worker, env, [ev.join(GROUP), ev.text(GROUP, BEER, `${addr} status`)]);
    assert.equal(said.replies.length, 1, "addressed, so it answers");
  });
}

test("the address is stripped before the command is read", async () => {
  const env = room();
  const said = stubLine();
  await deliver(worker, env, [ev.join(GROUP), ev.text(GROUP, BEER, "@bot help")]);
  assert.equal(said.replies.length, 1);
  assert.match(said.replies[0], /photo|bug|status/i, "it reached the help branch, not a fallback");
});

test("a bare @bot answers with what it is holding", async () => {
  const env = room();
  const said = stubLine();
  await deliver(worker, env, [ev.join(GROUP), ev.text(GROUP, BEER, "@bot")]);
  assert.equal(said.replies.length, 1);
});

test("a LINE @-mention counts, even with no @ in the text", async () => {
  const env = room();
  const said = stubLine();
  await deliver(worker, env, [ev.join(GROUP), ev.text(GROUP, BEER, "status", mentioned("status"))]);
  assert.equal(said.replies.length, 1);
});

test("the full line is kept, not the stripped one", async () => {
  const env = room();
  stubLine();
  await deliver(worker, env, [ev.join(GROUP), ev.text(GROUP, BEER, "@bot status")]);
  const r = rows(env, "SELECT text FROM events WHERE kind='text'");
  assert.equal(r[0].text, "@bot status", "what was typed is what gets kept");
});

test("BEING ADDRESSED ONCE DOES NOT OPEN THE MOUTH FOR WHAT FOLLOWS", async () => {
  const env = room();
  const said = stubLine();
  await deliver(worker, env, [ev.join(GROUP), ev.text(GROUP, BEER, "@bot status")]);
  assert.equal(said.replies.length, 1);
  said.replies.length = 0;
  // Exactly the traffic that got it thrown out: photos, names, chatter.
  await deliver(worker, env, [
    ev.text(GROUP, BEER, "help"),
    ev.text(GROUP, BEER, "status"),
    ev.image(GROUP, BEER),
    ev.text(GROUP, BEER, "ตลาดวโรรส"),
    ev.text(GROUP, BEER, "bug still wrong"),
  ]);
  assert.deepEqual(said.replies, [], "the permission was spent on the one message that carried it");
});

test("a mention inside a longer sentence still addresses it", async () => {
  const env = room();
  const said = stubLine();
  await deliver(worker, env, [ev.join(GROUP), ev.text(GROUP, BEER, "ok @nanobotco status please")]);
  assert.equal(said.replies.length, 1);
});

test("an address never earns a push — the nightly summary stays off", async () => {
  const env = room();
  const said = stubLine();
  await deliver(worker, env, [ev.join(GROUP), ev.text(GROUP, BEER, "@bot status")]);
  await worker.scheduled({}, env, { waitUntil: () => {} });
  assert.deepEqual(said.pushes, [], "a push is not an answer to anything");
});

test("SPEAK=on still restores the talking bot", async () => {
  const env = room({ flag: "on" });
  const said = stubLine();
  await deliver(worker, env, [ev.join(GROUP)]);
  assert.equal(said.replies.length, 1);
});

// ── the other rooms (Nan, 2026-09-30) ────────────────────────────────────────
// A private room for her own thoughts, where the bot never speaks, and a room
// where the team talks to the bots. Every other group stays as silent as the
// ops room. These run the deployed way (SPEAK off) unless they say otherwise.

const THOUGHTS = "Cthoughts";
const BOTS = "Cbots";
const ELSE = "Celsewhere";
const NAN = "Unan";
const NAMES = { [THOUGHTS]: "ความคิด · thoughts", [BOTS]: "บอท · bots", [ELSE]: "family dinner" };

// Everything anyone could say to it, addressed every way it knows.
const EVERYTHING = (g, u) => [
  ev.text(g, u, "hello"),
  ev.text(g, u, "@bot status"),
  ev.text(g, u, "@nanobotco help"),
  ev.text(g, u, "status", mentioned("status")),
  ev.text(g, u, "bug the map is wrong"),
  ev.text(g, u, "bot, status"),
  ev.text(g, u, "@bot"),
  ev.image(g, u),
  ev.location(g, u, 18.7891, 99.0457),
];

for (const flag of [undefined, "off", "on"]) {
  test(`SPEAK=${JSON.stringify(flag)} — THOUGHTS says nothing, not on join and not when addressed`, async () => {
    const env = room({ flag });
    const said = stubLine({ groups: NAMES });
    await deliver(worker, env, [ev.join(GROUP)]);
    said.replies.length = 0;
    await deliver(worker, env, [ev.join(THOUGHTS), ...EVERYTHING(THOUGHTS, NAN)]);
    await worker.scheduled({}, env, { waitUntil: () => {} });
    assert.deepEqual(said.replies, [], "her room is silent whatever SPEAK says");
    assert.deepEqual(said.pushes, [], "and nothing is pushed there");
    assert.equal(rows(env, "SELECT mode FROM group_modes WHERE group_id=?", THOUGHTS)[0].mode, "thoughts");
    assert.ok(rows(env, "SELECT * FROM events WHERE group_id=? AND channel='thoughts'", THOUGHTS).length >= 8,
      "silent, and everything kept");
  });
}

test("an unknown group stays muted: no word on join, none when addressed, nothing kept", async () => {
  const env = room();
  const said = stubLine({ groups: NAMES });
  await deliver(worker, env, [ev.join(GROUP)]);
  await deliver(worker, env, [ev.join(ELSE), ...EVERYTHING(ELSE, BEER)]);
  assert.deepEqual(said.replies, []);
  assert.deepEqual(said.pushes, []);
  assert.equal(rows(env, "SELECT mode FROM group_modes WHERE group_id=?", ELSE)[0].mode, "muted");
  assert.equal(rows(env, "SELECT * FROM events WHERE group_id=?", ELSE).length, 0);
});

test("a group LINE gives no name for is muted, and not decided for good", async () => {
  const env = room();
  const said = stubLine({ groups: {} });
  await deliver(worker, env, [ev.join(GROUP)]);
  await deliver(worker, env, [ev.join("Cnameless"), ...EVERYTHING("Cnameless", BEER)]);
  assert.deepEqual(said.replies, []);
  assert.equal(rows(env, "SELECT * FROM group_modes").length, 0);
});

test("the ops room is untouched by the bots room: still silent unless addressed", async () => {
  const env = room();
  const said = stubLine({ groups: NAMES });
  await deliver(worker, env, [ev.join(GROUP), ev.join(BOTS)]);
  said.replies.length = 0;
  await deliver(worker, env, [
    ev.text(GROUP, BEER, "status"),
    ev.text(GROUP, BEER, "bug the map is wrong"),
    ev.text(GROUP, BEER, "bot, status"),
    ev.image(GROUP, BEER),
  ]);
  assert.deepEqual(said.replies, [], "commands on their own still get nothing in the ops room");
});

test("BOTS answers when addressed, and says one hello on join", async () => {
  const env = room();
  const said = stubLine({ groups: NAMES });
  await deliver(worker, env, [ev.join(GROUP), ev.join(BOTS)]);
  assert.equal(said.replies.length, 1, "one hello");
  said.replies.length = 0;
  await deliver(worker, env, [ev.text(BOTS, NAN, "@bot status")]);
  assert.equal(said.replies.length, 1);
  assert.match(said.replies[0], /photo/);
});
