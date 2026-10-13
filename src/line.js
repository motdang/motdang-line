// The Messaging API, only the calls this bot makes.
//
// Replies cost nothing and are unlimited; pushes come out of the account's
// monthly allowance. So everything conversational goes through reply(), and
// push() is reserved for the one nightly summary.

const API = "https://api.line.me/v2/bot";
const DATA_API = "https://api-data.line.me/v2/bot";

function auth(env) {
  return { Authorization: "Bearer " + env.LINE_CHANNEL_TOKEN };
}

// LINE signs the raw body with the channel secret. Verify against the bytes we
// received, never against a re-serialised parse of them.
export async function verify(rawBody, signature, secret) {
  if (!signature || !secret) return false;
  let sig;
  try {
    sig = Uint8Array.from(atob(signature), (c) => c.charCodeAt(0));
  } catch {
    return false;
  }
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  return crypto.subtle.verify("HMAC", key, sig, rawBody);
}

// SILENT UNLESS SPOKEN TO.
//
// Nan took this account out of the team group because it would not stop talking,
// and put it back on one condition — 2026-09-18: *"please mute nanobotco. I will
// say @bot if I want to talk to it or @nanobotco"*. So the rule is not "quieter".
// It is: the bot says nothing at all unless a person in the room addressed it in
// the message being answered.
//
// THE GATE IS THE REPLY TOKEN, and that is the point. Every reply the Worker
// makes is an answer to one incoming event, and LINE issues a fresh single-use
// token per event. worker.js calls allow() for the one event that carried an
// address; reply() speaks for that token and for no other, and consumes it.
//
// Doing it this way rather than passing a flag down to the fourteen call sites
// means a handler ADDED LATER is silent by default. Somebody writing a new reply
// cannot accidentally give the bot a voice; they would have to come here and
// register a token to do it. That is the property worth having, because the cost
// of getting it wrong is the account being thrown out of the room again.
//
// push() is never permitted this way: a push is not an answer to anything, and
// the nightly summary is exactly the unprompted chatter that caused the problem.
//
// SPEAK="on" restores the pre-2026-09-18 behaviour wholesale. Nothing sets it in
// production; the flow tests set it so they can keep asserting what the bot says.
const permitted = new Set();

// The opposite door, for the THOUGHTS room (Nan, 2026-09-30: "a private line
// group so I can send my own thoughts to a silent bot"). A token put here is
// never answered, not even with SPEAK "on", which otherwise opens every reply.
// worker.js puts every event from that room here before anything else runs.
const hushed = new Set();

export function hush(replyToken) {
  if (!replyToken) return;
  if (hushed.size > 256) hushed.clear();
  hushed.add(replyToken);
  permitted.delete(replyToken);
}

export function allow(replyToken) {
  if (!replyToken) return;
  // Tokens are single-use and short-lived. The cap is belt-and-braces against a
  // long-lived isolate accumulating tokens that were never spent.
  if (permitted.size > 256) permitted.clear();
  permitted.add(replyToken);
}

export function addressed(replyToken) {
  return permitted.has(replyToken);
}

// Give back a permission that was not used, so it cannot linger in the set.
export function spend(replyToken) {
  permitted.delete(replyToken);
}

function open(env, replyToken) {
  if (replyToken && hushed.has(replyToken)) return false;
  if (String(env.SPEAK ?? "").toLowerCase() === "on") return true;
  if (!replyToken || !permitted.has(replyToken)) return false;
  permitted.delete(replyToken);
  return true;
}

export async function reply(env, replyToken, text) {
  if (!replyToken || !text) return;
  if (!open(env, replyToken)) return void console.log("muted reply:", String(text).slice(0, 300));
  const r = await fetch(API + "/message/reply", {
    method: "POST",
    headers: { ...auth(env), "content-type": "application/json" },
    body: JSON.stringify({ replyToken, messages: chunk(text) }),
  });
  if (!r.ok) console.log("reply failed", r.status, await r.text());
}

// The same door as reply(), for an answer that is more than text: a quick-reply
// row under the message, which is how the page flow asks for a location or a
// yes. Goes through open() like every other reply.
export async function replyMessages(env, replyToken, messages) {
  if (!replyToken || !messages?.length) return;
  if (!open(env, replyToken)) return void console.log("muted reply:", JSON.stringify(messages).slice(0, 300));
  const r = await fetch(API + "/message/reply", {
    method: "POST",
    headers: { ...auth(env), "content-type": "application/json" },
    body: JSON.stringify({ replyToken, messages: messages.slice(0, 5) }),
  });
  if (!r.ok) console.log("reply failed", r.status, await r.text());
}

export async function push(env, to, text) {
  if (!to || !text) return;
  if (String(env.SPEAK ?? "").toLowerCase() !== "on") {
    return void console.log("muted push:", String(text).slice(0, 300));
  }
  const r = await fetch(API + "/message/push", {
    method: "POST",
    headers: { ...auth(env), "content-type": "application/json" },
    body: JSON.stringify({ to, messages: chunk(text) }),
  });
  if (!r.ok) console.log("push failed", r.status, await r.text());
}

