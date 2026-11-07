// Installs a packed basepod-hq tarball into an empty folder like a new user would,
// then checks the parts that differ by OS: the terminal library loads and can
// spawn, and HQ starts on a fresh repo and serves the page and a snapshot.
//
//   node scripts/smoke-test.mjs <path/to/package.tgz> [port]

import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

const tarball = resolve(process.argv[2] ?? "");
const port = Number(process.argv[3] ?? 7431);
const win = process.platform === "win32";
const work = mkdtempSync(join(tmpdir(), "jsmhq-smoke-"));
const app = join(work, "app");
const repo = join(work, "jsmhq-smoke-repo"); // also HQ's project id → ~/.jsmhq/jsmhq-smoke-repo
let hq = null;

const sh = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, stdio: "pipe", shell: win, encoding: "utf8" });
const step = (msg) => console.log(`• ${msg}`);
function fail(msg) {
  console.error(`✗ ${msg}`);
  cleanup();
  process.exit(1);
}
function cleanup() {
  if (hq && hq.exitCode === null) {
    if (win) spawnSyncKill(hq.pid);
    else hq.kill("SIGTERM");
  }
  try {
    rmSync(join(homedir(), ".jsmhq", "jsmhq-smoke-repo"), { recursive: true, force: true });
    rmSync(work, { recursive: true, force: true });
  } catch {
    /* Windows may still hold a file; the runner is thrown away anyway */
  }
}
function spawnSyncKill(pid) {
  try {
    execFileSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
  } catch {
    /* already gone */
  }
}

// 1. Install the tarball into an empty folder.
step(`installing ${tarball}`);
mkdirSync(app);
writeFileSync(join(app, "package.json"), '{ "name": "smoke", "private": true }\n');
try {
  sh("npm", ["install", "--no-audit", "--no-fund", tarball], app);
} catch (e) {
  fail(`npm install failed:\n${e.stdout ?? ""}${e.stderr ?? ""}`);
}
const pkgRoot = join(app, "node_modules", "@basepodapps", "basepod-hq");
const bin = join(pkgRoot, "bin", "basepod-hq.mjs");
step(`version ${sh(process.execPath, [bin, "--version"]).trim()}`);

// 2. The terminal library loads its prebuilt binary and can spawn a process.
const req = createRequire(join(pkgRoot, "package.json"));
const pty = req("@lydell/node-pty");
await new Promise((done) => {
  const p = pty.spawn(process.execPath, ["-e", "console.log('pty-ok')"], { cols: 80, rows: 10 });
  let out = "";
  p.onData((d) => (out += d));
  p.onExit(() => (out.includes("pty-ok") ? done() : fail(`pty spawn printed: ${JSON.stringify(out)}`)));
  setTimeout(() => fail("pty spawn timed out"), 15_000);
});
step("terminal library spawns processes");

// 3. A fresh repo, and HQ started on it.
mkdirSync(repo);
sh("git", ["init", "-q", "-b", "main"], repo);
writeFileSync(join(repo, "README.md"), "# smoke\n");
sh("git", ["add", "."], repo);
sh("git", ["-c", "user.name=smoke", "-c", "user.email=smoke@example.com", "commit", "-qm", "init"], repo);

hq = spawn(process.execPath, [bin, "--repo", repo, "--port", String(port), "--no-open"], { stdio: ["ignore", "pipe", "pipe"] });
let log = "";
const token = await new Promise((done) => {
  const onData = (d) => {
    log += d;
    const m = log.match(/token=([a-f0-9]+)/);
    if (m) done(m[1]);
  };
  hq.stdout.on("data", onData);
  hq.stderr.on("data", onData);
  hq.on("exit", (code) => fail(`HQ exited early (code ${code}):\n${log}`));
  setTimeout(() => fail(`HQ didn't start in 60s:\n${log}`), 60_000);
});
hq.removeAllListeners("exit");
step("HQ started");

const page = await fetch(`http://127.0.0.1:${port}/?token=${token}`);
const html = await page.text();
if (!page.ok || !html.includes("<div id=")) fail(`page: HTTP ${page.status}`);
step("page served");

const WebSocket = req("ws");
const snap = await new Promise((done) => {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${token}`, { headers: { Origin: `http://127.0.0.1:${port}` } });
  ws.on("message", (raw) => {
    const e = JSON.parse(String(raw));
    if (e.type === "snapshot") {
      ws.close();
      done(e.snapshot);
    }
  });
  ws.on("error", (err) => fail(`websocket: ${err.message}`));
  setTimeout(() => fail("no snapshot in 15s"), 15_000);
});
if (snap.welcome !== true) fail("expected the welcome screen on a fresh repo");
step(`snapshot ok (welcome, ${snap.setup.checks.length} setup checks)`);
for (const c of snap.setup.checks) console.log(`    ${c.status === "ok" ? "✓" : c.status === "warning" ? "!" : "✗"} ${c.label}: ${c.detail}`);

cleanup();
console.log("✓ smoke test passed");
process.exit(0);
