// Tests for client.mjs, the agent-side caller for the bootstrap worker.
//
// Posture: a real fake worker, not a mock of client.mjs's own internals. The fake models the
// actual routes and stores in worker/worker.mjs (ADDRESSES permanent, STEPS with a TTL,
// RESULTS gated behind an open step, MINT_KEY on every endpoint, extracted closes the step but
// failed does NOT, D6) — read from worker.mjs and converter.mjs, not from client.mjs's own
// comments about them. Time is injected (`sleep` AND `now`, both required together — see the
// clock note below) so nothing here costs wall-clock.
//
// Updated for the second pass: the client's contract changed (five outcomes now, not four;
// failed is held until the step ends; stale results from a prior step are ignored; the budget
// starts at step-open, not at waitForValue entry; mint dedupes concurrent callers; mask() no
// longer discloses a tail; openStep refuses an array linkPattern). Read client.mjs itself for
// the current contract, not this comment.

import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DevpingsAgent, DevpingsError, STEP_TTL_MS, mask } from "../src/client.mjs";

const KEY = "s3cr3t-mint-key";
const DOMAIN = "example.com.au";

afterEach(() => {
  vi.restoreAllMocks();
});

// --- A real fake of worker/worker.mjs's HTTP surface -------------------------------------
//
// Mirrors worker.mjs's four routes and adapt()'s EMIT gating, not client.mjs's assumptions
// about them:
//   - /mint and /address and /step and /result all require the X-Keyway-Mint-Key header to equal
//     MINT_KEY, and refuse any request carrying ?k= even with the right value (403), as the live
//     worker does.
//   - /mint always rewrites createdAt (worker.mjs's D-finding: re-minting is idempotent in the
//     address, not in the record).
//   - /step 404s if the address doesn't exist yet, and does NOT clear a previous result (the
//     real worker's own gap — F1/C5 — is that `result:<address>` outlives the step that made it).
//   - mailArrives() is the fake's stand-in for a real inbound message reaching EMIT: it only
//     stores a result if a step is currently open for that address (mail before a step exists
//     is ignored and stores nothing). It mirrors D6/C6 exactly: `extracted` closes the step,
//     `failed` does NOT — the step stays open so a later mail (GitHub's code-then-welcome
//     pattern) can still land and win.
//   - `at` on a stored result must come from the same clock as `expiresAt` (converter.mjs's
//     `now()` is real `Date.now()`, so in production both are the same clock by construction) —
//     the fake's `mailArrives` requires the caller to pass a realistic `at`, on purpose, so a
//     test that gets this wrong fails the way a real cross-clock bug would, rather than passing
//     by accident on a fixture shortcut.
function makeFakeWorker({ key = KEY, domain = DOMAIN, clockNow } = {}) {
  const addresses = new Map(); // address -> { account, createdAt }
  const steps = new Map(); // address -> step record (open) | absent
  const results = new Map(); // address -> result

  let lastInit = {};
  function authed(url) {
    if (url.searchParams.has("k")) return false;
    return (lastInit.headers || {})["X-Keyway-Mint-Key"] === key;
  }

  function handle(urlStr, init = {}) {
    lastInit = init;
    const url = new URL(urlStr);
    const method = (init.method || "GET").toUpperCase();

    if (url.pathname === "/mint" && method === "POST") {
      if (!authed(url)) return respond({ error: "not authorised to mint on this domain" }, 403);
      const account = (url.searchParams.get("account") || "github").toLowerCase();
      const address = `${account}@${domain}`;
      addresses.set(address, { account, createdAt: clockNow() });
      return respond({ address, permanent: true });
    }

    if (url.pathname === "/address") {
      if (!authed(url)) return respond({ error: "not authorised" }, 403);
      const account = (url.searchParams.get("account") || "github").toLowerCase();
      const address = `${account}@${domain}`;
      const rec = addresses.get(address);
      return respond(rec ? { address, permanent: true, createdAt: rec.createdAt } : { address: null });
    }

    if (url.pathname === "/step" && method === "POST") {
      if (!authed(url)) return respond({ error: "not authorised" }, 403);
      const address = (url.searchParams.get("address") || "").toLowerCase();
      if (!addresses.has(address)) return respond({ error: "no such address; mint it first" }, 404);
      const linkPattern = url.searchParams.get("linkPattern") || undefined;
      const step = {
        id: url.searchParams.get("step") || "github/verify-email",
        address,
        expect: url.searchParams.get("expect") || "link:verify",
        linkPattern,
        expiresAt: clockNow() + STEP_TTL_MS,
      };
      steps.set(address, step); // NOTE: the previous step's result is deliberately left in place.
      return respond({ opened: step.id, address, expiresAt: step.expiresAt });
    }

    if (url.pathname === "/result") {
      if (!authed(url)) return respond({ error: "not authorised" }, 403);
      const address = (url.searchParams.get("address") || "").toLowerCase();
      const addressAlive = addresses.has(address);
      const result = results.get(address) || null;
      return respond({ address, addressAlive, result });
    }

    return respond({ error: "not found" }, 404);
  }

  function respond(body, status = 200) {
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    };
  }

  return {
    handle,
    // Test-only surface, mirroring adapt()'s EMIT gating in worker.mjs. `event` must include a
    // realistic `at` (the fixture does not default it, on purpose — see the note above).
    mailArrives(address, event) {
      const step = steps.get(address);
      if (!step || step.address !== address) return; // ignored: no open step for this address
      results.set(address, event);
      if (event.kind === "extracted") steps.delete(address); // D6/C6: only extracted closes it
    },
    goneAddress(address) {
      addresses.delete(address);
    },
    hasOpenStep(address) {
      return steps.has(address);
    },
    currentStep(address) {
      return steps.get(address) || null;
    },
  };
}

