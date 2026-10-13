// The whole path a photo takes, and the ways it is allowed to fail.
import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/worker.js";
import { makeEnv, stubLine, deliver, sign, ev, SECRET } from "./harness.mjs";

const GROUP = "Cteam";
const OTHER = "Cstranger";
const BEER = "Ubeer";
const MIKE = "Umichael";

const INDEX = [
  { s: "thapae-gate-1017379824", n: "ประตูท่าแพ", e: "Thapae Gate" },
  { s: "warorot-1", n: "ตลาดวโรรส", e: "Warorot Market" },
  { s: "warorot-2", n: "ตลาดวโรรส", e: "Warorot Market" },
  { s: "punspace-9", n: "ปันสเปซ สาขาประตูท่าแพ", e: "Pun Space Tha Phae Gate" },
  { s: "carpark-7", n: "ลานจอดรถ · ใกล้ประตูท่าแพ 570 ม.", e: "Car park · 570 m from Tha Phae Gate" },
];

const rows = (env, sql, ...a) => env._db.prepare(sql).all(...a);

async function joined() {
  const env = makeEnv(INDEX);
  const said = stubLine();
  await deliver(worker, env, [ev.join(GROUP)]);
  return { env, said };
}

test("a bad signature is refused and nothing is kept", async () => {
  const env = makeEnv(INDEX);
  stubLine();
  const body = JSON.stringify({ events: [ev.text(GROUP, BEER, "hello")] });
  const res = await worker.fetch(
    new Request("https://x/line/webhook", {
      method: "POST", headers: { "x-line-signature": await sign(body, "wrong-secret") }, body,
    }), env, { waitUntil: () => {} });
  assert.equal(res.status, 401);
  assert.equal(rows(env, "SELECT * FROM events").length, 0);
});

test("LINE's own verify ping — empty events — gets a 200", async () => {
  const env = makeEnv(INDEX);
  stubLine();
  const res = await deliver(worker, env, []);
  assert.equal(res.status, 200);
});

test("the first group it joins becomes the team group, and it says what it does", async () => {
  const { env, said } = await joined();
  assert.equal(env._db.prepare("SELECT v FROM state WHERE k='team_group_id'").get().v, GROUP);
  assert.match(said.replies[0], /quiet/, "one line on arrival, not the manual");
  assert.ok(said.replies[0].length < 160, "short enough not to be a wall");
});

test("a one-to-one reader message is left entirely alone", async () => {
  const { env, said } = await joined();
  said.replies.length = 0;
  await deliver(worker, env, [ev.dm("Ureader", "where is the night market?")]);
  assert.deepEqual(said.replies, [], "the OA's own auto-reply answers readers, not this Worker");
  assert.equal(rows(env, "SELECT * FROM events WHERE kind='text'").length, 0);
});

test("a stranger's group is not worked in", async () => {
  const { env, said } = await joined();
  said.replies.length = 0;
  await deliver(worker, env, [ev.text(OTHER, "Ux", "bug everything is broken")]);
  assert.deepEqual(said.replies, []);
  assert.equal(rows(env, "SELECT * FROM events WHERE group_id=?", OTHER).length, 0);
});

test("photo after a name: filed, bytes kept, and it says where", async () => {
  const { env, said } = await joined();
  await deliver(worker, env, [ev.text(GROUP, BEER, "ตลาดวโรรส")]);
  said.replies.length = 0;
  await deliver(worker, env, [ev.image(GROUP, BEER)]);

  const p = env._db.prepare("SELECT * FROM events WHERE kind='photo'").get();
  assert.equal(p.status, "asking", "two records share that name, so it must ask rather than pick one");
  assert.match(said.replies[0], /which place/i);
  assert.ok(p.photo_key.startsWith("photos/"), "bytes are keyed by the day they arrived");
  assert.equal(env.INBOX.store.get(p.photo_key).body.byteLength, 4);
  assert.equal(p.user_name, "Beer");
});

test("an unambiguous name files the photo outright", async () => {
  const { env, said } = await joined();
  await deliver(worker, env, [ev.text(GROUP, BEER, "thapae gate")]);
  said.replies.length = 0;
  await deliver(worker, env, [ev.image(GROUP, BEER)]);
  const p = env._db.prepare("SELECT * FROM events WHERE kind='photo'").get();
  assert.equal(p.status, "matched");
  assert.equal(p.place_slug, "thapae-gate-1017379824");
  assert.deepEqual(said.replies, [], "filed in silence — the nightly line says how many");
});

