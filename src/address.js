// How a room addresses the bot. Shared by the bots room (worker.js) and the
// Golf Ball Drop room (gbd.js).
//
// Nan, 2026-09-18: "I will say @bot if I want to talk to it or @nanobotco".
// Two ways in, because LINE gives two:
//
//   * a real @-mention, which arrives structured with isSelf on the mentionee —
//     what the client produces when somebody picks the account out of the
//     mention list;
//   * the letters typed by hand, which is what happens when the mention list is
//     not offered, the name is autocorrected, or somebody is on a phone.
//
// The address is stripped before a command parser sees the line, so "@bot
// status" reaches the same branch "status" does.
export const ADDRESS = /(^|\s)@(?:nanobotco|nanobot|bot|มด)\s*[:,]?/gi;

export function readsAsAddress(m) {
  if ((m.mention?.mentionees || []).some((x) => x.isSelf)) return true;
  // ADDRESS is /g, so .test() leaves lastIndex behind it and the next call on a
  // different string starts mid-way. Reset on both sides.
  ADDRESS.lastIndex = 0;
  const hit = ADDRESS.test(m.text || "");
  ADDRESS.lastIndex = 0;
  return hit;
}

// "bot, …" / "bots: …" / "บอท…" at the start of a line. The Latin forms need the
// comma or colon, so "bots are fun" is not a call.
export const BOTS_CALL = /^(?:(?:hey|hi|ok)\s+)?(?:bots?|nanobotco|nanobot)\s*[,:，]\s*|^บอท\s*/i;

export function readsAsBotsCall(raw) {
  return BOTS_CALL.test(raw);
}

// The message text without the words that addressed the account: its own
// structured mentions (whatever its display name is), then the typed forms.
export function withoutAddress(m) {
  let t = String(m.text || "");
  const self = (m.mention?.mentionees || []).filter((x) => x.isSelf && Number.isInteger(x.index) && Number.isInteger(x.length))
    .sort((a, b) => b.index - a.index);
  for (const x of self) t = t.slice(0, x.index) + " " + t.slice(x.index + x.length);
  return t.replace(ADDRESS, " ").trim().replace(BOTS_CALL, "").replace(/\s+/g, " ").trim();
}
