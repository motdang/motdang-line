// STAMPS: rounds of stops, each stamped by sharing a location inside its
// radius. Once per stop per person; "N of M" after each; a card page when the
// round is complete.
//
// A round is a JSON file in rounds/ made by scripts/build_data.py, with its
// source named inside it:
//   mhs   the Mae Hong Son loop passport, seven towns, Chiang Mai stamped once
//         for start and end, either direction
//   wats  any nine distinct wats from the stop lists of the nine-wat rounds on
//         motdang.net/wats/. One round rather than one per /wats round: a
//         reader who strays from a listed round still gets the stamp.
//
// "พาสปอร์ต · passport <round>" starts one; only started rounds stamp.

import mhs from "../rounds/mhs.json" with { type: "json" };
import wats from "../rounds/wats.json" with { type: "json" };
import { say, sayMany, quick, LOCATION_BUTTON, metres, ensurePage, origin, when } from "./dm.js";
import { esc } from "./page.js";
import { shareBits } from "./plus.js";

export const ROUNDS = { mhs, wats };
const THAI_DIGITS = "๐๑๒๓๔๕๖๗๘๙";
const thaiNum = (n) => String(n).replace(/\d/g, (d) => THAI_DIGITS[d]);

export const cardLink = (env, slug, round) => `${origin(env)}/u/${slug}/card/${round}`;

const roundButtons = () => Object.values(ROUNDS).map((r) => ({
  type: "message", label: r.id === "mhs" ? "แม่ฮ่องสอน · MHS" : "๙ วัด · Nine wats", text: `พาสปอร์ต · passport ${r.id}`,
}));

export async function passport(ev, env, uid, which) {
  const id = String(which || "").trim().toLowerCase();
  const r = ROUNDS[id];
  if (!r) {
    return sayMany(env, ev, [quick("เลือกรอบ · Choose a round", roundButtons())]);
  }
  await env.DB.prepare("INSERT OR IGNORE INTO rounds_started (user_id, round, started_at) VALUES (?, ?, ?)")
    .bind(uid, id, Date.now()).run();
  const have = await stampedCount(env, uid, id);
  const lines = [`${r.th} · ${r.en}`, ""];
  if (r.stops.length <= 12) {
    r.stops.forEach((s, i) => lines.push(`${i + 1}. ${s.th} · ${s.en}`));
  } else {
    lines.push(`วัดใดก็ได้ ${r.need} วัด จาก ${r.stops.length} วัดในรอบไหว้พระ ๙ วัด`,
      `Any ${r.need} of the ${r.stops.length} wats on the nine-wat rounds:`, r.link);
  }
  lines.push("", "ส่งตำแหน่งเมื่อถึงแต่ละจุด แล้วจะได้ตราประทับ",
    "Share your location at each stop to get its stamp.",
    `${have} จาก ${r.need} · ${have} of ${r.need}`);
  return sayMany(env, ev, [quick(lines.join("\n"), [LOCATION_BUTTON])]);
}

async function stampedCount(env, uid, round) {
  return (await env.DB.prepare("SELECT COUNT(*) n FROM stamps WHERE user_id = ? AND round = ?").bind(uid, round).first())?.n ?? 0;
}

// Stamp whatever this location earns in the rounds this person started.
// [{round, stop, n, need, complete}] — empty when nothing was stamped.
export async function stampAt(env, uid, lat, lng, now = Date.now()) {
  const started = (await env.DB.prepare("SELECT round, completed_at FROM rounds_started WHERE user_id = ?").bind(uid).all()).results || [];
  const out = [];
  for (const s of started) {
    const r = ROUNDS[s.round];
    if (!r) continue;
    // The nearest stop whose circle this falls in. Wats inside the walls
    // stand closer than their radii, so one location stamps one of them.
    let best = null;
    for (const stop of r.stops) {
      const m = metres(lat, lng, stop.lat, stop.lng);
      if (m <= stop.radius_m && (!best || m < best.m)) best = { stop, m };
    }
    if (!best) continue;
    const ins = await env.DB.prepare("INSERT OR IGNORE INTO stamps (user_id, round, stop, ts) VALUES (?, ?, ?, ?)")
      .bind(uid, r.id, best.stop.id, now).run();
    if (!ins.meta.changes) continue;
    const n = await stampedCount(env, uid, r.id);
    const complete = n >= r.need && !s.completed_at;
    if (complete) {
      await env.DB.prepare("UPDATE rounds_started SET completed_at = ? WHERE user_id = ? AND round = ?").bind(now, uid, r.id).run();
    }
    out.push({ round: r, stop: best.stop, n, need: r.need, complete });
  }
  return out;
}

