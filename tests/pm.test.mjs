// Michael's PM words in a one-to-one chat (src/pm.js). The wheel is faked:
// every call it would get is recorded, so the tests can see what would post.
import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/worker.js";
import { parse, personAndNote, lists } from "../src/pm.js";
import { makeEnv, stubLine, deliver, ev } from "./harness.mjs";

const MICHAEL = "Umichael", STRANGER = "Ustranger";
const old = new Date(Date.now() - 6 * 864e5).toISOString();
const fresh = new Date().toISOString();

const BOARD = () => ({
  me: { id: "michael", name: "Michael" },
  holders: ["Beer", "Hom", "Marcus", "Wai Tun", "Michael", "NaN"],
  load: { Marcus: 5, Beer: 0, "Wai Tun": 1 },
  cap: { Marcus: 5 },
  drafts: [{ n: 1 }],
  gold: { paid: 2, baht: 6000, goal: 61000 },
  log: [{ at: fresh, id: "t5", title: "Passed one", act: "passed", who: "Michael" }],
  repeats: [
    { n: 1, title: "Check the mailbox", face: "📬", whoName: "Michael", due: true, late: false, slot: "2026-10-22", next: "2026-10-26", time: "10:00" },
    { n: 2, title: "Water the plants", face: "🪴", whoName: "Michael", due: false, slot: "2026-10-21", next: "2026-10-28" },
    { n: 3, title: "Sweep the shop", face: "🧹", whoName: "Beer", due: true, slot: "2026-10-22", next: "2026-10-23" },
  ],
  tickets: [
    { id: "t1", num: 31, title: "Print run quotes", state: "Done", who: ["Beer"], created: "1", active: fresh, goal: "Two quotes", done: "Two PDFs in the thread", link: "https://discord.com/channels/g/t1" },
    { id: "t2", num: 54, title: "NFC chips", state: "Open", who: [], created: "2", active: fresh },
    { id: "t3", num: 12, title: "Share card pattern", state: "Doing", who: ["Wai Tun"], created: "3", active: old },
    { id: "t4", num: 40, title: "Gold credit", state: "Waiting", who: ["Marcus"], created: "4", active: fresh, rank: 1 },
    { id: "t5", num: 5, title: "Passed one", state: "Done", who: ["Hom"], created: "5", active: fresh, checked: fresh },
  ],
});

function setup() {
  const env = makeEnv([]);
  env.SPEAK = "off"; // the deployed mute: these answers must get through it
  env.PM_USERS = MICHAEL;
  env.PM_KEY = "k-michael";
  env.PM_URL = "https://wheel.test";
  env.PM_LINK = "https://wheel.test/#k=secret";
  const said = stubLine();
  const line = globalThis.fetch;
  const wheel = [];
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.startsWith("https://wheel.test")) {
      wheel.push({ path: u.slice(18), key: init?.headers?.["x-key"], body: init?.body ? JSON.parse(init.body) : null });
      return new Response(JSON.stringify(BOARD()), { status: 200 });
    }
    return line(url, init);
  };
  return { env, said, wheel, acts: () => wheel.filter((w) => w.path === "/api/act") };
}
const send = (env, text, who = MICHAEL) => deliver(worker, env, [ev.dm(who, text)]);
const last = (said) => said.replies.at(-1);

test("parse reads the words Michael types", () => {
  assert.deepEqual(parse("Give 3 Wai Tun start Monday"), { k: "give", n: 3, rest: "Wai Tun start Monday" });
  assert.deepEqual(parse("give #3 to Beer"), { k: "give", n: 3, rest: "Beer" });
  assert.deepEqual(parse("fail 2 the link is broken"), { k: "fail", n: 2, note: "the link is broken" });
  assert.deepEqual(parse("doing 4"), { k: "state", state: "Doing", n: 4, note: "" });
  assert.deepEqual(parse("first 1"), { k: "rank", rank: 1, n: 1 });
  assert.deepEqual(parse("7"), { k: "open", n: 7 });
  assert.equal(parse("Today").k, "today");
  assert.equal(parse("how are you").k, "unknown");
  assert.deepEqual(personAndNote("wai tun please", ["Wai", "Wai Tun"]), { who: "Wai Tun", note: "please" });
  assert.equal(personAndNote("Bob", ["Beer"]), null);
});

test("lists match the wheel's Today page", () => {
  const B = BOARD();
  assert.deepEqual(lists.check(B).map((x) => x.id), ["t1"], "passed ones drop off");
  assert.deepEqual(lists.give(B).map((x) => x.id), ["t2"]);
  assert.deepEqual(lists.quiet(B).map((x) => x.id), ["t3"]);
});

