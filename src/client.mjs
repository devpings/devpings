// devpings agent client: the caller that asks the worker for an agent's mail.
//
// WHAT THIS IS FOR: an agent completes a provider setup on a fresh domain
// unattended, and the human reads a receipt in the morning. Everything needed for that
// already ran before today except this: `worker/worker.mjs` mints the address, catches the
// mail and extracts the credential, but the only thing that ever ASKED it for the value was a
// human tapping a page. This is the caller that isn't a human.
//
// It is deliberately a thin client over the four endpoints that already exist (/address,
// /mint, /step, /result). No new server, no new store, no new lifetimes. The two lifetimes in
// the worker — permanent ADDRESS, 15-minute STEP — are the worker's and are not restated here,
// because a client that keeps its own idea of when a step ends is a second source of truth.
//
// FOUR RULES, each one a rule because of something that already went wrong:
//
//   C1. THE KEY TRAVELS IN A HEADER, NEVER THE URL. It used to ride in `?k=` (bootstrap
//       worker's D4 defect); the worker refuses a key in the URL
//       outright, so this sends `X-Keyway-Mint-Key` (24 Sep 2026). Errors still quote the PATH
//       and the status, never the URL, out of the same habit.
//   C2. THE EXTRACTED VALUE IS A CREDENTIAL, NOT DATA (converter.mjs R5). It is returned to
//       the caller and never printed, never written to a file, never put in an error message.
//       The CLI masks it unless asked to reveal it.
//   C3. AN AMBIGUOUS OR FAILED EXTRACTION IS NOT A VALUE (converter.mjs R7). `failed` comes
//       back as an outcome the caller must handle, never as null-that-looks-like-not-yet.
//   C5. A RESULT IS ONLY THIS STEP'S RESULT IF IT POSTDATES THIS STEP.
//       The worker's /step does not clear `result:<address>`, and after D6 an extracted result
//       deliberately stands for the rest of its TTL. So the first poll of a NEW step returns the
//       PREVIOUS step's credential — a second provider setup acting on the first one's code.
//       Every result is checked against the step's own open time before it is believed.
//   C6. A FAILURE IS TERMINAL ONLY WHEN THE STEP IS.
//       Providers send more than one mail per signup — GitHub sent a code and then a welcome.
//       The worker closes a step on `extracted` but NOT on `failed`, precisely because the real
//       mail may still be coming. Returning `failed` on first sight contradicts the worker and
//       stops waiting seconds before the credential lands.
//   C4. MINT IS NOT IDEMPOTENT IN THE RECORD. Found 16 Sep by tapping the button
//       twice: re-minting keeps the same address but rewrites createdAt. So `ensureAddress`
//       ASKS FIRST (/address) and mints only when there is nothing there. Pressing it twice
//       is the CLAUDE.md checklist item; this makes pressing it twice harmless.

const DEFAULT_POLL_MS = 3000;

// The worker's STEP_TTL_SECONDS is 900. Waiting longer than the step can live is waiting for
// something that cannot arrive: once the step expires the converter ignores the mail and
// stores nothing, so a 20-minute wait on a 15-minute step is 5 minutes of certain silence.
// Capped here rather than left to the caller, and the cap is named so it moves if the TTL does.
// COUPLED TO THE WORKER. This must equal STEP_TTL_SECONDS in worker/worker.mjs (900). C5
// derives the step's open time by subtracting it from the worker's expiresAt, so if the worker's
// TTL changes and this does not, the derived open time lands early and stale results are admitted
// again — silently, everywhere, and invisibly to any test that reads both numbers from one file.
// The durable fix is queued for a later version: /step returns `openedAt` explicitly
// and this subtraction disappears.
export const STEP_TTL_MS = 900_000;

export class DevpingsError extends Error {
  constructor(message, { path, status } = {}) {
    super(message);
    this.name = "DevpingsError";
    this.path = path;      // C1: path, not URL.
    this.status = status;
  }
}

