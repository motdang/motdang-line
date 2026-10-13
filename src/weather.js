// Rain and flood answers, forwarded to mot-dang-claims (/rain, /flood), and
// SPOTTERS: the count and the credit for sending them.
//
// Every forward carries x-md-relay (RELAY_SECRET, the same value
// mot-dang-claims holds) and x-md-user (the first 16 hex of the sha256 of the
// LINE user id), so that Worker counts each person on their own instead of
// counting every LINE answer as one caller. The LINE id itself is not sent.
//
// With SPOTTERS on, each accepted answer is a row in weather_reports, the
// reply gives this month's count, "ชื่อบนหน้าอากาศ · credit me" puts the
// person's display name on GET /spotters, and "credit off" takes it off.

import { say, sayMany, quick, flag, rate, SLOW, fresh, setPending, askLocation, ensureName, month, sha256hex, origin } from "./dm.js";

export const OBS = {
  rain: { none: "ไม่ตก · None", light: "ปรอยๆ · Light", heavy: "หนัก · Heavy" },
  flood: { dry: "แห้ง · Dry", ankle: "ข้อเท้า · Ankle", knee: "เข่า · Knee", waist: "เอว · Waist",
    chest: "อก · Chest", roof: "หลังคา · Roof" },
};
const QUESTION = {
  rain: "ตอนนี้ฝนตกไหม\nIs it raining where you are?",
  flood: "น้ำท่วมสูงแค่ไหน\nHow deep is the water where you are?",
};
export const OBS_PER_HOUR = 6;
const claimsBase = (env) => String(env.CLAIMS_BASE || "https://mot-dang-claims.nanobotco.workers.dev").replace(/\/$/, "");

export function askObs(ev, env, kind) {
  return sayMany(env, ev, [quick(QUESTION[kind], Object.entries(OBS[kind]).map(([answer, label]) => ({
    type: "postback", label, data: `${kind}=${answer}`, displayText: label,
  })))]);
}

// An answer. It goes with the last location this person shared if that is
// recent; otherwise it waits for one.
export async function observe(ev, env, uid, row, kind, answer) {
  const now = ev.timestamp || Date.now();
  if (fresh(row, now)) return forward(ev, env, uid, kind, answer, row.last_lat, row.last_lng);
  await setPending(env, uid, `${kind}:${answer}`, now);
  return askLocation(env, ev);
}

export async function forward(ev, env, uid, kind, answer, lat, lng) {
  if (!(await rate(env, uid, "obs", OBS_PER_HOUR))) return say(env, ev, SLOW);
  const headers = { "content-type": "application/json" };
  if (env.RELAY_SECRET) {
    headers["x-md-relay"] = env.RELAY_SECRET;
    headers["x-md-user"] = (await sha256hex(uid)).slice(0, 16);
  }
  let status = 0;
  try {
    const r = await fetch(`${claimsBase(env)}/${kind}`, { method: "POST", headers, body: JSON.stringify({ answer, lat, lng }) });
    status = r.status;
  } catch (e) {
    console.log(kind, "forward failed", e.message);
  }
  if (status >= 200 && status < 300) {
    if (!flag(env, "SPOTTERS")) return say(env, ev, `บันทึกแล้ว · Recorded: ${OBS[kind][answer]}\nขอบคุณ · Thank you.`);
    const now = Date.now(), mo = month(now);
    await env.DB.prepare("INSERT INTO weather_reports (user_id, kind, answer, ts, month) VALUES (?, ?, ?, ?, ?)")
      .bind(uid, kind, answer, now, mo).run();
    const n = (await env.DB.prepare("SELECT COUNT(*) n FROM weather_reports WHERE user_id = ? AND month = ?").bind(uid, mo).first())?.n ?? 0;
    return say(env, ev, [
      `บันทึกแล้ว · Recorded: ${OBS[kind][answer]}`,
      `ขอบคุณ · Thanks — เดือนนี้ ${n} ครั้ง · ${n} report${n === 1 ? "" : "s"} this month`,
      "ชื่อบนหน้าอากาศ · credit me",
    ].join("\n"));
  }
  if (status === 400) return say(env, ev, "ตำแหน่งนี้อยู่นอกเชียงใหม่และเชียงราย · That location is outside Chiang Mai and Chiang Rai.");
  if (status === 429) return say(env, ev, "ตอนนี้มีคนส่งมาเยอะ ลองใหม่ภายหลัง · Too many answers right now. Try again later.");
  return say(env, ev, "ส่งไม่สำเร็จ ลองใหม่ · That did not go through. Try again?");
}

export async function credit(ev, env, uid, on) {
  const row = await ensureName(env, uid);
  await env.DB.prepare("UPDATE dm_users SET credit = ? WHERE user_id = ?").bind(on ? 1 : 0, uid).run();
  if (!on) return say(env, ev, "เอาชื่อออกจากรายชื่อแล้ว · Your name is off the spotters list.");
  if (!row.name || !row.name_ok) {
    return say(env, ev, "ชื่อนี้ขึ้นรายชื่อไม่ได้ ส่ง “ชื่อ <ชื่อใหม่>” เพื่อเปลี่ยน · That name cannot go on the list. Send “name <new name>” to change it.");
  }
  return say(env, ev, `ชื่อ ${row.name} อยู่ในรายชื่อผู้ส่งรายงานอากาศแล้ว · ${row.name} is on the weather spotters list.\n${origin(env)}/spotters`);
}

// GET /spotters — opted-in names with this month's counts, nothing else.
export async function spotters(env) {
  const mo = month();
  const rows = await env.DB.prepare(
    `SELECT u.name AS name, COUNT(*) AS reports FROM weather_reports w JOIN dm_users u ON u.user_id = w.user_id
      WHERE w.month = ? AND u.credit = 1 AND u.name_ok = 1 AND u.name IS NOT NULL
      GROUP BY w.user_id ORDER BY reports DESC, name ASC LIMIT 200`,
  ).bind(mo).all();
  return new Response(JSON.stringify({ month: mo, spotters: rows.results || [] }), {
    headers: { "content-type": "application/json", "cache-control": "public, max-age=300", "access-control-allow-origin": "*" },
  });
}
