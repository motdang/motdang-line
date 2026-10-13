// The page a LINE friend gets at /u/<slug>: their name, what they sent that the
// screen passed, newest first, and a small map when they shared a location.
// Thai first with English beside it. No script on the page; every value from
// a sender goes through esc().

const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const esc = (v) => (v == null ? "" : String(v).replace(/[&<>"']/g, (c) => ESC[c]));

const OA = "@964yxgnk";
const ADD_FRIEND = "https://line.me/R/ti/p/%40964yxgnk";

// Map pins are drawn to three decimals, about 100 m.
export const roundPin = (x) => Math.round(Number(x) * 1000) / 1000;

function when(ts) {
  const d = new Date(ts);
  const th = d.toLocaleDateString("th-TH", { timeZone: "Asia/Bangkok", day: "numeric", month: "short", year: "numeric" });
  const en = d.toLocaleDateString("en-GB", { timeZone: "Asia/Bangkok", day: "numeric", month: "short", year: "numeric" });
  return `${th} · ${en}`;
}

// A static map from OpenStreetMap tiles: the highest zoom that fits every pin
// in a 320 x 200 box, the tiles under that box, and the pins drawn over them
// in SVG. Six tile images at most, and no script.
export function tileMap(points) {
  if (!points.length) return "";
  const W = 320, H = 200, PAD = 28;
  const world = (lat, lng, z) => {
    const n = 256 * 2 ** z;
    const s = Math.sin((lat * Math.PI) / 180);
    return [((lng + 180) / 360) * n, (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n];
  };
  let z = 16, xy;
  for (; z >= 3; z--) {
    xy = points.map((p) => world(p.lat, p.lng, z));
    const xs = xy.map((p) => p[0]), ys = xy.map((p) => p[1]);
    if (Math.max(...xs) - Math.min(...xs) <= W - 2 * PAD && Math.max(...ys) - Math.min(...ys) <= H - 2 * PAD) break;
  }
  z = Math.max(z, 3);
  xy = points.map((p) => world(p.lat, p.lng, z));
  const xs = xy.map((p) => p[0]), ys = xy.map((p) => p[1]);
  const left = Math.round((Math.min(...xs) + Math.max(...xs)) / 2 - W / 2);
  const top = Math.round((Math.min(...ys) + Math.max(...ys)) / 2 - H / 2);
  const tiles = [];
  for (let tx = Math.floor(left / 256); tx <= Math.floor((left + W - 1) / 256); tx++) {
    for (let ty = Math.floor(top / 256); ty <= Math.floor((top + H - 1) / 256); ty++) {
      tiles.push(`<img src="https://tile.openstreetmap.org/${z}/${tx}/${ty}.png" alt="" width="256" height="256" ` +
        `style="left:${tx * 256 - left}px;top:${ty * 256 - top}px">`);
    }
  }
  const pins = xy.map(([x, y]) =>
    `<circle cx="${(x - left).toFixed(1)}" cy="${(y - top).toFixed(1)}" r="7" fill="#d62828" stroke="#fff" stroke-width="3"/>`,
  ).join("");
  const c = points[0];
  const open = `https://www.openstreetmap.org/?mlat=${c.lat}&amp;mlon=${c.lng}#map=${Math.min(z, 17)}/${c.lat}/${c.lng}`;
  return `<section class="map" aria-label="แผนที่ · Map">
<div class="tiles">${tiles.join("")}<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" aria-hidden="true">${pins}</svg></div>
<p class="small"><a href="${open}">เปิดแผนที่ · Open the map</a> · © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a></p>
</section>`;
}

const STYLE = `
:root{--bg:#fffdf6;--ink:#1d1b16;--soft:#6b6457;--red:#d62828;--card:#fff;--line:#eee6d4}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:18px/1.6 system-ui,-apple-system,"Noto Sans Thai","Sarabun",sans-serif}
main{max-width:640px;margin:0 auto;padding:20px 16px 48px}
a{color:var(--red)}
.kicker{margin:0;font-size:15px;font-weight:600}
.kicker a{text-decoration:none}
h1{margin:4px 0 20px;font-size:30px;line-height:1.25;overflow-wrap:anywhere}
.en{color:var(--soft)}
.small{font-size:14px;color:var(--soft)}
.map{margin:0 0 24px}
.tiles{position:relative;width:320px;max-width:100%;height:200px;overflow:hidden;border-radius:12px;background:#e8e4da}
.tiles img{position:absolute}
.tiles svg{position:absolute;left:0;top:0}
.feed{list-style:none;margin:0;padding:0}
.feed li{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:14px;margin:0 0 16px}
.feed img{display:block;width:100%;height:auto;border-radius:8px}
.post{margin:0;white-space:pre-wrap;overflow-wrap:anywhere}
time{display:block;margin-top:8px;font-size:14px;color:var(--soft)}
.empty{color:var(--soft)}
.sets{margin:0 0 24px}
.sets h2{font-size:20px;margin:0 0 8px}
.sets ul{margin:0;padding-left:20px}
.sets li{margin:0 0 6px;overflow-wrap:anywhere}
footer{margin-top:32px;border-top:1px solid var(--line);padding-top:16px;font-size:15px}
footer p{margin:0 0 10px}
`;

function shell(title, body) {
  return `<!doctype html>
<html lang="th"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>${esc(title)}</title>
<style>${STYLE}</style>
</head><body><main>
${body}
</main></body></html>`;
}

// user: the dm_users row. items: that user's shown page_items, newest first.
// sets: their kept pin sets and plans, when PINS is on.
export function renderPage(user, items, { sets = [] } = {}) {
  const name = user.name_ok && user.name ? user.name : `หน้า ${user.slug}`;
  const nameEn = user.name_ok && user.name ? "" : ` <span class="en">Page ${esc(user.slug)}</span>`;
  const pins = items.filter((i) => i.kind === "location" && i.lat != null)
    .slice(0, 50).map((i) => ({ lat: roundPin(i.lat), lng: roundPin(i.lng) }));
  const feed = items.filter((i) => i.kind !== "location").map((i) => {
    if (i.kind === "photo") {
      const ext = i.photo_type === "image/png" ? "png" : "jpg";
      return `<li><img src="/u/${esc(user.slug)}/${Number(i.id)}.${ext}" alt="รูป · Photo" loading="lazy"><time>${when(i.ts)}</time></li>`;
    }
    return `<li><p class="post">${esc(i.text)}</p><time>${when(i.ts)}</time></li>`;
  });
  const body = `<header>
<p class="kicker"><a href="https://motdang.net">มดแดง · Mot Dang</a></p>
<h1>${esc(name)}${nameEn}</h1>
</header>
${tileMap(pins)}
${sets.length ? `<section class="sets"><h2>หมุดและแผน <span class="en">· Pins and plans</span></h2><ul>
${sets.map((x) => `<li><a href="${esc(x.url)}">${esc(x.name)}</a> <span class="en">(${Number(x.count)})</span></li>`).join("\n")}
</ul></section>` : ""}
${feed.length ? `<ol class="feed">\n${feed.join("\n")}\n</ol>` : `<p class="empty">ยังไม่มีอะไร <span class="en">· Nothing here yet.</span></p>`}
<footer>
<p>หน้านี้ทำจากรูปและข้อความที่ส่งถึง ${OA} ใน LINE <span class="en">· Made from photos and messages sent to ${OA} in LINE.</span></p>
<p>อยากมีหน้าของตัวเอง เพิ่มเพื่อน <a href="${ADD_FRIEND}">${OA}</a> แล้วส่งรูปมา <span class="en">· For a page of your own, add <a href="${ADD_FRIEND}">${OA}</a> on LINE and send a photo.</span></p>
<p>เจ้าของหน้าส่งคำว่า “ลบ” ใน LINE เพื่อลบหน้านี้ <span class="en">· The owner can send “delete” in LINE to remove it.</span></p>
</footer>`;
  return shell(`${name} · มดแดง Mot Dang`, body);
}

export function notFoundPage() {
  return shell("ไม่พบหน้า · No such page", `<header>
<p class="kicker"><a href="https://motdang.net">มดแดง · Mot Dang</a></p>
<h1>ไม่พบหน้านี้ <span class="en">No such page</span></h1>
</header>
<p>อาจถูกลบไปแล้ว <span class="en">· It may have been deleted.</span></p>`);
}