export async function stampReply(ev, env, uid, results) {
  const lines = [];
  let slug = null;
  // The stop stamped, to pass on: its place ID when it has one, else its point.
  const s = results[0].stop;
  const share = shareBits(env, { lat: s.lat, lng: s.lng, code: s.code, name: `${s.th} · ${s.en}` });
  for (const x of results) {
    lines.push(`ประทับตราแล้ว · Stamped: ${x.stop.th} · ${x.stop.en}`, `${x.round.th}: ${Math.min(x.n, x.need)} จาก ${x.need} · ${Math.min(x.n, x.need)} of ${x.need}`);
    if (x.complete) {
      slug = slug || (await ensurePage(env, uid)).slug;
      lines.push("ครบรอบแล้ว · Round complete", cardLink(env, slug, x.round.id));
    }
    lines.push("");
  }
  lines.push(...share.lines);
  return sayMany(env, ev, [quick(lines.join("\n").trim(), [share.action, LOCATION_BUTTON])]);
}

// ── the card ─────────────────────────────────────────────────────────────────

function seal(r) {
  const label = (r.en || "").toUpperCase();
  const pts = Array.from({ length: 24 }, (_, i) => {
    const a = (i * Math.PI) / 12, rr = i % 2 ? 88 : 96;
    return `${(100 + rr * Math.cos(a)).toFixed(1)},${(100 + rr * Math.sin(a)).toFixed(1)}`;
  }).join(" ");
  return `<svg class="seal" viewBox="0 0 200 200" width="160" height="160" role="img" aria-label="ตรา · Seal">
<polygon points="${pts}" fill="#d62828"/>
<circle cx="100" cy="100" r="78" fill="#fffdf6"/>
<circle cx="100" cy="100" r="70" fill="none" stroke="#d62828" stroke-width="2"/>
<path id="arc" d="M 38 100 A 62 62 0 0 1 162 100" fill="none"/>
<text font-size="13" font-weight="700" fill="#d62828" letter-spacing="1.5"><textPath href="#arc" startOffset="50%" text-anchor="middle">${esc(label)}</textPath></text>
<text x="100" y="118" text-anchor="middle" font-size="48" font-weight="700" fill="#1d1b16">${thaiNum(r.need)}</text>
<text x="100" y="146" text-anchor="middle" font-size="14" fill="#1d1b16">มดแดง · MOT DANG</text>
</svg>`;
}

const CARD_STYLE = `
*{box-sizing:border-box}
body{margin:0;background:#fff4d6;color:#1d1b16;font:18px/1.55 system-ui,-apple-system,"Noto Sans Thai","Sarabun",sans-serif}
main{max-width:620px;margin:24px auto;padding:28px 20px 36px;background:#fffdf6;border:3px double #d62828;border-radius:18px;text-align:center}
.k{margin:0;font-size:15px;font-weight:700;color:#d62828}
h1{margin:6px 0 2px;font-size:28px;line-height:1.25}
.en{color:#6b6457}
.who{margin:18px 0 4px;font-size:26px;font-weight:700;overflow-wrap:anywhere}
.seal{display:block;margin:18px auto}
ol{list-style:none;margin:18px 0 0;padding:0;text-align:left}
li{padding:8px 0;border-top:1px solid #eee6d4}
li small{display:block;color:#6b6457}
a{color:#d62828}
`;

export async function renderCard(env, user, roundId) {
  const r = ROUNDS[roundId];
  if (!r) return null;
  const st = await env.DB.prepare("SELECT completed_at FROM rounds_started WHERE user_id = ? AND round = ?").bind(user.user_id, roundId).first();
  if (!st?.completed_at) return null;
  const rows = (await env.DB.prepare("SELECT stop, ts FROM stamps WHERE user_id = ? AND round = ? ORDER BY ts ASC").bind(user.user_id, roundId).all()).results || [];
  const byId = Object.fromEntries(r.stops.map((s) => [s.id, s]));
  const name = user.name_ok && user.name ? user.name : "ผู้เดินทาง · Traveller";
  const items = rows.filter((x) => byId[x.stop]).map((x) =>
    `<li>${esc(byId[x.stop].th)} <span class="en">· ${esc(byId[x.stop].en)}</span><small>${esc(when(x.ts))}</small></li>`);
  return `<!doctype html>
<html lang="th"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>${esc(r.th)} · ${esc(r.en)}</title>
<style>${CARD_STYLE}</style>
</head><body><main>
<p class="k">มดแดง · Mot Dang</p>
<h1>${esc(r.th)}</h1>
<p class="en">${esc(r.en)}</p>
${seal(r)}
<p class="who">${esc(name)}</p>
<p>ครบ ${thaiNum(r.need)} จุด <span class="en">· All ${r.need} stops</span></p>
<p class="en">${esc(when(st.completed_at))}</p>
<ol>
${items.join("\n")}
</ol>
<p class="en" style="margin-top:22px"><a href="${esc(r.link)}">${esc(r.link.replace(/^https:\/\//, ""))}</a></p>
</main></body></html>`;
}
