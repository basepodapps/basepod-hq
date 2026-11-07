#!/usr/bin/env node
// basepod-hq — run BasePod HQ for the git repo you're in.
import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const args = process.argv.slice(2);

if (args.includes("--version") || args.includes("-v")) {
  console.log(pkg.version);
  process.exit(0);
}
if (args.includes("--help") || args.includes("-h")) {
  console.log(`BasePod HQ ${pkg.version} — a pixel office for your team of AI coding agents.

Usage:
  npx @basepodapps/basepod-hq [options]          run inside a git repo

Options:
  --repo <path>   the git repo to manage (default: current folder)
  --port <n>      HQ server port (default: 7420)
  --no-open       don't open the browser
  -v, --version   print the version
  -h, --help      show this help

Needs: Docker Sandboxes (sbx) or Claude Code/Codex, tmux, git, gh.
HQ checks all of this on start and shows how to fix anything missing.
Docs: ${pkg.homepage ?? "https://github.com/basepodapps/basepod-hq"}`);
  process.exit(0);
}

const major = Number(process.versions.node.split(".")[0]);
if (major < 20) {
  console.error(`BasePod HQ needs Node.js 20 or newer (you have ${process.versions.node}).`);
  process.exit(1);
}

// Check option values here so a typo gets a clear message instead of a silent default.
const fail = (msg) => {
  console.error(`basepod-hq: ${msg}\nRun "npx @basepodapps/basepod-hq --help" for usage.`);
  process.exit(1);
};
for (const name of ["--repo", "--port"]) {
  const i = args.indexOf(name);
  if (i === -1) continue;
  const value = args[i + 1];
  if (value === undefined || value.startsWith("-")) fail(`${name} needs a value.`);
  if (name === "--port" && !(/^\d+$/.test(value) && Number(value) >= 1024 && Number(value) <= 65535)) fail(`--port must be a number from 1024 to 65535 (got "${value}").`);
}

await import("../dist-server/main.mjs");
