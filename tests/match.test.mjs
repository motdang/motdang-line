// What the matcher must never do is file a photo under the wrong place. Every
// case here is one the real 25,582-record index produced.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { match, prepare, norm, slugFromUrl, FILE } from "../src/match.js";

const IDX = prepare([
  { s: "thapae-gate-1017379824", n: "ประตูท่าแพ", e: "Thapae Gate", a: "塔佩门 Tha Phae Tor" },
  { s: "warorot-1", n: "ตลาดวโรรส", e: "Warorot Market" },
  { s: "warorot-2", n: "ตลาดวโรรส", e: "Warorot Market" },
  { s: "punspace-9", n: "ปันสเปซ สาขาประตูท่าแพ", e: "Pun Space Tha Phae Gate" },
  { s: "carpark-7", n: "ลานจอดรถ · ใกล้ประตูท่าแพ 570 ม.", e: "Car park · 570 m from Tha Phae Gate" },
  { s: "some-name-3", n: "Some name" },
  { s: "nimman-1", e: "Nimman Haemin" },
  { s: "market-only", e: "Market" },
  // The corpus decides which words are too common to file on, so the fixture
  // has to look like the corpus: twenty-odd records carrying "market" is what
  // the live index holds, and what makes the bare word unusable as a name.
  ...Array.from({ length: 25 }, (_, i) => ({ s: `mkt-${i}`, e: `Sunday Market ${i}` })),
]);

const m = (t) => match(t, IDX);

test("the name on its own files it", () => {
  assert.equal(m("ตลาดวโรรส").status, "ambiguous", "two records carry that name — asking is the only correct answer");
  assert.equal(m("thapae gate").place.s, "thapae-gate-1017379824");
  assert.ok(m("thapae gate").score >= FILE);
});

test("a name inside a sentence still files", () => {
  assert.equal(m("a few shots of Thapae Gate today").place.s, "thapae-gate-1017379824");
});

test("a generated bearing in a name is a description, not a name", () => {
  // "Car park · 570 m from Tha Phae Gate" must never be what a photo of the
  // gate is filed under. 172 records in the live index read that way.
  const r = m("tha phae gate");
  assert.notEqual(r.place?.s, "carpark-7");
  assert.equal(r.status, "ambiguous", "a branch named after the landmark scores as well as the landmark");
});

test("a one-word name shared with half the corpus cannot file a photo", () => {
  // There is a live record whose entire name is "Market". Saying "market"
  // matches it exactly, and without this it would win outright.
  const r = m("market");
  assert.equal(r.status, "ambiguous");
  assert.equal(r.place, undefined);
  assert.ok(r.options.some((o) => o.s === "market-only"), "still worth offering, just not worth assuming");
});

test("chatter is not a place", () => {
  for (const t of ["some pics", "here you go", "ok", "thanks", "รูป"]) {
    assert.notEqual(m(t).status, "matched", `"${t}" must not file anything`);
  }
});

test("nothing worth offering is offered", () => {
  assert.deepEqual(m("here you go").options, []);
  assert.ok(m("thapae").options.length <= 3, "at most three, so an answer stays one character");
});

test("where the spaces fall in a romanisation is not a different place", () => {
  assert.equal(m("nimmanhaemin").place.s, "nimman-1");
});

test("a link is the answer, whatever else the message says", () => {
  assert.equal(slugFromUrl("look https://motdang.net/cm/p/a-b-warorot-2 ta"), "a-b-warorot-2");
  assert.equal(m("this one https://motdang.net/cm/p/a-b-warorot-2").place.s, "warorot-2");
});

test("Thai and Latin fold the same way", () => {
  assert.equal(norm("  Wat  Phra   Singh!! "), "wat phra singh");
  assert.equal(norm("ประตูท่าแพ"), "ประตูท่าแพ");
});

test("the index actually built from the site behaves", { skip: !existsSync("build/match.json") }, () => {
  const live = prepare(JSON.parse(readFileSync("build/match.json", "utf8")));
  assert.ok(live.length > 20000, "the site index should carry twenty thousand-odd places");
  assert.equal(match("ประตูท่าแพ", live).place.n, "ประตูท่าแพ");
  assert.notEqual(match("some pics", live).status, "matched");
  assert.notEqual(match("here you go", live).status, "matched");
  const t0 = Date.now();
  match("a few photos from the sunday walking street", live);
  assert.ok(Date.now() - t0 < 60, "a match has to fit inside a reply token, not a coffee break");
});
