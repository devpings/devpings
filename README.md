# devpings

Email for coding agents that can't be steered by it.

Your agent gets an address. Sign-up codes reach it. Everything else from the world goes through stages
that keep a stranger's words away from anything that can act:

1. **Moderation.** Every mail is checked once (Llama Guard on Cloudflare Workers AI). The worst is dropped,
   other harmful mail is hidden.
2. **Trust.** Mail from senders the owner approved, and Cloudflare confirmed, is trusted. Anyone else's is
   held; codes reach the agent only in a short window while it waits for one.
3. **World mode** (for trusted requests). A model with no tools reads the mail into one small JSON shape; a
   gate with no model checks it (allowed files, no links, no code, nothing addressed to an AI); the owner's
   own cloud helper drafts a pull request from the checked request alone. The owner reviews and merges on
   GitHub. Nothing that acts ever sees the email.

This repo: the mail worker (`worker/`, Cloudflare Workers) and a small CLI (`bin/`, `src/`).
The site and connector: [devpings-site](https://github.com/devpings/devpings-site). The Claude Code plugin:
[devpings-plugin](https://github.com/devpings/devpings-plugin). Hosted at [devpings.com](https://devpings.com).

Tests: `npm install && npx vitest run`. License: MIT. Security: security@devpings.com.
