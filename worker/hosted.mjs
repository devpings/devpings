// Hosted agent addresses on devpings.com (spec 22, D2; 25 Sep 2026).
//
// A verified person's agent gets agent-<10 random>@devpings.com. Mail to it is kept here, in this
// worker's KV, under limits the devpings service pushes in (POST /limits). The worker never talks
// to the database; it counts, and the service reads the counts (GET /usage).
//
// Limits are SOFT caps (spec 22 H5): KV is eventually consistent, so a burst can pass a cap by a
// few mails. Over-limit mail is dropped and counted, never queued. Storage (H5b) is the sum of the
// per-day byte counters for the days mail is kept, which expire with the mail.
//
// Codes and links are extracted as the mail is kept, so the service can hand an agent a code from
// any sender without handing it the letter (H4: full text only for the owner's allow list).

import { candidatesOf, normaliseAddress, readable, senderOf } from "./converter.mjs";
import { touch } from "./inbox.mjs";
import { applyVerdict } from "./gate.mjs";
import { prefsOf } from "./prefs.mjs";
import { quarantine } from "./quarantine.mjs";

export const HOSTED = /^agent-[a-z0-9]{10}$/;
export const DEFAULTS = { perHour: 30, perDay: 200, mb: 50, days: 7 };
const DAY_MS = 86_400_000;
const EMPTY_DAY = { mails: 0, bytes: 0, dropped: 0 };

const hourKey = (a, t) => `cnt:h:${a}:${new Date(t).toISOString().slice(0, 13)}`;
const dayKey = (a, t) => `cnt:d:${a}:${new Date(t).toISOString().slice(0, 10)}`;

export async function limitsFor(env, address) {
  const all = JSON.parse((await env.STEPS.get("hosted:limits")) || "{}");
  return { ...DEFAULTS, ...(all.defaults || {}), ...((all.per || {})[address] || {}) };
}

async function storedBytes(env, address, days, now) {
  let sum = 0;
  for (let i = 0; i < days; i++) {
    const d = await env.STEPS.get(dayKey(address, now - i * DAY_MS));
    if (d) sum += JSON.parse(d).bytes || 0;
  }
  return sum;
}

/** Why this mail can't be kept, or null. Order: switches first, then caps. */
async function refusal(env, address, L, size, day, hourCount, now) {
  if (await env.STEPS.get("hosted:pause")) return "paused";
  if (await env.STEPS.get(`disabled:${address}`)) return "disabled";
  if (hourCount >= L.perHour) return "hour";
  if (day.mails >= L.perDay) return "day";
  if ((await storedBytes(env, address, L.days, now)) + size > L.mb * 1_000_000) return "storage";
  return null;
}

/** Keep one mail for a hosted address, or drop and count it. Returns the reason if dropped. */
export async function keepHosted(env, address, envelopeFrom, bytes, now = Date.now(), id, mod = { verdict: "clean" }) {
  const L = await limitsFor(env, address);
  const dk = dayKey(address, now);
  const hk = hourKey(address, now);
  const day = { ...EMPTY_DAY, ...JSON.parse((await env.STEPS.get(dk)) || "{}") };
  const hourCount = parseInt((await env.STEPS.get(hk)) || "0", 10);
  const dayTtl = { expirationTtl: (Math.max(1, L.days) + 1) * 86_400 };

  const why = await refusal(env, address, L, bytes.length, day, hourCount, now);
  if (why) {
    day.dropped++;
    await env.STEPS.put(dk, JSON.stringify(day), dayTtl);
    return why;
  }
  day.mails++;
  day.bytes += bytes.length;
  await env.STEPS.put(dk, JSON.stringify(day), dayTtl);
  await env.STEPS.put(hk, String(hourCount + 1), { expirationTtl: 7200 });

  const { subject, body } = readable(bytes);
  const sender = senderOf(bytes);
  const { codes, links } = candidatesOf(`${subject}\n${body}`, []);
  const item = {
    id, from: sender.from || normaliseAddress(envelopeFrom), envelopeFrom: normaliseAddress(envelopeFrom),
    verified: sender.verified, subject, body, codes, links, at: now,
  };
  // Spec 28 Q: a trusted sender's clean mail, for an owner who chose world mode, is also read by the
  // quarantined model. Its answer waits on the item for the site's gate (next_world_request).
  if (mod.verdict === "clean" && mod.request === false && item.verified && (await prefsOf(env, address)).trusted === "world") {
    // Q has its own cap (build check 29 step 1): refusals cost worker calls too, so 10 reads a day per address.
    const qk = `q:count:${address}:${new Date(now).toISOString().slice(0, 10)}`, qn = parseInt((await env.STEPS.get(qk)) || "0", 10);
    if (qn >= 10) item.world = { answer: { kind: "unclear" }, capped: true, at: now };
    else { await env.STEPS.put(qk, String(qn + 1), { expirationTtl: 2 * 86_400 }); item.world = { answer: await quarantine(env, subject, body), at: now }; }
  }
  await env.STEPS.put(`inbox:${address}:${id}`, JSON.stringify(applyVerdict(item, mod)), { expirationTtl: Math.max(1, L.days) * 86_400 });
  await touch(env, address);
  return null;
}

