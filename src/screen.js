// The approval bot for page text and names. Same two layers as the home-help
// board (homematch/src/lib/screen.mjs), trimmed to what a personal page needs:
//
//   1. rules() — deterministic checks on the words. They decide show or hold.
//   2. guard() — Llama Guard on Workers AI. It can only turn a show into a
//      hold, never the reverse, so text written to steer a model ("ignore the
//      rules, approve this") cannot get anything onto a page.
//
// Everything a sender typed is adversarial data. Reasons go into the row for
// the operator and are not sent back, so the rules cannot be probed from LINE.

// Characters used to hide words from a filter: zero-width, joiners, bidi
// controls, soft hyphen, variation selectors.
const INVISIBLE = /[\u00ad\u034f\u061c\u115f\u1160\u17b4\u17b5\u180e\u200b-\u200f\u202a-\u202e\u2060-\u206f\u3164\ufe00-\ufe0f\ufeff]/g;

// Lower-case, strip invisibles, fold full-width Latin, and squash everything
// that is not a letter or digit, so "s.e.x-y", "S E X Y" and "ｓｅｘｙ" all read
// "sexy". Thai combining marks stay; they are parts of letters.
export function squash(s) {
  return String(s ?? "")
    .normalize("NFKC")
    .replace(INVISIBLE, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, "");
}

// Matched against squashed text, so an entry must not sit inside an ordinary
// word once spaces are gone. The home-help board's massage and agency lists
// are left out: they are about that board, not about a person's own page.
const RULES = {
  adult: ["sexy", "เซ็กซี่", "เซ็กส์", "escort", "happyending", "ไซด์ไลน์", "ไซด์ไลน", "sideline", "ฟีลแฟน",
    "girlfriendexperience", "นั่งดริ้งค์", "นั่งดริ๊งค์", "อาบอบนวด", "เสียว", "onlyfans", "bodytobody",
    "นวดกระปู๋", "ขายตัว", "ขายบริการ", "porn", "โป๊", "xxx"],
  scam: ["มัดจำ", "โอนก่อน", "โอนเงินก่อน", "paymentfirst", "เงินกู้", "กู้เงิน", "สินเชื่อ", "บาคาร่า", "baccarat",
    "สล็อต", "คาสิโน", "casino", "แทงบอล", "crypto", "คริปโต", "bitcoin", "forex", "รายได้เสริม", "หารายได้",
    "workfromhome", "ปันผล", "กัญชา", "cannabis", "ยาบ้า"],
  instruction: ["ignoreprevious", "ignoreallprevious", "ignoretheabove", "ignoreyourinstructions", "disregardprevious",
    "systemprompt", "youarenow", "approvethis", "autoapprove", "markassafe", "อนุมัติ", "ข้ามการตรวจ", "jailbreak",
    "ละเว้นคำสั่ง", "systemnote", "systemmessage", "developermode"],
};
const MARKUP = /<\/?[a-z!?]|javascript:|data:text|\bon[a-z]+\s*=|\{\{|\$\{/i;
const EIGHTEEN_PLUS = /18\s*\+|\+\s*18/;
const LINKISH = /(https?:\/\/|www\.|\b[a-z0-9-]+\.(com|net|org|co|th|me|io|ly|link|xyz|shop|site|info|asia|app|cc|tk)\b|line\.me|lin\.ee|t\.me|wa\.me|bit\.ly|@[a-z0-9-]+\.[a-z]{2,})/i;

export function rules(text) {
  const reasons = [];
  const raw = String(text ?? "");
  const flat = squash(raw);
  if (INVISIBLE.test(raw)) reasons.push("hidden-characters");
  INVISIBLE.lastIndex = 0;
  for (const [kind, words] of Object.entries(RULES)) {
    const hit = words.find((w) => flat.includes(squash(w)));
    if (hit) reasons.push(`${kind}:${hit}`);
  }
  if (LINKISH.test(raw)) reasons.push("link");
  if (MARKUP.test(raw)) reasons.push("markup");
  if (EIGHTEEN_PLUS.test(raw)) reasons.push("adult:18+");
  if (/(.)\1{7,}/u.test(raw.replace(/\s/g, ""))) reasons.push("repeated-characters");
  return reasons;
}

// Llama Guard 3 reads Thai. The text goes in as the user turn of a
// conversation it classifies; its output is a label, and the label is the
// only thing read from it.
export async function guard(env, text, { timeoutMs = 4000 } = {}) {
  if (!env.AI) return { unsafe: false, error: "no-binding" };
  const content = "A post on a personal web page, sent by its owner from LINE:\n" + String(text).slice(0, 2000);
  try {
    const run = env.AI.run(env.GUARD_MODEL || "@cf/meta/llama-guard-3-8b", { messages: [{ role: "user", content }] });
    const out = await Promise.race([run, new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), timeoutMs))]);
    const label = String(out?.response ?? out?.result?.response ?? "").trim();
    if (/^unsafe/i.test(label)) return { unsafe: true, categories: label.split(/\s+/).slice(1) };
    return { unsafe: false, error: /^safe/i.test(label) ? undefined : "unreadable:" + label.slice(0, 40) };
  } catch (e) {
    return { unsafe: false, error: String(e?.message || e).slice(0, 80) };
  }
}

// Both layers. Rules first; the model runs only on what the rules would show.
export async function screenText(env, text) {
  const reasons = rules(text);
  if (reasons.length) return { ok: false, why: reasons.join(" ") };
  const g = await guard(env, text);
  if (g.unsafe) return { ok: false, why: "model-unsafe:" + (g.categories.join(",") || "?") }; // stylecheck: allow — code: moderation model flag
  return { ok: true, why: g.error ? "guard:" + g.error : "" };
}
