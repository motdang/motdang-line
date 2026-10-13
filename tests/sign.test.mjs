// The reading has to carry the BACKGROUND, or the photo cannot be placed.
//
// LINE strips EXIF from a photo send, so a picture from somebody's album
// arrives with no coordinates. The only way back to a pin is the other signs
// standing in the same frame: "Pharma Choice" is 19 branches and cannot be
// placed, but Pharma Choice beside Johns Place, a rooftop bar and Sleep Mai
// is one block. Every case here protects some part of that path.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSign, anchorsOf, describeSign } from "../src/sign.js";

const fenced = (o) => "```json\n" + JSON.stringify(o) + "\n```";

test("a reading keeps the neighbours it was given", () => {
  const s = parseSign(fenced({
    name_th: null, name_en: "Pharma Choice", phone: null, hours: null,
    line_id: null, what_kind: "pharmacy", other_text: "29/3",
    neighbours: ["Johns Place", "THC Roof top bar", "Sleep Mai"],
  }));
  assert.deepEqual(s.neighbours, ["Johns Place", "THC Roof top bar", "Sleep Mai"]);
});

test("neighbours survive the model returning a bare string or nothing at all", () => {
  assert.deepEqual(parseSign(fenced({ name_en: "A", neighbours: "Solo Shop" })).neighbours,
                   ["Solo Shop"]);
  assert.deepEqual(parseSign(fenced({ name_en: "A" })).neighbours, []);
  assert.deepEqual(parseSign(fenced({ name_en: "A", neighbours: null })).neighbours, []);
  assert.deepEqual(parseSign(fenced({ name_en: "A", neighbours: ["", "  ", "B"] })).neighbours,
                   ["B"]);
});

test("a frame where ONLY the neighbours are legible is still worth keeping", () => {
  // The subject's own sign is obscured, blown out, or round the corner. This
  // cannot name the shop and must not be thrown away: it can still say which
  // block the photo was taken on.
  const s = parseSign(fenced({ name_th: null, name_en: null, neighbours: ["Johns Place"] }));
  assert.ok(s, "a neighbours-only reading must not be discarded as empty");
  assert.equal(s.name_en, null);
});

test("a reading with nothing in it at all is still null", () => {
  assert.equal(parseSign(fenced({ name_th: null, name_en: null, neighbours: [] })), null);
  assert.equal(parseSign("no json here"), null);
});

test("anchors mark both scripts of the subject as subject", () => {
  // Either script may be the one the catalogue holds, so both are offered —
  // but a place must never corroborate itself, and the resolver decides
  // confidence from corroborating anchors only. Both must say "subject".
  const a = anchorsOf({
    name_en: "Pharma Choice", name_th: "ฟาร์มาช้อยซ์", neighbours: ["Johns Place"],
  });
  const subjects = a.filter((x) => x.role === "subject").map((x) => x.text);
  assert.deepEqual(subjects, ["Pharma Choice", "ฟาร์มาช้อยซ์"]);
  assert.deepEqual(a.filter((x) => x.role === "neighbour").map((x) => x.text), ["Johns Place"]);
});

test("a house number is pulled out whole, as its own kind", () => {
  const a = anchorsOf({ name_en: "Pharma Choice", other_text: "29/3 ROOF TOP", neighbours: [] });
  const hn = a.filter((x) => x.kind === "housenumber");
  assert.deepEqual(hn.map((x) => x.text), ["29/3"]);
  // never tokenised into 29 and 3 — that would match half the catalogue
  assert.ok(!a.some((x) => x.text === "29" || x.text === "3"));
});

test("a bare number is not a house number", () => {
  const a = anchorsOf({ name_en: "A", other_text: "open 24 hours 100 baht", neighbours: [] });
  assert.equal(a.filter((x) => x.kind === "housenumber").length, 0);
});

test("anchors do not repeat themselves", () => {
  const a = anchorsOf({
    name_en: "Same", name_th: "Same", neighbours: ["Next Door", "next door"],
    other_text: "29/3 29/3",
  });
  assert.equal(new Set(a.map((x) => x.role + x.kind + x.text.toLowerCase())).size, a.length);
});

test("an empty reading yields no anchors, and null does not throw", () => {
  assert.deepEqual(anchorsOf(null), []);
  assert.deepEqual(anchorsOf({ name_en: null, name_th: null, neighbours: [] }), []);
});

test("the line said in the room names the neighbours", () => {
  const line = describeSign({
    name_en: "Pharma Choice", what_kind: "pharmacy",
    neighbours: ["Johns Place", "THC Roof top bar"],
  });
  assert.match(line, /beside Johns Place, THC Roof top bar/);
});
