// The owner's choices per mailbox (the owner, 28 Sep 2026: the setup tree), and the timed window.
//
//   GET  /prefs?address=                 { untrusted, trusted, set }
//   POST /prefs {address, untrusted, trusted}
//   POST /wait?address=                  the agent started waiting for a code: open a window
//   POST /world?address=&id= {state, ...} the site records a world request's progress on the mail (taken,
//                                         refused, approved + head commit, merged)
//
// untrusted: "release" (nothing reaches the agent; the owner releases each mail) or "window" (a code
// reaches it only if the mail ARRIVED while a window was open). trusted: "full" or "world". The worker
// stores the choice; the site's connector enforces it. The window is stamped on the mail at arrival,
// so opening one later cannot let an earlier stranger's code through.
export const PREFS = { untrusted: "window", trusted: "full" };
export const WINDOW_SECONDS = 900;
const CHOICES = { untrusted: ["release", "window"], trusted: ["full", "world"] };

export async function prefsOf(env, address) {
  const v = await env.STEPS.get(`prefs:${address}`);
  return v ? { ...PREFS, ...JSON.parse(v), set: true } : { ...PREFS, set: false };
}

export const windowOpen = async (env, address) => Boolean(await env.STEPS.get(`wait:${address}`));

export async function prefsRoute(env, url, method, readJson, now = Date.now()) {
  const b = method === "POST" && url.pathname === "/prefs" ? await readJson() : {};
  const address = String(b.address || url.searchParams.get("address") || "").toLowerCase();
  if (!(await env.ADDRESSES.get(address))) return [404, { error: "no such address" }];
  if (url.pathname === "/world") {
    if (method !== "POST") return [405, { error: "POST" }];
    const id = String(url.searchParams.get("id") || "");
    const k = `inbox:${address}:${id}`, v = /^[a-z0-9_-]{1,64}$/i.test(id) ? await env.STEPS.get(k) : null;
    if (!v) return [404, { error: "no such mail" }];
    const item = JSON.parse(v), b2 = await readJson();
    if (!["taken", "refused", "approved", "merged"].includes(b2.state)) return [400, { error: "state" }];
    item.world = { ...(item.world || {}), state: b2.state, why: String(b2.why || "").slice(0, 200), pr: b2.pr ?? item.world?.pr, head: b2.head ?? item.world?.head, url: typeof b2.url === "string" && /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+$/.test(b2.url) ? b2.url : item.world?.url, [`${b2.state}_at`]: now };
    const left = Math.max(60, Math.floor((item.at + 7 * 86_400_000 - now) / 1000));
    await env.STEPS.put(k, JSON.stringify(item), { expirationTtl: left });
    return [200, { id, world: item.world }];
  }
  if (url.pathname === "/wait") {
    if (method !== "POST") return [405, { error: "POST" }];
    await env.STEPS.put(`wait:${address}`, String(now), { expirationTtl: WINDOW_SECONDS });
    return [200, { address, open_until: new Date(now + WINDOW_SECONDS * 1000).toISOString() }];
  }
  if (method === "GET") return [200, { address, ...(await prefsOf(env, address)) }];
  const next = { untrusted: String(b.untrusted || ""), trusted: String(b.trusted || "") };
  if (!CHOICES.untrusted.includes(next.untrusted) || !CHOICES.trusted.includes(next.trusted)) return [400, { error: "untrusted: release|window, trusted: full|world" }];
  await env.STEPS.put(`prefs:${address}`, JSON.stringify(next));
  return [200, { address, ...next, set: true }];
}
