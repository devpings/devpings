// DoD for approved senders and "done" (27 Sep 2026, the owner). Each line is one test below.
// 1. A hosted address starts with no one approved: a stranger's mail is a request, checked and kept in full
//    for the owner (the owner: see it before approving).
// 2. An approved, verified sender's mail is not a request; a forged, unverified From is.
// 7. /last says when each address last got mail, with the key only.
// 6. Blocked senders (exact or @domain) are dropped on arrival, codes and all; "*" can't be blocked.
// 3. "@domain" and "*" work; bad entries are refused; the list needs the key.
// 4. Team addresses (not hosted) accept words from anyone by default.
// 5. The agent can mark a mail done; the mark keeps it, with the time.
import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import worker from "../worker/worker.mjs";

const DOMAIN = "d.example", KEY = "worker-key-for-tests", A = `agent-abcde12345@${DOMAIN}`;
const sha = (s) => createHash("sha256").update(s).digest("hex");
function stubKv(initial = {}) {
  const m = new Map(Object.entries(initial));
  return { get: async (k) => m.get(k) ?? null, put: async (k, v) => { m.set(k, v); }, delete: async (k) => { m.delete(k); },
    list: async ({ prefix = "" } = {}) => ({ keys: [...m.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })) }), _map: m };
}
const env = () => {
  const e = { calls: 0, DOMAIN, ADDRESSES: stubKv(), STEPS: stubKv({ "setup:domain": DOMAIN, "setup:key_digest": sha(KEY), "setup:lock": "1" }) };
  e.AI = { run: async () => { e.calls++; return { response: { safe: true, categories: [] } }; } };
  return e;
};
const call = (e, path, { method = "GET", body, key = KEY } = {}) =>
  worker.fetch(new Request(`https://w.example${path}`, { method, headers: { ...(key ? { "X-Keyway-Mint-Key": key } : {}), "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined }), e);
const mint = (e, account, hosted = true) => call(e, `/mint?account=${account}${hosted ? "&hosted=1" : ""}`, { method: "POST" });
// Cloudflare writes its verdict on top; "pass" makes the From verified (see senderOf in converter.mjs).
const mail = (to, from, verified = true) => ({
  to, from,
  raw: `${verified ? `Authentication-Results: mx.cloudflare.net; dmarc=pass header.from=${from.split("@")[1]}\r\n` : ""}From: ${from}\r\nTo: ${to}\r\nSubject: Hello\r\nContent-Type: text/plain\r\n\r\nPlease fix the typo. Your code is 482913. https://x.example/verify?t=1\r\n`,
});
const kept = (e, addr = A) => [...e.STEPS._map.entries()].filter(([k]) => k.startsWith(`inbox:${addr}:`)).map(([, v]) => JSON.parse(v));

describe("approved senders and done", () => {
  it("DoD 1 — stranger: a request, checked, words kept for the owner", async () => {
    const e = env(); await mint(e, "agent-abcde12345");
    await worker.email(mail(A, "stranger@x.example"), e);
    expect(kept(e)[0]).toMatchObject({ check: "clean", request: true, codes: ["482913"] });
    expect(kept(e)[0].body).toContain("fix the typo");
    expect(e.calls).toBe(1);
  });

  it("DoD 2 — approved + verified: not a request; forged From is", async () => {
    const e = env(); await mint(e, "agent-abcde12345");
    expect((await call(e, "/senders", { method: "POST", body: { address: A, senders: ["sam@x.example"] } })).status).toBe(200);
    await worker.email(mail(A, "sam@x.example"), e);
    await worker.email(mail(A, "sam@x.example", false), e);
    expect(kept(e).length).toBe(2);
    expect(kept(e).filter((i) => i.request).length).toBe(1);
    expect(kept(e).filter((i) => !i.request)[0].body).toContain("fix the typo");
  });

  it("DoD 6 — blocked: dropped on arrival", async () => {
    const e = env(); await mint(e, "agent-abcde12345");
    expect((await call(e, "/blocked", { method: "POST", body: { address: A, senders: ["@spam.example"] } })).status).toBe(200);
    expect((await call(e, "/blocked", { method: "POST", body: { address: A, senders: ["*"] } })).status).toBe(400);
    await worker.email(mail(A, "pitch@spam.example"), e);
    expect(kept(e)).toEqual([]);
    expect(e.calls).toBe(0);
    expect([...e.STEPS._map.entries()].find(([k]) => k.startsWith(`blocked:count:${A}:`))?.[1]).toBe("1");
    await worker.email(mail(A, "friend@x.example"), e);
    expect(kept(e).length).toBe(1);
  });

  it("DoD 3 — @domain, *, bad entries, key", async () => {
    const e = env(); await mint(e, "agent-abcde12345");
    await call(e, "/senders", { method: "POST", body: { address: A, senders: ["@x.example"] } });
    await worker.email(mail(A, "anyone@x.example"), e);
    expect(kept(e)[0]).toMatchObject({ check: "clean" });
    expect(kept(e)[0].request).toBe(false);
    expect((await call(e, "/senders", { method: "POST", body: { address: A, senders: ["not an address"] } })).status).toBe(400);
    expect((await call(e, `/senders?address=${A}`, { key: null })).status).toBe(403);
    expect((await (await call(e, `/senders?address=${A}`)).json()).senders).toEqual(["@x.example"]);
  });

  it("DoD 4 — team addresses accept anyone by default", async () => {
    const e = env(); await mint(e, "opus", false);
    await worker.email(mail(`opus@${DOMAIN}`, "stranger@y.example", false), e);
    expect(kept(e, `opus@${DOMAIN}`)[0].check).toBe("clean");
  });

  it("DoD 5 — done", async () => {
    const e = env(); await mint(e, "agent-abcde12345");
    await worker.email(mail(A, "stranger@x.example"), e);
    const id = kept(e)[0].id;
    expect((await call(e, `/inbox?address=${A}&id=${id}&action=done`, { method: "POST" })).status).toBe(200);
    expect(kept(e)[0].done.at).toBeGreaterThan(0);
  });

  it("DoD 7 — /last", async () => {
    const e = env(); await mint(e, "agent-abcde12345");
    expect((await (await call(e, `/last?addresses=${A}`)).json()).last[A]).toBe(0);
    await worker.email(mail(A, "stranger@x.example"), e);
    expect((await (await call(e, `/last?addresses=${A}`)).json()).last[A]).toBeGreaterThan(0);
    expect((await call(e, `/last?addresses=${A}`, { key: null })).status).toBe(403);
  });

  it("DoD 8 — '*' approves no one on an agent address; request is written true or false", async () => {
    const e = env(); await mint(e, "agent-abcde12345");
    await call(e, "/senders", { method: "POST", body: { address: A, senders: ["*", "sam@x.example"] } });
    await worker.email(mail(A, "stranger@x.example"), e);
    await worker.email(mail(A, "sam@x.example"), e);
    expect(kept(e).find((i) => i.body && i.request === true)).toBeTruthy();
    expect(kept(e).find((i) => i.request === false)).toBeTruthy();
  });
});
