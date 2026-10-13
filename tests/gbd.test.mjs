// The Golf Ball Drop room (src/gbd.js): a ticket ledger in a club's group.
//
// Four things are proved here: the room is set only from the desk; it answers
// only what addresses it (and a bare "status"); it keeps ledger commands and
// nothing else, with nothing reaching the desk pull; and its six dated posts go
// through their own door.
import { test } from "node:test";
import assert from "node:assert/strict";
import worker, { modeFromName } from "../src/worker.js";
import { pushGbd, push } from "../src/line.js";
import { parseBalls, parseCommand, compress, runGbdPosts, SOP, GBD_CRON } from "../src/gbd.js";
import { ALERT_CRON } from "../src/alerts.js";
import { makeEnv, stubLine, deliver, ev } from "./harness.mjs";

const OPS = "Cops";
const GBD = "Cgolfballdrop";
const BOTS = "Cbots";
const NAN = "Unan", BEER = "Ubeer", TREAS = "Utreas";
const NAMES = { [OPS]: "operations - motdang", [GBD]: "Golf Ball Drop 2026-2027", [BOTS]: "บอท · bots" };
const WHO = { [NAN]: "Nan", [BEER]: "Beer", [TREAS]: "Treasurer Tom" };

const rows = (env, sql, ...a) => env._db.prepare(sql).all(...a);

// Every call the Worker makes to LINE, in order, with who the member lookups
// answered for.
function wire(said) {
  const calls = [];
  const inner = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    const body = init?.body ? JSON.parse(init.body) : null;
    calls.push({ url: u, body });
    if (u.includes("/member/")) {
      const uid = u.split("/member/")[1];
      return new Response(JSON.stringify({ displayName: WHO[uid] || "Someone" }), { status: 200 });
    }
    if (u.endsWith("/message/push")) {
      said.pushes.push(body.messages.map((m) => m.text).join(""));
      return new Response("{}", { status: 200 });
    }
    return inner(url, init);
  };
  return calls;
}

async function desk(env, path, init = {}, raw = false) {
  const r = await worker.fetch(new Request("https://line.motdang.net" + path, {
    ...init, headers: { authorization: "Bearer test-pull", ...(init.headers || {}) } }), env, { waitUntil() {} });
  return raw ? r : r.json();
}

// The ops room is known, the club's group has met the account under its own
// name (muted), and the desk then sets gbd, as scripts/group_mode.py does.
async function setup({ speak = "off", posts } = {}) {
  const env = makeEnv();
  env.SPEAK = speak;
  if (posts !== undefined) env.GBD_POSTS = posts;
  const said = stubLine({ groups: NAMES });
  const calls = wire(said);
  await deliver(worker, env, [ev.join(OPS), ev.join(GBD)]);
  assert.equal(rows(env, "SELECT mode FROM group_modes WHERE group_id=?", GBD)[0].mode, "muted", "a name does not make a gbd room");
  const set = await desk(env, "/desk/groups/" + GBD, { method: "POST", body: JSON.stringify({ mode: "gbd" }) });
  assert.equal(set.group.mode, "gbd");
  said.replies.length = 0;
  calls.length = 0;
  return { env, said, calls };
}

// One line from a member; what the bot said back, if anything.
async function say(env, said, uid, text, extra = {}) {
  const before = said.replies.length;
  await deliver(worker, env, [ev.text(GBD, uid, text, extra)]);
  return said.replies.slice(before);
}
const ask = async (env, said, uid, text) => (await say(env, said, uid, "@nanobotco " + text))[0];

// ── the mode ─────────────────────────────────────────────────────────────────

test("no group name gives gbd; the desk does", async () => {
  for (const n of ["gbd", "GBD bots", "Golf Ball Drop 2026-2027", "golf ball drop gbd", "Rotary GBD thoughts"]) {
    assert.notEqual(modeFromName(n), "gbd", n);
  }
  const env = makeEnv([]);
  env.SPEAK = "off";
  stubLine({ groups: { Cnew: "GBD" } });
  await deliver(worker, env, [ev.join(OPS)]);
  await deliver(worker, env, [ev.join("Cnew"), ev.text("Cnew", NAN, "@bot status")]);
  assert.equal(rows(env, "SELECT mode FROM group_modes WHERE group_id='Cnew'")[0].mode, "muted");
});