export class DevpingsAgent {
  /**
   * @param {object} opts
   * @param {string} opts.base      Worker origin, e.g. https://devpings-mail.<sub>.workers.dev
   * @param {string} opts.key       MINT_KEY. Held, never logged (C1).
   * @param {string} [opts.account] Account slug; the address is `<account>@<domain>`.
   * @param {function} [opts.fetch] Injected for tests. The default is the platform fetch.
   * @param {function} [opts.sleep] Injected for tests, so a 15-minute wait costs no wall-clock.
   * @param {function} [opts.now]   Injected WITH sleep. F3: faking sleep while Date.now stays
   *                                real makes the budget unreachable and the poll loop spins at
   *                                native speed — it does not time out, it hangs. A virtual sleep
   *                                needs a virtual clock or it is not virtual.
   * @param {function} [opts.onEvent] Progress callback — receives {at, event, ...} and never a value.
   */
  constructor({ base, key, account = "github", fetch: f = globalThis.fetch, sleep, now, onEvent } = {}) {
    if (!base) throw new DevpingsError("no worker base URL given");
    if (!key) throw new DevpingsError("no key given; minting and reading both require it");
    this.base = base.replace(/\/+$/, "");
    this.key = key;
    this.account = String(account).replace(/[^a-z0-9-]/gi, "").toLowerCase();
    this.fetch = f;
    this.sleep = sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = now || (() => Date.now());
    this.onEvent = onEvent || (() => {});
    this.#minting = null;
  }

  // C4, the concurrent hole: two simultaneous ensureAddress calls both see
  // null and both mint. One in-flight promise per instance closes it. The cost, named rather
  // than hidden: concurrent callers share one result, so both see `minted: true` though only
  // one mint happened. The address is right; the flag describes the call, not the caller.
  #minting;

