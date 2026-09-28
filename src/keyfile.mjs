// The key file: the owner keeps the worker's key, wherever they like, and devpings reads it from
// there each time. The website never holds it. Lost file: re-run setup; a new key is made and the
// old one stops working.
//
// One module for every reader: the command an agent runs, and the setup page that writes it.
// DoD: test/keyfile.test.mjs.
export const KEYFILE_VERSION = 1;

const DOMAIN = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/;
const MINT_KEY = /^[A-Za-z0-9_-]{16,200}$/;

function note(domain) {
  return `Your devpings worker key for ${domain}. It reads every email your domain's worker catches, so ` +
    `keep it private: not in git, not in a shared folder. Lost it? Run setup again and you get a new ` +
    `one; the old one stops working.`;
}

export function keyFileName(domain) {
  return `keyway-${domain}.key.json`;
}

export function buildKeyFile(k, now = new Date()) {
  const checked = checkFields(k);
  if (!checked.ok) throw new Error(checked.reason);
  return JSON.stringify({ keyway: KEYFILE_VERSION, what: note(k.domain), ...checked.file, savedAt: now.toISOString() }, null, 2) + "\n";
}

/** Reads a key file's text. Never throws; a bad file gets a reason a person can act on. */
export function parseKeyFile(text) {
  if (typeof text !== "string" || text.length > 8 * 1024) return { ok: false, reason: "That file is too big to be a devpings key file." };
  let raw;
  try { raw = JSON.parse(text); } catch { return { ok: false, reason: "That file isn't a devpings key file (it isn't JSON)." }; }
  if (!raw || typeof raw !== "object") return { ok: false, reason: "That file isn't a devpings key file." };
  if (raw.keyway !== KEYFILE_VERSION) return { ok: false, reason: "That file isn't a devpings key file, or it's from a newer version." };
  return checkFields(raw);
}

function checkFields(raw) {
  const domain = String(raw?.domain ?? "").trim().toLowerCase();
  if (!DOMAIN.test(domain)) return { ok: false, reason: "The key file has no usable domain in it." };

  let workerUrl;
  try { workerUrl = new URL(String(raw?.workerUrl ?? "")); } catch { return { ok: false, reason: "The key file has no usable worker address in it." }; }
  if (workerUrl.protocol !== "https:") return { ok: false, reason: "The key file's worker address isn't https." };

  const address = String(raw?.address ?? "").trim().toLowerCase();
  if (!/^[a-z0-9._+-]{1,64}@/.test(address) || !address.endsWith(`@${domain}`)) {
    return { ok: false, reason: `The key file's address isn't on ${domain}.` };
  }

  const mintKey = String(raw?.mintKey ?? "");
  if (!MINT_KEY.test(mintKey)) return { ok: false, reason: "The key file's key is missing or damaged." };

  // The allow list: who may give this agent full-text mail. Exact addresses or whole "@domains".
  // Absent means nobody, the safe default.
  let allow;
  if (raw?.allow !== undefined) {
    if (!Array.isArray(raw.allow)) return { ok: false, reason: "The key file's allow list should be a list of addresses." };
    allow = raw.allow.map((a) => String(a).trim().toLowerCase()).filter(Boolean);
    if (allow.some((a) => !/^([a-z0-9._+-]{1,64})?@[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(a))) {
      return { ok: false, reason: "The key file's allow list has something that isn't an address or @domain." };
    }
  }
  const file = { domain, workerUrl: workerUrl.toString().replace(/\/$/, ""), address, mintKey };
  if (allow) file.allow = allow;
  return { ok: true, file };
}

/** Is this sender on the allow list? Exact address, or "@domain" for a whole domain. */
export function isAllowed(file, from) {
  const f = String(from || "").trim().toLowerCase();
  const at = f.lastIndexOf("@");
  return (file.allow ?? []).some((a) => a === f || (a.startsWith("@") && at >= 0 && f.slice(at) === a));
}
