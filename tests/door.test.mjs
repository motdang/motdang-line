// The LINE door — the reasons to add Mot Dang on LINE, each behind its own var:
// PINS, ASK, ALERTS, STAMPS, OWNERS, SPOTTERS, SAFE. Nan, 2026-09-28: "let's do
// all of those, and also mae hong son passport".
//
// Run the way it deploys: SPEAK unset, so the team room's mute is on. The
// site, mot-dang-claims and LINE are stubbed; nothing leaves the machine.
import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/worker.js";
import { ROUNDS } from "../src/stamps.js";
import { ALERT_CRON, findAlerts } from "../src/alerts.js";
import { parseMapLink } from "../src/pins.js";
import { isQuestion } from "../src/ask.js";
import { sha256hex } from "../src/dm.js";
import { makeEnv, stubLine, deliver, ev } from "./harness.mjs";

const ME = "Unan";
const GROUP = "Cteam";
const TPG = [18.7877, 98.9933]; // Tha Phae Gate

let seq = 0;
const base = (type, extra, uid = ME) => ({ type, timestamp: Date.now(), source: { type: "user", userId: uid }, replyToken: "dr" + ++seq, ...extra });
const dm = {
  follow: (uid) => base("follow", {}, uid),
  text: (text, uid) => base("message", { message: { id: "t" + ++seq, type: "text", text } }, uid),
  image: (uid) => base("message", { message: { id: "i" + ++seq, type: "image" } }, uid),
  location: (lat, lng, uid) => base("message", { message: { id: "l" + ++seq, type: "location", latitude: lat, longitude: lng } }, uid),
  postback: (data, uid) => base("postback", { postback: { data } }, uid),
};

// A JPEG the photo check accepts: SOI, a JFIF header, a scan, EOI.
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0,
  0xff, 0xda, 0, 8, 1, 1, 0, 0, 0x3f, 0, 0x12, 0x34, 0xff, 0xd9]);

function room(flags = [], { name = "Nan" } = {}) {
  const env = makeEnv(null);
  delete env.SPEAK;
  for (const f of flags) env[f] = "on";
  env.CLAIMS_BASE = "https://claims.test";
  env.RELAY_SECRET = "relay-secret";
  env._vision = { people: false, children: false, nudity: false, sexual: false, text_or_qr: false, what: "shopfront" };
  env._ping = { stations: [] };
  env._air = { places: [] };
  env.AI = {
    run: async (model, input) => {
      if (model.includes("llama-guard")) return { response: "safe" };
      const q = input.messages[0].content[0].text;
      return { response: q.startsWith("How many") ? "0" : JSON.stringify(env._vision) };
    },
  };
  const said = stubLine({ imageBytes: JPEG });
  said.raw = [];
  const calls = { claims: [], search: [] };
  const line = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    const J = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
    if (u.includes("/v2/bot/profile/")) return J({ displayName: name });
    if (u.endsWith("/message/reply")) said.raw.push(JSON.parse(init.body).messages);
    if (u.startsWith("https://claims.test/")) {
      calls.claims.push({ path: new URL(u).pathname, headers: init.headers, body: JSON.parse(init.body) });
      return J({ ok: true, via: "line" }, env._claims || 200);
    }
    if (u.startsWith("https://motdang.net/api/v1/search")) {
      const sp = new URL(u).searchParams;
      calls.search.push(decodeURIComponent(sp.toString()));
      const [lat, lng] = sp.get("near").split(",").map(Number);
      const kind = sp.get("sub") || sp.get("facet") || sp.get("tag");
      // Three results, the API's order not the nearest-first order.
      return J({ results: [0.012, 0.004, 0.02].map((d, i) => ({
        name: `${kind} <b>${i}</b>`, url: `https://motdang.net/cm/p/${kind}-${i}.html`, lat: lat + d, lng,
      })) });
    }
    if (u === "https://motdang.net/data/codes/4.json") return J({ "4F2K9": "cm/fubar-shop-123" });
    if (u.startsWith("https://motdang.net/data/codes/")) return new Response("<!doctype html>", { status: 200, headers: { "content-type": "text/html" } });
    if (u === "https://motdang.net/data/ping.json") return J(env._ping);
    if (u === "https://motdang.net/data/air.json") return J(env._air);
    return line(url, init);
  };
  return { env, said, calls };
}

const rows = (env, sql, ...a) => env._db.prepare(sql).all(...a);
const one = (env, sql, ...a) => env._db.prepare(sql).get(...a);
const get = (env, path, headers = {}) => worker.fetch(new Request("https://line.motdang.net" + path, { headers }), env, { waitUntil: () => {} });
const post = (env, path, body, headers = {}) => worker.fetch(new Request("https://line.motdang.net" + path, {
  method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }), env, { waitUntil: () => {} });
