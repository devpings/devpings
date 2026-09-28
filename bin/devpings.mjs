#!/usr/bin/env node
// devpings — email for your dev agents. `devpings mail wait|inbox --key <keyfile>`;
// `devpings wake --folder <dir>` wakes the agent here when a letter arrives; `devpings desk` starts a
// session you reach from your phone and wake by hand ("check my mail"); `devpings world --repo <dir>`
// drafts the newest approved or released request in world mode (src/world.mjs).
import { main } from "../src/mail.mjs";
import { run } from "../src/wake.mjs";
import { desk } from "../src/desk.mjs";
import { world } from "../src/world.mjs";

const [group, ...rest] = process.argv.slice(2);
if (group === "wake") run(rest).then((code) => process.exit(code));
else if (group === "desk") process.exit(desk(rest));
else if (group === "world") world(rest).then((code) => process.exit(code)); // spec 27 D6: draft one request in world mode
else if (group === "mail") main(rest).then((code) => process.exit(code));
else {
  process.stderr.write("usage: devpings mail wait|inbox|reply --key <keyfile> …  |  devpings wake --folder <dir>\n");
  process.exit(1);
}
