// DoD for the inbox (24 Sep 2026). Each line is one test below, named for it.
//
// 1. Mail to a minted address is kept, window or not, and can be read back with the key.
// 2. Mail to an address nobody minted is kept nowhere.
// 3. Newest first, and one message can be deleted.
// 4. No key, no inbox: reading and deleting both refuse without the mint key.
// 5. Keeping mail does not break the window: a code in an open step is still extracted.
// 6. It is kept for a week, not forever.
// 7. Sender verification: only Cloudflare's own verdict, on top, counts; a forged one below doesn't.
// 8. Sending: key required, from a created address only, capped per day, and off without the binding.
import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import worker from "../worker/worker.mjs";

const DOMAIN = "d.example";
const KEY = "a-mint-key-for-tests-only";
const sha = (s) => createHash("sha256").update(s).digest("hex");

function stubKv(initial = {}) {
  const m = new Map(Object.entries(initial));
  const ttl = new Map();
  return {
    get: async (k) => m.get(k) ?? null,
    put: async (k, v, o) => { m.set(k, v); if (o?.expirationTtl) ttl.set(k, o.expirationTtl); },
    delete: async (k) => { m.delete(k); },
    list: async ({ prefix = "" } = {}) => ({ keys: [...m.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })) }),
    _map: m, _ttl: ttl,
  };
}
// Since spec 27 D2 every mail passes the safety check first; here it always answers "safe"
// (worker-moderate.test.mjs covers the other verdicts).
const SAFE = { run: async () => ({ response: { safe: true, categories: [] } }) };
function configured() {
  return {
    AI: SAFE,
    ADDRESSES: stubKv({ [`opus@${DOMAIN}`]: JSON.stringify({ account: "opus", createdAt: 1 }) }),
    STEPS: stubKv({ "setup:domain": DOMAIN, "setup:key_digest": sha(KEY), "setup:lock": "1" }),
  };
}
const letter = (to, subject, text) => ({ to, from: `Sam <t@x.example>`, raw: `From: t@x.example\r\nTo: ${to}\r\nSubject: ${subject}\r\nContent-Type: text/plain\r\n\r\n${text}\r\n` });
const inbox = (env, { key = KEY, method = "GET", id } = {}) =>
  worker.fetch(new Request(`https://w.example/inbox?address=opus@${DOMAIN}${id ? `&id=${id}` : ""}`, { method, headers: key ? { "X-Keyway-Mint-Key": key } : {} }), env);

describe("the inbox", () => {
  it("DoD 1 — mail to a minted address is kept with no window open, and reads back", async () => {
    const env = configured();
    await worker.email(letter(`opus@${DOMAIN}`, "Hello, friend", "A letter while nobody listened."), env);
    const r = await (await inbox(env)).json();
    expect(r.items).toHaveLength(1);
    expect(r.items[0]).toMatchObject({ from: "t@x.example", subject: "Hello, friend" });
    expect(r.items[0].body).toContain("A letter while nobody listened.");
  });

  it("DoD 2 — mail to an unminted address is kept nowhere", async () => {
    const env = configured();
    await worker.email(letter(`stranger@${DOMAIN}`, "spam", "buy things"), env);
    expect([...env.STEPS._map.keys()].some((k) => k.startsWith("inbox:"))).toBe(false);
  });

  it("DoD 3 — newest first, and one can be deleted", async () => {
    const env = configured();
    await worker.email(letter(`opus@${DOMAIN}`, "first", "one"), env);
    await new Promise((r) => setTimeout(r, 5));
    await worker.email(letter(`opus@${DOMAIN}`, "second", "two"), env);
    const { items } = await (await inbox(env)).json();
    expect(items.map((i) => i.subject)).toEqual(["second", "first"]);
    expect((await inbox(env, { method: "DELETE", id: items[0].id })).status).toBe(200);
    const after = await (await inbox(env)).json();
    expect(after.items.map((i) => i.subject)).toEqual(["first"]);
  });

  it("DoD 4 — no key, no inbox", async () => {
    const env = configured();
    await worker.email(letter(`opus@${DOMAIN}`, "private", "for opus only"), env);
    expect((await inbox(env, { key: null })).status).toBe(403);
    expect((await inbox(env, { key: "wrong" })).status).toBe(403);
    expect((await inbox(env, { key: null, method: "DELETE", id: "x" })).status).toBe(403);
  });

  it("DoD 5 — an open window still extracts its code", async () => {
    const env = configured();
    const step = { id: "t", address: `opus@${DOMAIN}`, expect: "code:6", expiresAt: Date.now() + 60_000 };
    await env.STEPS.put(`step:opus@${DOMAIN}`, JSON.stringify(step));
    await worker.email(letter(`opus@${DOMAIN}`, "Your code", "Your verification code is 482913"), env);
    const result = JSON.parse(await env.STEPS.get(`result:opus@${DOMAIN}`));
    expect(result).toMatchObject({ kind: "extracted", value: "482913" });
  });

  it("DoD 6 — kept for a week", async () => {
    const env = configured();
    await worker.email(letter(`opus@${DOMAIN}`, "ttl", "x"), env);
    const key = [...env.STEPS._map.keys()].find((k) => k.startsWith("inbox:"));
    expect(env.STEPS._ttl.get(key)).toBe(7 * 24 * 3600);
  });

  it("DoD 7 — Cloudflare's verdict on top verifies; forged or foreign verdicts don't", async () => {
    const raw = (ar) => `${ar}From: Sam <sam@x.example>\r\nTo: opus@${DOMAIN}\r\nSubject: s\r\nContent-Type: text/plain\r\n\r\nhello\r\n`;
    const keep = async (text) => {
      const env = configured();
      await worker.email({ to: `opus@${DOMAIN}`, from: "bounce@mail.x.example", raw: text }, env);
      const { items } = await (await inbox(env)).json();
      return items[0];
    };
    const pass = await keep(raw("Authentication-Results: mx.cloudflare.net; dkim=pass header.d=x.example header.s=s1; dmarc=pass header.from=x.example policy.dmarc=none\r\n"));
    expect(pass).toMatchObject({ from: "sam@x.example", envelopeFrom: "bounce@mail.x.example", verified: true });

    const parentDkim = await keep(raw("Authentication-Results: mx.cloudflare.net; dkim=pass header.d=example header.s=s1; dmarc=none\r\n"));
    expect(parentDkim.verified).toBe(true);

    const forgedBelow = await keep(raw("Authentication-Results: mx.cloudflare.net; dkim=fail header.d=x.example; dmarc=fail header.from=x.example\r\nAuthentication-Results: mx.cloudflare.net; dmarc=pass header.from=x.example\r\n"));
    expect(forgedBelow.verified).toBe(false);

    const foreign = await keep(raw("Authentication-Results: evil.example; dmarc=pass header.from=x.example\r\n"));
    expect(foreign.verified).toBe(false);

    const otherDomain = await keep(raw("Authentication-Results: mx.cloudflare.net; dkim=pass header.d=attacker.example; dmarc=fail header.from=x.example\r\n"));
    expect(otherDomain.verified).toBe(false);

    const none = await keep(raw(""));
    expect(none.verified).toBe(false);
  });

  it("DoD 8 — sending is gated: key, created sender, daily cap, and switched off without the binding", async () => {
    const sent = [];
    const env = { ...configured(), EMAIL: { send: async (m) => { sent.push(m); } } };
    const send = (body, key = KEY, e = env) => worker.fetch(new Request("https://w.example/send", { method: "POST", headers: { "content-type": "application/json", ...(key ? { "X-Keyway-Mint-Key": key } : {}) }, body: JSON.stringify(body) }), e);
    const ok = { from: `opus@${DOMAIN}`, to: "friend@example.org", subject: "Re: hi", text: "hello back" };

    expect((await send(ok, null)).status).toBe(403);
    expect((await send({ ...ok, from: `stranger@${DOMAIN}` })).status).toBe(400);
    expect((await send({ ...ok, text: "" })).status).toBe(400);
    expect((await send(ok, KEY, configured())).status).toBe(501);

    expect((await send(ok)).status).toBe(200);
    expect(sent[0]).toMatchObject({ from: `opus@${DOMAIN}`, to: "friend@example.org", subject: "Re: hi" });

    const day = new Date().toISOString().slice(0, 10);
    await env.STEPS.put(`sent:${day}`, "20");
    expect((await send(ok)).status).toBe(429);
  });
});


