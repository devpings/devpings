// Delivery from our own site (26 Sep 2026): the feedback form drops a message into one of this
// worker's own permanent addresses (e.g. opus@), so feedback reaches the team's agent like mail.
// Key required (the mint key, as for every write). Only team addresses this worker minted itself;
// never a hosted user's inbox. Marked via "form" and unverified: a form is not a signed email.
// Through the same safety check as mail (spec 27 D2; build check sonnet02 F1).
import { touch } from "./inbox.mjs";
import { applyVerdict, gate } from "./gate.mjs";
const INBOX_TTL_SECONDS = 7 * 24 * 3600;

export async function deliver(env, body, id) {
  const to = String(body.to || "").toLowerCase();
  const rec = to ? await env.ADDRESSES.get(to) : null;
  if (!rec || JSON.parse(rec).hosted) return { status: 400, body: { error: "deliver to a team address this worker created, never a hosted one" } };
  const text = String(body.text || "");
  if (!text.trim() || text.length > 20000) return { status: 400, body: { error: "text is required, up to 20,000 characters" } };
  const subject = String(body.subject || "").slice(0, 140);
  const bytes = new TextEncoder().encode(`Subject: ${subject.replace(/[\r\n]/g, " ")}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${text}\r\n`);
  const mod = await gate(env, bytes, to, "form");
  if (mod.verdict === "drop") return { status: 200, body: { delivered: false, to, id } };
  const item = { id, from: String(body.from || "feedback form").slice(0, 200), verified: false, via: "form", subject, body: text, at: Date.now() };
  await env.STEPS.put(`inbox:${to}:${id}`, JSON.stringify(applyVerdict(item, mod)), { expirationTtl: INBOX_TTL_SECONDS });
  await touch(env, to);
  return { status: 200, body: { delivered: true, to, id } };
}
