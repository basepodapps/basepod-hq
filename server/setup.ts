// The setup checklist: what this machine has, and how to fix what's missing.

import { existsSync, readFileSync } from "node:fs";
import { arch, cpus, platform, release, totalmem } from "node:os";
import type { AgentConfig, SetupCheck, SetupFix, SetupState } from "../src/data/types";
import { usesTmux } from "./backends";
import { parseCliJson, sandboxList } from "./lib/json";
import { has, run } from "./lib/exec";
import { checkAccess, CREDENTIALS_FILE, credentialsTooOpen, loadCredentials } from "./bitbucket";
import type { RepoInfo } from "./repo";

const SBX_DOCS = "https://docs.docker.com/ai/sandboxes/install/";
const os = platform();

type Check = Omit<SetupCheck, "fix"> & { fix: SetupFix | null };

const fix = (command: string, runnable: boolean, docs: string | null): SetupFix => ({ command, runnable, docs });

async function checkOs(): Promise<Check> {
  const base = { id: "os" as const, label: "Machine supports sandboxes", neededFor: "sandbox" as const, fix: fix("", false, SBX_DOCS) };
  if (os === "darwin") {
    const v = (await run("sw_vers", ["-productVersion"])).stdout.trim();
    const major = Number(v.split(".")[0]);
    if (arch() !== "arm64") return { ...base, status: "unsupported", detail: `macOS ${v} on Intel. Sandboxes need Apple silicon — use Local mode.` };
    if (major < 14) return { ...base, status: "unsupported", detail: `macOS ${v}. Sandboxes need macOS 14 (Sonoma) or later.` };
    return { ...base, status: "ok", detail: `macOS ${v} · Apple silicon`, fix: null };
  }
  if (os === "win32") {
    const build = Number(release().split(".")[2] ?? 0);
    return build >= 22000
      ? { ...base, status: "ok", detail: "Windows 11 (needs Windows Hypervisor Platform enabled)", fix: null }
      : { ...base, status: "unsupported", detail: "Windows 10. Sandboxes need Windows 11 — use Local mode." };
  }
  const osRelease = existsSync("/etc/os-release") ? readFileSync("/etc/os-release", "utf8") : "";
  const id = osRelease.match(/^ID=(.*)$/m)?.[1]?.replace(/"/g, "");
  const ver = Number(osRelease.match(/^VERSION_ID="?([\d.]+)/m)?.[1] ?? 0);
  if (id === "ubuntu" && ver >= 24.04) return { ...base, status: "ok", detail: `Ubuntu ${ver} (needs KVM)`, fix: null };
  return { ...base, status: "warning", detail: `${id ?? "Linux"} ${ver || ""} — Docker documents Ubuntu 24.04+ with KVM.` };
}

async function checkSbx(brew: boolean): Promise<Check> {
  const base = { id: "sbx" as const, label: "Docker Sandboxes (sbx)", neededFor: "sandbox" as const };
  const v = await run("sbx", ["version"], { timeoutMs: 8000 });
  if (v.ok) return { ...base, status: "ok", detail: v.stdout.trim().split(/\s+/)[2] ?? v.stdout.trim(), fix: null };
  const cmd =
    os === "darwin" ? "brew trust docker/tap && brew install docker/tap/sbx"
    : os === "win32" ? "winget install -h Docker.sbx"
    : "curl -fsSL https://get.docker.com | sudo SBX=1 sh";
  const runnable = os === "darwin" ? brew : os === "win32";
  return { ...base, status: "missing", detail: "Not installed.", fix: fix(cmd, runnable, SBX_DOCS) };
}

/** sbx's error when its base network policy was never chosen (fresh install). */
export const POLICY_NOT_INITIALIZED = /not been initialized|sbx policy init/i;

/**
 * `sbx policy check network <host>`: "allowed", "denied", or null when sbx gave no verdict.
 * Newer sbx (0.50+) may print the verdict on stderr and add terminal escape codes, so both
 * streams are read with the codes removed.
 */
export async function policyVerdict(host: string): Promise<{ verdict: "allowed" | "denied" | null; out: string }> {
  const r = await run("sbx", ["policy", "check", "network", host], { timeoutMs: 10_000 });
  // eslint-disable-next-line no-control-regex
  const out = `${r.stdout}\n${r.stderr}`.replace(/\x1b(\[[0-9;?]*[ -\/]*[@-~]|\][^\x07\x1b]*(\x07|\x1b\\)|[@-_])/g, "");
  const m = out.match(/\b(Allowed|Denied):/);
  return { verdict: m ? (m[1] === "Allowed" ? "allowed" : "denied") : null, out };
}

/**
 * A fresh sbx needs a base network policy (`sbx policy init`) before any rule
 * can be added or a sandbox started. HQ suggests one but never picks it.
 */
async function checkSbxPolicy(loginOk: boolean): Promise<Check> {
  const base = { id: "sbx-policy" as const, label: "Sandbox network policy", neededFor: "sandbox" as const };
  if (!loginOk) return { ...base, status: "missing", detail: "Waiting for Docker sign-in.", fix: null };
  const { verdict, out } = await policyVerdict("registry.npmjs.org");
  if (POLICY_NOT_INITIALIZED.test(out))
    return {
      ...base,
      status: "missing",
      detail:
        "Not set yet. Choose what sandboxes can reach once: balanced (recommended: AI services, package registries, GitHub), allow-all, or deny-all. Change it later with sbx policy reset.",
      fix: fix("sbx policy init balanced", true, SBX_DOCS),
    };
  if (!verdict) return { ...base, status: "warning", detail: out.trim().split("\n")[0] || "sbx did not respond.", fix: fix("sbx diagnose", true, SBX_DOCS) };
  const open = (await policyVerdict("hq-probe.invalid")).verdict === "allowed";
  const name = open ? "Allow all" : verdict === "allowed" ? "Balanced" : "Deny all";
  return { ...base, status: "ok", detail: `${name}. HQ adds only the rule that lets sandboxes reach it.`, fix: null };
}

async function checkSbxLogin(sbxOk: boolean): Promise<Check> {
  const base = { id: "sbx-login" as const, label: "Signed in to Docker", neededFor: "sandbox" as const };
  if (!sbxOk) return { ...base, status: "missing", detail: "Waiting for sbx.", fix: null };
  const r = await run("sbx", ["ls", "--json"], { timeoutMs: 10_000 });
  const list = r.ok ? sandboxList<unknown>(r.stdout) : null;
  // The command worked, so you're signed in; an unreadable list only loses the count (never block Start on it).
  if (r.ok) {
    const n = list?.length;
    return { ...base, status: "ok", detail: n === undefined ? "Signed in" : `Signed in · ${n} sandbox${n === 1 ? "" : "es"} on this machine`, fix: null };
  }
  const msg = (r.stderr || r.stdout).trim();
  const loggedOut = /log ?in|sign ?in|unauthori[sz]ed|not authenticated/i.test(msg);
  return {
    ...base,
    status: loggedOut ? "missing" : "warning",
    detail: loggedOut ? "Not signed in. Sign-in opens your browser." : msg.split("\n")[0] || "sbx did not respond.",
    fix: fix(loggedOut ? "sbx login" : "sbx diagnose", true, SBX_DOCS),
  };
}

async function checkTmux(brew: boolean): Promise<Check> {
  const base = { id: "tmux" as const, label: "tmux (keeps agents running if HQ closes)", neededFor: "all" as const };
  if (!usesTmux())
    return { ...base, label: "Agent sessions", status: "ok", detail: "HQ runs agents itself on Windows (no tmux needed). They stop when HQ stops; sandboxes and folders are kept.", fix: null };
  const v = await run("tmux", ["-V"], { timeoutMs: 5000 });
  if (v.ok) return { ...base, status: "ok", detail: v.stdout.trim(), fix: null };
  if (os === "win32") return { ...base, status: "unsupported", detail: "tmux needs WSL on Windows. Run HQ inside WSL.", fix: fix("wsl --install", false, "https://learn.microsoft.com/windows/wsl/install") };
  return {
    ...base,
    status: "missing",
    detail: "Not installed.",
    fix: os === "darwin" ? fix("brew install tmux", brew, "https://github.com/tmux/tmux/wiki/Installing") : fix("sudo apt install tmux", false, "https://github.com/tmux/tmux/wiki/Installing"),
  };
}

async function checkClaude(): Promise<Check> {
  const base = { id: "claude" as const, label: "Claude Code (for Local mode)", neededFor: "local" as const };
  const v = await run("claude", ["--version"], { timeoutMs: 8000 });
  if (v.ok) return { ...base, status: "ok", detail: v.stdout.trim(), fix: null };
  return {
    ...base,
    status: "missing",
    detail: "Not installed. Only needed for agents in Local mode.",
    fix: fix(os === "win32" ? "irm https://claude.ai/install.ps1 | iex" : "curl -fsSL https://claude.ai/install.sh | bash", false, "https://docs.claude.com/en/docs/claude-code/setup"),
  };
}

async function checkGh(brew: boolean): Promise<Check> {
  const base = { id: "gh" as const, label: "GitHub CLI (reads PRs and reviews)", neededFor: "github" as const };
  if (!(await has("gh")))
    return {
      ...base,
      status: "missing",
      detail: "Not installed.",
      fix: fix(os === "darwin" ? "brew install gh" : os === "win32" ? "winget install --id GitHub.cli" : "sudo apt install gh", os === "darwin" ? brew : os === "win32", "https://cli.github.com"),
    };
  const r = await run("gh", ["auth", "status"], { timeoutMs: 10_000 });
  const out = r.stdout + r.stderr;
  if (r.ok) return { ...base, status: "ok", detail: `Signed in as ${out.match(/account (\S+)/)?.[1] ?? "you"}`, fix: null };
  return { ...base, status: "missing", detail: "Not signed in.", fix: fix("gh auth login", true, "https://cli.github.com/manual/gh_auth_login") };
}

function checkRemote(repo: RepoInfo): Check {
  const base = { id: "gh-remote" as const, label: "GitHub remote", neededFor: "github" as const };
  if (repo.github) return { ...base, status: "ok", detail: repo.github, fix: null };
  return {
    ...base,
    status: "warning",
    detail: repo.originUrl ? `origin is ${repo.originUrl} (not GitHub)` : "No origin remote. Agents can't push or open PRs.",
    fix: fix("gh repo create --source . --private --push", false, "https://cli.github.com/manual/gh_repo_create"),
  };
}

// Bitbucket projects: HQ itself reads PRs with an API token, and does the git push and
// PR calls for the agents. The agents need nothing from Bitbucket inside their sandbox.
async function checkBitbucket(repo: RepoInfo): Promise<Check> {
  const base = { id: "bb" as const, label: "Bitbucket API token (reads PRs and reviews)", neededFor: "github" as const };
  if (!repo.bitbucket) return { ...base, status: "missing", detail: "Needs a Bitbucket Cloud remote first.", fix: null };
  if (!loadCredentials())
    return {
      ...base,
      status: "missing",
      detail: `No credentials in ${CREDENTIALS_FILE}. Create an Atlassian API token (or an app password) with pull request and repository access.`,
      fix: fix(
        `mkdir -p ~/.jsmhq && printf '{"user":"YOUR_EMAIL_OR_USERNAME","token":"YOUR_TOKEN"}' > ~/.jsmhq/bitbucket.json && chmod 600 ~/.jsmhq/bitbucket.json`,
        false,
        "https://id.atlassian.com/manage-profile/security/api-tokens",
      ),
    };
  const err = await checkAccess(repo.bitbucket);
  if (err) return { ...base, status: "warning", detail: err, fix: null };
  if (credentialsTooOpen()) return { ...base, status: "warning", detail: `Works, but ${CREDENTIALS_FILE} is readable by other users.`, fix: fix(`chmod 600 ${CREDENTIALS_FILE}`, false, null) };
  return { ...base, status: "ok", detail: `${repo.bitbucket} reachable`, fix: null };
}

function checkBitbucketRemote(repo: RepoInfo): Check {
  const base = { id: "bb-remote" as const, label: "Bitbucket remote", neededFor: "github" as const };
  if (repo.bitbucket) return { ...base, status: "ok", detail: repo.bitbucket, fix: null };
  return { ...base, status: "warning", detail: repo.originUrl ? `origin is ${repo.originUrl} (not Bitbucket Cloud)` : "No origin remote.", fix: null };
}

async function checkGithubSecret(sbxOk: boolean): Promise<Check> {
  const base = { id: "github-secret" as const, label: "GitHub access inside sandboxes", neededFor: "sandbox" as const };
  if (!sbxOk) return { ...base, status: "missing", detail: "Waiting for sbx.", fix: null };
  const r = await run("sbx", ["secret", "ls"], { timeoutMs: 10_000 });
  if (r.ok && /\bgithub\b/.test(r.stdout)) return { ...base, status: "ok", detail: "Stored in Docker's secret store; injected by the proxy.", fix: null };
  return {
    ...base,
    status: "missing",
    detail: "Agents can't push or open PRs until this is set.",
    fix: fix("sbx secret set github --command 'gh auth token'", true, "https://docs.docker.com/ai/sandboxes/get-started/"),
  };
}

async function checkCodex(): Promise<Check> {
  const base = { id: "codex" as const, label: "Codex (for Codex agents in Local mode)", neededFor: "local" as const };
  const v = await run("codex", ["--version"], { timeoutMs: 8000 });
  if (v.ok) return { ...base, status: "ok", detail: v.stdout.trim(), fix: null };
  return { ...base, status: "missing", detail: "Not installed. Only needed for Codex agents in Local mode (sandboxes have it).", fix: fix("npm install -g @openai/codex", false, "https://developers.openai.com/codex/cli") };
}

async function checkOpenAiSecret(sbxOk: boolean): Promise<Check> {
  const base = { id: "openai-secret" as const, label: "OpenAI sign-in for Codex agents", neededFor: "sandbox" as const };
  if (!sbxOk) return { ...base, status: "missing", detail: "Waiting for sbx.", fix: null };
  const r = await run("sbx", ["secret", "ls", "--json"], { timeoutMs: 10_000 });
  let has = false;
  try {
    has = (parseCliJson<{ secrets?: { name: string; scope: string }[] }>(r.stdout)?.secrets ?? []).some((s) => s.name === "openai" && s.scope === "global");
  } catch {
    /* sbx down */
  }
  if (has) return { ...base, status: "ok", detail: "Stored in Docker's secret store.", fix: null };
  return { ...base, status: "missing", detail: "Codex agents can't sign in until this is set. Opens your browser to sign in with ChatGPT.", fix: fix("sbx secret set openai --oauth", true, "https://docs.docker.com/ai/sandboxes/") };
}

/** `team` adds the Codex checks only when the team has Codex agents. */
export async function runSetupChecks(repo: RepoInfo, team: AgentConfig[] = []): Promise<SetupState> {
  const brew = os === "darwin" && (await has("brew"));
  const bitbucket = repo.provider === "bitbucket";
  const [osCheck, sbx, tmux, claude, gh] = await Promise.all([checkOs(), checkSbx(brew), checkTmux(brew), checkClaude(), bitbucket ? Promise.resolve(null) : checkGh(brew)]);
  const sbxOk = sbx.status === "ok";
  const [login, secret] = await Promise.all([checkSbxLogin(sbxOk), bitbucket ? Promise.resolve(null) : checkGithubSecret(sbxOk)]);
  const policy = await checkSbxPolicy(login.status === "ok");
  const checks: SetupCheck[] = bitbucket
    ? [osCheck, sbx, login, policy, tmux, claude, await checkBitbucket(repo), checkBitbucketRemote(repo)]
    : [osCheck, sbx, login, policy, secret!, tmux, claude, gh!, checkRemote(repo)];
  const codexAgents = team.filter((a) => a.cli === "codex");
  if (codexAgents.some((a) => a.mode === "sandbox")) checks.splice(checks.findIndex((c) => c.id === "tmux"), 0, await checkOpenAiSecret(sbxOk));
  if (codexAgents.some((a) => a.mode === "local")) checks.push(await checkCodex());
  const ok = (c: SetupCheck) => c.status === "ok";
  return {
    machine: { cpus: cpus().length, memoryGb: Math.round(totalmem() / 1024 ** 3), persistentAgents: usesTmux() },
    checks,
    sandboxReady: osCheck.status !== "unsupported" && ok(sbx) && ok(login) && ok(policy) && ok(tmux),
    localReady: ok(tmux) && ok(claude),
    checkedAt: new Date().toISOString(),
  };
}