test("the desk lists and sets gbd; the ops room cannot take it", async () => {
  const { env } = await setup();
  const list = await desk(env, "/desk/groups");
  assert.ok(list.groups.some((g) => g.group_id === GBD && g.mode === "gbd" && g.source === "desk"));
  const refused = await desk(env, "/desk/groups/" + OPS, { method: "POST", body: JSON.stringify({ mode: "gbd" }) });
  assert.equal(refused.ok, false);
});

// ── who it answers ───────────────────────────────────────────────────────────

for (const speak of ["off", "on"]) {
  test(`SPEAK=${speak}: people talking to each other get nothing, and nothing is looked up or kept`, async () => {
    const { env, said, calls } = await setup({ speak });
    await deliver(worker, env, [
      ev.text(GBD, BEER, "are you selling tomorrow?"),
      ev.text(GBD, NAN, "yes, ten of mine"),
      ev.text(GBD, BEER, "issue 1-20 to Beer"),
      ev.text(GBD, BEER, "sold 5 Somchai"),
      ev.text(GBD, BEER, "paid 1-20"),
      ev.text(GBD, BEER, "status please"),
      ev.text(GBD, BEER, "what's the status of the posters"),
      ev.text(GBD, BEER, "the bots are funny"),
      ev.text(GBD, BEER, "bug the map is wrong"),
      ev.text(GBD, BEER, "help"),
      ev.image(GBD, BEER),
      ev.audio(GBD, BEER),
      ev.location(GBD, BEER, 18.79, 98.98),
    ]);
    assert.deepEqual(said.replies, []);
    assert.deepEqual(said.pushes, []);
    assert.equal(calls.length, 0, "no member lookup, no content download, nothing sent to LINE");
    assert.equal(rows(env, "SELECT * FROM gbd_tickets").length, 0);
    assert.equal(rows(env, "SELECT * FROM gbd_log").length, 0);
  });
}

test("no hello on join, SPEAK on or off", async () => {
  for (const speak of ["off", "on"]) {
    const { env, said } = await setup({ speak });
    await deliver(worker, env, [ev.join(GBD), { type: "memberJoined", source: { type: "group", groupId: GBD }, replyToken: "rtx", joined: { members: [] } }]);
    assert.deepEqual(said.replies, []);
  }
});

test("addressed four ways, and a line that is only status", async () => {
  const { env, said } = await setup();
  const mention = (text, length) => ({ mention: { mentionees: [{ index: 0, length, type: "user", isSelf: true }] }, text });
  let r = await say(env, said, BEER, "@nanobotco status");
  assert.match(r[0], /^Issued 0 · sold 0 · paid 0 · unissued 300 · baht in 0/);
  r = await say(env, said, BEER, "@NaNoBotCo issue 1-5 to Beer", mention("@NaNoBotCo issue 1-5 to Beer", 10));
  assert.equal(r[0], "Issued 1-5 to Beer (5).");
  // the account's display name can be anything; the structured mention is what counts
  r = await say(env, said, BEER, "@Club Bot sold 1", mention("@Club Bot sold 1", 9));
  assert.equal(r[0], "Sold 1.");
  r = await say(env, said, BEER, "bot, sold 2");
  assert.equal(r[0], "Sold 2.");
  r = await say(env, said, BEER, "บอท who 1");
  assert.match(r[0], /^1 is with Beer\. Sold\./);
  r = await say(env, said, BEER, "status");
  assert.match(r[0], /^Issued 5 · sold 2/);
  r = await say(env, said, BEER, "Status!");
  assert.equal(r.length, 1);
});

