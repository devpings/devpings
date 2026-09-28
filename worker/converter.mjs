// devpings converter: email in, event out. Runs inside the mail worker.
//
// SCOPE: receive an email for a listening window, turn it into an event (a code, a link, or the
// message as text), hand that event to whoever is waiting, and forget the message. The converter
// itself keeps nothing beyond the window. (The worker's separate 7-day inbox, in the owner's own
// KV, is the one place mail is kept; see worker.mjs.)
//
// THE RETENTION RULES, and why each one is a rule and not a preference:
//
//   R1. The raw message is never logged. Not at debug level, not in an error, not in a
//       stack trace. Cloudflare's log pipeline (tail, Logpush, dashboard) is storage we do
//       not control and cannot empty. A console.log of a message body IS retention, and it
//       is the most likely way this promise gets broken by accident later.
//   R2. The raw message is never written to a binding. This Worker declares no KV, no R2,
//       no D1, no Durable Object, no cache. The harness asserts this by handing it a
//       binding that records every write and checking the recorder stayed empty.
//   R3. Nothing is kept for debugging on failure. A failed extraction emits a
//       failure event naming the step and the pattern, and discards the message like any
//       other. Keeping "just the ones that broke" is how an inbox starts.
//   R4. No retry buffer. If event delivery fails, the converter does not hold the message to
//       try again — it emits a delivery-failure record with no content in it. Retry is the
//       waiting step's problem, and re-sending the verification email is free.
//   R5. The extracted value is treated as a credential, not as data. See the note on
//       relocation at emitEvent().

export const SCOPE_NOTE =
  "This settles nothing about identity: not the identity row, not the vault key, not a " +
  "custody model, not an address model. Receive, convert, deliver, forget.";

// What a waiting step declares it needs. Patterns only — never a place to put a message.
//
// R7 (added 17 Sep, from a review): AN AMBIGUOUS EXTRACTION IS A FAILURE, NOT A
// GUESS. Review probe D found `code:6` returning an order number because it was the first
// six-digit run in the body. A wrong value emitted as "extracted" is worse than no value at
// all: the waiting step acts on it, and the failure surfaces somewhere else entirely, much
// later. So every extractor below either returns a value it can justify or returns null.

const CODE_CONTEXT_G = /(code|verification|verify|passcode|one[\s-]?time|otp|pin|security)/gi;

// SEGMENTS. The subject is part of the message (F2), but a keyword in the SUBJECT must not
// key a number in the BODY: "Verify your email" + "Ref 100200" would otherwise extract the
// reference number as a code. Caught by this build's own T9 immediately after the subject was
// added. Proximity is only meaningful inside one segment, so candidates are gathered per
// segment and never across the join.
const SEG = "\u0000";

function digitsWithContext(corpus, n) {
  const out = [];
  for (const seg of String(corpus).split(SEG)) {
    const v = digitsInSegment(seg, n);
    if (v && typeof v === "object" && v.ambiguous) return v;
    if (v) out.push(v);
  }
  const unique = [...new Set(out)];
  if (unique.length === 1) return unique[0];
  if (unique.length === 0) return null;
  return AMBIGUOUS(unique.length);
}

function digitsInSegment(text, n) {
  // Providers split codes for readability: "482-913", "482 913". Normalise a separator that
  // sits between two runs of digits, and only that — nothing else about the text changes.
  //
  text = text.replace(/(?<=\d)[\u2010-\u2015\-\u00a0 ](?=\d)/g, "");
  const re = new RegExp(`(?<!\\d)(\\d{${n}})(?!\\d)`, "g");
  const candidates = [];
  for (let m; (m = re.exec(text)); ) {
    // Look BEHIND only. "Your code is 482913" keys the code; an order number earlier in the
    // line must not be keyed by a "code" that appears after it. (Review probe D: an
    // after-window keyed both numbers and the extractor then refused a message it should
    // have read.) Nearest preceding keyword wins.
    const before = text.slice(Math.max(0, m.index - 40), m.index);
    const k = [...before.matchAll(CODE_CONTEXT_G)].pop();
    candidates.push({ value: m[1], distance: k ? before.length - (k.index + k[0].length) : Infinity });
  }
  if (candidates.length === 0) return null;
  const keyed = candidates.filter((c) => c.distance !== Infinity).sort((a, b) => a.distance - b.distance);
  if (keyed.length === 1) return keyed[0].value;
  // Two keyed candidates but one clearly closer to the word: take it. Equally close is a
  // guess, and a guess is a failure.
  if (keyed.length > 1 && keyed[0].distance < keyed[1].distance) return keyed[0].value;
  if (keyed.length === 0 && candidates.length === 1) return candidates[0].value;
  return AMBIGUOUS(candidates.length);
}