describe("team addresses (26 Sep 2026)", () => {
  it("support@ and security@ are forwarded to FORWARD_TO, and nothing else is", async () => {
    // A confirmed sender since 28 Sep (unconfirmed mail becomes a notice: worker-prefs.test.mjs DoD 4).
    const env = { ...configured(), FORWARD_TO: "owner@x.example" };
    const sent = [];
    const confirmed = (m) => ({ ...m, raw: `Authentication-Results: mx.cloudflare.net; dmarc=pass header.from=x.example\r\n${m.raw}` });
    for (const to of [`support@${DOMAIN}`, `security@${DOMAIN}`, `opus@${DOMAIN}`]) {
      await worker.email({ ...confirmed(letter(to, "hi", "hello")), forward: async (a) => sent.push([to, a]) }, env);
    }
    expect(sent).toEqual([[`support@${DOMAIN}`, "owner@x.example"], [`security@${DOMAIN}`, "owner@x.example"]]);
  });
  it("forwards nothing without FORWARD_TO", async () => {
    const sent = [];
    await worker.email({ ...letter(`support@${DOMAIN}`, "hi", "hello"), forward: async (a) => sent.push(a) }, configured());
    expect(sent).toEqual([]);
  });
});

describe("delivery from our own site (26 Sep 2026)", () => {
  const post = (env, body, key = KEY) => worker.fetch(new Request("https://w.example/deliver", { method: "POST", headers: { "content-type": "application/json", ...(key ? { "X-Keyway-Mint-Key": key } : {}) }, body: JSON.stringify(body) }), env);
  it("drops a form message into a permanent address, unverified and marked as from the form", async () => {
    const env = configured();
    env.ADDRESSES._map.set(`team@${DOMAIN}`, JSON.stringify({ account: "team", permanent: true, createdAt: 1 }));
    expect((await post(env, { to: `team@${DOMAIN}`, from: "a@b.example", subject: "idea", text: "please add X" })).status).toBe(200);
    const [k] = [...env.STEPS._map.keys()].filter((k) => k.startsWith(`inbox:team@${DOMAIN}:`));
    const item = JSON.parse(env.STEPS._map.get(k));
    expect(item).toMatchObject({ from: "a@b.example", verified: false, via: "form", subject: "idea", body: "please add X" });
  });
  it("refuses without the key, and refuses a hosted user's address or an unknown one", async () => {
    const env = configured();
    env.ADDRESSES._map.set(`agent-x@${DOMAIN}`, JSON.stringify({ account: "agent-x", hosted: true, createdAt: 1 }));
    expect((await post(env, { to: `opus@${DOMAIN}`, text: "x" }, null)).status).toBe(403);
    expect((await post(env, { to: `agent-x@${DOMAIN}`, text: "x" })).status).toBe(400);
    expect((await post(env, { to: `nobody@${DOMAIN}`, text: "x" })).status).toBe(400);
    expect((await post(env, { to: `opus@${DOMAIN}`, text: "x" })).status).toBe(200);
  });
});
