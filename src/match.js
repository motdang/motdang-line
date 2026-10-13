// Working out which place a photo is of, from whatever text came with it.
//
// The index is built from the site's own docs/data/index.json — the same names
// the search box matches — so a place the bot can name is a place the site can
// already show. Nothing here guesses beyond the names: a photo that scores
// under FILE gets asked about rather than filed on a hunch, because a photo
// filed against the wrong shop is worse than one waiting in a tray.
//
// prepare() is not an optimisation detail. Normalising 25,000 names on every
// message costs about 100 ms of CPU a photo; done once per isolate it costs
// nothing again, and the bot answers inside its reply token.

export const FILE  = 0.80;  // at or above this, and clear of the runner-up: file it
export const OFFER = 0.60;  // worth putting in front of a person as a guess
const ASK   = 0.45;         // worth recording as "the best there was", nothing more
const GAP   = 0.08;         // top two closer than this = ambiguous, so ask

// Thai has no case and no spaces between words; Latin names arrive with every
// spelling of every vowel. Fold both to something comparable: strip the
// decorations, keep Thai and alphanumerics, collapse the rest to single spaces.
export function norm(s) {
  if (!s) return "";
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^\p{L}\p{N}฀-๿]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

// Words that carry no place in them. Without these, "some pics" finds a shop
// called "Some name" and files a photo under it.
const STOP = new Set([
  "the", "a", "an", "at", "in", "on", "of", "and", "or", "is", "this", "that",
  "photo", "photos", "pic", "pics", "picture", "pictures", "shot", "shots",
  "here", "it", "for", "new", "some", "few", "from", "these", "my", "our",
  "today", "yesterday", "more", "another", "again", "just", "got",
  "ร้าน", "ที่", "นี่", "นี้", "รูป", "ภาพ", "ของ", "วันนี้", "อีก",
]);

function toks(n) {
  return n ? n.split(" ").filter((t) => t && !STOP.has(t)) : [];
}

/**
 * Fold the compact index into the shape match() reads. Call once and keep it.
 * Token lists stay arrays, not Sets: names are one to five words, and 75,000
 * Sets in an isolate cost more memory than the scan they save.
 */
const GENERIC_DF = 20;  // a one-word name this many records share is a label, not a name

export function prepare(index) {
  const out = [];
  const df = new Map();  // how many records use each word anywhere in a name
  for (const rec of index || []) {
    const norms = [];
    for (const raw of [rec.n, rec.r, rec.e, rec.a]) {
      // A generated bearing rides in the name after a middle dot — "Car park ·
      // 570 m from Tha Phae Gate". 172 records read that way, all of them car
      // parks, and matching on the tail files a photo of the gate under one of
      // them. The name is the part before the dot; the rest is a description.
      const head = String(raw || "").split(" · ")[0];
      const n = norm(head);
      if (n && !norms.includes(n)) norms.push(n);
    }
    if (!norms.length) continue;
    const t = norms.map(toks);
    for (const w of new Set(t.flat())) df.set(w, (df.get(w) || 0) + 1);
    out.push({ rec, norms, flat: norms.map((n) => n.replace(/ /g, "")), toks: t });
  }
  // A name that is made of nothing but common words is a label, not a name.
  // Two shapes of it, and the corpus decides both — never a list of ours:
  //
  //   "Market", "ตลาด"  — one word that hundreds of other names also use
  //   "This is"          — every word a stop word
  //
  // The second one cost us a real photo. Nan sent a picture and wrote "This is
  // a picture of Get Er to the Greek", and a record actually named "This is"
  // swallowed it at 0.92, because a two-word name skipped the one-word guard
  // and the sentence contains "this is". A name with no content word in it can
  // be offered, never filed on.
  for (const p of out) {
    p.generic = p.toks.map(
      (t) => t.length === 0 || t.every((w) => (df.get(w) || 0) > GENERIC_DF),
    );
  }
  return out;
}

