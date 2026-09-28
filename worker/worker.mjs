// devpings mail worker: deployable template.
//
// Deployed by the OWNER of a domain into THEIR OWN Cloudflare account via the official
// Deploy button. No third party ever holds a credential for this worker: the mint key is
// generated here, shown once, and only its SHA-256 digest is stored.
//
// THE TWO-GATE CLAIM:
//   Gate 1 — account control: setup refuses unless the caller presents the `claim_authz`
//   secret that the owner placed in the STEPS KV namespace BY HAND in their own dashboard.
//   Absent entry = fail closed (F4-2). Wrong guesses are priced: 5 consecutive failures
//   lock /setup and /setup/claim for 5 minutes, correct answers included (F4-3).
//   Gate 2 — mail routing: a claim ripens only when the challenge email carrying its nonce
//   arrives THROUGH THIS WORKER'S OWN catch-all (proving the domain's mail lands here).
//   Sending mail proves nothing by itself: no key is released without Gate 1 again at
//   /setup/claim (F3-1, and the negative case is a test, per the A-check's warning).
//
// KEY LIFECYCLE (F4-1 ordering): the email handler only marks the claim ready. The key is
// generated at /setup/claim after claim_authz validates; it is returned once, THEN
// claim_authz is deleted and setup locks permanently. A locked worker answers 409 on both
// setup routes — the owner's compromise-discovery signal, a deliberate trade recorded in
// the spec's revision history.
//
// /health is the ONLY route with CORS, and it is NOT a setup oracle: byte-identical
// `{ ok: true }` before and after setup. Auth on the mail routes is the
// X-Keyway-Mint-Key HEADER ONLY — a key in a query string is refused even when correct.

import { deliver } from "./deliver.mjs";
import { handleEmail, normaliseAddress, readBytes } from "./converter.mjs";
import { joinOn, joinToken, keepJoin, readJoin } from "./join.mjs";
import { PAGE } from "./page.mjs";
import { HOSTED, keepHosted, keepInInbox, setLimits, usage } from "./hosted.mjs";
import { inboxRoute, isBlocked, wordsAllowed } from "./inbox.mjs";
import { forwardOrNotice, gate } from "./gate.mjs";
import { prefsRoute, windowOpen } from "./prefs.mjs";
import { sendDigest } from "./digest.mjs";
import { alarmIfUnwell } from "./health.mjs";
import { moderateRoute } from "./outbound.mjs";
import { quarantineRoute } from "./quarantine.mjs";

const STEP_TTL_SECONDS = 900;      // a step's expiry, never the address's
const CLAIM_TTL_SECONDS = 900;     // 15 minutes per pending claim
const CLAIM_MAX_PENDING = 3;       // cap on simultaneous pending claims (A4)
const LOCKOUT_AFTER_FAILS = 5;     // consecutive claim_authz failures before lockout
const LOCKOUT_TTL_SECONDS = 300;   // 5-minute lockout (F4-3)
const SETUP_MAILBOX = "keyway-setup"; // local part the challenge email must be sent to
const SEND_PER_DAY = 20;             // reply-only sending; a cap so a mistake stays small

// ---- small crypto helpers (Workers runtime + Node test runtime both have webcrypto) ----