const DESK = { authorization: "Bearer test-pull" };
const lastText = (said) => said.replies.at(-1) || "";
const quickOf = (said) => said.raw.at(-1)[0].quickReply?.items.map((i) => i.action) || [];

// ── flags ────────────────────────────────────────────────────────────────────

test("each feature answers on its own flag, and makes no page by itself", async () => {
  const { env, said } = room(["SAFE"]);
  await deliver(worker, env, [dm.follow(), dm.text("hello"), dm.text("ปลอดภัย · safe")]);
  assert.equal(said.replies.length, 1, "follow and a plain line go to the OA's own replies; the command is answered");
  assert.match(lastText(said), /Marked safe/);
  assert.equal(one(env, "SELECT slug FROM dm_users").slug, null);
  assert.equal(rows(env, "SELECT * FROM page_items").length, 0);
});

test("a command whose flag is off is an ordinary line", async () => {
  const { env, said } = room(["PAGES"]);
  await deliver(worker, env, [dm.text("ปลอดภัย · safe"), dm.text("บ้าน · home"), dm.text("พาสปอร์ต · passport mhs")]);
  assert.equal(rows(env, "SELECT * FROM page_items WHERE kind = 'text'").length, 3, "posted to the page");
  assert.ok(said.replies.every((r) => /รับแล้ว/.test(r)));
});

test("/health lists every flag", async () => {
  const { env } = room(["ASK"]);
  const h = await (await get(env, "/health")).json();
  assert.deepEqual(h.flags, { pages: false, pins: false, ask: true, alerts: false, stamps: false, owners: false, spotters: false, safe: false });
});

test("with every flag on, the team room is as quiet as before", async () => {
  const { env, said } = room(["PAGES", "PINS", "ASK", "ALERTS", "STAMPS", "OWNERS", "SPOTTERS", "SAFE"]);
  await deliver(worker, env, [ev.join(GROUP), ev.text(GROUP, "Ubeer", "ปลอดภัย · safe"), ev.text(GROUP, "Ubeer", "where is it?"),
    ev.location(GROUP, "Ubeer", ...TPG), ev.text(GROUP, "Ubeer", "เจ้าของ · owner MD-4F2K9")]);
  assert.deepEqual(said.replies, []);
  assert.equal(rows(env, "SELECT * FROM dm_users").length, 0);
  assert.equal(rows(env, "SELECT * FROM events WHERE kind = 'location'").length, 1, "the room still keeps its pins");
});

// ── pins ─────────────────────────────────────────────────────────────────────

const MAP = "https://motdang.net/map.html#15/18.78770/98.99330/all/q=" + encodeURIComponent("ข้าวซอย") +
  "&pins=" + encodeURIComponent("18.78770,98.99330,ร้านป้า;18.79000,98.98000,Wat <b>X</b>");

test("parseMapLink keeps what the map wrote and rebuilds the address", () => {
  const got = parseMapLink(MAP);
  assert.equal(got.pins.length, 2);
  assert.equal(got.q, "ข้าวซอย");
  assert.equal(got.pins[1].n, "Wat b X /b", "angle brackets do not survive");
  assert.ok(got.url.startsWith("https://motdang.net/map.html#15/18.78770/98.99330/all/q="));
  for (const bad of ["javascript:alert(1)", "https://evil.example/map.html#pins=1,2", "http://motdang.net/map.html#pins=1,2",
    "https://motdang.net/map.html", "https://motdang.net/map.html#pins=999,999", "https://motdang.net/x\"onload=.html#pins=1,2"]) {
    assert.equal(parseMapLink(bad), null, bad);
  }
});

test("“หมุด · pins <url>” keeps the set; “pins” lists; the page shows it", async () => {
  const { env, said } = room(["PAGES", "PINS"]);
  await deliver(worker, env, [dm.follow(), dm.text("หมุด · pins " + MAP)]);
  assert.match(lastText(said), /Saved: ข้าวซอย — 2 หมุด · 2 pins/);
  assert.ok(lastText(said).includes("https://motdang.net/map.html#15/"));
  await deliver(worker, env, [dm.text("pins")]);
  assert.match(lastText(said), /ข้าวซอย \(2\)/);
  const slug = one(env, "SELECT slug FROM dm_users").slug;
  const html = await (await get(env, "/u/" + slug)).text();
  assert.match(html, /Pins and plans/);
  assert.ok(html.includes("ข้าวซอย") && !html.includes("<b>X"));
});

