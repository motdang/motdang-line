// A Worker-shaped environment on top of node:sqlite, so the whole event path —
// signature, D1 writes, R2 puts, what the bot actually says — can be run
// without deploying and without touching LINE.
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));

class Stmt {
  constructor(db, sql) { this.db = db; this.sql = sql; this.args = []; }
  bind(...args) { this.args = args.map((a) => (a === undefined ? null : a)); return this; }
  async run() {
    const r = this.db.prepare(this.sql).run(...this.args);
    return { meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
  }
  async first() { return this.db.prepare(this.sql).get(...this.args) ?? null; }
  async all() { return { results: this.db.prepare(this.sql).all(...this.args) }; }
}

class R2 {
  constructor() { this.store = new Map(); }
  async put(key, body, opts) {
    let buf = body;
    if (body && typeof body.getReader === "function") buf = await new Response(body).arrayBuffer();
    this.store.set(key, { body: buf, httpMetadata: opts?.httpMetadata, customMetadata: opts?.customMetadata });
    return {};
  }
  async delete(key) { this.store.delete(key); }
  async get(key) {
    const o = this.store.get(key);
    if (!o) return null;
    return {
      body: o.body,
      httpMetadata: o.httpMetadata,
      async json() { return JSON.parse(new TextDecoder().decode(o.body)); },
      async arrayBuffer() { return o.body; },
    };
  }
}

export const SECRET = "test-channel-secret";

export function makeEnv(indexRows) {
  const db = new DatabaseSync(":memory:");
  // Every migration, in order — a test that runs an older schema than the
  // Worker does is a test that passes for the wrong reason.
  for (const f of readdirSync(join(HERE, "..", "migrations")).sort()) {
    if (f.endsWith(".sql")) db.exec(readFileSync(join(HERE, "..", "migrations", f), "utf8"));
  }
  const inbox = new R2();
  if (indexRows) {
    inbox.store.set("index/match.json", { body: new TextEncoder().encode(JSON.stringify(indexRows)).buffer });
  }
  // The vision model, stubbed: tests set env._sign to what "the sign says",
  // or leave it null for a photo with nothing legible on it.
  const env = {
    _sign: null,
    AI: { run: async () => ({ response: env._sign ? "```json\n" + JSON.stringify(env._sign) + "\n```" : "{}" }) },
    SIGN_MODEL: "@cf/test/vision",
    DB: { prepare: (s) => new Stmt(db, s) },
    INBOX: inbox,
    LINE_CHANNEL_SECRET: SECRET,
    LINE_CHANNEL_TOKEN: "test-token",
    PULL_TOKEN: "test-pull",
    // The flow tests assert what the bot SAYS, so they run it unmuted. Silence
    // is the deployed default and has its own file, tests/silence.test.mjs.
    SPEAK: "on",
    SITE: "https://motdang.net",
    _db: db,
  };
  return env;
}

// Everything the Worker says, in order, plus the photo bytes it asked LINE for.
// `groups` maps a group id to the name LINE gives for it (the summary call);
// a group not in it gets no name, as when LINE does not answer. `strangers`
// are user ids LINE says are not members of any group asked about.
export function stubLine({ imageBytes = new Uint8Array([1, 2, 3, 4]), member = "Beer", groups = {}, strangers = [] } = {}) {
  const said = { replies: [], pushes: [] };
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    const body = init?.body ? JSON.parse(init.body) : null;
    if (u.endsWith("/message/reply")) {
      said.replies.push(body.messages.map((m) => m.text).join(""));
      return new Response("{}", { status: 200 });
    }
    if (u.endsWith("/message/push")) {
      said.pushes.push(body.messages.map((m) => m.text).join(""));
      return new Response("{}", { status: 200 });
    }
    if (u.includes("/content")) {
      return new Response(imageBytes, { status: 200, headers: { "content-type": "image/jpeg" } });
    }
    if (u.endsWith("/summary")) {
      const gid = decodeURIComponent(u.split("/group/")[1].split("/")[0]);
      if (!(gid in groups)) return new Response("{}", { status: 404 });
      return new Response(JSON.stringify({ groupId: gid, groupName: groups[gid] }), { status: 200 });
    }
    if (u.includes("/member/")) {
      if (strangers.includes(u.split("/member/")[1])) return new Response("{}", { status: 404 });
      return new Response(JSON.stringify({ displayName: member }), { status: 200 });
    }
    return new Response("unexpected " + u, { status: 500 });
  };
  return said;
}

export async function sign(bodyText, secret = SECRET) {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(bodyText));
  return Buffer.from(mac).toString("base64");
}

// Post events the way LINE does, and wait for the work the Worker deferred.
export async function deliver(worker, env, events) {
  const bodyText = JSON.stringify({ destination: "U0", events });
  const waits = [];
  const res = await worker.fetch(
    new Request("https://line.motdang.net/line/webhook", {
      method: "POST",
      headers: { "x-line-signature": await sign(bodyText), "content-type": "application/json" },
      body: bodyText,
    }),
    env,
    { waitUntil: (p) => waits.push(p) },
  );
  await Promise.all(waits);
  return res;
}

let seq = 0;
export const ev = {
  audio: (groupId, userId) => ({
    type: "message", timestamp: Date.now(), source: { type: "group", groupId, userId },
    replyToken: "rt" + ++seq, message: { id: "m" + ++seq, type: "audio", duration: 4000 },
  }),
  join: (groupId) => ({ type: "join", timestamp: Date.now(), source: { type: "group", groupId }, replyToken: "rt" + ++seq }),
  text: (groupId, userId, text, extra = {}) => ({
    type: "message", timestamp: Date.now(), source: { type: "group", groupId, userId },
    replyToken: "rt" + ++seq, message: { id: "m" + ++seq, type: "text", text, ...extra },
  }),
  image: (groupId, userId, extra = {}) => ({
    type: "message", timestamp: Date.now(), source: { type: "group", groupId, userId },
    replyToken: "rt" + ++seq, message: { id: "m" + ++seq, type: "image", ...extra },
  }),
  location: (groupId, userId, lat, lng, extra = {}) => ({
    type: "message", timestamp: Date.now(), source: { type: "group", groupId, userId },
    replyToken: "rt" + ++seq, message: { id: "m" + ++seq, type: "location", latitude: lat, longitude: lng, ...extra },
  }),
  dm: (userId, text) => ({
    type: "message", timestamp: Date.now(), source: { type: "user", userId },
    replyToken: "rt" + ++seq, message: { id: "m" + ++seq, type: "text", text },
  }),
};
