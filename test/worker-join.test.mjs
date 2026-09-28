// DoD for sign-up verification by email (25 Sep 2026). Each line is one test below, named for it.
//
// 1. A verified email to join-<token>@ is noted: GET /join/<token> gives its sender.
// 2. Nothing of the letter is kept: no subject, no body, no inbox entry.
// 3. An unverified email (no or forged Cloudflare verdict) is not noted.
// 4. The first verified email decides; a later one can't replace it.
// 5. It lasts 10 minutes.
// 6. Off unless JOIN is "on": join- mail is then kept nowhere and /join/ is not found.
// 7. A malformed token is refused, and a token nobody wrote to says "not arrived".
import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import worker from "../worker/worker.mjs";
import { joinCode } from "../worker/join.mjs";

const DOMAIN = "d.example";
const TOKEN = "abcdefgh12345678";
const CODE = await joinCode(TOKEN); // since 26 Sep every join email carries the code (spec 24 A2)
const sha = (s) => createHash("sha256").update(s).digest("hex");
const PASS = "Authentication-Results: mx.cloudflare.net; dkim=pass header.d=x.example header.s=s1; dmarc=pass header.from=x.example policy.dmarc=none\r\n";

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
const env = (join = "on") => ({
  JOIN: join,
  ADDRESSES: stubKv(),
  STEPS: stubKv({ "setup:domain": DOMAIN, "setup:key_digest": sha("k"), "setup:lock": "1" }),
});
const mail = (auth, from = "sam@x.example", token = TOKEN) => ({
  to: `join-${token}@${DOMAIN}`, from,
  raw: `${auth}From: Sam <${from}>\r\nTo: join-${token}@${DOMAIN}\r\nSubject: secret subject ${CODE}\r\nContent-Type: text/plain\r\n\r\nsecret body\r\n`,
});
const ask = async (e, token = TOKEN) => worker.fetch(new Request(`https://w.example/join/${token}`), e);

describe("sign-up verification by email", () => {
  it("DoD 1 — a verified email is noted and read back by token", async () => {
    const e = env();
    await worker.email(mail(PASS), e);
    expect(await (await ask(e)).json()).toMatchObject({ arrived: true, from: "sam@x.example" });
  });

  it("DoD 2 — nothing of the letter is kept", async () => {
    const e = env();
    await worker.email(mail(PASS), e);
    const all = JSON.stringify([...e.STEPS._map.entries()]);
    expect(all).not.toContain("secret subject");
    expect(all).not.toContain("secret body");
    expect([...e.STEPS._map.keys()].some((k) => k.startsWith("inbox:"))).toBe(false);
  });

  it("DoD 3 — unverified or forged mail is not noted", async () => {
    for (const auth of ["", "Authentication-Results: evil.example; dmarc=pass header.from=x.example\r\n",
      "Authentication-Results: mx.cloudflare.net; dkim=fail header.d=x.example; dmarc=fail header.from=x.example\r\n"]) {
      const e = env();
      await worker.email(mail(auth), e);
      expect(await (await ask(e)).json()).toEqual({ arrived: false });
    }
  });

  it("DoD 4 — the first verified email decides", async () => {
    const e = env();
    await worker.email(mail(PASS), e);
    await worker.email(mail(PASS.replaceAll("x.example", "y.example"), "eve@y.example"), e);
    expect((await (await ask(e)).json()).from).toBe("sam@x.example");
  });

  it("DoD 5 — it lasts 10 minutes", async () => {
    const e = env();
    await worker.email(mail(PASS), e);
    expect(e.STEPS._ttl.get(`join:${TOKEN}`)).toBe(600);
  });

  it("DoD 6 — off unless JOIN is on", async () => {
    const e = env("off");
    await worker.email(mail(PASS), e);
    expect([...e.STEPS._map.keys()].some((k) => k.startsWith("join:"))).toBe(false);
    expect((await ask(e)).status).toBe(404);
  });

  it("DoD 7 — malformed token refused; unknown token not arrived", async () => {
    const e = env();
    expect((await ask(e, "short")).status).toBe(404);
    expect((await ask(e, "BAD_TOKEN_1234567")).status).toBe(404);
    expect(await (await ask(e, "zzzzzzzzzzzzzzzz")).json()).toEqual({ arrived: false });
  });
});