test("a photo with nothing said gets asked about, and the answer settles it", async () => {
  const { env, said } = await joined();
  said.replies.length = 0; // the greeting used to contain "which place" and matched by accident
  await deliver(worker, env, [ev.image(GROUP, BEER)]);
  assert.match(said.replies[0], /which place/i);
  said.replies.length = 0;

  await deliver(worker, env, [ev.text(GROUP, BEER, "https://motdang.net/cm/p/thapae-gate-1017379824")]);
  const p = env._db.prepare("SELECT * FROM events WHERE kind='photo'").get();
  assert.equal(p.status, "matched");
  assert.equal(p.place_slug, "thapae-gate-1017379824");
  assert.match(said.replies[0], /เก็บแล้ว/, "a person answered, so a word back — silence would read as ignored");
  assert.match(p.decided_by, /thapae-gate/, "the ledger records what actually named it");
});

test("the numbered offer can be answered with the number", async () => {
  const { env, said } = await joined();
  await deliver(worker, env, [ev.text(GROUP, BEER, "ตลาดวโรรส")]);
  await deliver(worker, env, [ev.image(GROUP, BEER)]);
  assert.match(said.replies.at(-1), /1\. /, "the options are numbered so an answer can be one character");
  await deliver(worker, env, [ev.text(GROUP, BEER, "1")]);
  const p = env._db.prepare("SELECT * FROM events WHERE kind='photo'").get();
  assert.equal(p.status, "matched");
  assert.equal(p.place_slug, "warorot-1");
});

test("“none” leaves the photo for a person instead of guessing", async () => {
  const { env } = await joined();
  await deliver(worker, env, [ev.image(GROUP, BEER)]);
  await deliver(worker, env, [ev.text(GROUP, BEER, "none")]);
  assert.equal(env._db.prepare("SELECT status FROM events WHERE kind='photo'").get().status, "unmatched");
});

test("a quoted message names the photo it is quoted on", async () => {
  const { env, said } = await joined();
  const t = ev.text(GROUP, BEER, "thapae gate");
  await deliver(worker, env, [t]);
  said.replies.length = 0;
  // A photo sent much later, quoting that line rather than following it.
  const img = ev.image(GROUP, MIKE, { quotedMessageId: t.message.id });
  img.timestamp = Date.now() + 60 * 60 * 1000;
  await deliver(worker, env, [img]);
  assert.equal(env._db.prepare("SELECT place_slug FROM events WHERE kind='photo'").get().place_slug,
    "thapae-gate-1017379824");
});

test("stale context does not name a photo", async () => {
  const { env } = await joined();
  const t = ev.text(GROUP, BEER, "thapae gate");
  t.timestamp = Date.now() - 6 * 60 * 1000; // older than the context window
  await deliver(worker, env, [t]);
  const img = ev.image(GROUP, BEER);
  await deliver(worker, env, [img]);
  assert.equal(env._db.prepare("SELECT status FROM events WHERE kind='photo'").get().status, "asking");
});

test("a bug gets a number, and the numbers keep counting", async () => {
  const { env, said } = await joined();
  await deliver(worker, env, [ev.text(GROUP, MIKE, "bug: the toilets page shows 0 in Hang Dong")]);
  await deliver(worker, env, [ev.text(GROUP, MIKE, "bug photos on /here are stretched")]);
  const bugs = rows(env, "SELECT ticket, text, kind FROM events WHERE kind='bug' ORDER BY id");
  assert.deepEqual(bugs.map((b) => b.ticket), ["BUG-0001", "BUG-0002"]);
  assert.equal(bugs[0].text, "the toilets page shows 0 in Hang Dong");
  assert.match(said.replies.at(-1), /BUG-0002/);
});

test("a photo LINE will not hand over is said out loud, not swallowed", async () => {
  const { env, said } = await joined();
  const upstream = globalThis.fetch;
  globalThis.fetch = async (url, init) =>
    String(url).includes("/content") ? new Response("gone", { status: 404 }) : upstream(url, init);
  said.replies.length = 0;
  await deliver(worker, env, [ev.image(GROUP, BEER)]);
  assert.match(said.replies[0], /send it again/i);
  assert.equal(rows(env, "SELECT * FROM events WHERE kind='photo'").length, 0);
});

