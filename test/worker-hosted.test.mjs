// DoD for hosted addresses in the worker (spec 22, D2). Each line is one test below.
//
// 1. Hosted mint accepts only agent-<10 random>; reserved or other names are refused; no double mint.
// 2. Mail to a hosted address is kept with its codes and links extracted, and counted.
// 3. Per-hour cap: cap + 1 sequential mails → one drop counted (H5, soft cap).
// 4. Storage cap: mail that would pass the MB limit is dropped and counted (H5b).
// 5. Disable and pause drop the next mail at once (H7).
// 6. Limits pushed via /limits apply to the next mail, per address overrides win (H6).
// 7. /limits and /usage need the worker key.
import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import worker from "../worker/worker.mjs";

const DOMAIN = "d.example";
const KEY = "worker-key-for-tests";
const A = `agent-abcde12345@${DOMAIN}`;
const sha = (s) => createHash("sha256").update(s).digest("hex");

function stubKv(initial = {}) {
  const m = new Map(Object.entries(initial));
  return {
    get: async (k) => m.get(k) ?? null,
    put: async (k, v) => { m.set(k, v); },
    delete: async (k) => { m.delete(k); },
    list: async ({ prefix = "" } = {}) => ({ keys: [...m.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })) }),
    _map: m,
  };
}
const env = () => ({ ADDRESSES: stubKv(), STEPS: stubKv({ "setup:domain": DOMAIN, "setup:key_digest": sha(KEY), "setup:lock": "1" }) });
const call = (e, path, { method = "GET", body, key = KEY } = {}) =>
  worker.fetch(new Request(`https://w.example${path}`, { method, headers: { ...(key ? { "X-Keyway-Mint-Key": key } : {}), "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined }), e);
const mint = (e, account) => call(e, `/mint?account=${account}&hosted=1`, { method: "POST" });
const mail = (to, text = "Your GitHub launch code is 123456.", pad = "") => ({
  to, from: "noreply@github.com",
  raw: `From: GitHub <noreply@github.com>\r\nTo: ${to}\r\nSubject: Verify\r\nContent-Type: text/plain\r\n\r\n${text}${pad}\r\n`,
});
const items = (e) => [...e.STEPS._map.entries()].filter(([k]) => k.startsWith(`inbox:${A}:`)).map(([, v]) => JSON.parse(v));
const today = (e) => JSON.parse(e.STEPS._map.get(`cnt:d:${A}:${new Date().toISOString().slice(0, 10)}`) || "{}");

describe("hosted addresses (spec 22)", () => {
  it("DoD 1 — only agent-<10 random>, no reserved names, no double mint", async () => {
    const e = env();
    expect((await mint(e, "agent-abcde12345")).status).toBe(200);
    expect((await mint(e, "agent-abcde12345")).status).toBe(409);
    for (const bad of ["opus", "security", "agent-short", "join-abcdefghijklmnop"]) expect((await mint(e, bad)).status).toBe(400);
  });

  it("DoD 2 — kept with codes extracted, and counted", async () => {
    const e = env();
    await mint(e, "agent-abcde12345");
    await worker.email(mail(A), e);
    expect(items(e)[0].codes).toContain("123456");
    expect(today(e)).toMatchObject({ mails: 1, dropped: 0 });
  });

  it("DoD 3 — per-hour cap + 1 → one drop", async () => {
    const e = env();
    await mint(e, "agent-abcde12345");
    await call(e, "/limits", { method: "POST", body: { defaults: { perHour: 2 } } });
    for (let i = 0; i < 3; i++) await worker.email(mail(A), e);
    expect(items(e)).toHaveLength(2);
    expect(today(e)).toMatchObject({ mails: 2, dropped: 1 });
  });

  it("DoD 4 — storage cap drops what would pass it", async () => {
    const e = env();
    await mint(e, "agent-abcde12345");
    await call(e, "/limits", { method: "POST", body: { defaults: { mb: 0.001 } } }); // 1,000 bytes
    await worker.email(mail(A, "small 123456"), e);
    await worker.email(mail(A, "big", "x".repeat(2000)), e);
    expect(items(e)).toHaveLength(1);
    expect(today(e).dropped).toBe(1);
  });

  it("DoD 5 — disable and pause act on the next mail", async () => {
    const e = env();
    await mint(e, "agent-abcde12345");
    await call(e, "/limits", { method: "POST", body: { disable: [A] } });
    await worker.email(mail(A), e);
    await call(e, "/limits", { method: "POST", body: { enable: [A], pause: true } });
    await worker.email(mail(A), e);
    await call(e, "/limits", { method: "POST", body: { pause: false } });
    await worker.email(mail(A), e);
    expect(items(e)).toHaveLength(1);
    expect(today(e)).toMatchObject({ mails: 1, dropped: 2 });
  });

  it("DoD 6 — per-address override wins over defaults", async () => {
    const e = env();
    await mint(e, "agent-abcde12345");
    await call(e, "/limits", { method: "POST", body: { defaults: { perHour: 0 }, per: { [A]: { perHour: 5 } } } });
    await worker.email(mail(A), e);
    expect(items(e)).toHaveLength(1);
    const u = await (await call(e, "/usage")).json();
    expect(u.rows[0]).toMatchObject({ address: A, mails: 1 });
  });

  it("DoD 7 — /limits and /usage need the worker key", async () => {
    const e = env();
    expect((await call(e, "/limits", { method: "POST", body: { pause: true }, key: null })).status).toBe(403);
    expect((await call(e, "/usage", { key: "wrong" })).status).toBe(403);
    expect(e.STEPS._map.has("hosted:pause")).toBe(false);
  });
});

describe("hosted limits push", () => {
  it("replace: true drops overrides that are no longer sent", async () => {
    const e = env();
    await call(e, "/limits", { method: "POST", body: { per: { [A]: { perHour: 5 } } } });
    const r = await (await call(e, "/limits", { method: "POST", body: { replace: true, defaults: { perHour: 9 }, per: {} } })).json();
    expect(r.limits).toEqual({ defaults: { perHour: 9 }, per: {} });
  });
});