test("addressed but not a command gets the list; a bare @nanobotco gets status", async () => {
  const { env, said } = await setup();
  assert.match(await ask(env, said, BEER, "what time is the drop"), /^Not a ledger command\.\nBall numbers 1-300/);
  assert.match(await ask(env, said, BEER, "help"), /issue 1-20 to <name>/);
  assert.match(await ask(env, said, BEER, ""), /^Issued 0/);
  assert.match(await ask(env, said, BEER, "sold 5 7"), /^Not a ledger command/);
  assert.match(await ask(env, said, BEER, "issue 1-5"), /^Not a ledger command/);
});

test("a reply spends its token once", async () => {
  const { env, said } = await setup();
  await deliver(worker, env, [ev.text(GBD, BEER, "@nanobotco status")]);
  assert.equal(said.replies.length, 1);
  await deliver(worker, env, [ev.text(GBD, BEER, "thanks")]);
  assert.equal(said.replies.length, 1);
});

// ── parsing ──────────────────────────────────────────────────────────────────

test("ball numbers: single, range, list, bounds", () => {
  assert.deepEqual(parseBalls("5").nums, [5]);
  assert.deepEqual(parseBalls("1-20").nums.length, 20);
  assert.deepEqual(parseBalls("5, 7,9").nums, [5, 7, 9]);
  assert.deepEqual(parseBalls("3-5,4,10").nums, [3, 4, 5, 10]);
  assert.deepEqual(parseBalls("1 – 3").nums, [1, 2, 3], "en dash");
  assert.equal(parseBalls("300").nums[0], 300);
  assert.equal(parseBalls("1-300").nums.length, 300);
  assert.equal(parseBalls("0").error, "Ball 0 is outside 1-300.");
  assert.equal(parseBalls("301").error, "Ball 301 is outside 1-300.");
  assert.equal(parseBalls("290-310").error, "Ball 310 is outside 1-300.");
  assert.equal(parseBalls("99999999999999999999").error, "Ball 999999 is outside 1-300.");
  assert.equal(parseBalls("20-1").error, "20-1 runs backwards.");
  assert.equal(compress([1, 2, 3, 7, 9, 10]), "1-3, 7, 9-10");
});

test("commands parse to their parts", () => {
  assert.deepEqual(parseCommand("issue 1-20 to Beer"), { kind: "issue", spec: "1-20", name: "Beer" });
  assert.deepEqual(parseCommand("Issue 5,7 to @Khun Noi"), { kind: "issue", spec: "5,7", name: "Khun Noi" });
  assert.deepEqual(parseCommand("sold 5"), { kind: "sold", spec: "5", buyer: null });
  assert.deepEqual(parseCommand("sold 5 Somchai P."), { kind: "sold", spec: "5", buyer: "Somchai P." });
  assert.deepEqual(parseCommand("sold 1-3 to Mali"), { kind: "sold", spec: "1-3", buyer: "Mali" });
  assert.deepEqual(parseCommand("paid 1-20"), { kind: "paid", spec: "1-20", amount: null });
  assert.deepEqual(parseCommand("paid 1-20 18,000"), { kind: "paid", spec: "1-20", amount: 18000 });
  assert.deepEqual(parseCommand("paid 5 ฿1000 baht"), { kind: "paid", spec: "5", amount: 1000 });
  assert.deepEqual(parseCommand("back 15-20"), { kind: "back", spec: "15-20" });
  assert.deepEqual(parseCommand("who 17"), { kind: "who", spec: "17" });
  assert.deepEqual(parseCommand("price"), { kind: "price", amount: null });
  assert.deepEqual(parseCommand("price 1,200"), { kind: "price", amount: 1200 });
  assert.equal(parseCommand("who").kind, "unknown");
  assert.equal(parseCommand("sold").kind, "unknown");
  assert.equal(parseCommand("issue 1-5 to").kind, "unknown");
});

// ── the ledger ───────────────────────────────────────────────────────────────

