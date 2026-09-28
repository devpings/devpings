// Sign-up verification by email (25 Sep 2026, the owner's idea: no links to click, no codes to type).
//
// devpings.com gives a person a random address, join-<token>@devpings.com, open for 10 minutes.
// They send any email to it from the address they signed up with. This worker notes WHO sent it
// and whether Cloudflare verified the sender (DKIM/DMARC). The site asks GET /join/<token> and
// compares that sender with the sign-up.
//
// Off unless the worker's JOIN var is "on": only devpings.com's own worker runs sign-ups, and
// every other owner's worker ignores join- mail like any unminted address.
//
// This is the one mailbox that takes mail from strangers, so it keeps as little as possible:
//   - the sender and the verdict only, never the subject or body;
//   - only verified mail is written at all, and only the first one per token;
//   - everything is gone after 10 minutes.

// 26 Sep 2026 (spec 24 §4, the owner's design): the address says what it does
// (sign-me-in-to-devpings-<token>, A1), the email must carry the code the waiting page shows (A2:
// a person composed it, and an old signed email can't be replayed), and only a fresh, hand-sent
// email counts (A3). A refused email writes nothing, so it can't use up or overwrite the window.
// The old join-<token> form is still recognised but needs the code too (build check F1: the
// prefix must never be a way around it). KeyWay moved to the new form in the maintainers' other project 69bd40c.

import { senderOf, readable } from "./converter.mjs";

export const JOIN_TTL_SECONDS = 600;
const JOIN_LOCAL = /^(join|sign-me-in-to-devpings)-([a-z0-9]{16,40})$/;
const MAX_BYTES = 256 * 1024;
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

/** The 6-character code for a token. The site derives the same one; it proves composition, not secrecy. */
export async function joinCode(token) {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`devpings-join-code:${token}`)));
  return [...d.slice(0, 6)].map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join("");
}

/** Why this email can't be a person's fresh sign-in email, or null if it can (A3). */
export function refusedWhy(bytes) {
  if (bytes.length > MAX_BYTES) return "too large";
  const raw = new TextDecoder("latin1").decode(bytes);
  const end = raw.search(/\r?\n\r?\n/);
  const head = (end === -1 ? raw : raw.slice(0, end)).replace(/\r?\n[ \t]+/g, " ");
  const lines = head.split(/\r?\n/).map((l) => l.toLowerCase());
  const has = (name) => lines.some((l) => l.startsWith(name + ":"));
  const value = (name) => (lines.find((l) => l.startsWith(name + ":")) || "").slice(name.length + 1).trim();
  if (has("in-reply-to") || has("references")) return "a reply";
  if (has("auto-submitted") && value("auto-submitted") !== "no") return "automatic";
  if (/^(bulk|list|junk|auto_reply)$/.test(value("precedence"))) return "automatic";
  if (has("x-autoreply") || has("x-autorespond") || lines.some((l) => /^(resent-|list-)/.test(l))) return "automatic";
  if (has("return-path") && /<\s*>/.test(value("return-path"))) return "automatic";
  if (/(text\/calendar|message\/disposition-notification|multipart\/report)/.test(raw.toLowerCase())) return "automatic";
  return null;
}

/** Does the subject or the first line of the body carry the code, with nothing quoted? */
export function carriesCode(bytes, code) {
  const { subject, body } = readable(bytes);
  if (/^\s*>/m.test(body) || /\bon\b.{0,200}\bwrote:/i.test(body)) return false;
  const first = String(body).trim().split(/\n/)[0].slice(0, 200);
  return new RegExp(`\\b${code}\\b`, "i").test(`${subject} ${first}`);
}

export const joinOn = (env) => env.JOIN === "on";

/** The token in a join address (either form), or null. */
export function joinToken(local) {
  const m = JOIN_LOCAL.exec(local);
  return m ? m[2] : null;
}

/** Email handler for join addresses: keep the verified sender, nothing else. */
export async function keepJoin(env, token, bytes, local = `join-${token}`) {
  const s = senderOf(bytes);
  if (!s.verified || !s.from) return;
  if (refusedWhy(bytes)) return;
  if (!carriesCode(bytes, await joinCode(token))) return; // every prefix: the token decides, not the prefix (build check F1)
  const key = `join:${token}`;
  if (await env.STEPS.get(key)) return; // the first good email decides
  await env.STEPS.put(key, JSON.stringify({ from: s.from, at: Date.now() }), { expirationTtl: JOIN_TTL_SECONDS });
}

/** GET /join/<token>: the verified sender, if one has arrived. Knowing the token is the right to ask. */
export async function readJoin(env, pathname) {
  const token = joinToken("join-" + pathname.slice("/join/".length));
  if (!token) return json({ error: "no such join address" }, 404);
  const held = await env.STEPS.get(`join:${token}`);
  return json(held ? { arrived: true, ...JSON.parse(held) } : { arrived: false });
}

const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