  async #call(path, params = {}, init = {}) {
    const url = new URL(this.base + path);
    for (const [k, v] of Object.entries(params)) if (v !== undefined) url.searchParams.set(k, v);
    let res;
    try {
      res = await this.fetch(url.toString(), { ...init, headers: { ...(init.headers || {}), "X-Keyway-Mint-Key": this.key } });
    } catch (cause) {
      // C1: the URL carries the key. The path is enough to debug with.
      throw new DevpingsError(`could not reach the worker at ${path}`, { path });
    }
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new DevpingsError(body.error || `worker refused ${path}`, { path, status: res.status });
    }
    return body;
  }

  /** The address's kept mail, newest first (the worker's 7-day inbox). Nothing is filtered here:
   *  the allowlist gate is the caller's (mail.ts), because the key file holds the list. */
  async inbox(address) {
    const r = await this.#call("/inbox", { address });
    return r.items || [];
  }

  /** Send one email from an address this worker created (reply-only; see worker /send). */
  async send({ from, to, subject, text }) {
    return this.#call("/send", {}, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ from, to, subject, text }) });
  }

  /** What address exists for this account right now, or null. Creates nothing. */
  async lookupAddress() {
    const r = await this.#call("/address", { account: this.account });
    return r.address || null;
  }

  /**
   * C4. Ask first, mint only if absent. Returns { address, minted }.
   * `minted: false` means it already existed and createdAt was left alone.
   */
  async ensureAddress() {
    if (this.#minting) return this.#minting;
    this.#minting = this.#ensureAddressOnce().finally(() => { this.#minting = null; });
    return this.#minting;
  }

  async #ensureAddressOnce() {
    const existing = await this.lookupAddress();
    if (existing) {
      this.onEvent({ event: "address.exists", address: existing });
      return { address: existing, minted: false };
    }
    const r = await this.#call("/mint", { account: this.account }, { method: "POST" });
    if (!r.address) throw new DevpingsError("mint returned no address", { path: "/mint" });
    this.onEvent({ event: "address.minted", address: r.address });
    return { address: r.address, minted: true };
  }

  /**
   * Open a step behind an address that already exists. The worker refuses (404) if it does
   * not — deliberately, so a typo cannot silently create a second address.
   */
  async openStep(address, { step = "github/verify-email", expect = "link:verify", linkPattern } = {}) {
    // The transport is a query string. An array stringifies to "a,b", which the worker stores
    // as ONE pattern that then matches nothing — the converter supports arrays, the wire does
    // not. Refusing loudly beats a step that silently cannot match.
    if (Array.isArray(linkPattern)) {
      throw new DevpingsError("linkPattern must be a single pattern; the query string cannot carry an array", { path: "/step" });
    }
    const r = await this.#call("/step", { address, step, expect, linkPattern }, { method: "POST" });
    this.onEvent({ event: "step.opened", step: r.opened, address, expiresAt: r.expiresAt });
    return r;
  }

  /**
   * C7, and it is the reason this is a hash and not a string.
   *
   * The obvious fingerprint — JSON of kind, at, value, reason — CONTAINS THE CREDENTIAL
   * VERBATIM, while being called a fingerprint. A fingerprint is exactly the kind of thing the
   * next person logs, diffs, or drops into a receipt, precisely because the name promises it
   * discloses nothing. That is the verify-body trap one abstraction earlier: safe today because
   * nobody happens to print it, unsafe the first time somebody adds `step.baseline` to a
   * timeline in good faith. Hashing makes the name true rather than documenting that it is false.
   */
  async #digest(result) {
    if (!result) return null;
    const raw = JSON.stringify([result.kind, result.at, result.value ?? null, result.reason ?? null]);
    const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw));
    return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  /**
   * What is in the result slot right now, as a SHA-256 digest — never the value itself (C2, C7).
   * Used to tell a leftover result from a fresh one without comparing clocks.
   */
  async resultFingerprint(address) {
    const r = await this.#call("/result", { address });
    return this.#digest(r.result);
  }

  /**
   * Wait for the converter to hand back a value.
   *
   * Returns one of, and the caller must tell them apart (C3):
   *   { outcome: "extracted", value, at }   — a credential. Do not log it (C2).
   *   { outcome: "failed", reason }         — mail arrived and could not be read, and the step
   *                                           then ended. Re-sending the SAME mail fails again.
   *   { outcome: "timeout", waitedMs }      — the caller's own budget ran out first; the step
   *                                           may still be open, so re-triggering is right.
   *   { outcome: "expired", waitedMs }      — the step's 15 minutes ran out. Re-triggering alone
   *                                           is NOT right: mail after expiry is ignored by the
   *                                           converter and stored nowhere. Reopen, then trigger.
   *   { outcome: "gone" }                   — the address is no longer live.
   *
   * @param {number} [opts.since]     Local clock reading taken when /step was opened. The budget
   *                                  runs from THERE, not from entry here: the trigger sits in
   *                                  between and a slow signup can eat the whole step. (F4.)
   * @param {string} [opts.baseline] Fingerprint of the result already in the store when the step
   *                                  opened, from collect(). The clock-independent half of C5.
   * @param {number} opts.expiresAt  REQUIRED. The worker's own expiry for this step, from
   *                                  openStep. It is the only thing that makes C5 possible, and
   *                                  without it this method would believe the previous step's
   *                                  credential — F1 alive through the public API. Not optional,
   *                                  not defaulted: the worker's clock or nothing.
   */
  async waitForValue(address, { timeoutMs = STEP_TTL_MS, pollMs = DEFAULT_POLL_MS, since, expiresAt, baseline } = {}) {
    // F5. The first version made the staleness filter conditional on
    // expiresAt being present, and the comment above it claimed the absent case was "the
    // conservative direction". It was the opposite: no expiry meant no filter, so every stale
    // result was believed. A fallback here would have to compare the worker's clock to ours,
    // which is the exact comparison C5 exists to avoid — so there is no fallback.
    if (typeof expiresAt !== "number") {
      throw new DevpingsError("waitForValue needs the step's expiresAt from openStep; without it a stale result cannot be told from a fresh one", { path: "/result" });
    }
    const startedAt = since ?? this.now();
    // C5. The staleness boundary is derived from the worker's OWN expiry, so both sides of the
    // comparison are on the worker's clock. Using our own clock here would be a cross-clock
    // comparison, and a few seconds of skew would either admit a stale credential or discard a
    // fresh one. There is no absent-expiry case: it throws above.
    // COUPLED CONSTANT — see STEP_TTL_MS. This reconstructs the worker's own Date.now() at the
    // moment /step ran, so both sides of the staleness test are on the worker's clock.
    const stepOpenedOnWorker = expiresAt - STEP_TTL_MS;
    const budget = Math.min(timeoutMs, STEP_TTL_MS);
    let lastFailure = null; // C6: held, not returned, until the step itself is over.

    for (let attempt = 1; ; attempt++) {
      const r = await this.#call("/result", { address });
      if (!r.addressAlive) {
        this.onEvent({ event: "address.gone", address });
        return { outcome: "gone" };
      }
      const result = r.result;
      // C5. A result older than this step belongs to the previous one. The worker's /step does
      // not clear it and an extracted result deliberately outlives its step (D6), so without
      // this the second provider setup in an unattended run acts on the first one's credential.
      // C5 has two tests, and the second is the one that survives a coarse clock.
      //
      // Found in review: with a timestamp comparison alone, two collect() calls in the same
      // millisecond — a fast unattended agent doing two setups back to back, or just a coarse
      // Date.now() tick — put the new step's open time exactly equal to the leftover result's
      // `at`, and equal is not "before", so the previous credential passed straight through.
      // Widening to `<=` would have fixed that case and broken the honest one, because with a
      // frozen clock a fresh result is ALSO equal. Time cannot separate them at that resolution.
      //
      // So the reliable test is not "when" but "which": `baseline` is the fingerprint of
      // whatever was already sitting in the store when the step opened, read BEFORE the trigger
      // fired. Anything identical to it is that same leftover, whatever the clock says. (Mail
      // arriving between openStep and the baseline read is necessarily from an EARLIER trigger,
      // since this step's trigger has not run yet — so treating it as the baseline is right.)
      //
      // WHAT THIS DELIBERATELY MISSES, so the investigation starts at the answer: a fresh result
      // IDENTICAL to the leftover — same kind, same value, same `at` — is discarded as baseline.
      // Providers do resend the same OTP inside its validity window, so only a differing `at`
      // separates them, and on a coarse clock it may not. The failure direction is a timeout,
      // never a wrong credential. If "why did the resend time out" is ever the question, it is
      // this line. Per-step attribution is the real fix.
      const fingerprint = await this.#digest(result); // C7: a digest, never the value.
      const stale = Boolean(
        result &&
          ((typeof result.at === "number" && result.at < stepOpenedOnWorker) ||
            (baseline != null && fingerprint === baseline))
      );
      if (stale) {
        this.onEvent({ event: "result.stale.ignored", address, at: result.at });
      } else if (result?.kind === "extracted") {
        // C2: the event carries no value. The value goes back to the caller only.
        this.onEvent({ event: "value.extracted", address, at: result.at });
        return { outcome: "extracted", value: result.value, at: result.at };
      } else if (result?.kind === "failed") {
        // C6. Do NOT return here. The worker leaves the step open after a failure on purpose,
        // because providers send more than one mail per signup and the next one may carry the
        // code. An extracted result overwrites this in the store, so continuing to poll wins
        // that race for free. The failure is reported only if the step ends without one.
        if (!lastFailure) this.onEvent({ event: "value.failed.holding", address, reason: result.reason });
        lastFailure = { outcome: "failed", reason: result.reason || "pattern not found" };
      }

      const waitedMs = this.now() - startedAt;
      if (waitedMs + pollMs > budget) {
        // Which kind of ending was it? The distinction decides the caller's retry: a step that
        // expired must be REOPENED before another trigger, because mail arriving after expiry
        // is ignored and stored nowhere.
        const ended = waitedMs + pollMs > STEP_TTL_MS ? "expired" : "timeout";
        if (lastFailure) {
          this.onEvent({ event: "value.failed", address, reason: lastFailure.reason });
          return { ...lastFailure, waitedMs };
        }
        this.onEvent({ event: `wait.${ended}`, address, waitedMs });
        return { outcome: ended, waitedMs };
      }
      this.onEvent({ event: "wait.polling", address, attempt, waitedMs });
      await this.sleep(pollMs);
    }
  }

  /**
   * ONE step of the unattended loop: have an address, open a step, cause the mail to be sent,
   * catch what comes back. Not a whole provider setup — `account` is fixed per instance, so a
   * setup spanning several providers wants one agent per provider, run in whatever order the
   * setup needs. Serialising a multi-provider run through a single address would put every
   * provider's mail on one step, and only one of them can be the answer.
   *
   * `trigger` is the caller's — it is the thing that makes a provider send the mail (a signup
   * POST, a Supabase auth call, a human clicking "resend"). It is invoked AFTER the step is
   * open, never before: mail that arrives before a step exists is ignored by the converter and
   * stores nothing, which looks exactly like a timeout and is the easiest way to lose an hour.
   */
  async collect({ trigger, step, expect, linkPattern, timeoutMs, pollMs } = {}) {
    const { address, minted } = await this.ensureAddress();
    const opened = await this.openStep(address, { step, expect, linkPattern });
    // F4: the budget starts HERE, not after the trigger. A real signup flow can take minutes,
    // and every one of them is spent out of the step's fifteen.
    const since = this.now();
    // The baseline read happens HERE: after the step is open, before the trigger fires. See C5
    // in waitForValue — this is what makes staleness detectable without trusting a clock.
    const baseline = await this.resultFingerprint(address);
    if (trigger) {
      this.onEvent({ event: "trigger.start", address });
      await trigger(address);
      this.onEvent({ event: "trigger.done", address });
    }
    const result = await this.waitForValue(address, { timeoutMs, pollMs, since, expiresAt: opened.expiresAt, baseline });
    return { address, minted, ...result };
  }
}

/** C2. For receipts and logs: proves a value arrived without disclosing it. */
export function mask(value) {
  const s = String(value ?? "");
  if (!s) return "(empty)";
  if (/^https?:/i.test(s)) {
    try {
      const u = new URL(s);
      return `${u.origin}${u.pathname.replace(/[^/]/g, "•")} (${s.length} chars)`;
    } catch { /* fall through to the digit form */ }
  }
  // The tail used to be here. On a six-digit code, disclosing the last two is a hundredfold
  // cut in the search space, printed on a receipt that may be screenshotted. Length alone
  // proves something arrived, which is all a receipt needs it to prove.
  return `${s.length} chars`;
}
