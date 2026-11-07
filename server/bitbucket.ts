// Bitbucket Cloud: the same job github.ts does for GitHub, over the REST API 2.0.
//
// HQ (on the host) talks to Bitbucket. Agents never do: they have no Bitbucket
// credentials in their sandbox. They ask HQ through the Team MCP to push a
// branch, open a PR, merge, or read review comments (see bitbucketGit.ts, mcp.ts).
//
// Credentials live in ~/.jsmhq/bitbucket.json: {"user": "...", "token": "..."}
//   - Atlassian API token: user = your Atlassian account email
//   - App password:        user = your Bitbucket username
// HQ only reads this file. It is never copied into an agent's folder or sandbox.

import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ReviewTool } from "../src/data/types";
import type { GhPr } from "./github";
import { RateLimited } from "./github";

/** Tests may point this at a local fake. Only a loopback address is honoured, so a stray variable can't send the token elsewhere. */
export function apiBase(): string {
  const o = process.env.HQ_BITBUCKET_API;
  try {
    if (o && ["127.0.0.1", "localhost"].includes(new URL(o).hostname)) return o.replace(/\/$/, "");
  } catch {
    /* ignore */
  }
  return "https://api.bitbucket.org/2.0";
}

export const CREDENTIALS_FILE = join(homedir(), ".jsmhq", "bitbucket.json");

/** Bitbucket Cloud allows roughly 1,000 API requests an hour; HQ stays well under that. */
export const BITBUCKET_BUDGET = 600;

// ---------------------------------------------------------------- credentials

export interface Credentials {
  user: string;
  token: string;
}

export function loadCredentials(file = CREDENTIALS_FILE): Credentials | null {
  try {
    if (!existsSync(file)) return null;
    const j = JSON.parse(readFileSync(file, "utf8")) as Partial<Credentials>;
    return j.user && j.token ? { user: String(j.user), token: String(j.token) } : null;
  } catch {
    return null;
  }
}

