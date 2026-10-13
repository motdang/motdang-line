// The thoughts room and the bots room (Nan, 2026-09-30). tests/silence.test.mjs
// proves who stays silent; this file proves what the two new rooms do.
import { test } from "node:test";
import assert from "node:assert/strict";
import worker, { modeFromName } from "../src/worker.js";
import { makeEnv, stubLine, deliver, ev } from "./harness.mjs";

const OPS = "Cops";
const THOUGHTS = "Cthoughts";
const BOTS = "Cbots";
const NAN = "Unan", BEER = "Ubeer", STRANGER = "Ustranger";
const NAMES = { [THOUGHTS]: "ความคิด · thoughts", [BOTS]: "บอท · bots" };

const rows = (env, sql, ...a) => env._db.prepare(sql).all(...a);

async function setup(opts = {}) {
  const env = makeEnv([{ s: "warorot-1", n: "ตลาดวโรรส", e: "Warorot Market" }]);
  env.SPEAK = "off";
  const said = stubLine({ groups: NAMES, strangers: [STRANGER], ...opts });
  await deliver(worker, env, [ev.join(OPS), ev.join(THOUGHTS), ev.join(BOTS)]);
  said.replies.length = 0;
  return { env, said };
}

async function desk(env, path, init = {}) {
  const r = await worker.fetch(new Request("https://line.motdang.net" + path, {
    ...init, headers: { authorization: "Bearer test-pull", ...(init.headers || {}) } }), env, { waitUntil() {} });
  return r.json();
}

test("names Nan will use, and near misses", () => {
  assert.equal(modeFromName("ความคิด · thoughts"), "thoughts");
  assert.equal(modeFromName("Nan's thoughts"), "thoughts");
  assert.equal(modeFromName("ความคิดของแนน"), "thoughts");
  assert.equal(modeFromName("บอท · bots"), "bots");
  assert.equal(modeFromName("Mot Dang bots"), "bots");
  assert.equal(modeFromName("ห้องบอท"), "bots");
  assert.equal(modeFromName("operations - motdang"), "muted");
  assert.equal(modeFromName("NaNoBotCo fans"), "muted", "bot inside a word is not the word");
  assert.equal(modeFromName("robots club"), "muted");
  assert.equal(modeFromName("thoughts for the bots"), "thoughts", "the silent one wins a tie");
  assert.equal(modeFromName(""), "muted");
});

test("THOUGHTS keeps text, photos, voice notes and locations, marked as hers", async () => {
  const { env, said } = await setup();
  await deliver(worker, env, [
    ev.text(THOUGHTS, NAN, "maybe the anthill should open at dusk"),
    ev.image(THOUGHTS, NAN),
    ev.audio(THOUGHTS, NAN),
    ev.location(THOUGHTS, NAN, 18.79, 98.98),
  ]);
  assert.deepEqual(said.replies, []);
  const r = rows(env, "SELECT kind, channel, photo_key, via FROM events WHERE group_id=? ORDER BY id", THOUGHTS);
  assert.deepEqual(r.map((x) => x.kind), ["text", "photo", "file", "location"]);
  assert.ok(r.every((x) => x.channel === "thoughts"));
  assert.match(r[1].photo_key, /^thoughts\/\d{4}\/\d\d\/\d\d\/m\d+\.jpg$/);
  assert.match(r[2].photo_key, /\.m4a$/);
  assert.ok(env.INBOX.store.has(r[1].photo_key), "bytes in R2 under their own prefix");
});

test("THOUGHTS is not the ops room: not filed, not a bug, not in the nightly count", async () => {
  const { env, said } = await setup();
  await deliver(worker, env, [
    ev.text(THOUGHTS, NAN, "ตลาดวโรรส"),
    ev.image(THOUGHTS, NAN),
    ev.text(THOUGHTS, NAN, "bug the map"),
  ]);
  assert.equal(rows(env, "SELECT * FROM events WHERE group_id=? AND (kind='bug' OR place_slug IS NOT NULL)", THOUGHTS).length, 0);
  assert.equal(rows(env, "SELECT * FROM events WHERE channel='thoughts' AND group_id=?", OPS).length, 0);
  await worker.scheduled({}, { ...env, SPEAK: "on" }, { waitUntil: () => {} });
  assert.deepEqual(said.pushes, [], "the ops room's nightly line does not count her thoughts");
});

test("a stranger's group named thoughts or bots keeps and answers nothing from strangers", async () => {
  const { env, said } = await setup();
  await deliver(worker, env, [
    ev.text(THOUGHTS, STRANGER, "hello"),
    ev.text(BOTS, STRANGER, "@bot status"),
    ev.text(BOTS, STRANGER, "bug everything"),
  ]);
  assert.deepEqual(said.replies, []);
  assert.equal(rows(env, "SELECT * FROM events WHERE user_id=?", STRANGER).length, 0);
});

