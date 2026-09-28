// The inbox routes and the approved-senders rule (27 Sep 2026; split out of worker.mjs when it reached
// 400 lines). All routes need the worker key; the site checks the signed-in owner before calling.
//
//   GET    /inbox?address=              newest first, up to 50
//   DELETE /inbox?address=&id=          remove one
//   POST   /inbox?address=&id=          release one clean mail to the agent (B4, spec 27 D3)
//   POST   /inbox?address=&id=&action=done   the agent marks one handled (hidden from its default list)
//   POST   /inbox?address=&id=&action=seen   the agent was shown it (first time only)
//   POST   /inbox?address=&id=&action=undone the owner hands it back: not done, not seen (28 Sep)
//   GET    /senders?address=            the owner's approved senders
//   POST   /senders  {address, senders} replace them: exact addresses, "@domain", or "*" (anyone)
//   GET    /blocked?address=  POST /blocked {address, senders}   the same, for blocked senders
//   GET    /last?addresses=a,b          when each address last got mail: KV reads, not lists, so the
//                                       mail view can check often without spending the list quota
//
// Approved senders (the owner, 27 Sep): mail from senders the owner approved AND Cloudflare verified goes to
// the inbox, and (after the safety check) to the agent: approval is trust; only requests need release; from anyone else it is a *request* (the owner: "I need to see what it says before I can know to
// approve it"): safety-checked and kept like any mail, readable by the owner, and its words reach the
// agent only if the owner releases it. "*" means anyone, verified or not (the owner's explicit choice; the
// default for team addresses). Hosted addresses start with no one approved. Blocked senders are dropped
// on arrival, codes and all.
import { senderOf } from "./converter.mjs";

const LIST_MAX = 50;
const ID = /^[a-z0-9_-]{1,64}$/i;
const SENDER = /^(\*|@[a-z0-9.-]+\.[a-z]{2,}|[^\s@]{1,64}@[a-z0-9.-]+\.[a-z]{2,})$/;

export async function sendersOf(env, address, hosted) {
  const v = await env.STEPS.get(`senders:${address}`);
  return v ? JSON.parse(v) : hosted ? [] : ["*"];
}

/** May this mail's words be kept for this address? */
export async function wordsAllowed(env, address, hosted, bytes) {
  const list = await sendersOf(env, address, hosted);
  // For a hosted (agent) address approval means delivery to the agent (the owner, 27 Sep), so "*" can't
  // approve anyone there: every stranger stays a request. Team addresses keep "*".
  if (list.includes("*") && !hosted) return true;
  const s = senderOf(bytes);
  if (s.verified !== true || !s.from) return false;
  const from = s.from.toLowerCase();
  return list.includes(from) || list.includes(from.slice(from.lastIndexOf("@")));
}

/** Record that an address just got mail (read by /last). */
export const touch = (env, address, now = Date.now()) => env.STEPS.put(`last:${address}`, String(now), { expirationTtl: 8 * 86_400 });

/** Is this mail's From on the address's blocked list (exact or @domain)? Unverified counts: dropping is safe. */
export async function isBlocked(env, address, bytes) {
  const v = await env.STEPS.get(`blocked:${address}`);
  if (!v) return false;
  const list = JSON.parse(v), from = (senderOf(bytes).from || "").toLowerCase();
  const hit = Boolean(from) && (list.includes(from) || list.includes(from.slice(from.lastIndexOf("@"))));
  if (hit) { // counted per day, so a block that swallows real mail shows up (build check sonnet05)
    const k = `blocked:count:${address}:${new Date().toISOString().slice(0, 10)}`;
    await env.STEPS.put(k, String(parseInt((await env.STEPS.get(k)) || "0", 10) + 1), { expirationTtl: 30 * 86_400 });
  }
  return hit;
}

async function mark(env, address, id, action, now) {
  if (!ID.test(id)) return [400, { error: "id required" }];
  const k = `inbox:${address}:${id}`;
  const v = await env.STEPS.get(k);
  if (!v) return [404, { error: "no such mail" }];
  const item = JSON.parse(v);
  if (action === "done") item.done = item.done || { at: now };
  else if (action === "seen") item.seen = item.seen || { at: now };
  else if (action === "undone") { delete item.done; delete item.seen; item.back = { at: now }; }
  else {
    if (item.check !== "clean") return [409, { error: "only mail the safety check passed can be released" }];
    item.released = item.released || { at: now, mode: "normal" }; // world mode joins as a choice when it exists
  }
  const left = Math.max(60, Math.floor((item.at + 7 * 86_400_000 - now) / 1000)); // keep the original expiry
  await env.STEPS.put(k, JSON.stringify(item), { expirationTtl: left });
  if (action !== "release") return [200, { [action]: id, at: action === "undone" ? now : item[action].at }]; // a repeat keeps the first time (build check sonnet, 28 Sep)
  return [200, { released: id, at: item.released.at }];
}

/** Handles /inbox and /senders once the caller is authorised. Returns [status, body]. */
export async function inboxRoute(env, url, method, readJson, now = Date.now()) {
  const q = (k) => String(url.searchParams.get(k) || "");
  if (url.pathname === "/last") {
    const list = q("addresses").toLowerCase().split(",").filter(Boolean).slice(0, 10);
    const out = {};
    for (const a of list) out[a] = parseInt((await env.STEPS.get(`last:${a}`)) || "0", 10);
    return [200, { last: out }];
  }
  if (url.pathname === "/senders" || url.pathname === "/blocked") {
    const kind = url.pathname.slice(1);
    const b = method === "POST" ? await readJson() : {};
    const address = String(b.address || q("address")).toLowerCase();
    const rec = await env.ADDRESSES.get(address);
    if (!rec) return [404, { error: "no such address" }];
    const stored = await env.STEPS.get(`${kind}:${address}`);
    if (method === "GET") return [200, { address, senders: kind === "senders" ? await sendersOf(env, address, JSON.parse(rec).hosted) : JSON.parse(stored || "[]"), set: Boolean(stored) }];
    const list = [...new Set((Array.isArray(b.senders) ? b.senders : []).map((s) => String(s).trim().toLowerCase()))];
    const ok = (s) => SENDER.test(s) && !(kind === "blocked" && s === "*");
    if (list.length > 50 || !list.every(ok)) return [400, { error: "up to 50: exact addresses or @domain" + (kind === "senders" ? ", or *" : "") }];
    await env.STEPS.put(`${kind}:${address}`, JSON.stringify(list));
    return [200, { address, senders: list }];
  }
  const address = q("address").toLowerCase();
  if (!(await env.ADDRESSES.get(address))) return [404, { error: "no such address" }];
  const prefix = `inbox:${address}:`;
  if (method === "POST") return mark(env, address, q("id"), ["done", "seen", "undone"].includes(q("action")) ? q("action") : "release", now);
  if (method === "DELETE") {
    if (!ID.test(q("id"))) return [400, { error: "id required" }];
    await env.STEPS.delete(prefix + q("id"));
    return [200, { deleted: q("id") }];
  }
  const listed = await env.STEPS.list({ prefix });
  const names = listed.keys.map((k) => k.name).sort().reverse().slice(0, LIST_MAX);
  const items = [];
  for (const n of names) {
    const v = await env.STEPS.get(n);
    if (v) items.push(JSON.parse(v));
  }
  return [200, { address, items }];
}