test("a ledger from first ticket to last baht", async () => {
  const { env, said } = await setup();
  assert.equal(await ask(env, said, BEER, "issue 1-20 to Beer"), "Issued 1-20 to Beer (20).");
  assert.equal(await ask(env, said, NAN, "issue 100-105 to Nan"), "Issued 100-105 to Nan (6).");

  // conflicts name the first ball and change nothing
  assert.equal(await ask(env, said, NAN, "issue 15-25 to Nan"), "Ball 15 is already with Beer (+5 more). Nothing recorded.");
  assert.equal(rows(env, "SELECT * FROM gbd_tickets WHERE n >= 21 AND n < 100").length, 0);
  assert.equal(await ask(env, said, NAN, "issue 101 to Nan"), "Ball 101 is already with Nan. Nothing recorded.");

  // bounds
  assert.equal(await ask(env, said, NAN, "issue 301 to Nan"), "Ball 301 is outside 1-300.");
  assert.equal(await ask(env, said, NAN, "issue 0 to Nan"), "Ball 0 is outside 1-300.");
  assert.equal(await ask(env, said, NAN, "issue 290-310 to Nan"), "Ball 310 is outside 1-300.");
  assert.equal(await ask(env, said, NAN, "issue 20-1 to Nan"), "20-1 runs backwards.");

  // sold
  assert.equal(await ask(env, said, BEER, "sold 5 Somchai"), "Sold 5 to Somchai.");
  assert.equal(await ask(env, said, BEER, "sold 5"), "Ball 5 is already sold to Somchai. Nothing recorded.");
  assert.equal(await ask(env, said, BEER, "sold 30"), "Ball 30 is not issued. Nothing recorded.");
  assert.equal(await ask(env, said, BEER, "sold 1-3"), "Sold 1-3.");
  assert.equal(await ask(env, said, BEER, "sold 3-6"), "Ball 3 is already sold (+1 more). Nothing recorded.");

  // paid: default price, a given total, a total that does not divide, sold implied
  assert.equal(await ask(env, said, TREAS, "paid 1-3"), "Paid 1-3: 3,000 baht.");
  assert.equal(await ask(env, said, TREAS, "paid 4 500"), "Paid 4: 500 baht. 1 also marked sold.");
  assert.equal(await ask(env, said, TREAS, "paid 6,7,8 1000"), "Paid 6-8: 1,000 baht. 3 also marked sold.");
  assert.equal(await ask(env, said, TREAS, "paid 6"), "Ball 6 is already paid. Nothing recorded.");
  assert.equal(await ask(env, said, TREAS, "paid 150"), "Ball 150 is not issued. Nothing recorded.");
  assert.equal(await ask(env, said, TREAS, "paid 9 0"), "The amount is not a usable number of baht. Nothing recorded.");
  assert.deepEqual(rows(env, "SELECT n, paid_amount FROM gbd_tickets WHERE n IN (6,7,8) ORDER BY n").map((r) => r.paid_amount), [334, 333, 333]);

  // price
  assert.equal(await ask(env, said, NAN, "price"), "Price 1,000 baht a ball.");
  assert.equal(await ask(env, said, NAN, "price 1500"), "Price 1,500 baht a ball.");
  assert.equal(await ask(env, said, TREAS, "paid 9"), "Paid 9: 1,500 baht. 1 also marked sold.");
  assert.equal(await ask(env, said, NAN, "price 0"), "The price is not a usable number of baht. Nothing recorded.");

  // back: unsold only
  assert.equal(await ask(env, said, BEER, "back 5"), "Ball 5 is sold and cannot go back. Nothing recorded.");
  assert.equal(await ask(env, said, BEER, "back 4"), "Ball 4 is paid and cannot go back. Nothing recorded.");
  assert.equal(await ask(env, said, BEER, "back 99"), "Ball 99 is not issued. Nothing recorded.");
  assert.equal(await ask(env, said, BEER, "back 15-20"), "Back 15-20 from Beer; unissued again.");
  assert.equal(await ask(env, said, BEER, "back 15"), "Ball 15 is not issued. Nothing recorded.");
  assert.equal(await ask(env, said, BEER, "issue 15 to Mali"), "Issued 15 to Mali (1).");

  // who
  assert.equal(await ask(env, said, BEER, "who 5"), "5 is with Beer. Sold to Somchai. Not paid.");
  assert.equal(await ask(env, said, BEER, "who 4"), "4 is with Beer. Sold. Paid 500 baht.");
  assert.equal(await ask(env, said, BEER, "who 12"), "12 is with Beer. Not sold. Not paid.");
  assert.equal(await ask(env, said, BEER, "who 16"), "16 is unissued.");
  assert.equal(await ask(env, said, BEER, "who 301"), "Ball 301 is outside 1-300.");
  assert.equal(await ask(env, said, BEER, "who 1-20"), "who takes up to 10 balls.");

  // status: 14 + 1 with Beer/Mali... Beer holds 1-14, Mali 15, Nan 100-105
  const st = (await ask(env, said, BEER, "status")).split("\n");
  assert.equal(st[0], "Issued 21 · sold 9 · paid 8 · unissued 279 · baht in 6,000");
  assert.deepEqual(st.slice(1), ["Beer: 14 issued, 9 sold, 8 paid", "Mali: 1 issued, 0 sold, 0 paid", "Nan: 6 issued, 0 sold, 0 paid"]);
});