// "Not found" and "found several and would not guess" are different messages to whoever
// fixes the parser later. Reporting the second as the first sends them looking for a
// pattern that was there all along.
const AMBIGUOUS = (n) => ({ ambiguous: n });

export const EXTRACTORS = {
  "code:6": { what: "six-digit verification code", find: (t) => digitsWithContext(t, 6) },
  "code:8": { what: "eight-digit verification code", find: (t) => digitsWithContext(t, 8) },
  "link:verify": {
    what: "verification or sign-in link",
    // F1, from a review: the generic keyword set (token|login|signin|…) matches an
    // unsubscribe link and a footer sign-in link as readily as the real one, so on a
    // GitHub-shaped message R7 correctly refused to guess — on a message that should have
    // passed. R7 is right; the candidate set was wrong.
    //
    // Spec 07 step 3 already says the converter "parses the message for whatever the waiting
    // step declared it needs". So the step declares the provider's actual path
    // (`/emails/verify`, `/auth/v1/verify`) and generic keywords are only the fallback for a
    // provider nobody has written down yet. This is the spec read literally, not new scope.
    find: (text, step) => {
      const urls = [...new Set((text.match(/https?:\/\/[^\s"'<>\])]+/g) || []).map(trimUrl))];
      if (urls.length === 0) return null;

      const declared = step && step.linkPattern
        ? (Array.isArray(step.linkPattern) ? step.linkPattern : [step.linkPattern])
        : null;

      if (declared) {
        const hits = urls.filter((u) => declared.some((pat) => matchPath(u, pat)));
        if (hits.length === 1) return hits[0];
        if (hits.length > 1) return AMBIGUOUS(hits.length);
        return null; // declared and not present is a clean miss, not a reason to fall back
      }

      // Fallback: generic keywords, minus the links every marketing footer carries. A
      // deny-list is a heuristic and is why declaring the path is the real answer.
      const hits = urls.filter(
        (u) => /verify|confirm|activate|magic|signin|sign-in|login|token|invite/i.test(u) && !FOOTER.test(u)
      );
      if (hits.length === 0) return null;
      return hits.length === 1 ? hits[0] : AMBIGUOUS(hits.length);

      // REMOVED 17 Sep, after a third review, and the removal is the finding.
      //
      // There was a tie-break here: when several candidates survived the deny-list, the one
      // "carrying a secret" (a 12+ character token-shaped value) was taken, on the reasoning
      // that a verification link carries a credential and a footer link does not. It was
      // wrong in an ordinary way — marketing tracking parameters are exactly that shape.
      // `utm_campaign=welcome_series_2026` and `ref=onboarding_flow_v2` beat a short real
      // verify id, and review probes H1 and H4 emitted a footer link as `extracted`.
      //
      // A wrong value marked success is the precise failure R7 exists to prevent, and I
      // reintroduced it in the floor I put under R7. A narrower version — exclude utm_*,
      // ref, campaign, source, medium — would pass the review fixtures and is still a guess dressed
      // as a rule, so it is not taken either. When several candidates survive, the honest
      // answer is `ambiguous`, and the ambiguous event already tells the reader exactly what
      // to do: declare the provider's path (H2 shows a declared path reading these same
      // messages correctly, H5 and H6 show it failing safely when too loose or absent).
    },
  },
};

// "any" — added 23 Sep 2026, after a live test. A step that names ONE shape (code:6) misses the
// provider that sends eight digits, or a link, or changes its email next month. So this
// extractor does not decide: it lists what a person would look for — keyed codes and
// verify-shaped links — and the sender and subject, and the human picks. R7 is crossed here
// out loud: ambiguity is shown, not refused, because a person is choosing, not a step acting.
export function candidatesOf(text, hrefs) {
  const urls = [...new Set([...hrefs, ...(String(text).match(/https?:\/\/[^\s"'<>\])]+/g) || [])].map(trimUrl))];
  const links = urls.filter(
    (u) => /verify|verification|confirm|activate|magic|signin|sign-in|login|token|invite/i.test(u) && !FOOTER.test(u)
  );
  // Digits inside a URL are ids, not codes. And when the mail carries a verify link, only a
  // number a keyword points at counts — otherwise a footer postcode shows up as a "code".
  const codes = [];
  for (const seg of String(text).replace(/https?:\/\/\S+/g, " ").split(SEG)) {
    const t = seg.replace(/(?<=\d)[\u2010-\u2015\-\u00a0 ](?=\d)/g, "");
    const all = [];
    for (const m of t.matchAll(/(?<![\d\w])(\d{4,10})(?![\d\w])/g)) {
      const before = t.slice(Math.max(0, m.index - 40), m.index);
      all.push({ v: m[1], keyed: CODE_CONTEXT_G.test(before) });
      CODE_CONTEXT_G.lastIndex = 0;
    }
    const keyed = all.filter((c) => c.keyed);
    for (const c of keyed.length ? keyed : !links.length && all.length <= 2 ? all : []) codes.push(c.v);
  }
  return { codes: [...new Set(codes)].slice(0, 3), links: links.slice(0, 3) };
}

// Links every bulk sender puts in the footer. Never the thing a step is waiting for.
const FOOTER = /unsubscribe|preferences|notification-settings|\/settings\/notifications|email-preferences|manage-subscription|\/help|\/support|\/docs|\/privacy|\/terms|\/legal|list-unsubscribe/i;

function matchPath(url, pattern) {
  try {
    const u = new URL(url);
    return (u.pathname + u.search).toLowerCase().includes(String(pattern).toLowerCase());
  } catch {
    return String(url).toLowerCase().includes(String(pattern).toLowerCase());
  }
}

function trimUrl(u) {
  // Trailing punctuation from prose ("visit <url>.") is not part of the URL.
  return u.replace(/[.,;:!?)\]]+$/, "");
}

// ---------------------------------------------------------------------------
// MIME. Added 17 Sep after a review: providers do not send plain text, and the
// previous `decode()` was a bare UTF-8 pass over the raw bytes. Quoted-printable (the default
// for HTML mail) turned "=" into "=3D" and soft-broke long lines, base64 parts matched
// nothing, and "&amp;" in an href truncated the link at the second parameter — all three
// emitted as "extracted". Done by hand: still zero dependencies. The retention rules are
// unchanged; every string below lives and dies inside the same block `text` already did.
// ---------------------------------------------------------------------------

const bytesOf = (latin1) => Uint8Array.from(latin1, (c) => c.charCodeAt(0) & 0xff);
const asUtf8 = (latin1) => new TextDecoder("utf-8", { fatal: false }).decode(bytesOf(latin1));

function decodeQuotedPrintable(body) {
  return body
    .replace(/=(?:\r\n|\n|\r)/g, "")               // soft line break
    .replace(/=([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

function decodeBase64(body) {
  try {
    return atob(body.replace(/[^A-Za-z0-9+/=]/g, ""));
  } catch {
    return "";
  }
}

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'", "#x2F": "/", "#47": "/" };
function decodeEntities(s) {
  return s.replace(/&(#x?[0-9A-Fa-f]+|[a-zA-Z]+);/g, (m, name) => {
    if (ENTITIES[name] !== undefined) return ENTITIES[name];
    if (/^#x/i.test(name)) return String.fromCodePoint(parseInt(name.slice(2), 16));
    if (/^#/.test(name)) return String.fromCodePoint(parseInt(name.slice(1), 10));
    return m;
  });
}

function splitHeaders(chunk) {
  const i = chunk.search(/\r?\n\r?\n/);
  const head = i === -1 ? chunk : chunk.slice(0, i);
  const body = i === -1 ? "" : chunk.slice(i).replace(/^\r?\n\r?\n/, "");
  const headers = {};
  // Unfold continuation lines before splitting.
  for (const line of head.replace(/\r?\n[ \t]+/g, " ").split(/\r?\n/)) {
    const c = line.indexOf(":");
    if (c > 0) headers[line.slice(0, c).trim().toLowerCase()] = line.slice(c + 1).trim();
  }
  return { headers, body };
}

// Returns { text, hrefs } — the corpus an extractor searches. Prefers text/plain; falls back
// to HTML with entities decoded and tags stripped, keeping href values separately so a link
// survives even when the visible text does not contain it.
function mimeCorpus(latin1) {
  const parts = [];
  let subject = "";
  walk(latin1, 0);
  const plain = parts.filter((p) => p.type.startsWith("text/plain"));
  const html = parts.filter((p) => p.type.startsWith("text/html"));
  // Never an image, video, audio or file part as text (spec 27 D2, build check sonnet02 F3): the safety
  // check reads text, so a binary part would be kept unread.
  const chosen = plain.length ? plain : html.length ? html : parts.filter((p) => !/^(image|video|audio|application|font|model)\//i.test(p.type));
  // F2, from a review: Vercel puts the code in the Subject line, which the parser never
  // read. The subject is part of the message a step is waiting on, not metadata about it.
  let text = decodeRfc2047(subject) + SEG;
  const hrefs = [];
  for (const p of chosen) {
    const decoded = asUtf8(p.body);
    // Declared type is a claim; some mail carries HTML with no Content-Type at all (a review's
    // probe C). Sniff as well as trust, or "&amp;" ships inside a link as literal text.
    const looksHtml = /<\s*(a|html|body|table|div|p)\b[^>]*>/i.test(decoded);
    if (p.type.startsWith("text/html") || looksHtml) {
      for (const m of decoded.matchAll(/(?:href|src)\s*=\s*["']([^"']+)["']/gi)) hrefs.push(decodeEntities(m[1]));
      text += " " + decodeEntities(decoded.replace(/<[^>]*>/g, " "));
    } else {
      text += " " + decoded;
    }
  }
  return { text, hrefs, subject: decodeRfc2047(subject) };

  function walk(chunk, depth) {
    if (depth > 8) return;
    const { headers, body } = splitHeaders(chunk);
    if (depth === 0 && headers["subject"]) subject = headers["subject"];
    const type = (headers["content-type"] || "text/plain").toLowerCase();
    const cte = (headers["content-transfer-encoding"] || "").toLowerCase().trim();
    if (type.startsWith("multipart/")) {
      const b = /boundary\s*=\s*"?([^";]+)"?/i.exec(headers["content-type"] || "");
      if (!b) return;
      const marker = "--" + b[1];
      const segs = body.split(marker);
      for (const seg of segs.slice(1)) {
        if (/^--/.test(seg.trim())) break;
        walk(seg.replace(/^\r?\n/, ""), depth + 1);
      }
      return;
    }
    let decoded = body;
    if (cte === "quoted-printable") decoded = decodeQuotedPrintable(body);
    else if (cte === "base64") decoded = decodeBase64(body);
    parts.push({ type: type.split(";")[0].trim(), body: decoded });
  }
}

// Subjects arrive RFC 2047 encoded ("=?UTF-8?B?...?=" / "=?UTF-8?Q?...?=") whenever they are
// not plain ASCII. Decoding is two lines and the alternative is reading base64 as prose.
function decodeRfc2047(v) {
  return String(v || "").replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (_, _cs, enc, data) => {
    try {
      if (enc.toUpperCase() === "B") return asUtf8(decodeBase64(data));
      return asUtf8(data.replace(/_/g, " ").replace(/=([0-9A-Fa-f]{2})/g, (_m, h) => String.fromCharCode(parseInt(h, 16))));
    } catch { return ""; }
  });
}

// An address as a provider writes it: `"Setup" <setup@x.com>`. Compare the envelope address,
// not the display name. (Review probe E — flagged as possibly a non-issue in
// production, since Cloudflare documents `EmailMessage.to` as the bare address. Normalising
// costs nothing and removes the question.)
export function normaliseAddress(a) {
  const m = /<([^>]+)>/.exec(String(a || ""));
  return (m ? m[1] : String(a || "")).trim().toLowerCase();
}

// ---------------------------------------------------------------------------
// The handler. Cloudflare calls this with an EmailMessage.
// ---------------------------------------------------------------------------

export default {
  async email(message, env, ctx) {
    return handleEmail(message, env, now());
  },
};

export async function handleEmail(message, env, at = now()) {
  const to = normaliseAddress(message.to);
  const step = env.STEPS && env.STEPS.lookup ? env.STEPS.lookup(to) : null;

  // R6 — expiry. A message for a step that is closed, expired or unknown produces no
  // event at all. It is not stored, not queued, not reported with content.
  if (!step) {
    return finish(env, { kind: "ignored", reason: "no open step for this address", at });
  }
  if (step.expiresAt && at >= step.expiresAt) {
    return finish(env, { kind: "expired", step: step.id, at });
  }

  if (step.expect === "any") {
    try {
      const original = decodeLatin1(await readAll(message.raw));
      const { text, hrefs, subject } = mimeCorpus(original);
      const { codes, links } = candidatesOf(text, hrefs);
      return finish(env, {
        kind: "received", step: step.id, from: normaliseAddress(message.from),
        subject: String(subject || "").slice(0, 140), codes, links,
        // The message as a person would read it (23 Sep: "it is a human seeing this"). Text only,
        // whitespace tidied, capped — the screen renders it as text, never as HTML.
        // The original, headers and all, so the person can download it (.eml). Held exactly as
        // long as the body above — the step's window — and in the same place. Capped: a message
        // this large is not a verification email.
        original: original.length <= 512 * 1024 ? original : null,
        body: String(text).split(SEG).slice(1).join(" ").replace(/[ \t]+/g, " ").replace(/\s*\n\s*\n\s*/g, "\n\n").trim().slice(0, 3000),
        at, expiresAt: step.expiresAt ?? null,
      });
    } catch (e) {
      return finish(env, { kind: "failed", step: step.id, reason: `read error: ${e && e.name ? e.name : "Error"}`, at });
    }
  }

  const extractor = EXTRACTORS[step.expect];
  if (!extractor) {
    return finish(env, { kind: "failed", step: step.id, reason: `unknown extractor ${step.expect}`, at });
  }

  // The one moment the raw message exists in this process. It is a local binding inside
  // this function: when the function returns there is no reference to it anywhere, and
  // nothing above this line or below it puts one somewhere that outlives the call.
  let found = null;
  try {
    const raw = await readAll(message.raw);
    const { text, hrefs } = mimeCorpus(decodeLatin1(raw));
    // hrefs first: a link survives in an href even when the visible text mangles it.
    // hrefs first: a link survives in an href even when the visible text mangles it. But an
    // ambiguous href result must not short-circuit a clean answer in the text, so only a
    // definite string wins outright.
    const fromHrefs = extractor.find(hrefs.join("\n"), step);
    found = typeof fromHrefs === "string" ? fromHrefs : extractor.find(text, step) || fromHrefs;
    // R1: nothing derived from `text` is logged, and `text` itself never leaves this block.
  } catch (e) {
    // R1 again, at the most dangerous moment: an error thrown while parsing must not
    // carry the message into the error path. Only the error's *type* is kept.
    return finish(env, {
      kind: "failed", step: step.id, reason: `read error: ${e && e.name ? e.name : "Error"}`, at,
    });
  }

  if (found && typeof found === "object" && found.ambiguous) {
    // "Not found" and "found several and would not guess" are different messages to whoever
    // fixes the parser later; reporting the second as the first sends them hunting for a
    // pattern that was there all along. R3 still holds: the COUNT is reported, never any of
    // the candidates themselves.
    return finish(env, {
      kind: "failed", step: step.id, expected: step.expect,
      reason: `ambiguous: ${found.ambiguous} candidates, refusing to guess`,
      at, expiresAt: step.expiresAt ?? null,
    });
  }

  if (!found) {
    // R3: no sample, no snippet, no "first 200 chars for debugging".
    return finish(env, {
      kind: "failed", step: step.id, expected: step.expect, reason: "pattern not found",
      at, expiresAt: step.expiresAt ?? null,
    });
  }

  // R8: the event carries the step's expiry, so a receiver cannot hold
  // the credential longer than the converter itself would have. The value is a bearer
  // credential; its lifetime travels with it or it does not exist.
  return finish(env, {
    kind: "extracted", step: step.id, expect: step.expect, value: found,
    at, expiresAt: step.expiresAt ?? null,
  });
}

// ---------------------------------------------------------------------------

async function finish(env, event) {
  // R5 — RELOCATION, SAID OUT LOUD. When `event.kind === "extracted"`, `event.value` is a
  // live sign-in link or a live verification code. Discarding the raw message while emitting
  // that value does not make the secret go away; it moves it. Everything downstream of this
  // function is therefore holding a credential, and this is the honest name for what the
  // converter does: it narrows a whole message to one credential and hands it on. The
  // narrowing is real and worth having. "Nothing is kept" is true of the converter and NOT
  // true of the system, unless whatever receives this event treats `value` as single-use
  // and short-lived. Spec 07 does not define that delivery; this comment is the handover
  // note for whoever does.
  try {
    if (env.EMIT) await env.EMIT(event);
  } catch (e) {
    // R4: delivery failed. We do not keep the message to try again, and the failure record
    // carries no content — not even the value we just extracted.
    return { emitted: false, event: { kind: "delivery-failed", step: event.step, at: event.at } };
  }
  return { emitted: true, event };
}

/**
 * The inbox's reading of a message (24 Sep 2026): who, what, and the text a person would read.
 * Same decoding as the "any" window below, so the inbox and the window never disagree.
 */
export function readable(bytes) {
  const original = decodeLatin1(bytes);
  const { text, subject } = mimeCorpus(original);
  return {
    subject: String(subject || "").slice(0, 140),
    body: String(text).split(SEG).slice(1).join(" ").replace(/[ \t]+/g, " ").replace(/\s*\n\s*\n\s*/g, "\n\n").trim().slice(0, 20000),
  };
}

/**
 * Who really sent this? (24 Sep 2026, the DKIM gate.)
 *
 * The From: line is text anyone can type. Cloudflare's mail servers check each message's DKIM,
 * SPF and DMARC on arrival and write the verdict into an Authentication-Results header ON TOP of
 * the message. Headers a sender forges sit BELOW it. So only the FIRST Authentication-Results
 * header counts, and only if Cloudflare (mx.cloudflare.net) wrote it.
 *
 * Verified means: DMARC passed for the From: domain, or a DKIM signature passed for that same
 * domain (or its parent). Anything else, including no verdict at all, is unverified.
 */
export function senderOf(bytes) {
  const raw = decodeLatin1(bytes);
  const end = raw.search(/\r?\n\r?\n/);
  const head = (end === -1 ? raw : raw.slice(0, end)).replace(/\r?\n[ \t]+/g, " ");
  const lines = head.split(/\r?\n/);
  const header = (name) => lines.find((l) => l.toLowerCase().startsWith(name.toLowerCase() + ":"));
  const fromLine = header("From");
  const from = fromLine ? normaliseAddress(fromLine.slice(5)) : "";
  const fromDomain = from.includes("@") ? from.slice(from.lastIndexOf("@") + 1) : "";

  const ar = header("Authentication-Results");
  const byCloudflare = !!ar && /^authentication-results:\s*mx\.cloudflare\.net\s*;/i.test(ar);
  const dmarc = byCloudflare ? (/\bdmarc=(\w+)[^;]*?header\.from=([^\s;]+)/i.exec(ar) || []) : [];
  const dkimPassed = byCloudflare ? [...ar.matchAll(/\bdkim=pass\b[^;]*?header\.d=([^\s;]+)/gi)].map((m) => m[1].toLowerCase()) : [];
  const aligned = (d) => !!fromDomain && (fromDomain === d || fromDomain.endsWith("." + d));
  const verified = byCloudflare && !!fromDomain && (
    (String(dmarc[1] || "").toLowerCase() === "pass" && String(dmarc[2] || "").toLowerCase() === fromDomain) ||
    dkimPassed.some(aligned)
  );
  return { from, verified, checkedBy: byCloudflare ? "mx.cloudflare.net" : null, dkim: dkimPassed, dmarc: String(dmarc[1] || "none").toLowerCase() };
}

/** The whole message as bytes, whatever shape Cloudflare (or a test) hands over. Read once. */
export async function readBytes(raw) {
  if (typeof raw === "string") return new TextEncoder().encode(raw);
  return readAll(raw);
}

async function readAll(stream) {
  if (!stream) return new Uint8Array();
  if (stream instanceof Uint8Array) return stream;
  const reader = stream.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
    // A message larger than Email Routing's own 25 MiB inbound cap cannot be real; refusing
    // early also means a hostile sender cannot make us hold an unbounded buffer.
    if (total > 26_214_400) throw Object.assign(new Error("too large"), { name: "TooLarge" });
  }
  const out = new Uint8Array(total);
  let i = 0;
  for (const c of chunks) { out.set(c, i); i += c.length; }
  return out;
}

function decodeLatin1(bytes) {
  // One char per byte, so quoted-printable and base64 decode to the right bytes before any
  // UTF-8 interpretation happens. mimeCorpus() does the UTF-8 step per part.
  // By hand, not TextDecoder("latin1"): the web's "latin1" is really windows-1252, which turns
  // bytes 0x80-0x9F into other characters (0x80 -> "€"), so the bytes do not survive the round
  // trip. Found 23 Sep while making the original downloadable, where they must.
  let s = "";
  for (let i = 0; i < bytes.length; i += 8192) s += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return s;
}

function now() { return Date.now(); }