async function sha256Hex(s) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(s)));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function randomToken(bytes = 24) {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  let s = "";
  for (const b of a) s += String.fromCharCode(b);
  return btoa(s).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

// ---- gate 1: claim_authz validation with fail pricing ----------------------------------
// Returns { ok:true } | { ok:false, response } . The SAME counter covers /setup and
// /setup/claim so an attacker cannot shop between the two routes for free guesses.

async function gate1(env, presented) {
  const fails = parseInt((await env.STEPS.get("setup:fails")) || "0", 10);
  if (fails >= LOCKOUT_AFTER_FAILS) {
    return { ok: false, response: json({ error: "too many failed attempts; locked for a few minutes" }, 429) };
  }
  const stored = await env.STEPS.get("claim_authz");
  if (stored === null || stored === "") {
    // F4-2: fail closed. A worker whose owner has not yet written claim_authz is UNCLAIMABLE,
    // not open — this is the window the whole spec chain existed to close.
    return { ok: false, response: json({ error: "setup is not enabled: no claim_authz found in the STEPS KV namespace. Set it in your Cloudflare dashboard first." }, 403) };
  }
  // Compared as digests, not as strings: a short-circuiting compare of the secret itself
  // leaks a timing signal in principle (build check F6). Digesting both first means the
  // comparison never touches the secret's bytes in order.
  if ((await sha256Hex(presented ?? "")) !== (await sha256Hex(stored))) {
    await env.STEPS.put("setup:fails", String(fails + 1), { expirationTtl: LOCKOUT_TTL_SECONDS });
    return { ok: false, response: json({ error: "claim_authz does not match" }, 403) };
  }
  return { ok: true };
}

// ---- header-only mint-key auth (digest compare; the key itself is stored nowhere) ------

async function authorised(request, url, env) {
  // A key in the URL is a key in someone's logs. Refuse the request outright, even if the
  // value is correct — otherwise "it worked" teaches the leaking habit.
  if (url.searchParams.has("k")) return false;
  const digest = await env.STEPS.get("setup:key_digest");
  if (!digest) return false;
  const header = request.headers.get("X-Keyway-Mint-Key");
  if (header === null) return false;
  return (await sha256Hex(header)) === digest;
}

async function boundDomain(env) {
  return (await env.STEPS.get("setup:domain")) || null;
}

export default {
  async email(message, env, ctx) {
    const address = normaliseAddress(message.to);
    const at = address.lastIndexOf("@");
    const local = at === -1 ? address : address.slice(0, at);

    // Gate 2: the challenge email. Its arrival HERE is the routing proof — only mail for a
    // domain whose catch-all targets this worker can reach this handler. It marks the claim
    // ready; it releases nothing (F4-1) and it cannot open a claim (F3-1's negative case).
    if (local === SETUP_MAILBOX) {
      if (await env.STEPS.get("setup:lock")) return; // locked workers ignore setup mail
      const body = await readMessageText(message);
      const pending = await env.STEPS.list({ prefix: "claim:" });
      for (const { name } of pending.keys) {
        const nonce = name.slice("claim:".length);
        if (!body.includes(nonce)) continue;
        const claim = JSON.parse((await env.STEPS.get(name)) || "{}");
        const mailDomain = at === -1 ? "" : address.slice(at + 1);
        // The claim names a domain and the mail arrived on a domain; they must be the same
        // domain, or a claim for foo.com could ripen off mail routed for bar.com.
        if (!claim.domain || claim.domain.toLowerCase() !== mailDomain.toLowerCase()) continue;
        // A ripened-but-uncollected claim expires like a pending one (build check F3):
        // otherwise it would extend claim_authz's useful life from fifteen minutes to
        // unbounded. The domain is bound at COLLECTION, not here — only a completed setup
        // deserves permanent state.
        await env.STEPS.put("setup:ready", JSON.stringify({ domain: claim.domain, nonce, at: Date.now() }), { expirationTtl: CLAIM_TTL_SECONDS });
        await env.STEPS.delete(name);
        return;
      }
      return; // no matching pending claim: the mail advances nothing
    }

    // Ordinary product mail: converter path, domain from KV (bound at claim time).
    const domain = await boundDomain(env);
    if (!domain) return; // unconfigured worker holds no addresses and stores nothing

    // THE INBOX (24 Sep 2026). Mail to an address this worker minted is kept for a week in the
    // owner's own KV, window or not, so a letter that arrives while nobody is listening is not
    // lost. Mail to addresses nobody minted is still kept nowhere. The raw stream can be read
    // once, so it is read here and handed on as bytes.
    // Team addresses (26 Sep 2026): support@ and security@ also reach a person, forwarded to FORWARD_TO
    // (a Cloudflare-verified destination), and are still kept here like any other mail.
    // B2 (spec 27 D2, 27 Sep 2026): every mail is checked once before anything is kept or forwarded.
    // Mail nobody would keep is not read at all, so it costs no check (build check sonnet02 F2).
    const token = joinOn(env) ? joinToken(local) : null;
    const rec = await env.ADDRESSES.get(address);
    const rawStep = token || rec ? null : await env.STEPS.get(`step:${address}`);
    const team = Boolean(env.FORWARD_TO) && ["support", "security"].includes(local);
    if (!token && !rec && !rawStep && !team) return;
    const bytes = await readBytes(message.raw);
    // Blocked senders are dropped before anything; mail from anyone not approved is a request (inbox.mjs).
    if (rec && (await isBlocked(env, address, bytes))) return;
    const approved = token || !rec || (await wordsAllowed(env, address, Boolean(JSON.parse(rec).hosted), bytes));
    const mod = { ...(await gate(env, bytes, address, message.from)), request: !approved, window: Boolean(rec) && (await windowOpen(env, address)) };
    if (mod.verdict === "drop") return; // never stored, forwarded or shown (gate.mjs keeps the fingerprint)
    if (team) await forwardOrNotice(message, env, local, mod, bytes);
    if (token) return keepJoin(env, token, bytes, local); // sign-up verification: sender only (join.mjs)
    if (rec && JSON.parse(rec).hosted) return keepHosted(env, address, message.from, bytes, Date.now(), mailId(), mod); // spec 22
    if (rec) await keepInInbox(env, address, message.from, bytes, mailId(), mod);
    if (mod.verdict !== "clean") return; // held: no step reads a flagged or unchecked mail

    const raw = rawStep ?? await env.STEPS.get(`step:${address}`);
    const step = raw ? JSON.parse(raw) : null;
    return handleEmail({ to: message.to, from: message.from, headers: message.headers, raw: bytes }, adapt(env, domain, address, step));
  },

  async scheduled(_event, env, ctx) { ctx.waitUntil(Promise.all([sendDigest(env), alarmIfUnwell(env)])); }, // 19:00 UTC: digest + self-check

  async fetch(request, env) {
    const url = new URL(request.url);
    const method = request.method;

    // /health — the one CORS route, and never a setup oracle: identical before/after setup.
    if (url.pathname === "/health") {
      if (method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json", ...CORS },
      });
    }

    if (url.pathname === "/setup" && method === "POST") {
      if (await env.STEPS.get("setup:lock")) return json({ error: "locked" }, 409);
      const body = await readJson(request);
      const g = await gate1(env, body.claim_authz);
      if (!g.ok) return g.response;
      const domain = String(body.domain || "").trim().toLowerCase();
      if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(domain)) return json({ error: "domain is required, e.g. example.com" }, 400);
      const pending = await env.STEPS.list({ prefix: "claim:" });
      if (pending.keys.length >= CLAIM_MAX_PENDING) {
        return json({ error: "too many pending claims; wait for one to expire (15 minutes)" }, 429);
      }
      const nonce = randomToken(18);
      await env.STEPS.put(`claim:${nonce}`, JSON.stringify({ domain, createdAt: Date.now() }), { expirationTtl: CLAIM_TTL_SECONDS });
      return json({
        nonce,
        send_to: `${SETUP_MAILBOX}@${domain}`,
        instructions: `Send an email containing this nonce to ${SETUP_MAILBOX}@${domain} within 15 minutes. When it arrives through your catch-all, call POST /setup/claim with your claim_authz to receive your mint key (shown once).`,
        expires_in_seconds: CLAIM_TTL_SECONDS,
      });
    }

    if (url.pathname === "/setup/claim" && method === "POST") {
      if (await env.STEPS.get("setup:lock")) return json({ error: "locked" }, 409);
      const body = await readJson(request);
      const g = await gate1(env, body.claim_authz); // Gate 1 AGAIN at the release hop (F3-1)
      if (!g.ok) return g.response;
      const readyRaw = await env.STEPS.get("setup:ready");
      if (!readyRaw) return json({ error: "challenge not completed: no verified challenge email has arrived yet" }, 409);
      const ready = JSON.parse(readyRaw);
      // F4-1 order: generate -> return once -> delete claim_authz -> lock. The key exists in
      // this response and nowhere else; KV holds only its digest.
      const mintKey = randomToken(24);
      await env.STEPS.put("setup:key_digest", await sha256Hex(mintKey));
      await env.STEPS.put("setup:domain", ready.domain); // bound only on completed setup (F3)
      await env.STEPS.delete("claim_authz");
      await env.STEPS.delete("setup:ready");
      await env.STEPS.put("setup:lock", "1");
      return json({
        mint_key: mintKey,
        domain: ready.domain,
        shown_once: true,
        note: "This key is stored nowhere. If you lose it, recovery is: delete the catch-all rule, the worker, and the two KV namespaces in your dashboard, then redeploy.",
      });
    }

    if (url.pathname === "/mint" && method === "POST") {
      if (!(await authorised(request, url, env))) return json({ error: "not authorised to mint on this domain" }, 403);
      const domain = await boundDomain(env);
      if (!domain) return json({ error: "worker is not set up" }, 409);
      const account = (url.searchParams.get("account") || "github").replace(/[^a-z0-9-]/gi, "").toLowerCase();
      const hosted = url.searchParams.get("hosted") === "1"; // spec 22: only agent-<10 random>, never a reserved name
      if (hosted && !HOSTED.test(account)) return json({ error: "hosted addresses are agent-<10 random> only" }, 400);
      const address = `${account}@${domain}`;
      if (hosted && (await env.ADDRESSES.get(address))) return json({ error: "address taken" }, 409);
      await env.ADDRESSES.put(address, JSON.stringify({ account, createdAt: Date.now(), ...(hosted ? { hosted: true } : {}) }));
      return json({ address, permanent: true });
    }

    if (url.pathname === "/address") {
      if (!(await authorised(request, url, env))) return json({ error: "not authorised" }, 403);
      const domain = await boundDomain(env);
      if (!domain) return json({ error: "worker is not set up" }, 409);
      const account = (url.searchParams.get("account") || "github").replace(/[^a-z0-9-]/gi, "").toLowerCase();
      const address = `${account}@${domain}`;
      const rec = await env.ADDRESSES.get(address);
      return json(rec ? { address, permanent: true, createdAt: JSON.parse(rec).createdAt } : { address: null });
    }

    if (url.pathname === "/step" && method === "POST") {
      if (!(await authorised(request, url, env))) return json({ error: "not authorised" }, 403);
      const address = String(url.searchParams.get("address") || "").toLowerCase();
      if (!(await env.ADDRESSES.get(address))) return json({ error: "no such address; mint it first" }, 404);
      const step = {
        id: url.searchParams.get("step") || "github/verify-email",
        address,
        expect: url.searchParams.get("expect") || "link:verify",
        linkPattern: url.searchParams.get("linkPattern") || undefined,
        expiresAt: Date.now() + STEP_TTL_SECONDS * 1000,
      };
      await env.STEPS.put(`step:${address}`, JSON.stringify(step), { expirationTtl: STEP_TTL_SECONDS });
      return json({ opened: step.id, address, expiresAt: step.expiresAt });
    }

    if (url.pathname === "/result") {
      if (!(await authorised(request, url, env))) return json({ error: "not authorised" }, 403);
      const address = String(url.searchParams.get("address") || "").toLowerCase();
      const held = await env.STEPS.get(`result:${address}`);
      const addressAlive = Boolean(await env.ADDRESSES.get(address));
      return json({ address, addressAlive, result: held ? JSON.parse(held) : null });
    }

    // The inbox: newest first. DELETE with &id= removes one message.
    // Sending (24 Sep 2026): reply-only by design. Cloudflare's send_email binding only delivers to
    // VERIFIED destination addresses (each recipient clicked Cloudflare's consent link once), the
    // sender must be an address this worker created, and there is a daily cap. The allow list in
    // the owner's key file is checked by the command before it ever calls this.
    if (url.pathname === "/deliver" && method === "POST") { // the site's feedback form (deliver.mjs)
      if (!(await authorised(request, url, env))) return json({ error: "not authorised" }, 403);
      const r = await deliver(env, await readJson(request), mailId()); return json(r.body, r.status);
    }
    if (url.pathname === "/send" && method === "POST") {
      if (!(await authorised(request, url, env))) return json({ error: "not authorised" }, 403);
      if (!env.EMAIL) return json({ error: "sending isn't switched on for this worker" }, 501);
      const b = await readJson(request);
      const from = String(b.from || "").toLowerCase();
      const to = String(b.to || "").toLowerCase();
      const subject = String(b.subject || "").slice(0, 200);
      const text = String(b.text || "");
      if (!(await env.ADDRESSES.get(from))) return json({ error: "send from an address this worker created" }, 400);
      if (!/^[^\s@]{1,64}@[^\s@]+\.[^\s@]+$/.test(to)) return json({ error: "one recipient address" }, 400);
      if (!text.trim() || text.length > 20000) return json({ error: "text is required, up to 20,000 characters" }, 400);
      const day = new Date().toISOString().slice(0, 10);
      const sent = parseInt((await env.STEPS.get(`sent:${day}`)) || "0", 10);
      if (sent >= SEND_PER_DAY) return json({ error: `daily limit of ${SEND_PER_DAY} reached` }, 429);
      try {
        await env.EMAIL.send({ from, to, subject, text });
      } catch (e) {
        return json({ error: `Cloudflare refused: ${e && e.message ? e.message : "send failed"}` }, 502);
      }
      await env.STEPS.put(`sent:${day}`, String(sent + 1), { expirationTtl: 2 * 24 * 3600 });
      return json({ sent: true, from, to });
    }

    // Spec 22: the devpings service pushes limits and switches in, and reads the counts out.
    if (url.pathname === "/limits" && method === "POST") {
      if (!(await authorised(request, url, env))) return json({ error: "not authorised" }, 403);
      return json(await setLimits(env, await readJson(request)));
    }
    if (url.pathname === "/usage" && method === "GET") {
      if (!(await authorised(request, url, env))) return json({ error: "not authorised" }, 403);
      return json({ rows: await usage(env) });
    }

    if ((url.pathname === "/moderate" || url.pathname === "/quarantine") && method === "POST") { // outbound.mjs, quarantine.mjs
      if (!(await authorised(request, url, env))) return json({ error: "not authorised" }, 403);
      const [status, body] = await (url.pathname === "/moderate" ? moderateRoute : quarantineRoute)(env, () => readJson(request)); return json(body, status);
    }
    if (["/prefs", "/wait", "/world"].includes(url.pathname)) {
      if (!(await authorised(request, url, env))) return json({ error: "not authorised" }, 403);
      const [status, body] = await prefsRoute(env, url, method, () => readJson(request));
      return json(body, status);
    }
    if (["/inbox", "/senders", "/blocked", "/last"].includes(url.pathname)) {
      if (!(await authorised(request, url, env))) return json({ error: "not authorised" }, 403);
      const [status, body] = await inboxRoute(env, url, method, () => readJson(request));
      return json(body, status);
    }

    if (url.pathname.startsWith("/join/") && method === "GET" && joinOn(env)) return readJoin(env, url.pathname);

    if (url.pathname === "/" && method === "GET") return html(PAGE);
    return new Response("not found", { status: 404 });
  },
};

