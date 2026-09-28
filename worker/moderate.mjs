// B2 moderation (spec 27 rev 6, D2; 27 Sep 2026). Every mail the worker would keep is read once by
// Llama Guard 3 on Cloudflare Workers AI (the AI binding; Cloudflare keeps no inputs and trains on none,
// per its Workers AI data-usage page) before anything is stored or forwarded.
//
//   drop      child sexual exploitation (S4): never stored, never forwarded, never shown. Only a
//             fingerprint and the envelope are kept, for reporting, and the owner is alarmed.
//   flagged   any other category: kept, but the words are hidden from every view, and no code passes.
//   clean     kept as before. Clean never means "deliver to an agent": the connector is codes only.
//   unchecked the check failed (no binding, out of budget, an answer we can't read): fail closed.
//             Only the envelope and codes are kept, never the words, and the owner is alarmed once a day.
export const MODEL = "@cf/meta/llama-guard-3-8b";
export const HARD_DROP = new Set(["S4"]);
export const MAX_CHARS = 20_000; // only what was checked is kept

// Llama Guard 3's categories (Meta), for labels in the mail view.
export const CATEGORIES = {
  S1: "violent crimes", S2: "non-violent crimes", S3: "sex-related crimes", S4: "child sexual exploitation",
  S5: "defamation", S6: "specialised advice", S7: "privacy", S8: "intellectual property",
  S9: "indiscriminate weapons", S10: "hate", S11: "suicide and self-harm", S12: "sexual content",
  S13: "elections", S14: "code interpreter abuse",
};

/** Read the model's answer, whichever shape it comes in. Anything we can't read is null (fail closed). */
export function parseVerdict(out) {
  const r = out && typeof out === "object" && "response" in out ? out.response : out;
  if (r && typeof r === "object" && typeof r.safe === "boolean") {
    return { safe: r.safe, categories: (Array.isArray(r.categories) ? r.categories : []).map(String).map((c) => c.trim().toUpperCase()) };
  }
  if (typeof r === "string") {
    const t = r.trim().toLowerCase();
    if (t === "safe") return { safe: true, categories: [] };
    const m = t.match(/^unsafe\s*([\s\S]*)$/);
    if (m) return { safe: false, categories: (m[1].match(/s\d{1,2}/g) || []).map((c) => c.toUpperCase()) };
  }
  return null;
}

/** One verdict for one mail's readable text. `run` is env.AI.run, injected for tests. */
export async function moderate(run, text) {
  const checked = String(text || "").slice(0, MAX_CHARS);
  if (typeof run !== "function") return { verdict: "unchecked", categories: [], checked, why: "no AI binding" };
  let out;
  try {
    out = await run(MODEL, { messages: [{ role: "user", content: checked || "(empty)" }] });
  } catch (e) {
    return { verdict: "unchecked", categories: [], checked, why: String((e && e.message) || e).slice(0, 200) };
  }
  const v = parseVerdict(out);
  if (!v) return { verdict: "unchecked", categories: [], checked, why: "unreadable answer" };
  if (v.safe) return { verdict: "clean", categories: [], checked };
  if (v.categories.some((c) => HARD_DROP.has(c))) return { verdict: "drop", categories: v.categories, checked };
  return { verdict: "flagged", categories: v.categories.length ? v.categories : ["unknown"], checked };
}

export async function fingerprint(bytes) {
  const d = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Tell the owner, without the content. */
export async function alarm(env, kind, facts, now = Date.now()) {
  const day = new Date(now).toISOString().slice(0, 10);
  // At most one "unchecked" and five "drop" mails a day, so the alarm itself can't be used to flood
  // the owner; every drop is still recorded in KV.
  const k = `mod:alarmed:${kind}:${day}`;
  const n = parseInt((await env.STEPS.get(k)) || "0", 10);
  if (n >= (kind === "drop" ? 5 : 1)) return;
  await env.STEPS.put(k, String(n + 1), { expirationTtl: 2 * 86_400 });
  if (!env.EMAIL || !env.FORWARD_TO) return;
  const lines = kind === "drop"
    ? ["A mail was dropped by the safety check: child sexual exploitation (S4).", "It was not stored, forwarded or shown. What is kept (90 days, for a report):"]
    : kind === "budget" ? ["The safety check has used 80% of today's cap. Past the cap, mail is kept without its words.", "Details:"]
    : ["The safety check could not run. Mail is held without its words until it works again.", "Details:"];
  const text = [...lines, ...Object.entries(facts).map(([k, v]) => `  ${k}: ${v}`),
    "", kind === "drop" ? "Report: https://www.esafety.gov.au/report (Australia) or the police. Do not look for the mail: it is gone." : "Check Workers AI in the Cloudflare dashboard."].join("\n");
  try {
    await env.EMAIL.send({ from: `security@${env.DOMAIN || "devpings.com"}`, to: env.FORWARD_TO, subject: `devpings safety: ${kind}`, text });
  } catch { /* the record in KV stays; the mail view shows the count */ }
}