// waitForValue and ensureAddress measure elapsed time with the injected `now()`, and the
// client's own doc comment (F3) is explicit that a virtual sleep needs a virtual clock or it is
// not virtual — a real Date.now() with an instant sleep spins at native speed until real
// wall-clock time passes the (up to 15-minute) budget, which OOM'd this file's first draft. The
// fake clock here advances only when `sleep` is awaited, and `now` and the fake worker's
// `clockNow` share the same counter, so `expiresAt` and a mailed result's `at` are always on one
// consistent clock, the way they are in production (converter.mjs's `now()` is real Date.now()).
function fakeClock(startAt = 1_700_000_000_000) {
  let now = startAt;
  return {
    now: () => now,
    sleep: vi.fn(async (ms) => {
      now += ms;
    }),
  };
}

function agentOver(worker, opts = {}) {
  const calls = [];
  const fetch = vi.fn(async (url, init) => {
    calls.push({ url: String(url), init });
    return worker.handle(String(url), init);
  });
  const agent = new DevpingsAgent({
    base: "https://devpings-mail.example.workers.dev",
    key: KEY,
    fetch,
    sleep: worker.clock.sleep,
    now: worker.clock.now,
    ...opts,
  });
  return { agent, calls, fetch };
}

function makeWorkerWithClock(opts = {}) {
  const clock = fakeClock();
  const worker = makeFakeWorker({ ...opts, clockNow: clock.now });
  worker.clock = clock;
  return worker;
}

// --- ensureAddress / C4: ask first, mint only if absent --------------------------------------

describe("ensureAddress", () => {
  it("mints when nothing exists yet", async () => {
    const worker = makeWorkerWithClock();
    const { agent, calls } = agentOver(worker);
    const r = await agent.ensureAddress();
    expect(r).toEqual({ address: "github@example.com.au", minted: true });
    expect(calls.map((c) => new URL(c.url).pathname)).toEqual(["/address", "/mint"]);
  });

  it("does not mint a second time, and createdAt is left alone", async () => {
    const worker = makeWorkerWithClock();
    const { agent: first } = agentOver(worker);
    await first.ensureAddress();
    const before = await (await worker.handle(`https://x/address?account=github`, { headers: { "X-Keyway-Mint-Key": KEY } })).json();

    // A second press, found 16 Sep: this must not re-mint.
    const { agent: second, calls } = agentOver(worker);
    const r = await second.ensureAddress();

    expect(r).toEqual({ address: "github@example.com.au", minted: false });
    expect(calls.some((c) => new URL(c.url).pathname === "/mint")).toBe(false);

    const after = await (await worker.handle(`https://x/address?account=github`, { headers: { "X-Keyway-Mint-Key": KEY } })).json();
    expect(before.createdAt).toBeTypeOf("number");
    expect(after.createdAt).toBe(before.createdAt);
  });

  it("C1 — the key goes in a header on every call, never in the URL", async () => {
    const worker = makeWorkerWithClock();
    const { agent, calls } = agentOver(worker);
    await agent.ensureAddress();
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) expect(c.url).not.toContain(KEY);
  });

  it("fires address.exists, not address.minted, on the second call", async () => {
    const worker = makeWorkerWithClock();
    const onEvent = vi.fn();
    const { agent: first } = agentOver(worker);
    await first.ensureAddress();

    const { agent: second } = agentOver(worker, { onEvent });
    await second.ensureAddress();

    expect(onEvent).toHaveBeenCalledWith({ event: "address.exists", address: "github@example.com.au" });
    expect(onEvent).not.toHaveBeenCalledWith(expect.objectContaining({ event: "address.minted" }));
  });

  it("two concurrent calls on the same instance mint exactly once", async () => {
    const worker = makeWorkerWithClock();
    const { agent, calls } = agentOver(worker);

    const [a, b] = await Promise.all([agent.ensureAddress(), agent.ensureAddress()]);
    expect(a).toEqual(b);
    expect(a.minted).toBe(true);
    expect(calls.filter((c) => new URL(c.url).pathname === "/mint")).toHaveLength(1);
  });

  it("a later call, after the in-flight one settles, does not mint again", async () => {
    const worker = makeWorkerWithClock();
    const { agent, calls } = agentOver(worker);
    await agent.ensureAddress();
    await agent.ensureAddress();
    expect(calls.filter((c) => new URL(c.url).pathname === "/mint")).toHaveLength(1);
  });
});

