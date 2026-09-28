// DoD for B2 moderation in the mail worker (spec 27 D2). Each line is one test below.
// 1. The model's answer is read in either shape; anything unreadable is "unchecked" (fail closed).
// 2. Clean mail is kept as before, marked clean.
// 3. S4 is dropped: nothing stored, nothing forwarded; a fingerprint and the envelope are kept and the owner alarmed.
// 4. Other categories: kept but flagged, no codes or links; support@ gets a notice, not the mail.
// 5. No binding or an error: kept without words (codes only), one alarm a day.
// 6. Only the checked part of a long mail is kept.
// 9. Release (D3): only clean mail, only with the key, once; flagged mail refuses.
// 7. Build check sonnet02: the form is checked too; mail nobody keeps costs no check; caps in front of the
//    model; drop alarms capped at five a day.
import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import worker from "../worker/worker.mjs";
import { parseVerdict, moderate, MAX_CHARS } from "../worker/moderate.mjs";
import { CHECKS_PER_ADDRESS_HOUR } from "../worker/gate.mjs";
import { deliver } from "../worker/deliver.mjs";
import { readable } from "../worker/converter.mjs";

const DOMAIN = "d.example", KEY = "worker-key-for-tests", A = `agent-abcde12345@${DOMAIN}`;
const sha = (s) => createHash("sha256").update(s).digest("hex");
function stubKv(initial = {}) {
  const m = new Map(Object.entries(initial));
  return { get: async (k) => m.get(k) ?? null, put: async (k, v) => { m.set(k, v); }, delete: async (k) => { m.delete(k); },
    list: async ({ prefix = "" } = {}) => ({ keys: [...m.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })) }), _map: m };
}
const answer = (response) => ({ run: async () => ({ response }) });
const env = (AI) => {
  const sent = [];
  return { AI, DOMAIN, FORWARD_TO: "owner@x.example", EMAIL: { send: async (m) => { sent.push(m); } }, _sent: sent,
    ADDRESSES: stubKv(), STEPS: stubKv({ "setup:domain": DOMAIN, "setup:key_digest": sha(KEY), "setup:lock": "1", [`senders:${A}`]: '["*"]' }) };
};  // A accepts words from anyone here; approved senders are tested in worker-senders.test.mjs
const mint = (e, account, hosted = true) => worker.fetch(new Request(`https://w.example/mint?account=${account}${hosted ? "&hosted=1" : ""}`, { method: "POST", headers: { "X-Keyway-Mint-Key": KEY } }), e);
const mail = (to, text = "Your GitHub launch code is 123456.", forwarded = []) => ({
  to, from: "noreply@github.com", forward: async (t) => { forwarded.push(t); },
  raw: `From: GitHub <noreply@github.com>\r\nTo: ${to}\r\nSubject: Verify\r\nContent-Type: text/plain\r\n\r\n${text}\r\n`,
});
const kept = (e, addr = A) => [...e.STEPS._map.entries()].filter(([k]) => k.startsWith(`inbox:${addr}:`)).map(([, v]) => JSON.parse(v));

