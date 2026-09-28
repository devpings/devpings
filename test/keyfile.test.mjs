/**
 * DoD for the key file. Each line is one test below, named for it.
 *
 * 1. What devpings writes, devpings reads back unchanged.
 * 2. The file says what it is and how to keep it, readable in any editor.
 * 3. A damaged or foreign file is refused with a reason a person can act on, never a crash.
 * 4. The address must be on the file's own domain: a file cannot point the key at someone else's.
 * 5. Only https worker addresses: the key never travels in the clear.
 */
import { describe, it, expect } from "vitest";
import { buildKeyFile, parseKeyFile, keyFileName, isAllowed } from "../src/keyfile.mjs";

const good = {
  domain: "example-cafe.example",
  workerUrl: "https://keyway-mail.someone.workers.dev/",
  address: "admin@example-cafe.example",
  mintKey: "Zx8_k2mQ-9vP3aLw7yT1cR5nB0eH4jUd",
};

describe("the key file", () => {
  it("DoD 1 — round trip: what is written is what is read", () => {
    const parsed = parseKeyFile(buildKeyFile(good));
    expect(parsed).toEqual({ ok: true, file: { ...good, workerUrl: "https://keyway-mail.someone.workers.dev" } });
  });

  it("DoD 2 — the file explains itself and has a findable name", () => {
    const text = buildKeyFile(good, new Date("2026-09-23T10:00:00Z"));
    expect(text).toContain("keep it private");
    expect(text).toContain("Run setup again");
    expect(text).toContain("2026-09-23T10:00:00.000Z");
    expect(keyFileName("example-cafe.example")).toBe("keyway-example-cafe.example.key.json");
  });

  it("DoD 3 — junk, foreign JSON and damaged keys are refused with a reason", () => {
    for (const text of ["", "not json", "[]", "{}", JSON.stringify({ keyway: 2, ...good }), "x".repeat(9000)]) {
      const p = parseKeyFile(text);
      expect(p.ok).toBe(false);
      if (!p.ok) expect(p.reason.length).toBeGreaterThan(10);
    }
    const damaged = parseKeyFile(buildKeyFile(good).replace(good.mintKey, "short"));
    expect(damaged).toEqual({ ok: false, reason: "The key file's key is missing or damaged." });
  });

  it("DoD 4 — the address must sit on the file's own domain", () => {
    const text = JSON.stringify({ keyway: 1, ...good, address: "admin@someone-else.example" });
    expect(parseKeyFile(text).ok).toBe(false);
    expect(() => buildKeyFile({ ...good, address: "admin@elsewhere.example" })).toThrow();
  });

  it("DoD 5 — an http worker address is refused", () => {
    const text = JSON.stringify({ keyway: 1, ...good, workerUrl: "http://keyway-mail.someone.workers.dev" });
    expect(parseKeyFile(text)).toEqual({ ok: false, reason: "The key file's worker address isn't https." });
  });

  it("DoD 6 — the allow list: exact addresses and whole @domains, lowercased; junk refused", () => {
    const p = parseKeyFile(JSON.stringify({ keyway: 1, ...good, allow: ["Friend@Example.org", "@github.com"] }));
    expect(p.ok).toBe(true);
    if (p.ok) {
      expect(isAllowed(p.file, "friend@example.org")).toBe(true);
      expect(isAllowed(p.file, "noreply@github.com")).toBe(true);
      expect(isAllowed(p.file, "noreply@github.com.evil.example")).toBe(false);
      expect(isAllowed(p.file, "other@example.org")).toBe(false);
    }
    expect(parseKeyFile(JSON.stringify({ keyway: 1, ...good, allow: "friend@example.org" })).ok).toBe(false);
    expect(parseKeyFile(JSON.stringify({ keyway: 1, ...good, allow: ["not an address"] })).ok).toBe(false);
    expect(isAllowed({}, "anyone@example.org")).toBe(false);
  });
});