test("a plan link is kept the same way", async () => {
  const { env, said } = room(["PINS"]);
  await deliver(worker, env, [dm.text("แผน · plan https://motdang.net/plan.html#plan=cm:wat-phan-tao,cm:wat-duang-di")]);
  assert.match(lastText(said), /Saved/);
  assert.equal(one(env, "SELECT kind FROM pin_sets").kind, "plan");
  await deliver(worker, env, [dm.text("หมุด · pins https://evil.example/#pins=1,2")]);
  assert.match(lastText(said), /could not be read/);
});

// ── ask the ant ──────────────────────────────────────────────────────────────

test("a shared location gets the nearest of each kind, straight-line, with buttons to switch", async () => {
  const { env, said, calls } = room(["ASK", "PAGES"]);
  await deliver(worker, env, [dm.location(...TPG)]);
  const t = lastText(said);
  assert.match(t, /ระยะตรง · straight-line/);
  for (const k of ["Pharmacy", "Fuel", "Toilet", "Hospital", "7-Eleven"]) assert.ok(t.includes(k), k);
  assert.match(t, /pharmacy <b>1<\/b> — 440 ม\. · m/, "the nearest of the three, measured here");
  assert.equal(calls.search.length, 5);
  assert.ok(calls.search.every((q) => /radius=3000/.test(q) && /near=18\.78770,98\.99330/.test(q)));
  const buttons = quickOf(said).map((a) => a.data || a.type);
  assert.ok(buttons.includes("a=near&k=fuel") && buttons.includes("a=pin") && buttons.includes("location"));
  assert.equal(rows(env, "SELECT * FROM page_items").length, 0, "asking what is near is not a pin on the page");
  await deliver(worker, env, [dm.postback("a=pin")]);
  assert.equal(rows(env, "SELECT * FROM page_items WHERE kind = 'location'").length, 1);
});