test("someone else's one-to-one chat gets nothing from the PM words", async () => {
  const { env, said, wheel } = setup();
  await send(env, "today", STRANGER);
  assert.deepEqual(said.replies, []);
  assert.equal(wheel.length, 0);
});

test("today answers through the mute, numbered, with Michael's key", async () => {
  const { env, said, wheel } = setup();
  await send(env, "today");
  const r = last(said);
  assert.match(r, /To check[\s\S]*#31 ✅ Print run quotes · Beer/);
  assert.match(r, /To give out[\s\S]*#54 📥 NFC chips · nobody/);
  assert.match(r, /Quiet 4\+ days[\s\S]*#12 🔨 Share card pattern · Wai Tun/);
  assert.match(r, /Marcus 5\/5/);
  assert.match(r, /1 drafts not posted/);
  assert.equal(wheel[0].key, "k-michael");
});

test("a number opens the ticket with that number", async () => {
  const { env, said } = setup();
  await send(env, "31");
  assert.match(last(said), /^#31 Print run quotes\n✅ Done · Beer\nGoal: Two quotes\nDone means: Two PDFs/);
});

test("give asks first, posts only on yes", async () => {
  const { env, said, acts } = setup();
  await send(env, "today");
  await send(env, "give 54 Wai Tun start Monday");
  assert.match(last(said), /Give 54 · NFC chips\nto Wai Tun\nNote: start Monday/);
  assert.equal(acts().length, 0, "nothing posted before the yes");
  await send(env, "yes");
  assert.deepEqual(acts()[0].body, { id: "t2", act: "give", who: "Wai Tun", note: "start Monday" });
  assert.equal(last(said), "Done: 54 given to Wai Tun.");
  await send(env, "yes");
  assert.equal(last(said), "Nothing waiting for a yes.");
  assert.equal(acts().length, 1, "a second yes does not post again");
});

test("give to someone at their limit is refused before any yes", async () => {
  const { env, said, acts } = setup();
  await send(env, "today");
  await send(env, "give 54 Marcus");
  assert.match(last(said), /Marcus holds 5\/5, the limit\. Pick someone else/);
  await send(env, "yes");
  assert.equal(acts().length, 0, "nothing posted");
});

test("someone at their limit can still be given a ticket they already hold", async () => {
  const { env, said, acts } = setup();
  await send(env, "find gold");
  await send(env, "give 40 Marcus");
  assert.doesNotMatch(last(said), /the limit/);
  await send(env, "yes");
  assert.equal(acts()[0].body.id, "t4");
  assert.equal(acts()[0].body.who, "Marcus");
});

test("no cancels; fail needs a reason; unknown person is named", async () => {
  const { env, said, acts } = setup();
  await send(env, "today");
  await send(env, "pass 31");
  await send(env, "no");
  await send(env, "yes");
  assert.equal(acts().length, 0);
  await send(env, "fail 31");
  assert.match(last(said), /Say what is wrong/);
  await send(env, "give 54 Bob");
  assert.match(last(said), /to whom\? Beer, Hom/);
});

test("a number no ticket has is refused, and a place on the list is not a number", async () => {
  const { env, said } = setup();
  await send(env, "77");
  assert.match(last(said), /No ticket #77/);
  await send(env, "today");
  await send(env, "2");
  assert.match(last(said), /No ticket #2/);
});

test("order posts nothing and needs no yes", async () => {
  const { env, said, acts } = setup();
  await send(env, "today");
  await send(env, "first 12");
  assert.deepEqual(acts()[0].body, { id: "t3", act: "rank", rank: 1 });
  assert.match(last(said), /order first\. Nothing posted\./);
});

test("who, find, report, link, help", async () => {
  const { env, said } = setup();
  await send(env, "who marcus");
  assert.match(last(said), /Marcus: 5 open or doing \(limit 5\) · 1 not done\n#40 ⏳ Gold credit/);
  await send(env, "find nfc");
  assert.match(last(said), /Found 1\n#54 📥 NFC chips/);
  await send(env, "report");
  assert.match(last(said), /Gold sold, last 30 days: 2 · ฿6,000 of ฿61,000/);
  assert.match(last(said), /First:\n- Gold credit \(Marcus\)/);
  assert.match(last(said), /— Michael$/);
  await send(env, "link");
  assert.match(last(said), /wheel\.test\/#k=secret/);
  await send(env, "hello there");
  assert.match(last(said), /^I didn't catch that\.\n\nPM words/);
});

test("the ops room stays silent when Michael says today there", async () => {
  const { env, said } = setup();
  await deliver(worker, env, [ev.join("Cops")]);
  said.replies.length = 0;
  await deliver(worker, env, [ev.text("Cops", MICHAEL, "today")]);
  assert.deepEqual(said.replies, []);
});

test("another word in between drops the waiting action (CodeRabbit, #4)", async () => {
  const { env, said, acts } = setup();
  await send(env, "today");
  await send(env, "give 54 Beer");
  await send(env, "today");
  await send(env, "yes");
  assert.equal(last(said), "Nothing waiting for a yes.");
  assert.equal(acts().length, 0);
});

test("parse tells a repeat word from a ticket number", () => {
  assert.deepEqual(parse("done mailbox"), { k: "rdone", words: "mailbox" });
  assert.deepEqual(parse("Did the mailbox"), { k: "rdone", words: "the mailbox" });
  assert.deepEqual(parse("done"), { k: "rdone", words: "" });
  assert.deepEqual(parse("done 3"), { k: "state", state: "Done", n: 3, note: "" });
  assert.deepEqual(parse("done 3 all good"), { k: "state", state: "Done", n: 3, note: "all good" });
  assert.equal(parse("undo").k, "undo");
});

test("today lists Michael's due repeats on top, not anyone else's, and keeps the ticket numbers", async () => {
  const { env, said } = setup();
  await send(env, "today");
  const r = last(said);
  assert.match(r, /^🔁 Due today\n📬 Check the mailbox · 10:00 → send: done mailbox\n✅ To check/);
  assert.doesNotMatch(r, /plants|Sweep/);
  assert.match(r, /#31 ✅ Print run quotes/);
});

test("done mailbox ticks it with no yes and posts nothing; undo takes it back", async () => {
  const { env, said, wheel, acts } = setup();
  await send(env, "done mailbox");
  const call = wheel.find((w) => w.path === "/api/repeat/done");
  assert.deepEqual(call.body, { n: 1 });
  assert.equal(acts().length, 0, "no ticket action");
  assert.match(last(said), /^✅ 📬 Check the mailbox, done\. Next: Mon 26 Oct\. Nothing posted\./);
  await send(env, "undo");
  assert.deepEqual(wheel.filter((w) => w.path === "/api/repeat/done").at(-1).body, { n: 1, undo: true, was: null });
  assert.match(last(said), /not done again/);
  await send(env, "undo");
  assert.equal(last(said), "Nothing to undo.");
});

test("done alone ticks the one due; a repeat already done, or someone else's, is refused", async () => {
  const { env, said, wheel } = setup();
  await send(env, "done");
  assert.deepEqual(wheel.find((w) => w.path === "/api/repeat/done").body, { n: 1 });
  await send(env, "done plants");
  assert.match(last(said), /Water the plants is already done\. Next: Wed 28 Oct\./);
  await send(env, "done sweep");
  assert.match(last(said), /No repeat called "sweep"\. Yours: Check the mailbox, Water the plants/);
  assert.equal(wheel.filter((w) => w.path === "/api/repeat/done").length, 1);
});

test("a short title still gets a done word that matches it (CodeRabbit, #8)", async () => {
  const { env, said, wheel } = setup();
  const board = BOARD;
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith("https://wheel.test")) {
      const B = board(); B.repeats = [{ n: 9, title: "Go", face: "🔁", whoName: "Michael", due: true, slot: "2026-10-22", next: "2026-10-23" }];
      wheel.push({ path: String(url).slice(18), body: init?.body ? JSON.parse(init.body) : null });
      return new Response(JSON.stringify(B), { status: 200 });
    }
    return orig(url, init);
  };
  await send(env, "today");
  assert.match(last(said), /🔁 Go → send: done go/);
  await send(env, "done go");
  assert.deepEqual(wheel.find((w) => w.path === "/api/repeat/done").body, { n: 9 });
});

test("undo keeps its place when the wheel fails, so a retry still works (CodeRabbit, #8)", async () => {
  const { env, said } = setup();
  await send(env, "done mailbox");
  const orig = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.startsWith("https://wheel.test")) calls.push(u.slice(18));
    return u === "https://wheel.test/api/repeat/done" ? new Response("{}", { status: 500 }) : orig(url, init);
  };
  await send(env, "undo");
  assert.match(last(said), /The wheel didn't answer/);
  assert.deepEqual(calls, ["/api/repeat/done"], "undo goes straight to the repeat, no board first (#9)");
  globalThis.fetch = orig;
  await send(env, "undo");
  assert.match(last(said), /not done again/);
});
