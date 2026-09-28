// Upload the devpings.com mail worker (keyway-mail-devpings-com) to Cloudflare: multipart PUT, keep every
// existing binding, set FORWARD_TO. Token CF_WORKER_TOKEN from ~/the maintainers' other project/.env.local, never printed.
// Run from anywhere: node ~/devpings/devpings/scripts/upload-worker.mjs   (then check the bindings and /health).
import { readFileSync } from "node:fs";
const env = Object.fromEntries(readFileSync("~/the maintainers' other project/.env.local", "utf8").split("\n").filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).replace(/^["']|["']$/g, "")]));
const acct = env.CF_ACCOUNT_ID || "<from-your-env>", token = env.CF_WORKER_TOKEN;
if (!acct || !token) { console.log("missing", !!acct, !!token); process.exit(1); }
const dir = "~/devpings/devpings/worker/";
const fd = new FormData();
fd.append("metadata", new Blob([JSON.stringify({
  main_module: "worker.mjs", compatibility_date: "2026-09-01",
  keep_bindings: ["kv_namespace", "plain_text", "send_email", "secret_text"],
  bindings: [{ type: "plain_text", name: "FORWARD_TO", text: "owner@example.com" }, { type: "ai", name: "AI" }], // AI: spec 27 D2
})], { type: "application/json" }));
for (const f of ["worker.mjs", "converter.mjs", "join.mjs", "page.mjs", "hosted.mjs", "deliver.mjs", "gate.mjs", "moderate.mjs", "inbox.mjs", "prefs.mjs", "digest.mjs", "outbound.mjs", "quarantine.mjs", "health.mjs"])
  fd.append(f, new Blob([readFileSync(dir + f)], { type: "application/javascript+module" }), f);
const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${acct}/workers/scripts/keyway-mail-devpings-com`, { method: "PUT", headers: { authorization: `Bearer ${token}` }, body: fd });
const j = await r.json();
console.log(r.status, j.success, (j.errors || []).map((e) => e.message).join("; "), j.result?.bindings?.map?.((b) => `${b.type}:${b.name}`).join(" ") || "");
// The daily notice (digest.mjs): 19:00 UTC = 5 am AEST.
const c = await fetch(`https://api.cloudflare.com/client/v4/accounts/${acct}/workers/scripts/keyway-mail-devpings-com/schedules`, { method: "PUT", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify([{ cron: "0 19 * * *" }]) });
const cj = await c.json();
console.log("schedules", c.status, cj.success, (cj.errors || []).map((e) => e.message).join("; "), JSON.stringify(cj.result?.schedules || []));
