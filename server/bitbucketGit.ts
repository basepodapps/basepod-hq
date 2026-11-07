// Git work HQ does on the host for sandboxed agents, because their sandbox has no
// Bitbucket access (and must not get credentials).
//
// The rule that keeps this safe: an agent's folder is untrusted. It is mounted into
// the sandbox, so the agent can write anything in it, including .git/config and
// .git/hooks. So HQ never runs git *inside* an agent folder. It only
//   - fetches FROM an agent folder into the user's own repo (the direction git is
//     built to treat as untrusted; hooks and repo config are not executed), and
//   - hands data TO an agent as a file (a bundle) that the agent applies itself,
//     inside its sandbox.
// Before fetching, the folder must be a real repository: a plain .git folder, no
// symlink, no gitfile pointing at a host path, no alternates borrowing host objects.

import { existsSync, lstatSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentWrite } from "./lib/agentFs";
import { run } from "./lib/exec";
import { excludeFromGit } from "./agentFiles";

const GIT_ENV = { GIT_TERMINAL_PROMPT: "0" };
const git = (cwd: string, args: string[], timeoutMs = 120_000) => run("git", args, { cwd, timeoutMs, env: GIT_ENV });

const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._-]*(\/[A-Za-z0-9][A-Za-z0-9._-]*)+$/;

/** An agent's branch: `<something>/<something>`, plain characters only. (A bare `main` has no slash, so it never passes.) */
export function cleanBranch(raw: string): string {
  const b = raw.trim();
  if (!BRANCH.test(b) || b.includes("..") || b.endsWith(".lock") || b.length > 120) throw new Error(`"${raw}" isn't a branch name HQ will push. Use something like <your-id>/<TASK-ID>-short-name.`);
  return b;
}

/** Refuses a folder whose .git isn't a plain directory or that borrows objects from elsewhere. */
export function assertPlainRepo(dir: string) {
  let st;
  try {
    st = lstatSync(join(dir, ".git"));
  } catch {
    throw new Error(`${dir} isn't a git repository.`);
  }
  if (!st.isDirectory()) throw new Error("This folder's .git isn't a plain directory (a symlink or gitfile). HQ won't push from it.");
  if (existsSync(join(dir, ".git", "objects", "info", "alternates"))) throw new Error("This repository borrows objects from another location. HQ won't push from it.");
}

/** The repo's default branch as the remote reports it (origin/HEAD), else "main". */
export async function defaultBranch(root: string): Promise<string> {
  const r = await git(root, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], 10_000);
  const name = r.ok ? r.stdout.trim().replace(/^origin\//, "") : "";
  return /^[A-Za-z0-9._/-]+$/.test(name) ? name : "main";
}

/**
 * Pushes the agent's branch to Bitbucket from the user's repo, with the user's own
 * git credentials. Never forces. The temporary ref is removed afterwards.
 */
export async function pushAgentBranch(root: string, agentDir: string, agentId: string, branch: string): Promise<void> {
  assertPlainRepo(agentDir);
  const tmp = `refs/hq-submit/${agentId.replace(/[^A-Za-z0-9_-]/g, "_")}`;
  const fetched = await git(root, ["fetch", "--quiet", "--no-tags", "--no-write-fetch-head", "--no-recurse-submodules", agentDir, `+refs/heads/${branch}:${tmp}`]);
  if (!fetched.ok) throw new Error(`Couldn't read branch ${branch} from your folder. Commit your work on that branch first. (${fetched.stderr.trim().split("\n")[0]})`);
  try {
    const pushed = await git(root, ["push", "--quiet", "origin", `${tmp}:refs/heads/${branch}`]);
    if (!pushed.ok) throw new Error(`git push to Bitbucket failed: ${pushed.stderr.trim().split("\n").slice(-2).join(" ")}`);
  } finally {
    await git(root, ["update-ref", "-d", tmp], 10_000);
  }
}

/**
 * Fetches the base branch on the host and writes it into the agent's folder as a
 * bundle. The agent applies it itself:
 *   git fetch .hq/main.bundle +refs/remotes/origin/<base>:refs/remotes/origin/<base>
 */
export async function writeBaseBundle(root: string, agentDir: string, base: string): Promise<string> {
  const ref = `refs/remotes/origin/${base}`;
  const fetched = await git(root, ["fetch", "--quiet", "--no-tags", "origin", `+refs/heads/${base}:${ref}`]);
  if (!fetched.ok) throw new Error(`Couldn't fetch ${base} from Bitbucket: ${fetched.stderr.trim().split("\n")[0]}`);
  const dir = mkdtempSync(join(tmpdir(), "hq-bundle-"));
  try {
    const file = join(dir, "main.bundle");
    const made = await git(root, ["bundle", "create", "--quiet", file, ref]);
    if (!made.ok) throw new Error(`Couldn't bundle ${base}: ${made.stderr.trim().split("\n")[0]}`);
    agentWrite(agentDir, ".hq/main.bundle", readFileSync(file));
    excludeFromGit(agentDir, [".hq/"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return `git fetch .hq/main.bundle +${ref}:${ref}`;
}
