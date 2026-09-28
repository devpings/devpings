// devpings desk (DP-05 demo step 3): a live Remote Control session; push and merge are never
// pre-allowed (each asks the person), force and reset are blocked, and the prompt reads the inbox.
import { it, expect } from "vitest";
import { deskArgs } from "../src/desk.mjs";

const a = deskArgs({ folder: "/p/home", site: "/p/app", inbox: "opus@devpings.com", keyFile: "/k.json", repoWeb: "https://github.com/o/r" });
const allowed = a[a.indexOf("--allowedTools") + 1], denied = a[a.indexOf("--disallowedTools") + 1];

it("is a live session with Remote Control, named devpings desk", () => {
  expect(a.slice(0, 4)).toEqual(["--model", "claude-opus-5-5", "--remote-control", "devpings desk"]);
});
it("never pre-allows push or merge, so each asks the person", () => {
  expect(allowed).not.toMatch(/git push|git merge|Bash\(git:\*\)/);
});
it("blocks force-push, reset and the -C/-c routes around the rules", () => {
  for (const d of ["git reset", "git push --force", "git push -f", "git -C", "git -c"]) expect(denied).toContain(d);
});
it("reads the named inbox with the key file, and gives the diff link", () => {
  expect(a.at(-1)).toContain("--address opus@devpings.com");
  expect(a.at(-1)).toContain("https://github.com/o/r/compare/main...devpings/<slug>");
});

it("knows whether Claude Code trusts the folder (an untrusted one would stop a hidden session)", async () => {
  const { trusted } = await import("../src/desk.mjs");
  const { writeFileSync, mkdtempSync } = await import("node:fs");
  const { join } = await import("node:path"); const { tmpdir } = await import("node:os");
  const f = join(mkdtempSync(join(tmpdir(), "dt")), "c.json");
  writeFileSync(f, JSON.stringify({ projects: { "/a": { hasTrustDialogAccepted: true }, "/b": {} } }));
  expect(trusted("/a", f)).toBe(true);
  expect(trusted("/b", f)).toBe(false);
  expect(trusted("/c", f)).toBe(false);
});

it("gives the instructions as a system prompt (a first message can be lost) and opens the site folder", () => {
  expect(a[a.length - 2]).toBe("--append-system-prompt");
  expect(a[a.indexOf("--add-dir") + 1]).toBe("/p/app");
  expect(a.at(-1)).toContain("The product you change is the website in /p/app");
});