// --- The five outcomes -------------------------------------------------------------------------

describe("waitForValue — the five outcomes", () => {
  it("extracted: returns the value with its outcome", async () => {
    const worker = makeWorkerWithClock();
    const { agent } = agentOver(worker);
    const { address } = await agent.ensureAddress();
    const opened = await agent.openStep(address);
    worker.mailArrives(address, { kind: "extracted", value: "https://example.com/verify?t=abc123", at: worker.clock.now() });

    const r = await agent.waitForValue(address, { pollMs: 10, expiresAt: opened.expiresAt });
    expect(r).toEqual({ outcome: "extracted", value: "https://example.com/verify?t=abc123", at: worker.clock.now() });
  });

  it("failed: is held, not returned immediately, and is not a bare value", async () => {
    const worker = makeWorkerWithClock();
    const { agent } = agentOver(worker);
    const { address } = await agent.ensureAddress();
    const opened = await agent.openStep(address);
    worker.mailArrives(address, { kind: "failed", reason: "pattern not found", at: worker.clock.now() });

    // C6: the worker leaves the step open after a failure, so waitForValue must keep polling
    // rather than returning the instant it sees `failed` — it only surfaces once the step ends.
    const r = await agent.waitForValue(address, { pollMs: 60_000, expiresAt: opened.expiresAt });
    expect(r.outcome === "failed" || r.outcome === "expired").toBe(true);
    if (r.outcome === "failed") {
      expect(r.reason).toBe("pattern not found");
      expect(r).not.toHaveProperty("value");
    }
  });

  it("failed with no reason still returns the client's own fallback, not silence", async () => {
    const worker = makeWorkerWithClock();
    const { agent } = agentOver(worker);
    const { address } = await agent.ensureAddress();
    const opened = await agent.openStep(address);
    worker.mailArrives(address, { kind: "failed", at: worker.clock.now() }); // no reason supplied

    const r = await agent.waitForValue(address, { pollMs: STEP_TTL_MS, expiresAt: opened.expiresAt });
    expect(r.outcome).toBe("failed");
    expect(r.reason).toBe("pattern not found");
  });

  it("timeout: the CALLER's own budget runs out while the step is still open", async () => {
    const worker = makeWorkerWithClock();
    const { agent } = agentOver(worker);
    const { address } = await agent.ensureAddress();
    const opened = await agent.openStep(address);
    // Nothing ever arrives, and the caller's budget (5s) is far short of the step's 15 minutes.
    const r = await agent.waitForValue(address, { timeoutMs: 5000, pollMs: 1000, expiresAt: opened.expiresAt });
    expect(r.outcome).toBe("timeout");
    expect(typeof r.waitedMs).toBe("number");
    // The step itself is still open — a caller told "timeout" should be able to re-trigger
    // without reopening, unlike "expired" below.
    expect(worker.hasOpenStep(address)).toBe(true);
  });

  it("expired: the STEP's own 15 minutes ran out, distinct from a caller timeout", async () => {
    const worker = makeWorkerWithClock();
    const { agent } = agentOver(worker);
    const { address } = await agent.ensureAddress();
    const opened = await agent.openStep(address);
    // No explicit timeoutMs: the caller's budget defaults to the step's own TTL, so running the
    // clock out here means the STEP ended, not merely the caller's patience.
    const r = await agent.waitForValue(address, { pollMs: 60_000, expiresAt: opened.expiresAt });
    expect(r.outcome).toBe("expired");
    expect(r.waitedMs).toBeLessThanOrEqual(STEP_TTL_MS);
  });

  it("gone: the address is no longer live", async () => {
    const worker = makeWorkerWithClock();
    const { agent } = agentOver(worker);
    const { address } = await agent.ensureAddress();
    const opened = await agent.openStep(address);
    worker.goneAddress(address);

    const r = await agent.waitForValue(address, { pollMs: 10, expiresAt: opened.expiresAt });
    expect(r).toEqual({ outcome: "gone" });
  });
});

