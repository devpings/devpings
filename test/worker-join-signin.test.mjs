// Spec 24 §4 (26 Sep 2026, the owner's design), in the worker. Each line is one test below.
// A1. sign-me-in-to-devpings-<token>@ is a join address.
// A2. On it, the email must carry the page's code (subject or first line); without it, nothing is noted.
// A3. Replies, auto-replies, calendar replies, read receipts, list mail, resent mail, quoted text and
//     oversized mail are refused, and a refused email doesn't use up the window.
// The old join-<token>@ form needs the code too (build check F1).
import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import worker from "../worker/worker.mjs";
import { joinCode } from "../worker/join.mjs";

const DOMAIN = "d.example";
const TOKEN = "abcdefgh12345678abcdefgh";
const sha = (s) => createHash("sha256").update(s).digest("hex");
const PASS = "Authentication-Results: mx.cloudflare.net; dkim=pass header.d=x.example header.s=s1; dmarc=pass header.from=x.example policy.dmarc=none\r\n";
const kv = (init = {}) => { const m = new Map(Object.entries(init)); return { get: async (k) => m.get(k) ?? null, put: async (k, v) => { m.set(k, v); }, delete: async (k) => { m.delete(k); }, list: async () => ({ keys: [] }) }; };
const env = () => ({ JOIN: "on", ADDRESSES: kv(), STEPS: kv({ "setup:domain": DOMAIN, "setup:key_digest": sha("k"), "setup:lock": "1" }) });
const to = (local = `sign-me-in-to-devpings-${TOKEN}`) => `${local}@${DOMAIN}`;
const mail = ({ local, subject = "hi", body = "hello", extra = "", type = "text/plain" } = {}) => ({
  to: to(local), from: "sam@x.example",
  raw: `${PASS}From: Sam <sam@x.example>\r\nTo: ${to(local)}\r\nSubject: ${subject}\r\n${extra}Content-Type: ${type}\r\n\r\n${body}\r\n`,
});
const arrived = async (e) => (await (await worker.fetch(new Request(`https://w.example/join/${TOKEN}`), e)).json()).arrived;

describe("sign-in email, spec 24 §4", () => {
  it("A1+A2: the new address with the code in the subject is noted", async () => {
    const e = env(), code = await joinCode(TOKEN);
    await worker.email(mail({ subject: `devpings ${code}` }), e);
    expect(await arrived(e)).toBe(true);
  });
  it("A2: the code in the first body line counts, lower case too", async () => {
    const e = env(), code = await joinCode(TOKEN);
    await worker.email(mail({ body: `${code.toLowerCase()} thanks` }), e);
    expect(await arrived(e)).toBe(true);
  });
  it("A2: without the code, nothing is noted", async () => {
    const e = env();
    await worker.email(mail({ subject: "hello" }), e);
    expect(await arrived(e)).toBe(false);
  });
  it("A2: a code only deep in the body doesn't count", async () => {
    const e = env(), code = await joinCode(TOKEN);
    await worker.email(mail({ body: `line one\nline two ${code}` }), e);
    expect(await arrived(e)).toBe(false);
  });
  const refused = [
    ["a reply", { extra: "In-Reply-To: <a@b>\r\n" }],
    ["a thread", { extra: "References: <a@b>\r\n" }],
    ["an auto-reply", { extra: "Auto-Submitted: auto-replied\r\n" }],
    ["bulk precedence", { extra: "Precedence: bulk\r\n" }],
    ["X-Autoreply", { extra: "X-Autoreply: yes\r\n" }],
    ["list mail", { extra: "List-Id: <x.example>\r\n" }],
    ["resent mail", { extra: "Resent-From: m@x.example\r\n" }],
    ["a null return path", { extra: "Return-Path: <>\r\n" }],
    ["a calendar reply", { type: "text/calendar; method=REPLY" }],
    ["a read receipt", { type: "multipart/report; report-type=disposition-notification" }],
  ];
  for (const [name, m] of refused) {
    it(`A3: ${name} is refused even with the code`, async () => {
      const e = env(), code = await joinCode(TOKEN);
      await worker.email(mail({ subject: code, ...m }), e);
      expect(await arrived(e)).toBe(false);
    });
  }
  it("A3: quoted text is refused", async () => {
    const e = env(), code = await joinCode(TOKEN);
    await worker.email(mail({ subject: code, body: `ok\n> On Mon, Mallory wrote:\n> ${code}` }), e);
    expect(await arrived(e)).toBe(false);
  });
  it("A3: a refused email doesn't use up the window; a good one after it still counts", async () => {
    const e = env(), code = await joinCode(TOKEN);
    await worker.email(mail({ subject: code, extra: "In-Reply-To: <a@b>\r\n" }), e);
    await worker.email(mail({ subject: code }), e);
    expect(await arrived(e)).toBe(true);
  });
  it("A3: oversized mail is refused", async () => {
    const e = env(), code = await joinCode(TOKEN);
    await worker.email(mail({ subject: code, body: "x".repeat(300 * 1024) }), e);
    expect(await arrived(e)).toBe(false);
  });
  it("F1: the old join- prefix is no way around the code", async () => {
    const e = env(), code = await joinCode(TOKEN);
    await worker.email(mail({ local: `join-${TOKEN}`, subject: "anything" }), e);
    expect(await arrived(e)).toBe(false);
    await worker.email(mail({ local: `join-${TOKEN}`, subject: code }), e);
    expect(await arrived(e)).toBe(true);
  });
  it("F8: the code for a pinned token matches the site's (ZXN9JZ)", async () => {
    expect(await joinCode("abcdefgh12345678abcdefgh")).toBe("ZXN9JZ");
  });
  it("the code is 6 characters from an alphabet without look-alikes", async () => {
    expect(await joinCode(TOKEN)).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/);
  });
});