/** True when other users on this machine can read the credentials file. */
export function credentialsTooOpen(file = CREDENTIALS_FILE): boolean {
  try {
    return process.platform !== "win32" && (statSync(file).mode & 0o077) !== 0;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- HTTP

const enc = (slug: string) => slug.split("/").map(encodeURIComponent).join("/");

async function call(method: "GET" | "POST", path: string, body?: unknown): Promise<unknown> {
  const creds = loadCredentials();
  if (!creds) throw new Error(`No Bitbucket credentials. Create ${CREDENTIALS_FILE} (see docs/bitbucket.md).`);
  const res = await fetch(`${apiBase()}${path}`, {
    method,
    headers: {
      Authorization: "Basic " + Buffer.from(`${creds.user}:${creds.token}`).toString("base64"),
      Accept: "application/json",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20_000),
  });
  if (res.status === 429) {
    const wait = Number(res.headers.get("retry-after"));
    throw new RateLimited(new Date(Date.now() + (Number.isFinite(wait) && wait > 0 ? wait * 1000 : 120_000)));
  }
  const text = await res.text();
  if (!res.ok) {
    let detail = "";
    try {
      detail = (JSON.parse(text) as { error?: { message?: string } }).error?.message ?? "";
    } catch {
      /* not JSON */
    }
    if (res.status === 401) throw new Error("Bitbucket rejected the credentials (401). Check user and token in " + CREDENTIALS_FILE);
    if (res.status === 403) throw new Error(`Bitbucket says the token can't do that (403${detail ? `: ${detail}` : ""}). It needs pull request and repository read/write scopes.`);
    throw new Error(`Bitbucket ${res.status}${detail ? `: ${detail}` : ""}`);
  }
  return text ? JSON.parse(text) : {};
}

// ---------------------------------------------------------------- shapes (the parts HQ reads)

export interface BbParticipant {
  role?: string;
  approved?: boolean;
  state?: string | null; // "approved" | "changes_requested" | null
  participated_on?: string | null;
  user?: { nickname?: string; display_name?: string };
}

export interface BbPr {
  id: number;
  title: string;
  state: string; // OPEN | MERGED | DECLINED | SUPERSEDED
  draft?: boolean;
  created_on: string;
  updated_on: string;
  links?: { html?: { href?: string } };
  source?: { branch?: { name?: string } };
  destination?: { branch?: { name?: string } };
  participants?: BbParticipant[];
}

export interface BbComment {
  id: number;
  deleted?: boolean;
  parent?: { id: number };
  resolution?: unknown; // set once a thread is resolved
  content?: { raw?: string };
  user?: { nickname?: string; display_name?: string };
  inline?: { path?: string; to?: number | null; from?: number | null; outdated?: boolean };
}

export interface BbStatus {
  key?: string;
  name?: string;
  state?: string; // SUCCESSFUL | FAILED | INPROGRESS | STOPPED
  description?: string | null;
}

// ---------------------------------------------------------------- mapping to HQ's PR shape (pure)

const login = (u?: { nickname?: string; display_name?: string }) => u?.nickname || u?.display_name || "";

/** Inline (code review) comments that start a thread. Replies and deleted comments don't count. */
const threadStarters = (comments: BbComment[]) => comments.filter((c) => c.inline && !c.parent && !c.deleted);

const STATUS_STATE: Record<string, string> = { SUCCESSFUL: "SUCCESS", FAILED: "FAILURE", STOPPED: "FAILURE", INPROGRESS: "PENDING" };

/** A Bitbucket PR plus its comments and build statuses, in the shape github.ts's review logic reads. */
export function toGhPr(pr: BbPr, comments: BbComment[] = [], statuses: BbStatus[] = []): GhPr {
  const people = pr.participants ?? [];
  const changes = people.some((p) => p.state === "changes_requested");
  const approved = people.some((p) => p.approved || p.state === "approved");
  const decided = people.filter((p) => p.approved || p.state === "approved" || p.state === "changes_requested");
  const ctx = statuses.map((s) => ({
    __typename: "StatusContext" as const,
    context: s.name || s.key || "",
    state: STATUS_STATE[s.state ?? ""] ?? "PENDING",
    description: s.description ?? null,
  }));
  return {
    number: pr.id,
    title: pr.title,
    url: pr.links?.html?.href ?? "",
    headRefName: pr.source?.branch?.name ?? "",
    createdAt: pr.created_on,
    mergedAt: pr.state === "MERGED" ? pr.updated_on : null,
    state: pr.state === "OPEN" ? "OPEN" : pr.state === "MERGED" ? "MERGED" : "CLOSED",
    // The list API doesn't say. Not guessing "CONFLICTING" keeps HQ from sending agents on false alarms.
    mergeable: "UNKNOWN",
    isDraft: !!pr.draft,
    // Bitbucket hides "Request changes" from a PR's author, and agents open PRs with the owner's token,
    // so a solo owner can never click it. An open inline comment therefore counts as changes requested.
    reviewDecision: changes ? "CHANGES_REQUESTED" : approved ? "APPROVED" : openComments(comments).length ? "CHANGES_REQUESTED" : null,
    reviews: {
      nodes: decided.map((p) => ({
        author: { login: login(p.user) },
        state: p.state === "changes_requested" ? "CHANGES_REQUESTED" : "APPROVED",
        submittedAt: p.participated_on ?? pr.updated_on,
      })),
    },
    reviewThreads: {
      nodes: threadStarters(comments).map((c) => ({
        isResolved: !!c.resolution,
        isOutdated: !!c.inline?.outdated,
        comments: { nodes: [{ author: { login: login(c.user) } }] },
      })),
    },
    commits: { nodes: ctx.length ? [{ commit: { statusCheckRollup: { contexts: { nodes: ctx } } } }] : [] },
  };
}

export interface ReviewComment {
  file: string;
  line: number | null;
  author: string;
  text: string;
}

/** Open review threads, for the agent that has to fix them. */
export function openComments(comments: BbComment[]): ReviewComment[] {
  return threadStarters(comments)
    .filter((c) => !c.resolution && !c.inline?.outdated)
    .map((c) => ({
      file: c.inline?.path ?? "",
      line: c.inline?.to ?? c.inline?.from ?? null,
      author: login(c.user),
      text: (c.content?.raw ?? "").slice(0, 1500),
    }));
}

// ---------------------------------------------------------------- reads

interface Page<T> {
  values?: T[];
}

const prs = (slug: string) => `/repositories/${enc(slug)}/pullrequests`;

export async function listComments(slug: string, number: number): Promise<BbComment[]> {
  const page = (await call("GET", `${prs(slug)}/${number}/comments?pagelen=100`)) as Page<BbComment>;
  return page.values ?? [];
}

async function listStatuses(slug: string, number: number): Promise<BbStatus[]> {
  const page = (await call("GET", `${prs(slug)}/${number}/statuses?pagelen=50`)) as Page<BbStatus>;
  return page.values ?? [];
}

/**
 * Open PRs (with comments, and build statuses when a review bot is in use), a few
 * recently merged PRs, and the numbers of recently declined ones. One list call per
 * state, plus one or two calls per open PR.
 */
export async function fetchPrs(slug: string, tool: ReviewTool = "human") {
  const list = (state: string, n: number) => call("GET", `${prs(slug)}?state=${state}&pagelen=${n}&sort=-updated_on`) as Promise<Page<BbPr>>;
  const [open, merged, declined] = await Promise.all([list("OPEN", 20), list("MERGED", 10), list("DECLINED", 10)]);
  const wantStatuses = tool !== "human" && tool !== "custom";
  let requests = 3;
  const full = await Promise.all(
    (open.values ?? []).map(async (pr) => {
      requests += wantStatuses ? 2 : 1;
      const [comments, statuses] = await Promise.all([listComments(slug, pr.id), wantStatuses ? listStatuses(slug, pr.id) : Promise.resolve([])]);
      return toGhPr(pr, comments, statuses);
    }),
  );
  return {
    open: full,
    merged: (merged.values ?? []).map((pr) => toGhPr(pr)),
    closed: (declined.values ?? []).map((pr) => pr.id),
    // Not a GraphQL budget; `cost` is how many requests this poll made, so the sync paces itself.
    rate: { cost: requests, remaining: Number.MAX_SAFE_INTEGER, resetAt: "" },
  };
}

/** Checks the token can see the repository. Returns an error message, or null when fine. */
export async function checkAccess(slug: string): Promise<string | null> {
  try {
    await call("GET", `/repositories/${enc(slug)}`);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

// ---------------------------------------------------------------- writes (on behalf of agents)

export interface OpenedPr {
  number: number;
  url: string;
  created: boolean;
}

/** Opens a PR for `source` into `destination`, or returns the one already open for that branch. */
export async function openOrFindPr(slug: string, o: { title: string; description: string; source: string; destination: string }): Promise<OpenedPr> {
  const q = encodeURIComponent(`source.branch.name="${o.source}" AND state="OPEN"`);
  const existing = (await call("GET", `${prs(slug)}?q=${q}&pagelen=1`)) as Page<BbPr>;
  const found = existing.values?.[0];
  if (found) return { number: found.id, url: found.links?.html?.href ?? "", created: false };
  const made = (await call("POST", prs(slug), {
    title: o.title,
    description: o.description,
    source: { branch: { name: o.source } },
    destination: { branch: { name: o.destination } },
    close_source_branch: true,
  })) as BbPr;
  return { number: made.id, url: made.links?.html?.href ?? "", created: true };
}

/** Squash-merges a PR and deletes its branch (what `gh pr merge --squash --delete-branch` does). */
export async function mergePr(slug: string, number: number): Promise<void> {
  await call("POST", `${prs(slug)}/${number}/merge`, { merge_strategy: "squash", close_source_branch: true });
}