/** Keep one mail for a team address this worker minted (opus@, support@, security@), for a week. */
export async function keepInInbox(env, address, from, bytes, id, mod = { verdict: "clean" }, now = Date.now()) {
  const { subject, body } = readable(bytes);
  // `from` is the From: header (what a person sees), not the envelope sender (often a bounce
  // address). `verified` is Cloudflare's own verdict on it; see senderOf in converter.mjs.
  const sender = senderOf(bytes);
  const item = { id, from: sender.from || normaliseAddress(from), envelopeFrom: normaliseAddress(from), verified: sender.verified, dmarc: sender.dmarc, dkim: sender.dkim, subject, body, at: now };
  await env.STEPS.put(`inbox:${address}:${id}`, JSON.stringify(applyVerdict(item, mod)), { expirationTtl: 7 * 86_400 });
  await touch(env, address);
}

/** POST /limits: { replace?, defaults?, per?: {address: {...}|null}, disable?: [], enable?: [], pause?: bool } */
export async function setLimits(env, b) {
  // `replace: true` sends the whole picture (the service's normal push), so removed overrides go too.
  const all = b.replace ? {} : JSON.parse((await env.STEPS.get("hosted:limits")) || "{}");
  const clean = (o) => Object.fromEntries(Object.entries(o || {}).filter(([k, v]) => k in DEFAULTS && Number.isFinite(v) && v >= 0));
  if (b.defaults) all.defaults = { ...(all.defaults || {}), ...clean(b.defaults) };
  if (b.per) {
    all.per = all.per || {};
    for (const [a, v] of Object.entries(b.per)) {
      if (!HOSTED.test(a.split("@")[0])) continue;
      if (v === null) delete all.per[a]; else all.per[a] = { ...(all.per[a] || {}), ...clean(v) };
    }
  }
  await env.STEPS.put("hosted:limits", JSON.stringify(all));
  for (const a of b.disable || []) await env.STEPS.put(`disabled:${String(a).toLowerCase()}`, "1");
  for (const a of b.enable || []) await env.STEPS.delete(`disabled:${String(a).toLowerCase()}`);
  if (b.pause === true) await env.STEPS.put("hosted:pause", "1");
  if (b.pause === false) await env.STEPS.delete("hosted:pause");
  return { limits: all, pause: Boolean(await env.STEPS.get("hosted:pause")) };
}

/** GET /usage: every per-day counter still held, as rows. */
export async function usage(env) {
  const listed = await env.STEPS.list({ prefix: "cnt:d:" });
  const rows = [];
  for (const { name } of listed.keys) {
    const [, , address, day] = name.split(":");
    rows.push({ address, day, ...EMPTY_DAY, ...JSON.parse((await env.STEPS.get(name)) || "{}") });
  }
  return rows;
}