test("a holder typed in another case is the same holder in status", async () => {
  const { env, said } = await setup();
  await ask(env, said, BEER, "issue 1-2 to Beer");
  await ask(env, said, BEER, "issue 3-4 to beer");
  const st = (await ask(env, said, BEER, "status")).split("\n");
  assert.equal(st.length, 2);
  assert.match(st[1], /^Beer: 4 issued/);
});

test("a long list of holders gets a count, not a line each", async () => {
  const { env, said } = await setup();
  for (let i = 1; i <= 14; i++) await ask(env, said, NAN, `issue ${i} to Member${i}`);
  const st = (await ask(env, said, NAN, "status")).split("\n");
  assert.deepEqual(st, ["Issued 14 · sold 0 · paid 0 · unissued 286 · baht in 0", "14 members hold balls."]);
});

test("who sent each command, and when, is on the ticket and in the log", async () => {
  const { env, said } = await setup();
  const t0 = Date.now();
  await ask(env, said, BEER, "issue 1-3 to Beer");
  await ask(env, said, NAN, "sold 2 Somchai");
  await ask(env, said, TREAS, "paid 2");
  await ask(env, said, TREAS, "paid 2");
  const t = rows(env, "SELECT * FROM gbd_tickets WHERE n = 2")[0];
  assert.equal(t.issued_by, "Beer");
  assert.equal(t.sold_by, "Nan");
  assert.equal(t.paid_by, "Treasurer Tom");
  assert.ok(t.issued_at >= t0 && t.sold_at >= t.issued_at && t.paid_at >= t.sold_at);
  const log = rows(env, "SELECT * FROM gbd_log ORDER BY id");
  assert.deepEqual(log.map((l) => [l.user_name, l.user_id, l.cmd]), [
    ["Beer", BEER, "issue"], ["Nan", NAN, "sold"], ["Treasurer Tom", TREAS, "paid"], ["Treasurer Tom", TREAS, "paid"]]);
  assert.equal(log[0].text, "issue 1-3 to Beer");
  assert.equal(log[0].result, "Issued 1-3 to Beer (3).");
  assert.equal(log[3].result, "Ball 2 is already paid. Nothing recorded.", "a refused command is logged with its answer");
});

test("a webhook delivered twice is applied once", async () => {
  const { env, said } = await setup();
  const e = ev.text(GBD, BEER, "@nanobotco issue 1-3 to Beer");
  await deliver(worker, env, [e]);
  await deliver(worker, env, [{ ...e, replyToken: "retry-token" }]);
  assert.equal(said.replies.length, 1);
  assert.equal(rows(env, "SELECT * FROM gbd_tickets").length, 3);
  assert.equal(rows(env, "SELECT * FROM gbd_log").length, 1);
});

test("the ledger is per room", async () => {
  const { env, said } = await setup();
  await ask(env, said, BEER, "issue 1-3 to Beer");
  assert.equal(rows(env, "SELECT DISTINCT group_id FROM gbd_tickets")[0].group_id, GBD);
});

// ── the desk: nothing from the room reaches the pull ─────────────────────────

