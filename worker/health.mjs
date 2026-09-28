// Silence alarms (Opus, 29 Sep: "devpings needs to notice its own silence"; on 28 Sep a retired model made
// every world-mode read fail quietly for hours). Once a day, with the 5 am digest, the worker tries its own
// models on canned text. If one fails, the owner gets one plain email naming it. Silence is a finding.
import { moderate } from "./moderate.mjs";
import { quarantine } from "./quarantine.mjs";

const CANNED = { subject: "Button text", body: "On the mail page, please change the button text 'Check mail' to 'Refresh'." };

export async function health(env) {
  const problems = [];
  const run = env.AI && typeof env.AI.run === "function" ? (m, i) => env.AI.run(m, i) : null;
  const mod = await moderate(run, `${CANNED.subject}\n${CANNED.body}`);
  if (mod.verdict !== "clean") problems.push(`moderation answered "${mod.verdict}" on a harmless test mail`);
  const q = await quarantine(env, CANNED.subject, CANNED.body, true);
  if (q.error) problems.push(`the world-mode reader failed: ${String(q.error).slice(0, 200)}`);
  else if (!q.parsed || q.parsed.kind === "unclear" || !Array.isArray(q.parsed.changes) || !q.parsed.changes.length) problems.push("the world-mode reader couldn't read a plain test request");
  return problems;
}

export async function alarmIfUnwell(env) {
  const problems = await health(env);
  if (!problems.length || !env.EMAIL || !env.FORWARD_TO) return problems;
  await env.EMAIL.send({ from: `security@${env.DOMAIN || "devpings.com"}`, to: env.FORWARD_TO, subject: "devpings: something stopped working",
    text: `The daily self-check found:\n\n- ${problems.join("\n- ")}\n\nMail is still kept; the part named above fails closed until it's fixed.` }).catch(() => {});
  return problems;
}
