// src/site.js — what motdang.net asks of the account for a reader signed in
// with LINE: friend or not, home for alerts, a page sent to one's own chat,
// event reminders, the weekly issue, and forgetting a reader. LINE is stubbed.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as site from "../src/site.js";
import { runAlerts } from "../src/alerts.js";
import { makeEnv } from "./harness.mjs";

const A = "U" + "a".repeat(32), B = "U" + "b".repeat(32), C = "U" + "c".repeat(32);

function stub({ friends = [A], quota = 300, usedByLine = 0, fail = false } = {}) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    calls.push({ url: u, body: init.body ? JSON.parse(init.body) : null });
    if (u.endsWith("/message/quota")) return Response.json({ type: "limited", value: quota });
    if (u.endsWith("/message/quota/consumption")) return Response.json({ totalUsage: usedByLine });
    const p = /\/profile\/(U[0-9a-f]+)$/.exec(u);
    if (p) return friends.includes(p[1]) ? Response.json({ displayName: "x" }) : new Response("{}", { status: 404 });
    if (u.endsWith("/message/push") || u.endsWith("/message/multicast")) return new Response("{}", { status: fail ? 400 : 200 });
    if (u.includes("/data/ping.json")) return Response.json({ stations: [] });
    if (u.includes("/data/air.json")) return Response.json({ places: [{ id: "cm", th: "เชียงใหม่", en: "Chiang Mai", lat: 18.79, lng: 98.98, pm25: 120 }] });
    return new Response("not stubbed " + u, { status: 500 });
  };
  return calls;
}
const pushes = (calls) => calls.filter((c) => /\/message\/(push|multicast)$/.test(c.url));
const env = (extra = {}) => Object.assign(makeEnv(), { SITE_PUSH: "on" }, extra);

test("status: friend by LINE's profile answer, home, reminders, the day's sends left", async () => {
  stub();
  const e = env();
  await site.setHome(e, A, 18.78771, 98.99329);
  await site.remind(e, A, "ev:x@morning", Date.now() + 3600e3, "งาน x");
  const s = await site.status(e, A);
  assert.equal(s.friend, true);
  assert.deepEqual(s.home, { lat: 18.788, lng: 98.993 });
  assert.equal(s.reminders.length, 1);
  assert.equal(s.selfLeft, 20);
  assert.equal((await site.status(e, B)).friend, false);
  assert.deepEqual(await site.status(e, "Ubad"), { error: "uid" });
});

test("toSelf: one push to the reader, logged; twenty a day", async () => {
  const calls = stub();
  const e = env();
  const r = await site.toSelf(e, A, "Wat Phan Tao\nhttps://motdang.net/x");
  assert.equal(r.ok, true);
  assert.equal(pushes(calls).length, 1);
  assert.equal(pushes(calls)[0].body.to, A);
  for (let i = 0; i < 19; i++) await site.toSelf(e, A, "n" + i);
  assert.deepEqual(await site.toSelf(e, A, "one more"), { error: "day", left: 0 });
  assert.equal(pushes(calls).length, 20);
});

test("toSelf with SITE_PUSH off: nothing leaves", async () => {
  const calls = stub();
  const r = await site.toSelf(env({ SITE_PUSH: "off" }), A, "x");
  assert.equal(r.error, "held");
  assert.equal(pushes(calls).length, 0);
});

test("the month's room is the smaller of PUSH_CAP less our sends and LINE's own count", async () => {
  stub({ quota: 300, usedByLine: 295 });
  const e = env({ PUSH_CAP: "300" });
  assert.equal(await site.room(e), 5);
  stub({ quota: 300, usedByLine: 0 });
  assert.equal(await site.room(env({ PUSH_CAP: "2" })), 2);
});

test("reminders: sent in the run before they fall due, once; far-late ones are dropped", async () => {
  const calls = stub();
  const e = env();
  const now = Date.now();
  await site.remind(e, A, "soon", now + 20 * 60e3, "in 20 minutes");
  await site.remind(e, A, "later", now + 5 * 3600e3, "in 5 hours");
  e._db.prepare("INSERT INTO reminders (user_id, key, at, text, made) VALUES (?, 'old', ?, 'old', ?)").run(B, now - 7 * 3600e3, now);
  const r = await site.runReminders(e, now);
  assert.deepEqual(r, { sent: 1, failed: 0, capped: 0, late: 1 });
  assert.equal(pushes(calls).length, 1);
  assert.equal(pushes(calls)[0].body.messages[0].text, "in 20 minutes");
  assert.deepEqual(await site.runReminders(e, now), { sent: 0, failed: 0, capped: 0, late: 0 });
  await site.unremind(e, A, "later");
  assert.equal((await site.status(e, A)).reminders.length, 0);
});

test("reminders wait while SITE_PUSH is off, and go once it is on", async () => {
  const calls = stub();
  const e = env({ SITE_PUSH: "off" });
  await site.remind(e, A, "k", Date.now() + 60e3, "t");
  assert.equal((await site.runReminders(e)).held, 1);
  e.SITE_PUSH = "on";
  assert.equal((await site.runReminders(e)).sent, 1);
  assert.equal(pushes(calls).length, 1);
});

test("a reminder in the past or a year out is refused", async () => {
  stub();
  const e = env();
  assert.equal((await site.remind(e, A, "k", Date.now() - 3600e3, "t")).error, "when");
  assert.equal((await site.remind(e, A, "k", Date.now() + 500 * 864e5, "t")).error, "when");
});

test("weekly: one multicast, each reader once per issue, over the room capped", async () => {
  const calls = stub({ quota: 300, usedByLine: 298 });
  const e = env();
  const r = await site.weekly(e, [A, B, C, A, "junk"], "2026-10-26", "The week");
  assert.deepEqual(r, { asked: 3, already: 0, sent: 2, failed: 0, capped: 1, held: false });
  assert.deepEqual(pushes(calls)[0].body.to, [A, B]);
  stub();
  const again = await site.weekly(e, [A, B], "2026-10-26", "The week");
  assert.equal(again.already, 2);
  assert.equal(again.sent, 0);
});

test("weekly with SITE_PUSH off holds everything", async () => {
  const calls = stub();
  const r = await site.weekly(env({ SITE_PUSH: "off" }), [A], "2026-10-26", "x");
  assert.equal(r.held, true);
  assert.equal(pushes(calls).length, 0);
});

test("a home set on the site gets alerts with SITE_ALERTS on, and the stop line points at the site", async () => {
  const calls = stub();
  const e = env({ SITE_ALERTS: "on", ALERTS: "off" });
  await site.setHome(e, A, 18.79, 98.98);
  const r = await runAlerts(e);
  assert.equal(r.sent, 1);
  const text = pushes(calls)[0].body.messages[0].text;
  assert.match(text, /motdang\.net\/my\.html/);
});

test("forget: home, reminders and the push log go", async () => {
  stub();
  const e = env();
  await site.setHome(e, A, 18.79, 98.98);
  await site.remind(e, A, "k", Date.now() + 3600e3, "t");
  await site.toSelf(e, A, "x");
  await site.forget(e, A);
  const s = await site.status(e, A);
  assert.equal(s.home, null);
  assert.equal(s.reminders.length, 0);
  assert.equal(e._db.prepare("SELECT COUNT(*) n FROM site_push WHERE user_id = ?").get(A).n, 0);
});
