// The B2 gate in the mail path (spec 27 D2). The worker calls `gate` once per mail, before anything is
// kept or forwarded, and `applyVerdict` to every item it stores. See moderate.mjs for the verdicts.
import { readable, senderOf, normaliseAddress } from "./converter.mjs";
import { alarm, fingerprint, moderate, MAX_CHARS } from "./moderate.mjs";
import { noteNotice } from "./digest.mjs";

const DROP_TTL = 90 * 86_400;
// Caps in front of the model (build check sonnet02 F2; spec B0, F12). Over a cap the mail is kept
// as "unchecked" (no words, codes only), never read by the model. Measured from day one: raise with care.
export const CHECKS_PER_DAY = 1000;
export const CHECKS_PER_ADDRESS_HOUR = 40;

export async function gate(env, bytes, to, envelopeFrom, now = Date.now()) {
  const { subject, body } = readable(bytes);
  const day = new Date(now).toISOString().slice(0, 10);
  const ck = `mod:count:${day}`;
  const hk = `mod:h:${to}:${new Date(now).toISOString().slice(0, 13)}`;
  const counts = { clean: 0, flagged: 0, drop: 0, unchecked: 0, checks: 0, ...JSON.parse((await env.STEPS.get(ck)) || "{}") };
  const hour = parseInt((await env.STEPS.get(hk)) || "0", 10);
  const over = counts.checks >= CHECKS_PER_DAY ? "daily check cap" : hour >= CHECKS_PER_ADDRESS_HOUR ? "hourly check cap for this address" : null;
  const run = over ? null : env.AI && typeof env.AI.run === "function" ? (m, i) => env.AI.run(m, i) : null;
  const mod = over ? { verdict: "unchecked", categories: [], why: over } : await moderate(run, `${subject}\n${body}`);
  if (!over) {
    counts.checks++;
    await env.STEPS.put(hk, String(hour + 1), { expirationTtl: 7200 });
    if (counts.checks === Math.floor(CHECKS_PER_DAY * 0.8)) await alarm(env, "budget", { at: new Date(now).toISOString(), checks_today: counts.checks, cap: CHECKS_PER_DAY }, now);
  }
  counts[mod.verdict]++;
  await env.STEPS.put(ck, JSON.stringify(counts), { expirationTtl: 30 * 86_400 });
  if (mod.verdict === "drop") {
    const facts = { at: new Date(now).toISOString(), to, envelope_from: normaliseAddress(envelopeFrom), header_from: senderOf(bytes).from || "", sha256: await fingerprint(bytes), bytes: bytes.length, categories: mod.categories.join(",") };
    await env.STEPS.put(`mod:drop:${now}-${facts.sha256.slice(0, 12)}`, JSON.stringify(facts), { expirationTtl: DROP_TTL });
    await alarm(env, "drop", facts, now);
  }
  if (mod.verdict === "unchecked") await alarm(env, "unchecked", { at: new Date(now).toISOString(), why: mod.why }, now);
  return mod;
}

/** What may be kept of an item, by verdict. Flagged: words kept but marked hidden, no codes or links.
 *  Unchecked: no words at all, codes only. Clean: words up to what was checked. */
export function applyVerdict(item, mod) {
  // `request` is written either way (true or false) once known, so mail from before approval meant
  // delivery (27 Sep) never counts as approved: only an explicit false does (lib/mail.ts on the site).
  const out = { ...item, check: mod.verdict, ...(typeof mod.request === "boolean" ? { request: mod.request } : {}), ...(mod.window ? { window: true } : {}) };
  if (mod.verdict === "flagged") return { ...out, categories: mod.categories, codes: [], links: [] };
  if (mod.verdict === "unchecked") return { ...out, subject: "", body: "", links: [] };
  if (mod.verdict === "not-approved") return { ...out, subject: "", body: "" }; // older items only (before requests)
  return { ...out, body: String(item.body || "").slice(0, MAX_CHARS) };
}

/** support@ and security@ reach a person: clean mail from a verified sender is forwarded; anything else
 *  only a notice (28 Sep, the owner: forwarded junk costs devpings.com its standing with Gmail). */
export async function forwardOrNotice(message, env, local, mod, bytes) {
  const verified = bytes ? senderOf(bytes).verified === true : false;
  if (mod.verdict === "clean" && verified) {
    try { await message.forward(env.FORWARD_TO); return; } catch { /* fall through to a notice */ }
  }
  // Counted for the 5 am summary (digest.mjs) instead of one notice per mail (the owner, 28 Sep).
  const why = mod.verdict !== "clean" ? `${mod.verdict} by the safety check` : !verified ? "sender not confirmed" : "forwarding failed";
  try { await noteNotice(env, local, why); } catch { /* kept in the inbox either way */ }
}