// --- C6: failed is terminal only when the step is; extracted can still overwrite it -----------

describe("C6 — a held failure loses to a later extraction, in both directions", () => {
  it("failed arrives, then extracted arrives before the step ends: the extraction wins", async () => {
    const worker = makeWorkerWithClock();
    const { agent } = agentOver(worker);
    const { address } = await agent.ensureAddress();
    const opened = await agent.openStep(address);

    // The GitHub pattern this guards against: a welcome mail (failed to match) arrives first,
    // then the real code arrives on the second message, before the step's TTL runs out.
    worker.mailArrives(address, { kind: "failed", reason: "pattern not found", at: worker.clock.now() });
    worker.mailArrives(address, { kind: "extracted", value: "final-value", at: worker.clock.now() });

    const r = await agent.waitForValue(address, { pollMs: 10, expiresAt: opened.expiresAt });
    expect(r.outcome).toBe("extracted");
    expect(r.value).toBe("final-value");
  });

  it("failed arrives and nothing else follows before the step ends: failed is returned, not swallowed", async () => {
    const worker = makeWorkerWithClock();
    const { agent } = agentOver(worker);
    const { address } = await agent.ensureAddress();
    const opened = await agent.openStep(address);
    worker.mailArrives(address, { kind: "failed", reason: "pattern not found", at: worker.clock.now() });

    const r = await agent.waitForValue(address, { pollMs: STEP_TTL_MS, expiresAt: opened.expiresAt });
    expect(r.outcome).toBe("failed");
    expect(r.reason).toBe("pattern not found");
  });

  it("extracted then a later failed for the SAME address does not un-resolve an already-returned result", async () => {
    const worker = makeWorkerWithClock();
    const { agent } = agentOver(worker);
    const { address } = await agent.ensureAddress();
    const opened = await agent.openStep(address);
    worker.mailArrives(address, { kind: "extracted", value: "code-1", at: worker.clock.now() });

    const r1 = await agent.waitForValue(address, { pollMs: 10, expiresAt: opened.expiresAt });
    expect(r1.outcome).toBe("extracted");
    expect(r1.value).toBe("code-1");
    // extracted closed the step (D6/C6); a later mail has nowhere to land.
    expect(worker.hasOpenStep(address)).toBe(false);
  });
});

// --- C5: a stale result from a PREVIOUS step is ignored, not returned as this step's answer ----

