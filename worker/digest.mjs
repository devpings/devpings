// The daily notice (the owner, 28 Sep 2026): mail to support@ or security@ that isn't forwarded (not clean, or the
// sender couldn't be confirmed) is counted here instead of mailed one by one. A cron at 19:00 UTC (5 am AEST)
// sends one summary to FORWARD_TO, then clears the count. No words from the mail itself, only counts and reasons.
// Accepted risk (build check sonnet, 28 Sep): one KV key, read-modify-write, so two mails at the same moment can
// lose a count. It's a nudge to look, not a ledger; the mail itself is always kept (keepInInbox: 7 days).
const KEY = "notice:pending";

export async function noteNotice(env, local, why, now = Date.now()) {
  const p = JSON.parse((await env.STEPS.get(KEY)) || "null") || { since: now, boxes: {} };
  const b = (p.boxes[local] = p.boxes[local] || { n: 0, why: {} });
  b.n++;
  b.why[why] = (b.why[why] || 0) + 1;
  await env.STEPS.put(KEY, JSON.stringify(p), { expirationTtl: 8 * 86_400 });
}

export function digestText(p, domain = "devpings.com") {
  const lines = Object.entries(p.boxes).map(([box, b]) =>
    `${box}@${domain}: ${b.n} not forwarded (${Object.entries(b.why).map(([w, n]) => `${n} ${w}`).join(", ")})`);
  return `Since ${new Date(p.since).toISOString().slice(0, 16).replace("T", " ")} UTC:\n\n${lines.join("\n")}\n\nThey're kept for 7 days. Read them at https://www.devpings.com/mail.`;
}

export async function sendDigest(env) {
  const raw = await env.STEPS.get(KEY);
  if (!raw || !env.EMAIL || !env.FORWARD_TO) return false;
  const p = JSON.parse(raw);
  const total = Object.values(p.boxes).reduce((a, b) => a + b.n, 0);
  if (!total) { await env.STEPS.delete(KEY); return false; }
  await env.EMAIL.send({ from: `security@${env.DOMAIN || "devpings.com"}`, to: env.FORWARD_TO, subject: `devpings: ${total} mail${total === 1 ? "" : "s"} held at your team addresses`, text: digestText(p, env.DOMAIN || "devpings.com") });
  await env.STEPS.delete(KEY);
  return true;
}