test("the same message delivered twice is kept once", async () => {
  const { env } = await joined();
  const e = ev.image(GROUP, BEER);
  await deliver(worker, env, [e]);
  await deliver(worker, env, [e]);
  assert.equal(rows(env, "SELECT * FROM events WHERE kind='photo'").length, 1);
});

test("status reads back what is actually held", async () => {
  const { env, said } = await joined();
  await deliver(worker, env, [ev.text(GROUP, BEER, "thapae gate")]);
  await deliver(worker, env, [ev.image(GROUP, BEER)]);
  await deliver(worker, env, [ev.text(GROUP, MIKE, "bug the map is blank")]);
  said.replies.length = 0;
  await deliver(worker, env, [ev.text(GROUP, BEER, "status")]);
  assert.match(said.replies[0], /1 photo since I joined/);
  assert.match(said.replies[0], /1 bug report/);
});

test("the desk pulls, acks, and does not get the same row twice", async () => {
  const { env } = await joined();
  await deliver(worker, env, [ev.text(GROUP, BEER, "thapae gate")]);
  await deliver(worker, env, [ev.image(GROUP, BEER)]);
  await deliver(worker, env, [ev.text(GROUP, MIKE, "bug the map is blank")]);

  const hdr = { authorization: "Bearer test-pull" };
  const noAuth = await worker.fetch(new Request("https://x/desk/pull"), env, { waitUntil: () => {} });
  assert.equal(noAuth.status, 401);

  let got = await (await worker.fetch(new Request("https://x/desk/pull", { headers: hdr }), env, { waitUntil: () => {} })).json();
  // The ops channel means every line travels, not just the photo and the bug:
  // "thapae gate" is the caption AND, on another day, could be the fact.
  assert.equal(got.rows.length, 3, "the plain message comes down too");
  assert.deepEqual(got.rows.map((r) => r.kind).sort(), ["bug", "photo", "text"]);

  const photo = got.rows.find((r) => r.kind === "photo");
  const bytes = await worker.fetch(
    new Request("https://x/desk/photo?key=" + encodeURIComponent(photo.photo_key), { headers: hdr }), env, { waitUntil: () => {} });
  assert.equal((await bytes.arrayBuffer()).byteLength, 4);

  const ack = await (await worker.fetch(new Request("https://x/desk/ack", {
    method: "POST", headers: hdr, body: JSON.stringify({ ids: got.rows.map((r) => r.id) }),
  }), env, { waitUntil: () => {} })).json();
  assert.equal(ack.acked, 3);

  got = await (await worker.fetch(new Request("https://x/desk/pull", { headers: hdr }), env, { waitUntil: () => {} })).json();
  assert.equal(got.rows.length, 0);
});

test("the nightly summary speaks only when there is something to say", async () => {
  const { env, said } = await joined();
  await worker.scheduled({}, env, { waitUntil: (p) => p });
  assert.deepEqual(said.pushes, [], "a bot that reports nothing every night gets muted");

  await deliver(worker, env, [ev.text(GROUP, BEER, "thapae gate")]);
  await deliver(worker, env, [ev.image(GROUP, BEER)]);
  await deliver(worker, env, [ev.text(GROUP, MIKE, "bug the map is blank")]);
  const waits = [];
  await worker.scheduled({}, env, { waitUntil: (p) => waits.push(p) });
  await Promise.all(waits);
  assert.equal(said.pushes.length, 1);
  assert.match(said.pushes[0], /1 photo/);
  assert.match(said.pushes[0], /1 bug report/);
});

test("“bug.” on its own reports the last thing the bot did, and undoes it", async () => {
  const { env, said } = await joined();
  await deliver(worker, env, [ev.text(GROUP, BEER, "thapae gate")]);
  await deliver(worker, env, [ev.image(GROUP, BEER)]);
  const filed = env._db.prepare("SELECT * FROM events WHERE kind='photo'").get();
  assert.equal(filed.status, "matched", "set-up: it filed something");
  said.replies.length = 0;

  await deliver(worker, env, [ev.text(GROUP, BEER, "bug.")]);

  const bug = env._db.prepare("SELECT * FROM events WHERE kind='bug'").get();
  assert.equal(bug.ticket, "BUG-0001");
  assert.match(bug.text, /filed under/, "the report says what it is about, without anyone retyping it");
  assert.equal(bug.quoted_id, filed.message_id, "and points at the photo it is about");

  const after = env._db.prepare("SELECT * FROM events WHERE kind='photo'").get();
  assert.equal(after.status, "asking", "a report that a filing is wrong un-files it");
  assert.equal(after.place_slug, null);
  assert.match(said.replies[0], /taken that photo back off/i);
});