// Same adapter contract as the engine's bootstrap spike, with the domain read from KV
// (bound at claim time) instead of an env var — the template ships with no domain in it.
export function adapt(env, domain, address, step) {
  return {
    DOMAIN: domain,
    STEPS: { lookup: (to) => (step && step.address === to ? step : null) },
    EMIT: async (event) => {
      if (event.kind === "ignored" || event.kind === "expired") return;
      if (event.kind === "received") {
        // Every message in the window is kept (last five), so two arriving close together are
        // both shown. The step stays open: the human decides which one mattered.
        const prev = JSON.parse((await env.STEPS.get(`result:${address}`)) || "null");
        const items = prev && prev.kind === "messages" ? prev.items : [];
        items.push(event);
        await env.STEPS.put(`result:${address}`, JSON.stringify({ kind: "messages", items: items.slice(-5) }), { expirationTtl: STEP_TTL_SECONDS });
        return;
      }
      await env.STEPS.put(`result:${address}`, JSON.stringify(event), { expirationTtl: STEP_TTL_SECONDS });
      if (event.kind === "extracted") await env.STEPS.delete(`step:${address}`);
    },
  };
}

async function readJson(request) {
  try { return (await request.json()) ?? {}; } catch { return {}; }
}

function mailId() {
  // Time first so keys sort by arrival; a random tail so two in one millisecond never collide.
  return `${Date.now().toString(36).padStart(9, "0")}-${randomToken(6)}`;
}

async function readMessageText(message) {
  const raw = message.raw;
  if (typeof raw === "string") return raw;
  if (raw && typeof raw.getReader === "function") {
    const reader = raw.getReader();
    const chunks = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    let total = 0;
    for (const c of chunks) total += c.length;
    const joined = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) { joined.set(c, offset); offset += c.length; }
    return new TextDecoder().decode(joined);
  }
  return String(raw ?? "");
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

const json = (o, status = 200) => new Response(JSON.stringify(o, null, 2), { status, headers: { "content-type": "application/json" } });
const html = (s) => new Response(s, { headers: { "content-type": "text/html; charset=utf-8" } });