test("a kind button lists three of that kind", async () => {
  const { env, said } = room(["ASK"]);
  await deliver(worker, env, [dm.location(...TPG), dm.postback("a=near&k=seven")]);
  assert.equal((lastText(said).match(/https:\/\/motdang\.net\/cm\/p\//g) || []).length, 3);
  assert.match(lastText(said), /7-Eleven — ระยะตรง/);
});

test("a question gets a search link and is not posted", async () => {
  const { env, said } = room(["ASK", "PAGES"]);
  await deliver(worker, env, [dm.text("ร้านข้าวซอยอร่อยอยู่ที่ไหน")]);
  assert.match(lastText(said), /search\.html\?q=/);
  assert.equal(rows(env, "SELECT * FROM page_items").length, 0);
  assert.ok(isQuestion("where can I buy a SIM?") && isQuestion("เปิดกี่โมงคะ") && !isQuestion("ข้าวซอยอร่อยมาก"));
});

test("Near me without a recent location asks for one, then answers", async () => {
  const { env, said } = room(["ASK"]);
  await deliver(worker, env, [dm.postback("a=near")]);
  assert.equal(quickOf(said)[0].type, "location");
  await deliver(worker, env, [dm.location(...TPG)]);
  assert.match(lastText(said), /Nearest to you/);
});

// ── alerts ───────────────────────────────────────────────────────────────────

const P1 = { id: "P.1", th: "สะพานนวรัฐ", en: "Nawarat Bridge", level: 3.9, limit: 3.7, observed: "2026-09-28T14:00" };

test("“บ้าน · home” asks for a location, then keeps it to about 100 m", async () => {
  const { env, said } = room(["ALERTS"]);
  await deliver(worker, env, [dm.text("บ้าน · home")]);
  assert.equal(quickOf(said)[0].type, "location");
  await deliver(worker, env, [dm.location(18.787654, 98.993321)]);
  assert.deepEqual({ ...one(env, "SELECT lat, lng FROM alert_places") }, { lat: 18.788, lng: 98.993 });
  await deliver(worker, env, [dm.text("หยุดเตือน · stop alerts")]);
  assert.equal(rows(env, "SELECT * FROM alert_places").length, 0);
});

test("findAlerts: a gauge within 15 km at its limit, dust over 75 in the nearest city", () => {
  const place = { lat: 18.79, lng: 98.99 };
  const far = { lat: 19.9, lng: 99.8 };
  const ping = { stations: [P1, { ...P1, id: "P.20", level: 1.0, limit: 2.8 }] };
  const air = { places: [{ id: "chiang-mai", th: "เชียงใหม่", en: "Chiang Mai", lat: 18.7883, lng: 98.9853, pm25: 82 }] };
  assert.deepEqual(findAlerts(place, ping, air).map((a) => a.kind), ["flood", "dust"]);
  assert.deepEqual(findAlerts(far, ping, air), []);
  assert.deepEqual(findAlerts(place, { stations: [{ ...P1, level: 3.6 }] }, { places: [{ ...air.places[0], pm25: 75 }] }), []);
});

test("the hourly run pushes once per kind per 12 h, logs every push, and holds at the cap", async () => {
  const { env, said } = room(["ALERTS"]);
  env._ping = { stations: [P1] };
  env.ALERT_CAP = "1";
  await deliver(worker, env, [dm.location(18.79, 98.99), dm.text("บ้าน"), dm.location(18.79, 98.99, "Uother"), dm.text("home", "Uother")]);
  const run = async () => { const w = []; await worker.scheduled({ cron: ALERT_CRON }, env, { waitUntil: (p) => w.push(p) }); await Promise.all(w); };
  await run();
  assert.equal(said.pushes.length, 1);
  assert.match(said.pushes[0], /Nawarat Bridge \(P\.1\) is at 3\.90 m/);
  assert.deepEqual(rows(env, "SELECT status FROM alert_log ORDER BY id").map((r) => r.status).sort(), ["capped", "sent"]);
  await run();
  assert.equal(said.pushes.length, 1, "twelve hours between alerts of a kind");
  assert.equal(rows(env, "SELECT * FROM alert_log").length, 2);
});

test("ALERTS off: the run pushes nothing, and the nightly cron still reaches only the room's summary", async () => {
  const { env, said } = room(["PAGES"]);
  env._ping = { stations: [P1] };
  env._db.prepare("INSERT INTO alert_places (user_id, lat, lng, created_at) VALUES ('Ux', 18.79, 98.99, 0)").run();
  const w = [];
  await worker.scheduled({ cron: ALERT_CRON }, env, { waitUntil: (p) => w.push(p) });
  assert.deepEqual(await Promise.all(w), [{ why: "ALERTS not on" }]);
  await worker.scheduled({ cron: "0 13 * * *" }, env, { waitUntil: (p) => w.push(p) });
  await Promise.all(w);
  assert.deepEqual(said.pushes, []);
});

// ── stamps ───────────────────────────────────────────────────────────────────

test("the round files match their sources", () => {
  assert.deepEqual(ROUNDS.mhs.stops.map((s) => s.id), ["chiang-mai", "pai", "soppong", "mae-hong-son", "khun-yuam", "mae-sariang", "hot"]);
  assert.equal(ROUNDS.mhs.need, 7);
  assert.equal(ROUNDS.wats.need, 9);
  assert.ok(ROUNDS.wats.stops.length >= 9 && ROUNDS.wats.stops.every((s) => s.radius_m === 150));
  assert.ok(ROUNDS.mhs.source && ROUNDS.wats.source);
});

test("“passport” offers the rounds; “passport mhs” lists the stops", async () => {
  const { env, said } = room(["STAMPS"]);
  await deliver(worker, env, [dm.text("พาสปอร์ต · passport")]);
  assert.deepEqual(quickOf(said).map((a) => a.text), ["พาสปอร์ต · passport mhs", "พาสปอร์ต · passport wats"]);
  await deliver(worker, env, [dm.text("พาสปอร์ต · passport mhs")]);
  assert.match(lastText(said), /1\. เชียงใหม่ · Chiang Mai[\s\S]*7\. ฮอด · Hot/);
  assert.match(lastText(said), /0 of 7/);
});

test("the Mae Hong Son loop: a stamp per town, once each, and a card at seven", async () => {
  const { env, said } = room(["STAMPS"]);
  await deliver(worker, env, [dm.text("passport mhs")]);
  const [cm, pai] = ROUNDS.mhs.stops;
  await deliver(worker, env, [dm.location(pai.lat + 0.005, pai.lng)]);
  assert.match(lastText(said), /Stamped: ปาย · Pai[\s\S]*1 of 7/);
  said.replies.length = 0;
  await deliver(worker, env, [dm.location(pai.lat, pai.lng)]);
  assert.deepEqual(said.replies, [], "a stop stamps once; with only STAMPS on, nothing else answers");
  await deliver(worker, env, [dm.location(cm.lat + 0.02, cm.lng)]);
  assert.equal(rows(env, "SELECT * FROM stamps").length, 1, "2 km out of Chiang Mai is outside its 1,500 m");
  for (const s of ROUNDS.mhs.stops.filter((x) => x.id !== "pai")) await deliver(worker, env, [dm.location(s.lat, s.lng)]);
  assert.match(lastText(said), /7 of 7[\s\S]*Round complete/);
  const link = /https:\/\/line\.motdang\.net(\/u\/[a-z2-9]{10}\/card\/mhs)/.exec(lastText(said))[1];
  const card = await get(env, link);
  assert.equal(card.status, 200);
  const html = await card.text();
  assert.match(html, /<svg class="seal"/);
  assert.match(html, /Mae Hong Son Loop passport/);
  assert.ok(!/<script/i.test(html));
  assert.equal((await get(env, link.replace("mhs", "wats"))).status, 404, "an unfinished round has no card");
  assert.equal((await get(env, link.replace(/\/card\/mhs$/, ""))).status, 404, "the card does not open a page while PAGES is off");
  env.STAMPS = "off";
  assert.equal((await get(env, link)).status, 404);
});

test("nine wats: the nearest wat in range is the one stamped", async () => {
  const { env, said } = room(["STAMPS"]);
  await deliver(worker, env, [dm.text("passport wats")]);
  const w = ROUNDS.wats.stops;
  await deliver(worker, env, [dm.location(w[0].lat + 0.0002, w[0].lng)]);
  assert.equal(one(env, "SELECT stop FROM stamps").stop, w[0].id);
  const seen = new Set([w[0].id]);
  for (const s of w) {
    if (seen.size >= 9) break;
    if (seen.has(s.id)) continue;
    seen.add(s.id);
    await deliver(worker, env, [dm.location(s.lat, s.lng)]);
  }
  assert.equal(one(env, "SELECT COUNT(*) n FROM stamps").n, 9);
  assert.match(lastText(said), /9 of 9[\s\S]*card\/wats/);
});

// ── owners ───────────────────────────────────────────────────────────────────

test("a claim waits for a person; approved, what the owner sends goes to the place", async () => {
  const { env, said } = room(["PAGES", "OWNERS"]);
  await deliver(worker, env, [dm.text("เจ้าของ · owner MD-4F2K9")]);
  assert.match(lastText(said), /Claim on MD-4F2K9 received/);
  assert.equal(one(env, "SELECT status, place FROM owner_claims").place, "cm/fubar-shop-123");
  await deliver(worker, env, [dm.text("open 8 to 5")]);
  assert.equal(rows(env, "SELECT * FROM owner_edits").length, 0, "pending: posts still go to the page");
  assert.equal(rows(env, "SELECT * FROM page_items").length, 1);

  assert.equal((await get(env, "/desk/owners")).status, 401);
  const list = await (await get(env, "/desk/owners", DESK)).json();
  assert.equal(list.claims.length, 1);
  const ok = await (await post(env, `/desk/owners/${list.claims[0].id}`, { decision: "approve" }, DESK)).json();
  assert.equal(ok.status, "approved");

  await deliver(worker, env, [dm.text("เปิด 8 โมงถึง 5 โมงเย็น"), dm.image()]);
  assert.match(lastText(said), /owner edit/);
  const edits = rows(env, "SELECT kind, status, place FROM owner_edits ORDER BY id");
  assert.deepEqual(edits.map((e) => [e.kind, e.status]), [["text", "pending"], ["photo", "pending"]]);
  assert.equal(rows(env, "SELECT * FROM page_items").length, 1, "nothing more on the page");

  assert.equal((await get(env, "/owner-edits")).status, 401);
  const pulled = await (await get(env, "/owner-edits", DESK)).json();
  assert.equal(pulled.rows.length, 2);
  assert.equal(pulled.rows[0].code, "MD-4F2K9");
  assert.ok(pulled.rows[1].photo_key.startsWith("owners/cm/fubar-shop-123/"));
  await post(env, "/owner-edits/ack", { ids: pulled.rows.map((r) => r.id) }, DESK);
  assert.equal((await (await get(env, "/owner-edits", DESK)).json()).rows.length, 0);

  await deliver(worker, env, [dm.text("เจ้าของ ปิด"), dm.text("back on my page")]);
  assert.equal(rows(env, "SELECT * FROM page_items").length, 2);
});

test("owner off works as the bot prints it, and in each language alone", async () => {
  for (const off of ["เจ้าของ ปิด · owner off", "owner off", "เจ้าของ ปิด", "เจ้าของ · owner off", "Owner Off"]) {
    const { env, said } = room(["PAGES", "OWNERS"]);
    await deliver(worker, env, [dm.text("owner MD-4F2K9")]);
    const list = await (await get(env, "/desk/owners", DESK)).json();
    await post(env, `/desk/owners/${list.claims[0].id}`, { decision: "approve" }, DESK);
    await deliver(worker, env, [dm.text("owner MD-4F2K9")]);
    assert.match(lastText(said), /owner edit/, off);
    await deliver(worker, env, [dm.text(off)]);
    assert.match(lastText(said), /your own page again/, off);
    assert.equal(rows(env, "SELECT * FROM owner_claims").length, 1, `${off}: no new claim`);
    await deliver(worker, env, [dm.text("back on my page")]);
    assert.equal(rows(env, "SELECT * FROM owner_edits").length, 0, `${off}: posts go to the page`);
  }
});

test("an unknown code, or a codes file that is not JSON, names no place", async () => {
  const { env, said } = room(["OWNERS"]);
  await deliver(worker, env, [dm.text("owner MD-9ZZZZ"), dm.text("owner MD-4ZZZZ"), dm.text("owner hello")]);
  assert.match(said.replies[0], /No place has the code MD-9ZZZZ/);
  assert.match(said.replies[1], /No place has the code MD-4ZZZZ/);
  assert.match(said.replies[2], /Send the place code/);
  assert.equal(rows(env, "SELECT * FROM owner_claims").length, 0);
});

test("a refused claim sends posts back to the page", async () => {
  const { env } = room(["PAGES", "OWNERS"]);
  await deliver(worker, env, [dm.text("owner MD-4F2K9")]);
  const id = one(env, "SELECT id FROM owner_claims").id;
  await post(env, `/desk/owners/${id}`, { decision: "approve" }, DESK);
  await post(env, `/desk/owners/${id}`, { decision: "refuse" }, DESK);
  assert.equal(one(env, "SELECT owner_claim FROM dm_users").owner_claim, null);
  assert.equal((await post(env, `/desk/owners/${id}`, { decision: "maybe" }, DESK)).status, 400);
});

// ── spotters ─────────────────────────────────────────────────────────────────

test("a rain answer carries the relay headers, counts, and credits by choice", async () => {
  const { env, said, calls } = room(["SPOTTERS"]);
  await deliver(worker, env, [dm.location(...TPG), dm.postback("rain=light"), dm.postback("flood=ankle")]);
  const h = calls.claims[0].headers;
  assert.equal(h["x-md-relay"], "relay-secret");
  assert.equal(h["x-md-user"], (await sha256hex(ME)).slice(0, 16));
  assert.ok(!JSON.stringify(calls.claims).includes(ME), "the LINE id itself is not sent");
  assert.match(lastText(said), /Thanks — เดือนนี้ 2 ครั้ง · 2 reports this month/);

  assert.deepEqual((await (await get(env, "/spotters")).json()).spotters, []);
  await deliver(worker, env, [dm.text("ชื่อบนหน้าอากาศ · credit me")]);
  assert.deepEqual((await (await get(env, "/spotters")).json()).spotters, [{ name: "Nan", reports: 2 }]);
  await deliver(worker, env, [dm.text("credit off")]);
  assert.deepEqual((await (await get(env, "/spotters")).json()).spotters, []);
  env.SPOTTERS = "off";
  assert.equal((await get(env, "/spotters")).status, 404);
});

test("a display name that fails the screen stays off /spotters", async () => {
  const { env, said } = room(["SPOTTERS"], { name: "cheap loans www.example.com" });
  await deliver(worker, env, [dm.location(...TPG), dm.postback("rain=none"), dm.text("credit me")]);
  assert.match(lastText(said), /cannot go on the list/);
  assert.deepEqual((await (await get(env, "/spotters")).json()).spotters, []);
});

// ── safe ─────────────────────────────────────────────────────────────────────

test("“safe” gives a family link that shows the mark; the token is kept only as a hash", async () => {
  const { env, said } = room(["SAFE"]);
  await deliver(worker, env, [dm.text("ปลอดภัย · safe")]);
  const token = /\/safe\/([0-9a-f]{48})/.exec(lastText(said))[1];
  assert.equal(one(env, "SELECT token_hash FROM safe_links").token_hash, await sha256hex(token));
  assert.ok(!JSON.stringify(rows(env, "SELECT * FROM safe_links")).includes(token));
  const page = await get(env, "/safe/" + token);
  const html = await page.text();
  assert.equal(page.headers.get("cache-control"), "no-store");
  assert.match(html, /<h1>Nan<\/h1>/);
  assert.match(html, /ปลอดภัย/);
  assert.ok(!/Rough area/.test(html), "no location shared, no area");
  assert.equal((await get(env, "/safe/" + "0".repeat(48))).status, 404);
});

const tokenOf = (said) => /\/safe\/([0-9a-f]{48})/.exec(said.replies.findLast((r) => /\/safe\//.test(r)))[1];
const familyHtml = async (env, said) => (await get(env, "/safe/" + tokenOf(said))).text();

test("a location sent from the family button shows on the family page, exact, with its time and map links", async () => {
  const { env, said } = room(["SAFE"]);
  await deliver(worker, env, [dm.text("ปลอดภัย · safe")]);
  assert.match(lastText(said), /Share my location with family/);
  assert.deepEqual(quickOf(said).map((a) => [a.type, a.label]), [["location", "ให้ครอบครัว · Family"]]);
  await deliver(worker, env, [dm.location(18.787654, 98.993321)]);
  assert.match(lastText(said), /family link shows this location now[\s\S]*24 hours/);
  const html = await familyHtml(env, said);
  assert.match(html, /Location shared with family/);
  assert.match(html, /tile\.openstreetmap\.org/);
  assert.ok(html.includes("18.787654,98.993321"), "exact, as sent");
  for (const want of ["openstreetmap.org/?mlat=", "google.com/maps/search", "maps.apple.com", "geo:18.787654"]) assert.ok(html.includes(want), want);
});

test("locations sent for the nearest places, a stamp or home do not reach the family page", async () => {
  const { env, said } = room(["SAFE", "ASK", "STAMPS", "ALERTS"]);
  const pai = ROUNDS.mhs.stops[1];
  await deliver(worker, env, [dm.location(...TPG), dm.text("passport mhs"), dm.location(pai.lat, pai.lng),
    dm.text("home"), dm.location(18.8, 98.95), dm.text("safe")]);
  assert.ok(!/Location shared with family|tile\.openstreetmap|18\.7|19\.3/.test(await familyHtml(env, said)));
  // The family button is spent by anything sent after it.
  await deliver(worker, env, [dm.text("passport mhs"), dm.location(pai.lat, pai.lng)]);
  assert.ok(!/Location shared with family/.test(await familyHtml(env, said)), "a later ask came between");
});

test("the family button lapses after ten minutes", async () => {
  const { env, said } = room(["SAFE"]);
  await deliver(worker, env, [dm.text("safe")]);
  const late = dm.location(...TPG);
  late.timestamp = Date.now() + 11 * 60 * 1000;
  await deliver(worker, env, [late]);
  assert.ok(!/Location shared with family/.test(await familyHtml(env, said)));
});

test("“ลบตำแหน่ง · clear location”, a new “safe”, and 24 hours each take the location off", async () => {
  const { env, said } = room(["SAFE"]);
  const shared = async () => {
    await deliver(worker, env, [dm.text("safe"), dm.location(...TPG)]);
    assert.match(await familyHtml(env, said), /Location shared with family/);
  };
  await shared();
  await deliver(worker, env, [dm.text("ลบตำแหน่ง · clear location")]);
  assert.match(lastText(said), /no longer shows a location/);
  assert.ok(!/Location shared with family/.test(await familyHtml(env, said)));
  await shared();
  await deliver(worker, env, [dm.text("safe")]);
  assert.ok(!/Location shared with family/.test(await familyHtml(env, said)), "marked safe again");
  await shared();
  env._db.prepare("UPDATE dm_users SET family_at = ?").run(Date.now() - 25 * 3600 * 1000);
  assert.ok(!/Location shared with family/.test(await familyHtml(env, said)), "24 hours");
});

test("on need help the family location comes first on the page", async () => {
  const { env, said } = room(["SAFE"]);
  await deliver(worker, env, [dm.text("need help"), dm.location(...TPG)]);
  const html = await familyHtml(env, said);
  assert.ok(html.indexOf("Location shared with family") < html.indexOf("<h1>"));
  assert.match(html, /needs help/);
});

test("“need help” answers with 1784 and 1669 at once, asks where, then gives the nearest rescue units", async () => {
  const { env, said } = room(["SAFE"]);
  await deliver(worker, env, [dm.text("ต้องการความช่วยเหลือ · need help")]);
  assert.match(lastText(said), /1784[\s\S]*1669/);
  const acts = quickOf(said);
  assert.deepEqual(acts.filter((a) => a.type === "uri").map((a) => a.uri), ["tel:1784", "tel:1669"]);
  assert.ok(acts.some((a) => a.type === "location"));
  const token = /\/safe\/([0-9a-f]{48})/.exec(lastText(said))[1];
  assert.match(await (await get(env, "/safe/" + token)).text(), /needs help/);
  await deliver(worker, env, [dm.location(...TPG)]);
  assert.match(lastText(said), /Nearest rescue units/);
  assert.equal((lastText(said).match(/ม\. · m|กม\. · km/g) || []).length, 3);
});

test("“ช่วยด้วย” is a call for help, not a request for the command list", async () => {
  const { env, said } = room(["SAFE", "PAGES"]);
  await deliver(worker, env, [dm.text("ช่วยด้วย")]);
  assert.match(lastText(said), /1784/);
});

test("SAFE off: family links do not open", async () => {
  const { env, said } = room(["SAFE"]);
  await deliver(worker, env, [dm.text("safe")]);
  const token = /\/safe\/([0-9a-f]{48})/.exec(lastText(said))[1];
  env.SAFE = "off";
  assert.equal((await get(env, "/safe/" + token)).status, 404);
});

// ── privacy and delete ───────────────────────────────────────────────────────

test("“privacy” says what is held, and “delete” twice removes all of it", async () => {
  const all = ["PAGES", "PINS", "ASK", "ALERTS", "STAMPS", "OWNERS", "SPOTTERS", "SAFE"];
  const { env, said } = room(all);
  await deliver(worker, env, [
    dm.follow(), dm.text("a line for the page"), dm.image(), dm.text("หมุด · pins " + MAP),
    dm.location(...TPG), dm.text("home"), dm.text("passport mhs"), dm.postback("rain=heavy"),
    dm.text("safe"), dm.text("owner MD-4F2K9"),
  ]);
  const token = /\/safe\/([0-9a-f]{48})/.exec(said.replies.find((r) => /\/safe\//.test(r)))[1];
  await deliver(worker, env, [dm.text("ความลับ · privacy")]);
  const p = lastText(said);
  for (const want of ["LINE user id", "Page:", "Last location you shared", "Pin sets and plans: 1", "alert place",
    "Owner claims: 1", "Rain and flood reports counted: 1", "family links: 1", "Send “delete” twice"]) {
    assert.ok(p.includes(want), want);
  }
  await deliver(worker, env, [dm.text("ลบ · delete"), dm.text("ลบ")]);
  assert.match(lastText(said), /everything else kept for you are deleted/);
  for (const t of ["dm_users", "page_items", "pin_sets", "alert_places", "rounds_started", "owner_claims", "weather_reports", "safe_links", "dm_rate"]) {
    assert.equal(one(env, `SELECT COUNT(*) n FROM ${t}`).n, 0, t);
  }
  assert.ok(![...env.INBOX.store.keys()].some((k) => k.startsWith("pages/")));
  assert.equal((await get(env, "/safe/" + token)).status, 404);
});

// ── passing a point on ───────────────────────────────────────────────────────

test("plusCode matches the Open Location Code test vectors", async () => {
  const { plusCode } = await import("../src/plus.js");
  assert.equal(plusCode(20.3700625, 2.7821875), "7FG49QCJ+2V");
  assert.equal(plusCode(-41.2730625, 174.7859375), "4VCPPQGP+Q9");
});

test("a shared location's reply carries its Plus Code, a map link and a Share button", async () => {
  const { plusCode } = await import("../src/plus.js");
  const { env, said } = room(["ASK"]);
  await deliver(worker, env, [dm.location(...TPG)]);
  const code = plusCode(...TPG);
  assert.ok(lastText(said).includes(`Plus Code: ${code}`));
  assert.ok(lastText(said).includes(`https://motdang.net/map.html?go=${encodeURIComponent(code)}`));
  const share = quickOf(said).find((a) => a.label === "ส่งให้เพื่อน · Share");
  assert.ok(share.uri.startsWith("https://line.me/R/share?text="));
  assert.equal(decodeURIComponent(share.uri.split("text=")[1]),
    `📍 ตำแหน่งของฉัน · my location https://motdang.net/map.html?go=${encodeURIComponent(code)}`);
  assert.ok([...share.label].length <= 20);
});

test("a stamped wat is passed on by its place ID; home and the family location by Plus Code", async () => {
  const { env, said } = room(["STAMPS", "ALERTS", "SAFE"]);
  const wat = ROUNDS.wats.stops[0];
  await deliver(worker, env, [dm.text("passport wats"), dm.location(wat.lat, wat.lng)]);
  assert.ok(lastText(said).includes(`map.html?go=MD-${wat.code}`));
  assert.match(decodeURIComponent(quickOf(said)[0].uri), new RegExp(`${wat.th} · ${wat.en}`));
  // The wat location is recent, so "home" keeps it without asking again.
  await deliver(worker, env, [dm.text("home")]);
  assert.match(lastText(said), /Saved this place[\s\S]*Plus Code: 7MCW/);
  await deliver(worker, env, [dm.text("safe"), dm.location(...TPG)]);
  assert.match(lastText(said), /Plus Code: 7MCW[\s\S]*map\.html\?go=/);
  assert.equal(said.pushes.length, 0, "all of it by reply");
});