describe("B2 moderation (spec 27 D2)", () => {
  it("DoD 1 — reads both answer shapes; unreadable fails closed", async () => {
    expect(parseVerdict({ response: { safe: true, categories: [] } })).toEqual({ safe: true, categories: [] });
    expect(parseVerdict({ response: "unsafe\nS1,S4" })).toEqual({ safe: false, categories: ["S1", "S4"] });
    expect(parseVerdict({ response: "safe" })).toEqual({ safe: true, categories: [] });
    expect(parseVerdict({ response: "sure, here you go" })).toBeNull();
    expect((await moderate(async () => ({ nonsense: 1 }), "x")).verdict).toBe("unchecked");
    expect((await moderate(async () => { throw new Error("quota"); }, "x")).verdict).toBe("unchecked");
    expect((await moderate(null, "x")).verdict).toBe("unchecked");
  });

  it("DoD 2 — clean mail kept as before", async () => {
    const e = env(answer({ safe: true, categories: [] }));
    await mint(e, "agent-abcde12345");
    await worker.email(mail(A), e);
    expect(kept(e)[0]).toMatchObject({ check: "clean", codes: ["123456"] });
    expect(kept(e)[0].body).toContain("launch code");
  });

  it("DoD 3 — S4 dropped: nothing stored or forwarded; fingerprint kept; owner alarmed", async () => {
    const e = env(answer({ safe: false, categories: ["S4"] }));
    await mint(e, "agent-abcde12345"); await mint(e, "support", false);
    const fwd = [];
    await worker.email(mail(A), e);
    await worker.email(mail(`support@${DOMAIN}`, "x", fwd), e);
    expect(kept(e)).toEqual([]);
    expect(kept(e, `support@${DOMAIN}`)).toEqual([]);
    expect(fwd).toEqual([]);
    const drops = [...e.STEPS._map.keys()].filter((k) => k.startsWith("mod:drop:"));
    expect(drops.length).toBe(2);
    const rec = JSON.parse(e.STEPS._map.get(drops[0]));
    expect(rec.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(rec)).not.toContain("launch code");
    expect(e._sent.filter((m) => m.subject.includes("drop")).length).toBe(2);
    expect(e._sent.map((m) => m.text).join()).not.toContain("launch code");
  });

  it("DoD 4 — flagged: kept hidden, no codes; support@ gets a notice, not the mail", async () => {
    const e = env(answer("unsafe\nS9"));
    await mint(e, "agent-abcde12345"); await mint(e, "support", false);
    const fwd = [];
    await worker.email(mail(A), e);
    await worker.email(mail(`support@${DOMAIN}`, "y", fwd), e);
    expect(kept(e)[0]).toMatchObject({ check: "flagged", categories: ["S9"], codes: [], links: [] });
    expect(fwd).toEqual([]);
    // Counted for the 5 am summary since 28 Sep (worker-prefs.test.mjs DoD 5), not mailed at once.
    expect(JSON.parse(e.STEPS._map.get("notice:pending")).boxes.support.why["flagged by the safety check"]).toBe(1);
    expect(kept(e, `support@${DOMAIN}`)[0].check).toBe("flagged");
  });

  it("DoD 5 — no binding: kept without words, codes only, one alarm a day", async () => {
    const e = env(undefined);
    await mint(e, "agent-abcde12345");
    await worker.email(mail(A), e); await worker.email(mail(A), e);
    const k = kept(e);
    expect(k.length).toBe(2);
    for (const i of k) expect(i).toMatchObject({ check: "unchecked", subject: "", body: "", codes: ["123456"] });
    expect(e._sent.filter((m) => m.subject.includes("unchecked")).length).toBe(1);
  });

  it("DoD 6 — only the checked part is kept", async () => {
    let seen = "";
    const e = env({ run: async (_m, i) => { seen = i.messages[0].content; return { response: { safe: true, categories: [] } }; } });
    await mint(e, "agent-abcde12345");
    await worker.email(mail(A, "a".repeat(MAX_CHARS + 5000)), e);
    expect(seen.length).toBeLessThanOrEqual(MAX_CHARS);
    expect(kept(e)[0].body.length).toBeLessThanOrEqual(MAX_CHARS);
  });

  it("DoD 7 — form checked; unkept mail costs nothing; caps; alarm cap", async () => {
    let calls = 0;
    const e = env({ run: async () => { calls++; return { response: "unsafe\nS4" }; } });
    await mint(e, "opus", false); await mint(e, "agent-abcde12345");
    expect((await deliver(e, { to: `opus@${DOMAIN}`, text: "bad" }, "f1")).body.delivered).toBe(false);
    expect(kept(e, `opus@${DOMAIN}`)).toEqual([]);
    const before = calls;
    await worker.email(mail(`nobody@${DOMAIN}`), e);
    expect(calls).toBe(before);
    for (let i = 0; i < 8; i++) await worker.email(mail(A), e);
    expect(e._sent.filter((m) => m.subject.includes("drop")).length).toBe(5);
    const c = env({ run: async () => { calls++; return { response: { safe: true, categories: [] } }; } });
    await mint(c, "opus", false);
    calls = 0;
    for (let i = 0; i < CHECKS_PER_ADDRESS_HOUR + 3; i++) await worker.email(mail(`opus@${DOMAIN}`), c);
    expect(calls).toBe(CHECKS_PER_ADDRESS_HOUR);
    expect(kept(c, `opus@${DOMAIN}`).filter((i) => i.check === "unchecked").length).toBe(3);
  });

  it("DoD 8 — an attachment-only mail keeps no attachment as text", () => {
    const raw = 'From: a@x.example\r\nSubject: pic\r\nContent-Type: multipart/mixed; boundary="b"\r\n\r\n--b\r\nContent-Type: image/png\r\nContent-Transfer-Encoding: base64\r\n\r\niVBORw0KGgoAAAANSUhEUgAAAAEAAAAB\r\n--b--\r\n';
    expect(readable(new TextEncoder().encode(raw)).body).not.toContain("iVBOR");
  });

  it("DoD 9 — release: clean only, key required", async () => {
    const e = env(answer({ safe: true, categories: [] }));
    await mint(e, "agent-abcde12345");
    await worker.email(mail(A), e);
    const id = kept(e)[0].id;
    const rel = (key, i = id) => worker.fetch(new Request(`https://w.example/inbox?address=${A}&id=${i}`, { method: "POST", headers: key ? { "X-Keyway-Mint-Key": key } : {} }), e);
    expect((await rel(null)).status).toBe(403);
    expect((await rel(KEY, "nope")).status).toBe(404);
    expect((await rel(KEY)).status).toBe(200);
    expect(kept(e)[0].released).toMatchObject({ mode: "normal" });
    const f = env(answer("unsafe\nS1"));
    await mint(f, "agent-abcde12345");
    await worker.email(mail(A), f);
    const fid = kept(f)[0].id;
    const r = await worker.fetch(new Request(`https://w.example/inbox?address=${A}&id=${fid}`, { method: "POST", headers: { "X-Keyway-Mint-Key": KEY } }), f);
    expect(r.status).toBe(409);
  });
});