test("“bug.” with nothing to point at says so instead of inventing a report", async () => {
  const { env, said } = await joined();
  said.replies.length = 0;
  await deliver(worker, env, [ev.text(GROUP, BEER, "bug.")]);
  assert.equal(env._db.prepare("SELECT COUNT(*) n FROM events WHERE kind='bug'").get().n, 0);
  assert.match(said.replies[0], /cannot see what I did wrong/i);
});

test("“ไม่ใช่” answers an open question before it reports anything", async () => {
  const { env } = await joined();
  await deliver(worker, env, [ev.image(GROUP, BEER)]);          // asked: which place?
  await deliver(worker, env, [ev.text(GROUP, BEER, "ไม่ใช่")]);  // none of those
  assert.equal(env._db.prepare("SELECT status FROM events WHERE kind='photo'").get().status, "unmatched");
  assert.equal(env._db.prepare("SELECT COUNT(*) n FROM events WHERE kind='bug'").get().n, 0,
    "answering a question is not a bug report");
});

test("“wrong” after a filing, with no question open, is a report", async () => {
  const { env, said } = await joined();
  await deliver(worker, env, [ev.text(GROUP, BEER, "thapae gate")]);
  await deliver(worker, env, [ev.image(GROUP, BEER)]);
  said.replies.length = 0;
  await deliver(worker, env, [ev.text(GROUP, BEER, "wrong")]);
  assert.equal(env._db.prepare("SELECT status FROM events WHERE kind='photo'").get().status, "asking");
  assert.match(said.replies[0], /taken that photo back off/i);
});

test("talking about bugs undoes nothing, and asks once", async () => {
  const { env, said } = await joined();
  await deliver(worker, env, [ev.text(GROUP, BEER, "thapae gate")]);
  await deliver(worker, env, [ev.image(GROUP, BEER)]);
  said.replies.length = 0;

  await deliver(worker, env, [ev.text(GROUP, BEER, "michael put a bunch of bug reports in the drive")]);
  assert.equal(env._db.prepare("SELECT COUNT(*) n FROM events WHERE kind='bug'").get().n, 0,
    "a passing remark is not a report");
  assert.equal(env._db.prepare("SELECT status FROM events WHERE kind='photo'").get().status, "matched",
    "and it must not undo a correct filing");
  assert.match(said.replies[0], /was that one for me/i);
  assert.ok(said.replies[0].startsWith("("), "asked lightly, in an aside");

  // Taken up, it files. Left alone, nothing would have happened.
  await deliver(worker, env, [ev.text(GROUP, BEER, "yes")]);
  assert.equal(env._db.prepare("SELECT COUNT(*) n FROM events WHERE kind='bug'").get().n, 1);
  assert.equal(env._db.prepare("SELECT status FROM events WHERE kind='photo'").get().status, "asking");
});

test("a remark about bugs with nothing of mine nearby passes in silence", async () => {
  const { env, said } = await joined();
  said.replies.length = 0;
  await deliver(worker, env, [ev.text(GROUP, BEER, "we should file a bug for that eventually")]);
  assert.deepEqual(said.replies, [], "no question worth asking, so none asked");
  assert.equal(env._db.prepare("SELECT COUNT(*) n FROM events WHERE kind='bug'").get().n, 0);
  assert.equal(env._db.prepare("SELECT COUNT(*) n FROM events WHERE kind='text'").get().n, 1,
    "it is still kept — a hypothetical bug belongs in the transcript");
});

// ── the sign, and the pin ────────────────────────────────────────────────────

