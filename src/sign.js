// Reading the shop sign off a photo.
//
// A vision model on Workers AI looks at the picture and returns the fields a
// sign can actually show — name in Thai and English, phone, hours, LINE id,
// what the place is — as JSON with nulls where the sign shows nothing. It is
// a READING, offered in the room for a person to confirm, never a fact filed
// on its own: the model is asked not to guess, and the reply makes plain that
// it read rather than knew.
//
// It also reads the BACKGROUND, and that is not an afterthought. LINE strips
// EXIF from a photo send, so a picture from somebody's album arrives with no
// coordinates and no way to recover any. But a shopfront is never
// photographed alone: the neighbours' signs are in the same frame, and a
// neighbour is a place the catalogue already surveyed. "Pharma Choice" alone
// is 19 branches and cannot be placed; Pharma Choice standing beside Johns
// Place, a rooftop bar and Sleep Mai is one block on ถนนมูลเมือง. A reading
// that returns only the subject has thrown the coordinates away, so this asks
// for every legible sign and says which one the photo is about.

const PROMPT = [
  "You are reading the shop signs in a photo taken in Chiang Mai or Chiang Rai, Thailand.",
  "Answer immediately with JSON. Do not explain your reasoning.", // stylecheck: allow — model prompt
  "Return ONLY a JSON object with exactly these keys, in this order,",
  "using null (or [] for neighbours) for anything the picture does not show:",
  "name_en (the Latin-script name of the place this photo is OF),",
  "name_th (its Thai name, copied character for character),",
  "neighbours (a JSON ARRAY of the names of OTHER businesses whose signs you can read",
  "anywhere in the picture — next door, across the street, behind, in the distance —",
  "NOT the place this photo is of; [] if there are none),",
  "what_kind (a few words: what this place sells or does),",
  "phone, hours, line_id,",
  "other_text (anything else legible, AT MOST 20 WORDS).",
  "The neighbours matter as much as the main sign, because they are how the photo gets",
  "placed on a map. Before answering, sweep the whole picture — left edge, right edge,",
  "above the awnings, down the street, reflections, banners, neon, illuminated boxes,",
  "small plates beside doors — and put EVERY business name you can read into neighbours,",
  "even partly readable, even tiny, even out of focus, even if you are unsure of the",
  "spelling. A half-read name is worth more than an omitted one. Fill neighbours before",
  "other_text.",
  "Do not guess and do not translate: a field that is not printed on a sign is null.", // stylecheck: allow — model prompt
].join(" ");

const KEYS = ["name_th", "name_en", "phone", "hours", "line_id", "what_kind", "other_text"];
const LIST_KEYS = ["neighbours"];

// A Thai house number — 29/3, 141 — is printed on signage constantly and is
// worth pulling out on its own, because the resolver matches it whole against
// address text instead of tokenising it. Split into "29" and "3" it would
// match half the catalogue; kept whole it matches almost nothing, which is
// exactly why a hit is decisive.
const HOUSE_NUMBER = /(?<![\d/])\d{1,4}\/\d{1,3}(?![\d/])/g;

function toBase64(buf) {
  const bytes = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

// The model wraps its answer in ```json fences about half the time.
export function parseSign(text) {
  if (!text) return null;
  const m = /\{[\s\S]*\}/.exec(String(text));
  if (!m) return null;
  let obj;
  try {
    obj = JSON.parse(m[0]);
  } catch {
    return null;
  }
  const out = {};
  let any = false;
  for (const k of KEYS) {
    let v = obj[k];
    if (typeof v === "string") v = v.trim();
    if (v === "" || v === "null" || v === undefined) v = null;
    out[k] = v;
    if (v !== null && k !== "other_text") any = true;
  }
  for (const k of LIST_KEYS) {
    let v = obj[k];
    if (typeof v === "string") v = [v];
    if (!Array.isArray(v)) v = [];
    v = v.map((x) => (typeof x === "string" ? x.trim() : "")).filter(Boolean);
    out[k] = v;
    // A frame where only the neighbours are legible is still worth keeping:
    // it cannot name the shop, but it can still say which block it stands on.
    if (v.length) any = true;
  }
  return any ? out : null;
}

// The frame, as anchors the resolver can vote on. Both scripts of the subject
// name go in separately — either may be the one the catalogue holds — and
// they are both marked "subject", which keeps them out of the corroboration
// that decides confidence. A place cannot corroborate itself.
export function anchorsOf(sign) {
  if (!sign) return [];
  const out = [];
  const seen = new Set();
  const add = (text, role, kind) => {
    const t = (text || "").trim();
    if (!t) return;
    const dedupe = role + "|" + kind + "|" + t.toLowerCase();
    if (seen.has(dedupe)) return;
    seen.add(dedupe);
    out.push({ text: t, role, kind });
  };
  add(sign.name_en, "subject", "name");
  add(sign.name_th, "subject", "name");
  for (const n of sign.neighbours || []) add(n, "neighbour", "name");
  for (const field of [sign.other_text, ...(sign.neighbours || [])]) {
    for (const hn of String(field || "").match(HOUSE_NUMBER) || []) {
      add(hn, "neighbour", "housenumber");
    }
  }
  return out;
}

export async function readSign(env, bytes, contentType = "image/jpeg") {
  if (!env.AI || !env.SIGN_MODEL) return null;
  try {
    const res = await env.AI.run(env.SIGN_MODEL, {
      messages: [{
        role: "user",
        content: [
          { type: "text", text: PROMPT },
          { type: "image_url", image_url: { url: `data:${contentType};base64,${toBase64(bytes)}` } },
        ],
      }],
      // GLM-5.3-flash is a reasoning model: its thinking and its answer share
      // this budget. At 400 it spent the whole allowance reasoning about a
      // busy shopfront and returned an EMPTY string — finish_reason "length",
      // no JSON, every sign read silently lost. That is why `sign` was null on
      // every photo pulled on 2026-09-07, and it failed identically on the
      // original prompt, so it was never a regression — just never measured
      // against a crowded frame. Measured on the Pharma Choice photo: 400 →
      // empty, 2000 → truncated mid-field, 2500 → clean JSON in 16-24 s.
      max_tokens: 2500,
    });
    const text = res?.response ?? res?.choices?.[0]?.message?.content ?? res?.description ?? "";
    return parseSign(text);
  } catch (e) {
    console.log("sign read failed", e.message);
    return null;
  }
}

// One line a person can confirm at a glance: what the sign said.
export function describeSign(sign) {
  if (!sign) return "";
  const bits = [];
  const name = [sign.name_th, sign.name_en].filter(Boolean).join(" · ");
  if (name) bits.push(name);
  if (sign.neighbours && sign.neighbours.length) {
    bits.push("beside " + sign.neighbours.slice(0, 3).join(", "));
  }
  if (sign.what_kind) bits.push(sign.what_kind);
  if (sign.phone) bits.push(sign.phone);
  if (sign.hours) bits.push(sign.hours);
  if (sign.line_id) bits.push("LINE " + sign.line_id);
  return bits.join(" · ");
}