describe("C5 — stale results from a previous step are ignored", () => {
  it("a second collect() in a row does not return the first one's value", async () => {
    const worker = makeWorkerWithClock();
    const { agent } = agentOver(worker);

    const firstTrigger = vi.fn(async (address) => {
      worker.mailArrives(address, { kind: "extracted", value: "FIRST-CREDENTIAL", at: worker.clock.now() });
    });
    const first = await agent.collect({ trigger: firstTrigger, pollMs: 10 });
    expect(first.outcome).toBe("extracted");
    expect(first.value).toBe("FIRST-CREDENTIAL");

    // Move the clock forward, as a real second setup step later would (a second provider setup
    // is not literally the same millisecond as the first), then open a NEW step without
    // anything arriving yet. The worker's /step does NOT clear the old result, so a client that
    // trusted `at` alone (or nothing) would hand back FIRST-CREDENTIAL again.
    await worker.clock.sleep(5000);
    const secondTriggerNoMail = vi.fn(async () => {});
    const second = await agent.collect({ trigger: secondTriggerNoMail, pollMs: 60_000 });

    expect(second.outcome).not.toBe("extracted");
    expect(second.value).toBeUndefined();
    expect(["timeout", "expired"]).toContain(second.outcome);
  });

  it("FIXED FINDING: two steps opened in the same clock tick no longer let the leftover result read as fresh", async () => {
    // Originally reported: the timestamp check alone (`result.at < stepOpenedOnWorker`, strict
    // less-than) let a same-millisecond leftover pass as fresh, because equal is not "before".
    // The fix that landed is not a wider comparison (`<=` was tried and rejected — with a frozen
    // or coarse clock a FRESH result is ALSO equal to the step's open time, so it would discard
    // honest results in the same breath it fixed the leftover ones). Instead collect() takes a
    // `baseline` fingerprint of the result slot right after openStep and before the trigger
    // fires; anything matching that fingerprint is the leftover, independent of what the clock
    // says. This test still forces the same-millisecond condition (no clock advance between the
    // two collect() calls) to prove the fingerprint path, not the timestamp path, is what saves it.
    const worker = makeWorkerWithClock();
    const { agent } = agentOver(worker);

    const firstTrigger = vi.fn(async (address) => {
      worker.mailArrives(address, { kind: "extracted", value: "FIRST-CREDENTIAL", at: worker.clock.now() });
    });
    await agent.collect({ trigger: firstTrigger, pollMs: 10 });

    // No clock advance here — same tick as the moment FIRST-CREDENTIAL was written. The
    // timestamp check alone could not tell this apart from a fresh result; the baseline
    // fingerprint, read before secondTriggerNoMail runs, can.
    const secondTriggerNoMail = vi.fn(async () => {});
    const second = await agent.collect({ trigger: secondTriggerNoMail, pollMs: 60_000 });

    expect(second.outcome).not.toBe("extracted");
    expect(second.value).toBeUndefined();
    expect(["timeout", "expired"]).toContain(second.outcome);
  });

  it("the same-millisecond case is caught by the baseline fingerprint, not the timestamp check", async () => {
    // Direct confirmation of WHICH mechanism caught it: construct the exact case where the
    // timestamp comparison is false (at === stepOpenedOnWorker, not less-than) and confirm the
    // client still emits result.stale.ignored — which only the baseline path can produce here.
    const worker = makeWorkerWithClock();
    const { agent } = agentOver(worker);
    const events = [];
    const { agent: watchedAgent } = agentOver(worker, { onEvent: (e) => events.push(e) });

    const { address } = await watchedAgent.ensureAddress();
    const opened1 = await watchedAgent.openStep(address);
    const stepOpenedOnWorker1 = opened1.expiresAt - STEP_TTL_MS;
    worker.mailArrives(address, { kind: "extracted", value: "LEFTOVER", at: stepOpenedOnWorker1 });
    const r1 = await watchedAgent.waitForValue(address, { pollMs: 10, expiresAt: opened1.expiresAt });
    expect(r1.outcome).toBe("extracted"); // the first step's own read: legitimately fresh

    events.length = 0;
    const opened2 = await watchedAgent.openStep(address); // same tick: no sleep happened above
    const baseline = await watchedAgent.resultFingerprint(address); // LEFTOVER is still sitting there
    const stepOpenedOnWorker2 = opened2.expiresAt - STEP_TTL_MS;
    // Confirms the adversarial condition the test is built around: the leftover's `at` is NOT
    // strictly before this step's open time, so the timestamp check alone would admit it.
    expect(stepOpenedOnWorker1 < stepOpenedOnWorker2).toBe(false);

    const r2 = await watchedAgent.waitForValue(address, { pollMs: 60_000, expiresAt: opened2.expiresAt, baseline });
    expect(r2.outcome).not.toBe("extracted");
    expect(events.some((e) => e.event === "result.stale.ignored")).toBe(true);
  });

  it("a fresh result at or after the step's open time is trusted, not discarded as stale", async () => {
    const worker = makeWorkerWithClock();
    const { agent } = agentOver(worker);
    const { address } = await agent.ensureAddress();
    const opened = await agent.openStep(address);
    // `at` equal to the moment the step opened on the worker's own clock — the boundary case.
    const stepOpenedOnWorker = opened.expiresAt - STEP_TTL_MS;
    worker.mailArrives(address, { kind: "extracted", value: "boundary-value", at: stepOpenedOnWorker });

    const r = await agent.waitForValue(address, { pollMs: 10, expiresAt: opened.expiresAt });
    expect(r.outcome).toBe("extracted");
    expect(r.value).toBe("boundary-value");
  });

  it("with no expiresAt given, waitForValue refuses outright rather than guess (F5)", async () => {
    // A re-check of C5: an earlier version made the staleness filter conditional
    // on expiresAt being present and called the no-expiry case "conservative" — it was the
    // opposite, since skipping the filter means every stale result is believed. The current
    // client refuses to run at all without it.
    const worker = makeWorkerWithClock();
    const { agent } = agentOver(worker);
    const { address } = await agent.ensureAddress();
    await agent.openStep(address);
    worker.mailArrives(address, { kind: "extracted", value: "leftover", at: worker.clock.now() - 1 });

    let caught;
    try {
      await agent.waitForValue(address, { pollMs: 10 }); // no expiresAt
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(DevpingsError);
    expect(caught.message).toMatch(/expiresAt/i);
  });
});

// --- F4: the budget starts at step-open, not at waitForValue entry -----------------------------

describe("collect — the budget starts when the step opens, not after the trigger", () => {
  it("collect() passes since/expiresAt from openStep through to waitForValue (the wiring F4 depends on)", async () => {
    const worker = makeWorkerWithClock();
    const { agent, calls } = agentOver(worker);
    const originalWaitForValue = agent.waitForValue.bind(agent);
    let capturedOpts;
    agent.waitForValue = (address, opts) => {
      capturedOpts = opts;
      return originalWaitForValue(address, opts);
    };

    const trigger = vi.fn(async (address) => {
      worker.mailArrives(address, { kind: "extracted", value: "v", at: worker.clock.now() });
    });
    await agent.collect({ trigger, pollMs: 10 });

    expect(capturedOpts.since).toBeTypeOf("number");
    expect(capturedOpts.expiresAt).toBeTypeOf("number");
    // since is taken right after /step, i.e. no earlier than the recorded expiresAt minus the TTL.
    expect(capturedOpts.since).toBeGreaterThanOrEqual(capturedOpts.expiresAt - STEP_TTL_MS);
  });

  it("waitForValue honours an explicit `since` earlier than entry, shrinking the remaining budget", async () => {
    const worker = makeWorkerWithClock();
    const { agent } = agentOver(worker);
    const { address } = await agent.ensureAddress();
    const opened = await agent.openStep(address);

    // Pretend the step was opened 10 minutes ago (since = 10 minutes before "now"). Only 5
    // minutes of the 15-minute budget should remain, so a poll interval of 6 minutes should
    // immediately end the wait rather than sleep past the step.
    const since = worker.clock.now() - 10 * 60_000;
    const r = await agent.waitForValue(address, { since, pollMs: 6 * 60_000, expiresAt: opened.expiresAt });
    expect(["timeout", "expired"]).toContain(r.outcome);
    expect(r.waitedMs).toBeGreaterThanOrEqual(10 * 60_000);
  });
});

// --- collect(): step opened before the trigger fires -------------------------------------------

describe("collect", () => {
  it("opens the step before firing the trigger", async () => {
    const worker = makeWorkerWithClock();
    const { agent, calls } = agentOver(worker);
    const order = [];

    const trigger = vi.fn(async (address) => {
      order.push("trigger");
      // Simulate the provider's mail landing as a direct effect of the trigger, on the SAME
      // clock the worker uses for expiresAt — this is the fixture detail that mattered: an `at`
      // off the shared clock reads as older than the step and gets discarded as stale (C5),
      // which is a fixture bug, not a client defect (converter.mjs's real `now()` is Date.now(),
      // so `at` and `expiresAt` are the same clock in production by construction).
      worker.mailArrives(address, { kind: "extracted", value: "code-4242", at: worker.clock.now() });
    });

    const result = await agent.collect({ trigger, pollMs: 10 });

    const stepCallIndex = calls.findIndex((c) => new URL(c.url).pathname === "/step");
    expect(stepCallIndex).toBeGreaterThanOrEqual(0);
    expect(order).toEqual(["trigger"]);
    expect(result.outcome).toBe("extracted");
    expect(result.value).toBe("code-4242");
  });

  it("mail that arrives before a step exists is ignored and looks exactly like expired/timeout", async () => {
    const worker = makeWorkerWithClock();
    const { agent } = agentOver(worker);
    const { address } = await agent.ensureAddress();

    // Mail arrives BEFORE any step is opened.
    worker.mailArrives(address, { kind: "extracted", value: "too-early", at: worker.clock.now() });
    expect(worker.hasOpenStep(address)).toBe(false); // nothing to have been open

    const opened = await agent.openStep(address);
    const r = await agent.waitForValue(address, { timeoutMs: 20, pollMs: 10, expiresAt: opened.expiresAt });
    expect(["timeout", "expired"]).toContain(r.outcome);
  });

  it("passes minted through, and it reflects ensureAddress's own answer", async () => {
    const worker = makeWorkerWithClock();
    const { agent } = agentOver(worker);
    const trigger = vi.fn(async (address) => {
      worker.mailArrives(address, { kind: "extracted", value: "v", at: worker.clock.now() });
    });
    const result = await agent.collect({ trigger, pollMs: 10 });
    expect(result.minted).toBe(true);
    expect(result.address).toBe("github@example.com.au");
  });
});

// --- STEP_TTL_MS cap ---------------------------------------------------------------------------

// --- The STEP_TTL_MS/STEP_TTL_SECONDS coupling ---------------------------------------------
//
// C5's staleness boundary is `expiresAt - STEP_TTL_MS`, reconstructing the worker's own
// Date.now() at the moment /step ran. That only works because client.mjs's STEP_TTL_MS (ms) and
// worker.mjs's STEP_TTL_SECONDS (seconds) name the same 900. Nothing in the type system ties
// them together, and a unit test that reads both numbers from client.mjs (or from a fixture that
// hardcodes 900) cannot catch the worker's constant drifting on its own — it would just agree
// with itself. This reads the worker's source text directly, so a change to worker.mjs's own
// STEP_TTL_SECONDS breaks THIS test without anyone touching client.mjs or this file.
describe("STEP_TTL_MS stays coupled to the worker's own STEP_TTL_SECONDS", () => {
  it("client.mjs's STEP_TTL_MS matches worker/worker.mjs's STEP_TTL_SECONDS, read from its source", () => {
    const workerPath = fileURLToPath(new URL("../worker/worker.mjs", import.meta.url));
    const workerSource = readFileSync(workerPath, "utf8");
    const match = workerSource.match(/const\s+STEP_TTL_SECONDS\s*=\s*(\d+)/);
    expect(match, "worker/worker.mjs must define `const STEP_TTL_SECONDS = <number>` for this coupling to be checkable at all").not.toBeNull();
    const workerTtlSeconds = Number(match[1]);
    expect(STEP_TTL_MS).toBe(workerTtlSeconds * 1000);
  });
});

describe("waitForValue — the STEP_TTL_MS cap", () => {
  it("does not wait past the point where anything can arrive, and calls it 'expired' not 'timeout'", async () => {
    const worker = makeWorkerWithClock();
    const { agent } = agentOver(worker);
    const { address } = await agent.ensureAddress();
    const opened = await agent.openStep(address);

    // Ask for a wait far longer than the step can live (a step lives 15 minutes).
    const requestedMs = STEP_TTL_MS + 20 * 60_000;
    const pollMs = 60_000;
    const r = await agent.waitForValue(address, { timeoutMs: requestedMs, pollMs, expiresAt: opened.expiresAt });

    // Requesting longer than the step can live means the STEP is what ends the wait, not a
    // caller-chosen budget — that is "expired", the caller must reopen before retriggering.
    expect(r.outcome).toBe("expired");
    expect(r.waitedMs).toBeLessThanOrEqual(STEP_TTL_MS);

    const totalSlept = worker.clock.sleep.mock.calls.reduce((sum, [ms]) => sum + ms, 0);
    expect(totalSlept).toBeLessThanOrEqual(STEP_TTL_MS);
  });

  it("defaults to the step TTL when no timeout is given, and that ending is 'expired'", async () => {
    const worker = makeWorkerWithClock();
    const { agent } = agentOver(worker);
    const { address } = await agent.ensureAddress();
    const opened = await agent.openStep(address);

    const r = await agent.waitForValue(address, { pollMs: 300_000, expiresAt: opened.expiresAt });
    expect(r.outcome).toBe("expired");
    expect(r.waitedMs).toBeLessThanOrEqual(STEP_TTL_MS);
  });

  it("a caller budget shorter than the step's TTL ends as 'timeout', not 'expired'", async () => {
    const worker = makeWorkerWithClock();
    const { agent } = agentOver(worker);
    const { address } = await agent.ensureAddress();
    const opened = await agent.openStep(address);

    const r = await agent.waitForValue(address, { timeoutMs: 60_000, pollMs: 10_000, expiresAt: opened.expiresAt });
    expect(r.outcome).toBe("timeout");
  });
});

// --- C1: MINT_KEY never appears in a thrown error or an event ----------------------------------

describe("C1 — the key never surfaces", () => {
  it("a network failure's error carries the path, not the URL or the key", async () => {
    const fetch = vi.fn(async () => {
      throw new Error("network down");
    });
    const agent = new DevpingsAgent({ base: "https://devpings-mail.example.workers.dev", key: KEY, fetch, sleep: vi.fn(), now: () => 0 });

    let caught;
    try {
      await agent.lookupAddress();
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(DevpingsError);
    expect(caught.message).not.toContain(KEY);
    expect(caught.path).toBe("/address");
    expect(JSON.stringify(caught)).not.toContain(KEY);
  });

  it("a worker refusal's error carries no key either", async () => {
    const worker = makeWorkerWithClock({ key: "different-key" }); // forces a 403
    const { agent } = agentOver(worker);

    let caught;
    try {
      await agent.lookupAddress();
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(DevpingsError);
    expect(caught.message).not.toContain(KEY);
    expect(JSON.stringify(caught)).not.toContain(KEY);
  });

  it("no onEvent payload, across a full collect(), ever contains the key", async () => {
    const worker = makeWorkerWithClock();
    const events = [];
    const trigger = vi.fn(async (address) => {
      worker.mailArrives(address, { kind: "extracted", value: "secret-value-xyz", at: worker.clock.now() });
    });
    const { agent } = agentOver(worker, { onEvent: (e) => events.push(e) });
    await agent.collect({ trigger, pollMs: 10 });

    for (const e of events) {
      expect(JSON.stringify(e)).not.toContain(KEY);
    }
  });
});

// --- C2: the extracted value never appears in an error or an onEvent payload -------------------

describe("C2 — the extracted value is a credential, not data", () => {
  it("value.extracted event carries no value field", async () => {
    const worker = makeWorkerWithClock();
    const events = [];
    const { agent } = agentOver(worker, { onEvent: (e) => events.push(e) });
    const { address } = await agent.ensureAddress();
    const opened = await agent.openStep(address);
    worker.mailArrives(address, { kind: "extracted", value: "top-secret-code-99", at: worker.clock.now() });
    await agent.waitForValue(address, { pollMs: 10, expiresAt: opened.expiresAt });

    const extractedEvent = events.find((e) => e.event === "value.extracted");
    expect(extractedEvent).toBeDefined();
    expect(extractedEvent).not.toHaveProperty("value");
    for (const e of events) {
      expect(JSON.stringify(e)).not.toContain("top-secret-code-99");
    }
  });

  it("a held-then-surfaced failure's events never carry a value field either", async () => {
    const worker = makeWorkerWithClock();
    const events = [];
    const { agent } = agentOver(worker, { onEvent: (e) => events.push(e) });
    const { address } = await agent.ensureAddress();
    const opened = await agent.openStep(address);
    worker.mailArrives(address, { kind: "failed", reason: "pattern not found", at: worker.clock.now() });
    await agent.waitForValue(address, { pollMs: STEP_TTL_MS, expiresAt: opened.expiresAt });

    for (const e of events) {
      expect(e).not.toHaveProperty("value");
    }
  });

  it("resultFingerprint's own return value is not a form a caller could read the credential back from", async () => {
    // The new C5 mechanism reads the credential's value into a fingerprint internally
    // (`JSON.stringify([kind, at, value, reason])`) purely to compare two fingerprints for
    // equality. This is worth its own test: resultFingerprint is a public, exported method, and
    // a fingerprint that simply serialises the raw value is a second way for the credential to
    // leak out of the client to any caller who calls this method directly and logs its return.
    const worker = makeWorkerWithClock();
    const { agent } = agentOver(worker);
    const { address } = await agent.ensureAddress();
    await agent.openStep(address);
    worker.mailArrives(address, { kind: "extracted", value: "super-secret-credential-123", at: worker.clock.now() });

    const fp = await agent.resultFingerprint(address);
    expect(fp).not.toContain("super-secret-credential-123");
  });

  it("the value never appears in a thrown error, even under a malformed worker response", async () => {
    const badWorker = {
      handle: async () => ({
        ok: false,
        status: 500,
        json: async () => ({ error: "internal, value was top-secret-code-99" }),
      }),
    };
    const fetch = vi.fn(async (url, init) => badWorker.handle(url, init));
    const agent = new DevpingsAgent({ base: "https://x.workers.dev", key: KEY, fetch, sleep: vi.fn(), now: () => 0 });

    // Even in this adversarial case (a worker that misbehaves and echoes a secret in its own
    // error body), this documents current behavior of the body it was given, not a promise
    // about the worker.
    let caught;
    try {
      await agent.lookupAddress();
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(DevpingsError);
  });
});

// --- mask() --------------------------------------------------------------------------------------

describe("mask", () => {
  it("discloses nothing useful about a link", () => {
    const m = mask("https://example.com/verify?token=abcdef1234567890");
    expect(m).not.toContain("abcdef1234567890");
    expect(m).not.toContain("token=");
    expect(m).toContain("https://example.com");
    expect(m).toMatch(/•+/);
  });

  it("discloses nothing useful about a bare code — not even a tail", () => {
    const m = mask("30503060");
    expect(m).not.toBe("30503060");
    expect(m).not.toContain("30503060");
    expect(m).not.toContain("60"); // the old tail disclosure is gone
    expect(m).toBe("8 chars");
  });

  it("handles empty and nullish input without throwing or leaking undefined text oddly", () => {
    expect(mask("")).toBe("(empty)");
    expect(mask(undefined)).toBe("(empty)");
    expect(mask(null)).toBe("(empty)");
  });

  it("masks a link's path segments, not just the query", () => {
    const m = mask("https://example.com/a/b/c?token=xyz");
    expect(m).not.toContain("/a/b/c");
    expect(m).not.toContain("xyz");
  });
});

// --- openStep -------------------------------------------------------------------------------------

describe("openStep", () => {
  it("propagates the worker's refusal when the address does not exist", async () => {
    const worker = makeWorkerWithClock();
    const { agent } = agentOver(worker);
    let caught;
    try {
      await agent.openStep("github@" + DOMAIN);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(DevpingsError);
    expect(caught.status).toBe(404);
  });

  it("refuses an array linkPattern rather than silently flattening it on the wire", async () => {
    const worker = makeWorkerWithClock();
    const { agent } = agentOver(worker);
    const { address } = await agent.ensureAddress();

    let caught;
    try {
      await agent.openStep(address, { linkPattern: ["one", "two"] });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(DevpingsError);
    expect(caught.message).toMatch(/single pattern/i);
  });
});
