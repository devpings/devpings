// DoD for the owner's choices and the timed window (28 Sep 2026, the owner). Each line is one test below.
// 1. Choices per mailbox: default is untrusted "window", trusted "full"; set, read back; bad values refused; key required.
// 2. The window is stamped at arrival: mail that came before /wait carries no window, mail during it does.
// 3. seen and undone: the agent's first look is recorded; the owner's "back to new" clears done and seen.
// 4. Team addresses forward only clean mail from a confirmed sender; anything else becomes a notice.
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
  const sent = [];
  return { DOMAIN, FORWARD_TO: "owner@x.example", EMAIL: { send: async (m) => { sent.push(m); } }, _sent: sent,
    AI: { run: async () => ({ response: { safe: true, categories: [] } }) },
    ADDRESSES: stubKv(), STEPS: stubKv({ "setup:domain": DOMAIN, "setup:key_digest": sha(KEY), "setup:lock": "1" }) };
};
const call = (e, path, { method = "GET", body, key = KEY } = {}) =>
  worker.fetch(new Request(`https://w.example${path}`, { method, headers: { ...(key ? { "X-Keyway-Mint-Key": key } : {}), "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined }), e);
const mint = (e, account, hosted = true) => call(e, `/mint?account=${account}${hosted ? "&hosted=1" : ""}`, { method: "POST" });
const mail = (to, from, verified = true, forwarded = []) => ({
  to, from, forward: async (t) => { forwarded.push(t); },
  raw: `${verified ? `Authentication-Results: mx.cloudflare.net; dmarc=pass header.from=${from.split("@")[1]}\r\n` : ""}From: ${from}\r\nTo: ${to}\r\nSubject: Code\r\nContent-Type: text/plain\r\n\r\nYour code is 482913.\r\n`,
});
const kept = (e, addr = A) => [...e.STEPS._map.entries()].filter(([k]) => k.startsWith(`inbox:${addr}:`)).map(([, v]) => JSON.parse(v));

describe("owner's choices and the timed window", () => {
  it("DoD 1 — choices: default, set, refused, key required", async () => {
    const e = env(); await mint(e, "agent-abcde12345");
    expect(await (await call(e, `/prefs?address=${A}`)).json()).toMatchObject({ untrusted: "window", trusted: "full", set: false });
    expect((await call(e, "/prefs", { method: "POST", body: { address: A, untrusted: "release", trusted: "world" } })).status).toBe(200);
    expect(await (await call(e, `/prefs?address=${A}`)).json()).toMatchObject({ untrusted: "release", trusted: "world", set: true });
    expect((await call(e, "/prefs", { method: "POST", body: { address: A, untrusted: "anything", trusted: "full" } })).status).toBe(400);
    expect((await call(e, `/prefs?address=${A}`, { key: null })).status).toBe(403);
    expect((await call(e, `/wait?address=${A}`, { method: "POST", key: null })).status).toBe(403);
  });

  it("DoD 2 — the window is stamped at arrival, not after", async () => {
    const e = env(); await mint(e, "agent-abcde12345");
    await worker.email(mail(A, "a@x.example"), e);                      // before any wait
    expect((await call(e, `/wait?address=${A}`, { method: "POST" })).status).toBe(200);
    await worker.email(mail(A, "b@x.example"), e);                      // during the window
    const byFrom = Object.fromEntries(kept(e).map((i) => [i.from, i]));
    expect(byFrom["a@x.example"].window).toBeUndefined();
    expect(byFrom["b@x.example"].window).toBe(true);
  });

  it("DoD 3 — seen, done, and back to new", async () => {
    const e = env(); await mint(e, "agent-abcde12345");
    await worker.email(mail(A, "a@x.example"), e);
    const id = kept(e)[0].id;
    expect((await call(e, `/inbox?address=${A}&id=${id}&action=seen`, { method: "POST" })).status).toBe(200);
    expect((await call(e, `/inbox?address=${A}&id=${id}&action=done`, { method: "POST" })).status).toBe(200);
    expect(kept(e)[0]).toMatchObject({ seen: expect.any(Object), done: expect.any(Object) });
    expect((await call(e, `/inbox?address=${A}&id=${id}&action=undone`, { method: "POST" })).status).toBe(200);
    expect(kept(e)[0].done).toBeUndefined();
    expect(kept(e)[0].seen).toBeUndefined();
    expect(kept(e)[0].back).toBeDefined();
  });

  it("DoD 4 — team addresses forward only clean mail from a confirmed sender", async () => {
    const e = env(); await mint(e, "security", false);
    const fwd = [];
    await worker.email(mail(`security@${DOMAIN}`, "docusign@phish.example", false, fwd), e);
    expect(fwd).toEqual([]);
    expect(e._sent).toEqual([]); // counted for the daily notice (DoD 5)
    await worker.email(mail(`security@${DOMAIN}`, "reporter@x.example", true, fwd), e);
    expect(fwd).toEqual(["owner@x.example"]);
    expect(kept(e, `security@${DOMAIN}`).length).toBe(2); // both still kept for the mail view
  });
});

describe("the daily notice (28 Sep)", () => {
  it("DoD 5 — held team mail is counted, not mailed; the 5 am run sends one summary without words, then clears", async () => {
    const e = env(); await mint(e, "security", false); await mint(e, "support", false);
    await worker.email(mail(`security@${DOMAIN}`, "docusign@phish.example", false), e);
    await worker.email(mail(`security@${DOMAIN}`, "other@phish.example", false), e);
    await worker.email(mail(`support@${DOMAIN}`, "x@phish.example", false), e);
    expect(e._sent).toEqual([]);
    const waits = [];
    await worker.scheduled({}, e, { waitUntil: (p) => waits.push(p) });
    await Promise.all(waits);
    const digests = () => e._sent.filter((m) => m.subject.includes("held")); // the self-check may also write (DoD 9)
    expect(digests().length).toBe(1);
    expect(digests()[0].subject).toContain("3 mails held");
    expect(digests()[0].text).toContain(`security@${DOMAIN}: 2 not forwarded (2 sender not confirmed)`);
    expect(digests()[0].text).not.toContain("482913");
    await worker.scheduled({}, e, { waitUntil: (p) => waits.push(p) });
    await Promise.all(waits);
    expect(digests().length).toBe(1); // nothing new: no mail
  });
});

describe("outgoing moderation (28 Sep)", () => {
  it("DoD 6 — /moderate needs the key, answers the verdict, fails closed", async () => {
    const e = env();
    expect((await call(e, "/moderate", { method: "POST", body: { text: "hello" }, key: null })).status).toBe(403);
    expect(await (await call(e, "/moderate", { method: "POST", body: { text: "hello" } })).json()).toMatchObject({ verdict: "clean" });
    e.AI = { run: async () => ({ response: "unsafe\nS10" }) };
    expect(await (await call(e, "/moderate", { method: "POST", body: { text: "x" } })).json()).toMatchObject({ verdict: "flagged", categories: ["S10"] });
    e.AI = undefined;
    expect((await (await call(e, "/moderate", { method: "POST", body: { text: "x" } })).json()).verdict).toBe("unchecked");
    expect((await call(e, "/moderate", { method: "POST", body: { text: "" } })).status).toBe(400);
  });
});

describe("world mode v2, stage Q (28 Sep)", () => {
  const answer = { kind: "copy", summary: "Change button", changes: [{ file: "app/page.tsx", find: "Sign in", replace: "Log in" }] };
  const withQ = () => { const e = env(); e.AI = { run: async (model) => model.includes("guard") ? { response: { safe: true, categories: [] } } : { response: JSON.stringify(answer) } }; return e; };
  it("DoD 7 — only a trusted, confirmed sender's clean mail, for an owner who chose world mode, is read by Q", async () => {
    const e = withQ(); await mint(e, "agent-abcde12345");
    await call(e, "/senders", { method: "POST", body: { address: A, senders: ["sam@x.example"] } });
    await worker.email(mail(A, "sam@x.example"), e);                     // world mode not chosen yet
    expect(kept(e)[0].world).toBeUndefined();
    await call(e, "/prefs", { method: "POST", body: { address: A, untrusted: "window", trusted: "world" } });
    await worker.email(mail(A, "sam@x.example"), e);                     // trusted + world: read by Q
    await worker.email(mail(A, "stranger@x.example"), e);                // a stranger: never
    await worker.email(mail(A, "sam@x.example", false), e);              // forged trusted: never
    const q = kept(e).filter((i) => i.world);
    expect(q.length).toBe(1);
    expect(q[0].world.answer).toEqual(answer);
  });
  it("DoD 8 — Q's unreadable answer is 'unclear'; /world records progress with the key only", async () => {
    const { parseAnswer } = await import("../worker/quarantine.mjs");
    expect(parseAnswer({ response: "sure! here you go" })).toEqual({ kind: "unclear" });
    expect(parseAnswer({ response: 'x {"kind":"bug","summary":"s","changes":[]} y' }).kind).toBe("bug");
    const e = withQ(); await mint(e, "agent-abcde12345");
    await worker.email(mail(A, "a@x.example"), e);
    const id = kept(e)[0].id;
    expect((await call(e, `/world?address=${A}&id=${id}`, { method: "POST", body: { state: "taken" }, key: null })).status).toBe(403);
    expect((await call(e, `/world?address=${A}&id=${id}`, { method: "POST", body: { state: "approved", pr: 7, head: "abc123" } })).status).toBe(200);
    expect(kept(e)[0].world).toMatchObject({ state: "approved", pr: 7, head: "abc123" });
    expect((await call(e, `/world?address=${A}&id=${id}`, { method: "POST", body: { state: "nonsense" } })).status).toBe(400);
  });
});

describe("silence alarms (29 Sep)", () => {
  it("DoD 9 — a healthy day sends nothing; a failed model sends one plain alarm", async () => {
    const { alarmIfUnwell } = await import("../worker/health.mjs");
    const ok = env(); ok.AI = { run: async (m) => m.includes("guard") ? { response: { safe: true, categories: [] } } : { response: '{"kind":"copy","summary":"s","changes":[{"find":"Check mail","replace":"Refresh"}]}' } };
    expect(await alarmIfUnwell(ok)).toEqual([]);
    expect(ok._sent).toEqual([]);
    const bad = env(); bad.AI = { run: async (m) => { if (m.includes("guard")) return { response: { safe: true, categories: [] } }; throw new Error("5028: model deprecated"); } };
    const p = await alarmIfUnwell(bad);
    expect(p[0]).toContain("world-mode reader failed");
    expect(bad._sent[0].subject).toContain("stopped working");
  });
});