function scoreOne(qNorm, qFlat, qTokens, p) {
  let best = 0;
  for (let i = 0; i < p.norms.length; i++) {
    const n = p.norms[i];
    // A generic one-word name can be offered but never filed on by itself.
    const cap = p.generic?.[i] ? OFFER : 1;
    if (n === qNorm) { if (cap === 1) return 1; best = Math.max(best, cap); continue; }
    // Where a Thai name is broken into words is a matter of taste in Latin
    // script: Nimmanhaemin and Nimman Haemin are one place. Same letters in
    // the same order, different spacing, is the same name.
    if (qFlat.length >= 6 && p.flat[i] === qFlat) best = Math.max(best, Math.min(0.98, cap));
    // The name said in full inside a longer sentence — "photos of ตลาดวโรรส today"
    if (n.length >= 6 && qNorm.includes(n)) best = Math.max(best, Math.min(0.92, cap));
    // The message is a fragment of the name — "เจ๊หมวย" for "ร้านเจ๊หมวย ...".
    // Deliberately scored below FILE: a fragment also matches the branch named
    // after the landmark, so "tha phae gate" reaches "Pun Space Tha Phae Gate"
    // exactly as well as it reaches the gate. This is the shape of guess that
    // gets offered and confirmed, never the shape that files by itself.
    if (qNorm.length >= 6 && n.includes(qNorm) && qNorm.length / n.length >= 0.5)
      best = Math.max(best, Math.min(0.70, cap));
    const nT = p.toks[i];
    if (!nT.length || !qTokens.length) continue;
    let hit = 0;
    for (const t of qTokens) if (nT.includes(t)) hit++;
    if (hit) {
      // Every word of the name accounted for scores higher than a stray word
      // shared with it: "sunday market" against "Sunday Market" beats
      // "market" against "Warorot Market".
      best = Math.max(best, Math.min(0.5 * (hit / nT.length) + 0.35 * (hit / qTokens.length), cap));
    }
  }
  return best;
}

// A motdang.net link is the person telling us the record outright.
export function slugFromUrl(text) {
  const m = /motdang\.net\/(?:[a-z]{2}\/)?p\/([a-z0-9-]+)/i.exec(text || "");
  return m ? m[1] : null;
}

/**
 * @param {string} text     what the person said
 * @param {Array}  prepared output of prepare()
 * @returns {{status:'matched'|'ambiguous'|'none', place?:object, score:number, options:object[]}}
 */
export function match(text, prepared) {
  const out = { status: "none", score: 0, options: [] };
  if (!text || !prepared || !prepared.length) return out;

  // A page URL ends with the record's own id — motdang.net/cm/p/<name>-<id> —
  // so the tail of the slug identifies it, not the whole of it.
  const slug = slugFromUrl(text);
  if (slug) {
    const hit = prepared.find((p) => slug === p.rec.s || slug.endsWith("-" + p.rec.s));
    if (hit) return { status: "matched", place: hit.rec, score: 1, options: [hit.rec] };
  }

  const qNorm = norm(text);
  const qFlat = qNorm.replace(/ /g, "");
  const qTokens = toks(qNorm);
  if (!qNorm) return out;

  const scored = [];
  for (const p of prepared) {
    const s = scoreOne(qNorm, qFlat, qTokens, p);
    if (s >= ASK) scored.push({ rec: p.rec, s });
  }
  if (!scored.length) return out;
  scored.sort((a, b) => b.s - a.s || String(a.rec.s).localeCompare(String(b.rec.s)));

  out.score = scored[0].s;
  // Only guesses worth a person's attention get shown. Below OFFER the bot
  // asks an open question instead of reading out three wrong shops.
  out.options = scored.filter((x) => x.s >= OFFER).slice(0, 3).map((x) => x.rec);
  const clear = scored.length === 1 || scored[0].s - scored[1].s >= GAP;
  if (scored[0].s >= FILE && clear) {
    out.status = "matched";
    out.place = scored[0].rec;
  } else {
    out.status = "ambiguous";
  }
  return out;
}