// THE ONE THING THE MUTE LETS THROUGH, and it is let through by name.
//
// The mute above exists because the bot talked when nobody asked it to. On
// 2026-09-19 Nan asked for exactly one thing it should say unasked: the day's
// agenda, once each morning, in the group. That is not the chatter the mute was
// for — it is the close-out the room was missing on 15–16 September, when a 3:30
// became a 3:00 in a message addressed to somebody else and Nan was still
// holding the old time an hour before it started.
//
// It is a separate function rather than a flag on push() on purpose. push()
// stays flatly refused under SPEAK="off", so the nightly summary and anything
// added to it later cannot reach the room by editing a variable; a second job
// wanting a voice has to be written here, deliberately, and argued for. AGENDA
// turns this one off on its own — "off", or deleting the variable, and the
// morning goes quiet without touching anything else.
export async function pushAgenda(env, to, text) {
  if (!to || !text) return false;
  if (String(env.AGENDA ?? "").toLowerCase() !== "on") {
    console.log("agenda held (AGENDA not on):", String(text).slice(0, 300));
    return false;
  }
  const r = await fetch(API + "/message/push", {
    method: "POST",
    headers: { ...auth(env), "content-type": "application/json" },
    body: JSON.stringify({ to, messages: chunk(text) }),
  });
  if (!r.ok) {
    console.log("agenda push failed", r.status, await r.text());
    return false;
  }
  return true;
}

// THE SECOND THING LET THROUGH BY NAME: a warning about somebody's own place.
//
// Nan, 2026-09-28, said yes to "alerts for your own place": a river gauge near
// the place a person saved, at or over its own alert level, or dust over 75
// µg/m³ in its city. These go to one person who asked for them with "บ้าน ·
// home", never to a group, and they are pushes, which the account pays for.
// So, like pushAgenda, this is its own door with its own variable: ALERTS
// "off" stops it, and push() above stays refused under SPEAK "off". The
// spacing, the monthly cap and the log live in src/alerts.js.
export async function pushAlert(env, to, text) {
  if (!to || !text) return false;
  if (String(env.ALERTS ?? "").toLowerCase() !== "on") {
    console.log("alert held (ALERTS not on):", String(text).slice(0, 200));
    return false;
  }
  const r = await fetch(API + "/message/push", {
    method: "POST",
    headers: { ...auth(env), "content-type": "application/json" },
    body: JSON.stringify({ to, messages: chunk(text) }),
  });
  if (!r.ok) {
    console.log("alert push failed", r.status, await r.text());
    return false;
  }
  return true;
}

// THE THIRD DOOR: the dated posts in the Golf Ball Drop room (Nan, 2026-10-10).
//
// A push to a group counts once per member against the account's monthly
// allowance. Like pushAgenda and pushAlert this is its own function with its
// own variable: GBD_POSTS "on" opens it, anything else holds the text. push()
// above is not involved, and SPEAK does not change what this sends.
export async function pushGbd(env, to, text) {
  if (!to || !text) return false;
  if (String(env.GBD_POSTS ?? "").toLowerCase() !== "on") {
    console.log("gbd post held (GBD_POSTS not on):", String(text).slice(0, 200));
    return false;
  }
  const r = await fetch(API + "/message/push", {
    method: "POST",
    headers: { ...auth(env), "content-type": "application/json" },
    body: JSON.stringify({ to, messages: chunk(text) }),
  });
  if (!r.ok) {
    console.log("gbd post failed", r.status, await r.text());
    return false;
  }
  return true;
}

// A LINE text message tops out at 5,000 characters and five messages a call.
function chunk(text) {
  const out = [];
  let s = String(text);
  while (s.length && out.length < 5) {
    out.push({ type: "text", text: s.slice(0, 4900) });
    s = s.slice(4900);
  }
  return out;
}

// The bytes of a photo somebody sent. LINE keeps message content for a limited
// period only, which is why this runs at webhook time and there is no backfill.
export async function content(env, messageId) {
  const r = await fetch(`${DATA_API}/message/${messageId}/content`, { headers: auth(env) });
  if (!r.ok) {
    console.log("content failed", messageId, r.status);
    return null;
  }
  return {
    body: await r.arrayBuffer(),
    type: r.headers.get("content-type") || "image/jpeg",
  };
}

// Display name, so the ledger says "Beer" and not a 33-character user id.
// Best effort: a member who has left, or an id the account may not resolve,
// simply has no name and the row still stands.
export async function memberName(env, groupId, userId) {
  if (!groupId || !userId) return null;
  const r = await fetch(`${API}/group/${groupId}/member/${userId}`, { headers: auth(env) });
  if (!r.ok) return null;
  const j = await r.json().catch(() => null);
  return j?.displayName || null;
}

// A one-to-one sender's display name. LINE answers this for a user who has
// the account as a friend; anyone else, or a failure, has no name.
export async function profile(env, userId) {
  if (!userId) return null;
  const r = await fetch(`${API}/profile/${encodeURIComponent(userId)}`, { headers: auth(env) });
  if (!r.ok) return null;
  const j = await r.json().catch(() => null);
  return j?.displayName || null;
}

// A group's name, read once when the account first meets the group, to set
// the room's mode (worker.js, groupMode). Null for a room, or when LINE does
// not answer.
export async function groupSummary(env, groupId) {
  if (!groupId) return null;
  const r = await fetch(`${API}/group/${encodeURIComponent(groupId)}/summary`, { headers: auth(env) });
  if (!r.ok) return null;
  const j = await r.json().catch(() => null);
  return typeof j?.groupName === "string" ? j.groupName : null;
}