test("BOTS: a bug report gets its ticket back, addressed or not", async () => {
  const { env, said } = await setup();
  await deliver(worker, env, [ev.text(BOTS, BEER, "bug the toilets page shows 0")]);
  assert.equal(said.replies.length, 1);
  assert.match(said.replies[0], /^BUG-\d{4} — kept/);
  await deliver(worker, env, [ev.text(BOTS, NAN, "@bot bug the pin is in the river")]);
  assert.match(said.replies[1], /^BUG-\d{4} — kept/);
  const r = rows(env, "SELECT channel FROM events WHERE kind='bug'");
  assert.ok(r.length === 2 && r.every((x) => x.channel === "bots"));
});

test("BOTS: a command on its own line is answered; so is 'bot,' and 'บอท'", async () => {
  const { env, said } = await setup();
  await deliver(worker, env, [
    ev.text(BOTS, BEER, "status"),
    ev.text(BOTS, BEER, "help"),
    ev.text(BOTS, BEER, "bot, status"),
    ev.text(BOTS, BEER, "บอท สถานะ"),
  ]);
  assert.equal(said.replies.length, 4);
});

test("BOTS: people talking to each other get nothing", async () => {
  const { env, said } = await setup();
  await deliver(worker, env, [
    ev.text(BOTS, BEER, "are you coming at 3?"),
    ev.text(BOTS, NAN, "yes"),
    ev.text(BOTS, NAN, "nah"),
    ev.text(BOTS, BEER, "the bots are funny today"),
    ev.text(BOTS, BEER, "what's the status of the medals"),
    ev.text(BOTS, BEER, "we should file a bug for that"),
    ev.text(BOTS, BEER, "ตลาดวโรรส"),
    ev.image(BOTS, BEER),
    ev.location(BOTS, BEER, 18.79, 98.98),
  ]);
  assert.deepEqual(said.replies, []);
  assert.deepEqual(said.pushes, []);
  assert.ok(rows(env, "SELECT * FROM events WHERE channel='bots'").length >= 8, "kept all the same");
});

test("BOTS: addressed with nothing it knows still gets an answer, once", async () => {
  const { env, said } = await setup();
  await deliver(worker, env, [ev.text(BOTS, NAN, "@bot what do you think of the anthill")]);
  assert.equal(said.replies.length, 1);
  assert.match(said.replies[0], /Kept/);
  said.replies.length = 0;
  await deliver(worker, env, [ev.text(BOTS, NAN, "and the lanterns")]);
  assert.deepEqual(said.replies, [], "one address, one answer");
});

test("the mode survives a rename, and the desk can change it", async () => {
  const { env, said } = await setup();
  said.replies.length = 0;
  // Renamed to something muted: still the bots room.
  const renamed = stubLine({ groups: { [BOTS]: "family dinner" } });
  await deliver(worker, env, [ev.text(BOTS, NAN, "status")]);
  assert.equal(renamed.replies.length, 1);

  const list = await desk(env, "/desk/groups");
  assert.equal(list.team_group_id, OPS);
  assert.deepEqual(list.groups.map((g) => g.mode).sort(), ["bots", "thoughts"]);

  const set = await desk(env, "/desk/groups/" + BOTS, { method: "POST", body: JSON.stringify({ mode: "muted" }) });
  assert.equal(set.group.mode, "muted");
  assert.equal(set.group.source, "desk");
  renamed.replies.length = 0;
  await deliver(worker, env, [ev.text(BOTS, NAN, "@bot status")]);
  assert.deepEqual(renamed.replies, []);

  const refused = await desk(env, "/desk/groups/" + OPS, { method: "POST", body: JSON.stringify({ mode: "bots" }) });
  assert.equal(refused.ok, false, "the ops room cannot be given a mode");
  const bad = await desk(env, "/desk/groups/" + BOTS, { method: "POST", body: JSON.stringify({ mode: "loud" }) });
  assert.equal(bad.ok, false);
});

test("a group first met by a message (join missed) is decided the same way", async () => {
  const env = makeEnv([]);
  env.SPEAK = "off";
  const said = stubLine({ groups: { Clate: "บอท · bots" } });
  await deliver(worker, env, [ev.join(OPS)]);
  await deliver(worker, env, [ev.text("Clate", NAN, "@bot status")]);
  assert.equal(said.replies.length, 1);
  assert.equal(rows(env, "SELECT mode FROM group_modes WHERE group_id='Clate'")[0].mode, "bots");
});

test("the pull carries the channel", async () => {
  const { env } = await setup();
  await deliver(worker, env, [
    ev.text(OPS, BEER, "ops line"),
    ev.text(THOUGHTS, NAN, "private line"),
    ev.text(BOTS, NAN, "bots line"),
  ]);
  const pulled = await desk(env, "/desk/pull");
  const by = Object.fromEntries(pulled.rows.map((r) => [r.text, r.channel]));
  assert.deepEqual(by, { "ops line": "ops", "private line": "thoughts", "bots line": "bots" });
});
