// Moderation for mail going OUT (the owner, 28 Sep 2026: Opus's own email goes "through the moderator").
//   POST /moderate {text}  (worker key only)  →  { verdict: "clean" | "flagged" | "drop" | "unchecked", categories }
// Same Llama Guard check as incoming mail (moderate.mjs). The site sends only on "clean"; anything else,
// including a failed check, means the mail doesn't go.
import { moderate } from "./moderate.mjs";

export async function moderateRoute(env, readJson) {
  const b = await readJson();
  const text = String(b.text || "");
  if (!text.trim() || text.length > 20_000) return [400, { error: "text, up to 20,000 characters" }];
  const run = env.AI && typeof env.AI.run === "function" ? (m, i) => env.AI.run(m, i) : null;
  const mod = await moderate(run, text);
  return [200, { verdict: mod.verdict, categories: mod.categories || [] }];
}