test("the room's text, photos and files stay out of the desk pull, the photo door and R2", async () => {
  const { env, said, calls } = await setup();
  await deliver(worker, env, [ev.text(OPS, BEER, "ops line")]);
  await deliver(worker, env, [
    ev.text(GBD, BEER, "chatter about the picnic"),
    ev.text(GBD, BEER, "bug the map"),
    ev.text(GBD, BEER, "ตลาดวโรรส"),
    ev.image(GBD, BEER),
    ev.audio(GBD, BEER),
    { ...ev.image(GBD, BEER), message: { id: "mf1", type: "file", fileName: "ticket.jpg" } },
    ev.location(GBD, BEER, 18.79, 98.98),
    ev.text(GBD, BEER, "@nanobotco issue 1-10 to Beer"),
    ev.text(GBD, BEER, "@nanobotco sold 2 Somchai"),
    ev.text(GBD, BEER, "@nanobotco paid 2"),
    ev.text(GBD, BEER, "@nanobotco status"),
    ev.text(GBD, BEER, "status"),
  ]);
  assert.ok(said.replies.length >= 5);
  // events holds the ops room's one line and nothing from the club's room
  assert.equal(rows(env, "SELECT * FROM events WHERE group_id = ?", GBD).length, 0);
  assert.equal(rows(env, "SELECT * FROM events WHERE channel != 'ops'").length, 0);
  const pulled = await desk(env, "/desk/pull");
  assert.deepEqual(pulled.rows.map((r) => r.text), ["ops line"]);
  assert.ok(pulled.rows.every((r) => r.group_id === OPS));
  // no bytes were fetched from LINE and none written to R2
  assert.equal(calls.some((c) => c.url.includes("/content")), false);
  assert.deepEqual([...env.INBOX.store.keys()], []);
  // the ledger commands are in gbd_log, which no desk path other than the ledger reads
  assert.equal(rows(env, "SELECT * FROM gbd_log").length, 3);
  const paths = ["/desk/state", "/desk/groups", "/desk/pull?limit=500"];
  for (const p of paths) {
    const body = JSON.stringify(await desk(env, p));
    assert.equal(body.includes("Somchai"), false, p);
    assert.equal(body.includes("picnic"), false, p);
  }
  assert.equal((await desk(env, "/desk/photo?key=photos/x", {}, true)).status, 404);
});

test("the nightly summary and the morning agenda do not reach the room", async () => {
  const { env, said, calls } = await setup({ speak: "on" });
  env.AGENDA = "on";
  await deliver(worker, env, [ev.text(OPS, BEER, "bug the toilets page shows 0")]);
  calls.length = 0;
  const w = [];
  for (const cron of ["0 13 * * *", "0 0 * * *"]) {
    await worker.scheduled({ cron }, env, { waitUntil: (p) => w.push(p) });
  }
  await Promise.all(w);
  const sentTo = calls.filter((c) => c.url.endsWith("/message/push")).map((c) => c.body.to);
  assert.ok(sentTo.length >= 1 && sentTo.every((to) => to === OPS), "the nightly line went to the ops room only");
});

test("the ledger as TSV: bearer only, 300 balls, who and when", async () => {
  const { env, said } = await setup();
  const no = await worker.fetch(new Request("https://line.motdang.net/desk/gbd/ledger"), env, { waitUntil() {} });
  assert.equal(no.status, 401);
  await ask(env, said, BEER, "issue 1-3 to Beer");
  await ask(env, said, BEER, "sold 2 Somchai");
  await ask(env, said, TREAS, "paid 2 900");
  const r = await desk(env, "/desk/gbd/ledger", {}, true);
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-type"), /tab-separated/);
  const text = await r.text();
  assert.ok(text.endsWith("\n"));
  const lines = text.slice(0, -1).split("\n");
  assert.equal(lines.length, 301);
  assert.equal(lines[0], "ball\tstate\tholder\tbuyer\tpaid_baht\tissued_by\tissued_at\tsold_by\tsold_at\tpaid_by\tpaid_at");
  assert.ok(lines.every((l) => l.split("\t").length === 11));
  const f = (n) => lines[n].split("\t");
  assert.deepEqual(f(1).slice(0, 6), ["1", "issued", "Beer", "", "", "Beer"]);
  assert.deepEqual(f(2).slice(0, 6), ["2", "paid", "Beer", "Somchai", "900", "Beer"]);
  assert.match(f(2)[6], /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\+07:00$/);
  assert.equal(f(2)[9], "Treasurer Tom");
  assert.deepEqual(f(4).slice(0, 3), ["4", "unissued", ""]);
  assert.equal((await desk(env, "/desk/gbd/ledger?group=Cnone", {}, true)).status, 200, "an unknown room is an empty ledger");
});

