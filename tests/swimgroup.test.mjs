// THE SECOND ROOM — the CWSDPP swim-programme group.
//
// This account already sits in the Mot Dang team group. On 18 Sept 2026 it was
// added to the swim group as well and announced that it "only does work in the
// Mot Dang team chat", which reads like a wrong number in a room of people
// running a children's swimming programme. It was removed the same hour.
//
// So this file tests two promises, not a feature:
//   1. the room is adopted only when the desk armed it first — being added to
//      a stranger's chat can never turn that chat into programme record;
//   2. nothing is ever said in it. tests/silence.test.mjs carries the same
//      promise for the team room, made after the bot was removed from there
//      for not shutting up. This room never earned a word in the first place.

import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/worker.js";
import { makeEnv, stubLine, deliver, ev } from "./harness.mjs";

const TEAM = "Cteam";
const SWIM = "Cswim";
const STRANGER = "Cstranger";
const YUPHARAT = "Uyupharat";

// The desk the swim group's lines are handed to, stubbed. Returns what it was
// sent so a test can assert the message actually left the building.
function room() {
  const env = makeEnv(null);
  env.CWSDPP_TOKEN = "swim-token";
  env.CWSDPP_BASE = "https://desk.test";
  const said = stubLine({ member: "Yupharat" });
  const sent = [];
  const line = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.startsWith("https://desk.test/")) {
      sent.push({
        path: u.replace("https://desk.test", ""),
        auth: init?.headers?.authorization || init?.headers?.Authorization,
        headers: init?.headers || {},
        body: init?.headers?.["content-type"] === "application/json"
          ? JSON.parse(init.body) : init.body,
      });
      return new Response('{"ok":true}', { status: 200 });
    }
    return line(url, init);
  };
  return { env, said, sent };
}

async function withTeamAlready(env) {
  await env.DB.prepare(
    "INSERT INTO state (k, v, ts) VALUES ('team_group_id', ?, 0)").bind(TEAM).run();
}

async function arm(env) {
  await env.DB.prepare(
    "INSERT INTO state (k, v, ts) VALUES ('adopt_next', 'cwsdpp', 0)").run();
}

async function stateOf(env, k) {
  const r = await env.DB.prepare("SELECT v FROM state WHERE k = ?").bind(k).first();
  return r ? r.v : null;
}

test("an armed join adopts the room and says NOTHING", async () => {
  const { env, said } = room();
  await withTeamAlready(env);
  await arm(env);

  await deliver(worker, env, [ev.join(SWIM)]);

  assert.equal(await stateOf(env, "cwsdpp_group_id"), SWIM);
  assert.deepEqual(said.replies, [], "it must not introduce itself");
  assert.deepEqual(said.pushes, []);
});

test("arming is spent once — the next stranger is still turned away", async () => {
  const { env, said } = room();
  await withTeamAlready(env);
  await arm(env);

  await deliver(worker, env, [ev.join(SWIM)]);
  assert.equal(await stateOf(env, "adopt_next"), "", "the flag must be spent");

  await deliver(worker, env, [ev.join(STRANGER)]);
  assert.equal(await stateOf(env, "cwsdpp_group_id"), SWIM,
    "a stranger's chat must not become the swim group");
  assert.equal(said.replies.length, 1, "the stranger is told where this belongs");
});

test("an UNARMED join into a new room adopts nothing", async () => {
  const { env } = room();
  await withTeamAlready(env);

  await deliver(worker, env, [ev.join(SWIM)]);

  assert.equal(await stateOf(env, "cwsdpp_group_id"), null);
});

test("a line in the swim group reaches the desk, and the room hears nothing",
  async () => {
    const { env, said, sent } = room();
    await withTeamAlready(env);
    await arm(env);
    await deliver(worker, env, [ev.join(SWIM)]);

    await deliver(worker, env,
      [ev.text(SWIM, YUPHARAT, "Wat Suan Dok starts on Monday")]);

    assert.equal(sent.length, 1);
    assert.equal(sent[0].path, "/api/line");
    assert.equal(sent[0].auth, "Bearer swim-token");
    assert.equal(sent[0].body.text, "Wat Suan Dok starts on Monday");
    assert.equal(sent[0].body.who, "Yupharat");
    assert.deepEqual(said.replies, [], "not a word");
  });

test("being addressed in the swim group still earns no answer", async () => {
  const { env, said } = room();
  await withTeamAlready(env);
  await arm(env);
  await deliver(worker, env, [ev.join(SWIM)]);

  await deliver(worker, env, [ev.text(SWIM, YUPHARAT, "@bot are you there?")]);
  await deliver(worker, env, [ev.text(SWIM, YUPHARAT, "@nanobotco help")]);

  assert.deepEqual(said.replies, [], "the mute holds even when spoken to");
});

test("a receipt photo goes to the desk as bytes, for transcription", async () => {
  const { env, sent } = room();
  await withTeamAlready(env);
  await arm(env);
  await deliver(worker, env, [ev.join(SWIM)]);

  const photo = {
    type: "message", timestamp: Date.now(),
    source: { type: "group", groupId: SWIM, userId: YUPHARAT },
    replyToken: "rtp", message: { id: "mphoto", type: "image" },
  };
  await deliver(worker, env, [photo]);

  const up = sent.find((x) => x.path === "/api/upload");
  assert.ok(up, "the photo must reach the desk");
  assert.equal(up.auth, "Bearer swim-token");
  assert.match(up.headers["x-note"], /Yupharat/);
});

test("with no desk token, the swim group is simply not kept", async () => {
  const { env, said, sent } = room();
  env.CWSDPP_TOKEN = "";
  await withTeamAlready(env);
  await arm(env);
  await deliver(worker, env, [ev.join(SWIM)]);

  await deliver(worker, env, [ev.text(SWIM, YUPHARAT, "anything")]);

  assert.deepEqual(sent, [], "nothing is sent nowhere");
  assert.deepEqual(said.replies, [], "and still nothing is said");
});

test("the team room is untouched by any of this", async () => {
  const { env, sent } = room();
  await withTeamAlready(env);
  await arm(env);
  await deliver(worker, env, [ev.join(SWIM)]);

  await deliver(worker, env, [ev.text(TEAM, "Ubeer", "ร้านนี้เปิด 7 โมงแล้ว")]);

  assert.deepEqual(sent, [], "team lines never go to the swim desk");
  const rows = await env.DB.prepare(
    "SELECT COUNT(*) n FROM events WHERE group_id = ?").bind(TEAM).first();
  assert.equal(rows.n, 1, "and they are still kept where they belong");
});