test("the sign names the place when nobody typed one", async () => {
  const { env, said } = await joined();
  env._sign = { name_th: "ประตูท่าแพ", name_en: "Thapae Gate", phone: null, hours: null, line_id: null, what_kind: "city gate", other_text: null };
  said.replies.length = 0;
  await deliver(worker, env, [ev.image(GROUP, BEER)]);
  const p = env._db.prepare("SELECT * FROM events WHERE kind='photo'").get();
  assert.equal(p.status, "matched");
  assert.equal(p.place_slug, "thapae-gate-1017379824");
  assert.deepEqual(said.replies, [], "placed from the sign, filed in silence");
  assert.equal(JSON.parse(p.sign).name_en, "Thapae Gate", "the reading travels to the desk for a person to check");
});

test("a sign for a place we do not hold is offered, not filed", async () => {
  const { env, said } = await joined();
  env._sign = { name_th: null, name_en: "Get ER to the Greek", phone: null, hours: "11:00-22:00", line_id: null, what_kind: "Greek food", other_text: "GYRO" };
  said.replies.length = 0;
  await deliver(worker, env, [ev.image(GROUP, BEER)]);
  const p = env._db.prepare("SELECT * FROM events WHERE kind='photo'").get();
  assert.equal(p.status, "asking", "not in the index, so it asks");
  assert.match(said.replies[0], /Sign reads: Get ER to the Greek · Greek food · 11:00-22:00/);
  assert.match(said.replies[0], /which place/i);
});

test("what they typed beats what the sign says", async () => {
  const { env } = await joined();
  env._sign = { name_th: null, name_en: "Warorot Market", phone: null, hours: null, line_id: null, what_kind: null, other_text: null };
  await deliver(worker, env, [ev.text(GROUP, BEER, "thapae gate")]);
  await deliver(worker, env, [ev.image(GROUP, BEER)]);
  assert.equal(env._db.prepare("SELECT place_slug FROM events WHERE kind='photo'").get().place_slug, "thapae-gate-1017379824");
});

test("a blank or unreadable sign changes nothing", async () => {
  const { env, said } = await joined();
  env._sign = null;
  said.replies.length = 0;
  await deliver(worker, env, [ev.image(GROUP, BEER)]);
  const p = env._db.prepare("SELECT * FROM events WHERE kind='photo'").get();
  assert.equal(p.sign, null);
  assert.doesNotMatch(said.replies[0], /Sign reads/);
});

test("a shared location pins the photo sent just before it", async () => {
  const { env, said } = await joined();
  await deliver(worker, env, [ev.text(GROUP, BEER, "thapae gate")]);
  await deliver(worker, env, [ev.image(GROUP, BEER)]);
  said.replies.length = 0;
  await deliver(worker, env, [ev.location(GROUP, BEER, 18.78775, 98.99313, { address: "Tha Phae Rd" })]);
  const p = env._db.prepare("SELECT * FROM events WHERE kind='photo'").get();
  assert.equal(p.lat, 18.78775);
  assert.equal(p.address, "Tha Phae Rd");
  assert.deepEqual(said.replies, [], "a pin needs no announcement");
  assert.equal(env._db.prepare("SELECT COUNT(*) n FROM events WHERE kind='location'").get().n, 1, "and kept on its own row too");
});

test("a location sent first is picked up by the next photo", async () => {
  const { env, said } = await joined();
  said.replies.length = 0;
  await deliver(worker, env, [ev.location(GROUP, BEER, 18.78775, 98.99313)]);
  await deliver(worker, env, [ev.image(GROUP, BEER)]);
  const p = env._db.prepare("SELECT * FROM events WHERE kind='photo'").get();
  assert.equal(p.lng, 98.99313);
  assert.equal(said.replies.length, 1, "only the question, since the photo could not be placed");
  assert.match(said.replies[0], /Pinned from your location/);
});

test("somebody else's location does not pin my photo", async () => {
  const { env } = await joined();
  await deliver(worker, env, [ev.image(GROUP, BEER)]);
  await deliver(worker, env, [ev.location(GROUP, MIKE, 18.1, 98.1)]);
  assert.equal(env._db.prepare("SELECT lat FROM events WHERE kind='photo'").get().lat, null);
});

test("locations come down to the desk", async () => {
  const { env } = await joined();
  await deliver(worker, env, [ev.location(GROUP, BEER, 18.78775, 98.99313)]);
  const got = await (await worker.fetch(new Request("https://x/desk/pull", { headers: { authorization: "Bearer test-pull" } }), env, { waitUntil: () => {} })).json();
  assert.equal(got.rows[0].kind, "location");
  assert.equal(got.rows[0].lat, 18.78775);
});