test("no gbd room, no ledger", async () => {
  const env = makeEnv([]);
  assert.equal((await desk(env, "/desk/gbd/ledger", {}, true)).status, 404);
});

// ── the dated posts ──────────────────────────────────────────────────────────

const at = (iso) => Date.parse(iso);

test("six posts, on their dates, in Bangkok time", () => {
  assert.deepEqual(SOP.map((p) => p.date), ["2026-10-25", "2026-11-01", "2026-12-01", "2027-01-10", "2027-01-23", "2027-02-16"]);
  assert.match(SOP[0].text, /1 Nov/);
  assert.match(SOP[2].text, /golf ball sellers.*balloon ride sellers.*balloon area posts and tape.*parking monitor/);
  assert.ok(SOP.every((p) => p.text.split("\n").length <= 2));
  assert.equal(GBD_CRON, "0 2 * * *", "02:00 UTC is 09:00 in Bangkok");
});

test("GBD_POSTS gates pushGbd by itself: SPEAK does not open it, push() stays shut", async () => {
  const calls = [];
  globalThis.fetch = async (url) => { calls.push(String(url)); return new Response("{}", { status: 200 }); };
  for (const flag of [undefined, "off", "", "no", "true", "yes"]) {
    const e = { LINE_CHANNEL_TOKEN: "t", SPEAK: "on" };
    if (flag !== undefined) e.GBD_POSTS = flag;
    assert.equal(await pushGbd(e, "Cgolfballdrop", "x"), false, `spoke under GBD_POSTS=${flag}`);
  }
  assert.equal(calls.length, 0);
  assert.equal(await pushGbd({ LINE_CHANNEL_TOKEN: "t", SPEAK: "off", GBD_POSTS: "on" }, "Cgolfballdrop", "x"), true);
  assert.equal(calls.length, 1);
  await push({ LINE_CHANNEL_TOKEN: "t", SPEAK: "off", GBD_POSTS: "on" }, "Cgolfballdrop", "x");
  assert.equal(calls.length, 1, "push() ignores GBD_POSTS");
});

test("a post goes to the gbd room only, once, from 09:00, with the counts", async () => {
  const { env, said, calls } = await setup({ posts: "on" });
  await deliver(worker, env, [ev.join(BOTS)]);
  await ask(env, said, BEER, "issue 1-20 to Beer");
  await ask(env, said, TREAS, "paid 1-4 3600");
  said.replies.length = 0;
  calls.length = 0;
  const pushes = () => calls.filter((c) => c.url.endsWith("/message/push"));

  // 08:59 in Bangkok: not yet
  let r = await runGbdPosts(env, { now: at("2026-11-01T01:59:00Z") });
  assert.deepEqual(r.results, []);
  // a day with no post
  r = await runGbdPosts(env, { now: at("2026-11-02T03:00:00Z") });
  assert.deepEqual(r.results, []);
  assert.equal(pushes().length, 0);

  // 09:00
  r = await runGbdPosts(env, { now: at("2026-11-01T02:00:00Z") });
  assert.equal(r.results.length, 1);
  assert.equal(pushes().length, 1);
  assert.equal(pushes()[0].body.to, GBD);
  assert.equal(pushes()[0].body.messages[0].text,
    "Ticket handout starts today. To record numbers taken: @nanobotco issue 1-20 to <name>\nIssued 20 · sold 4 · paid 4 · unissued 280 · baht in 3,600");
  // the hourly retry does not repeat it
  await runGbdPosts(env, { now: at("2026-11-01T03:30:00Z") });
  assert.equal(pushes().length, 1);
  assert.deepEqual(rows(env, "SELECT group_id, key FROM gbd_posts").map((r) => [r.group_id, r.key]), [[GBD, "2026-11-01"]]);
  assert.deepEqual(said.replies, []);
});

