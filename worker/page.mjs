// The worker's own page: the setup wizard lives HERE, on the worker's origin, because only
// /health has CORS — setup never crosses origins and claim_authz never touches any site
// but the owner's own worker. The mint key field is kept in memory only.
export const PAGE = `<!doctype html><meta name=viewport content="width=device-width,initial-scale=1">
<title>devpings mail worker</title>
<style>body{font:17px/1.5 system-ui;margin:0;padding:24px;max-width:36rem}
input,button{font:inherit;padding:12px 14px;width:100%;box-sizing:border-box;border-radius:10px;border:1px solid #333;margin-top:8px}
button{background:#111;color:#fff}button[disabled]{opacity:.45}
code{background:#f2f2f2;padding:2px 6px;border-radius:4px;word-break:break-all}
.card{margin-top:18px;padding:14px;border:1px solid #ddd;border-radius:10px}
.muted{color:#666;font-size:14px}.warn{color:#a40}</style>
<h1>Set up this worker</h1>
<p class=muted>Two gates: the secret you placed in your own KV, and a challenge email through your own catch-all. Nothing here talks to any other site.</p>
<div class=card>
  <b>1. Start a claim</b>
  <input id=authz type=password placeholder="claim_authz (the secret you set in KV)">
  <input id=domain placeholder="your domain, e.g. example.com">
  <button id=start>Start claim</button>
  <p id=startout class=muted></p>
</div>
<div class=card hidden id=mailcard>
  <b>2. Send the challenge email</b>
  <p>Send an email containing this nonce to <code id=sendto></code> (from any mailbox):</p>
  <p><code id=nonce></code></p>
  <p class=muted>It must arrive within 15 minutes, through your catch-all.</p>
</div>
<div class=card hidden id=claimcard>
  <b>3. Collect your mint key</b>
  <button id=claim>I sent it — collect key</button>
  <p id=claimout></p>
</div>
<script>
const j = async (path, body) => {
  const r = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, data: await r.json().catch(() => ({})) };
};
start.onclick = async () => {
  const r = await j('/setup', { claim_authz: authz.value, domain: domain.value });
  if (r.status !== 200) { startout.textContent = r.data.error || ('failed (' + r.status + ')'); startout.className = 'warn'; return; }
  startout.textContent = 'Claim open for ' + domain.value + '.'; startout.className = 'muted';
  sendto.textContent = r.data.send_to; nonce.textContent = r.data.nonce;
  mailcard.hidden = false; claimcard.hidden = false;
};
claim.onclick = async () => {
  const r = await j('/setup/claim', { claim_authz: authz.value });
  if (r.status !== 200) { claimout.innerHTML = '<span class=warn>' + (r.data.error || ('failed (' + r.status + ')')) + '</span>'; return; }
  claimout.innerHTML = 'Your mint key — <b>shown once, stored nowhere</b>. Save it now:<br><code>' + r.data.mint_key + '</code>' +
    '<br><span class=muted>' + r.data.note + '</span>';
  authz.value = '';
};
</script>`;