test("every date posts its own line", async () => {
  const { env, calls } = await setup({ posts: "on" });
  for (const p of SOP) {
    calls.length = 0;
    await runGbdPosts(env, { now: at(p.date + "T02:00:00Z") });
    const sent = calls.filter((c) => c.url.endsWith("/message/push"));
    assert.equal(sent.length, 1, p.date);
    assert.ok(sent[0].body.messages[0].text.startsWith(p.text + "\n"), p.date);
  }
  assert.equal(rows(env, "SELECT * FROM gbd_posts").length, 6);
});

test("a failed push is tried again the same day by the hourly cron, and only then", async () => {
  const { env, said } = await setup({ posts: "on" });
  const inner = globalThis.fetch;
  let fail = true;
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith("/message/push") && fail) return new Response("busy", { status: 500 });
    return inner(url, init);
  };
  const realNow = Date.now;
  try {
    Date.now = () => at("2026-12-01T02:00:00Z");
    const w0 = [];
    await worker.scheduled({ cron: GBD_CRON }, env, { waitUntil: (p) => w0.push(p) });
    await Promise.all(w0);
    assert.deepEqual(said.pushes, []);
    assert.equal(rows(env, "SELECT * FROM gbd_posts").length, 0);
    fail = false;
    Date.now = () => at("2026-12-01T03:30:00Z");
    const w = [];
    await worker.scheduled({ cron: ALERT_CRON }, env, { waitUntil: (p) => w.push(p) });
    await Promise.all(w);
    assert.equal(said.pushes.length, 1);
    assert.match(said.pushes[0], /^Volunteer roles to confirm/);
    Date.now = () => at("2026-12-02T03:30:00Z");
    await worker.scheduled({ cron: ALERT_CRON }, env, { waitUntil: (p) => w.push(p) });
    await Promise.all(w);
    assert.equal(said.pushes.length, 1, "the next day does not send it again");
  } finally {
    Date.now = realNow;
  }
});

test("GBD_POSTS off: no push goes out and no post is marked sent", async () => {
  const { env, calls } = await setup({ posts: "off" });
  const r = await runGbdPosts(env, { now: at("2026-11-01T02:00:00Z") });
  assert.deepEqual(r.results, []);
  assert.equal(calls.filter((c) => c.url.endsWith("/message/push")).length, 0);
  assert.equal(rows(env, "SELECT * FROM gbd_posts").length, 0);
});

test("the desk shows what a day's post would say and sends nothing", async () => {
  const { env, calls } = await setup({ posts: "on" });
  const out = await desk(env, "/desk/gbd/posts?date=2027-01-23");
  assert.equal(out.ok, true);
  assert.equal(out.armed, true);
  assert.equal(out.results.length, 1);
  assert.match(out.results[0].text, /^One week to the drop, Sat 30 Jan\.\nIssued 0/);
  assert.equal(out.results[0].group, GBD);
  assert.equal((await desk(env, "/desk/gbd/posts?date=2027-01-24")).results.length, 0);
  assert.equal((await desk(env, "/desk/gbd/posts?date=soon", {}, true)).status, 400);
  assert.equal(calls.filter((c) => c.url.endsWith("/message/push")).length, 0);
  assert.equal(rows(env, "SELECT * FROM gbd_posts").length, 0);
});

test("a room that is not gbd gets no post", async () => {
  const { env, calls } = await setup({ posts: "on" });
  await desk(env, "/desk/groups/" + GBD, { method: "POST", body: JSON.stringify({ mode: "muted" }) });
  await runGbdPosts(env, { now: at("2026-11-01T02:00:00Z") });
  assert.equal(calls.filter((c) => c.url.endsWith("/message/push")).length, 0);
});
