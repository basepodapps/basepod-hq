// Polls GitHub, keeps the office's PRs in sync, and runs the review automations:
// comments → tell the author; passed → tell the lead; merged → task done.

import type { PullRequest, ReviewTool } from "../src/data/types";
import { fetchPrs as fetchGithubPrs, branchAgent, OPEN_LIMIT, RateLimited, taskIdOf, toPullRequest } from "./github";
import { BITBUCKET_BUDGET, fetchPrs as fetchBitbucketPrs } from "./bitbucket";
import type { Hub } from "./hub";
import { log } from "./lib/log";
import type { Planner } from "./planner";

export type Provider = "github" | "bitbucket";

/** How the lead merges: GitHub has the `gh` CLI in its sandbox; Bitbucket goes through HQ's merge_pull_request tool. */
const MERGE = {
  github: { run: (n: number | string) => `run \`gh pr merge ${n} --squash --delete-branch\``, host: "GitHub" },
  bitbucket: { run: (n: number | string) => `call the merge_pull_request tool with number ${n}`, host: "Bitbucket" },
} as const;

/** What the lead is told when a PR passes review: merge it, or leave it to the user (Settings → Workflow → Merge). */
export function passedNotice(pr: Pick<PullRequest, "number" | "title">, author: string, by: "human" | "lead", provider: Provider = "github"): string {
  const head = `PR #${pr.number} (${pr.title}) by ${author} passed review.`;
  const m = MERGE[provider];
  return by === "lead"
    ? `${head} You merge PRs on this project: ${m.run(pr.number)} now. If ${m.host} refuses (conflicts or failing checks), ask the author to fix it instead. Then assign the next task if anything is waiting.`
    : `${head} It's ready for the user to merge. Don't merge it yourself.`;
}

/** What the lead is told when the user changes who merges, with the PRs already waiting. */
export function mergeByNotice(by: "human" | "lead", waiting: number[], provider: Provider = "github"): string {
  if (by === "human") return "The user changed the workflow: the user merges PRs now. Don't merge PRs yourself.";
  const list = waiting.length ? ` These passed review and are waiting: ${waiting.map((n) => `#${n}`).join(", ")}. Merge each: ${MERGE[provider].run("<number>")}.` : "";
  return `The user changed the workflow: you now merge PRs once they pass review.${list}`;
}

/** Where PRs are read from. GitHub: the user's `gh` login. Bitbucket: HQ's own API token. */
export interface PrSource {
  provider: Provider;
  name: string;
  /** The setup check that must be "ok" before polling. */
  checkId: "gh" | "bb";
  /** How many API calls HQ may spend per hour; the rest is left for agents (GitHub) or the rate limit (Bitbucket). */
  budget: number;
  fetch: (repo: string, tool: ReviewTool) => ReturnType<typeof fetchGithubPrs>;
}

export const githubSource: PrSource = { provider: "github", name: "GitHub", checkId: "gh", budget: 1200, fetch: (repo) => fetchGithubPrs(repo) };
export const bitbucketSource: PrSource = { provider: "bitbucket", name: "Bitbucket", checkId: "bb", budget: BITBUCKET_BUDGET, fetch: fetchBitbucketPrs };

const MIN_POLL_MS = 20_000; // never more often than this (nudges included)
const MAX_POLL_MS = 5 * 60_000;
const LOW_REMAINING = 800; // below this, poll at most every 2 minutes
const label = { coderabbit: "CodeRabbit", greptile: "Greptile", copilot: "Copilot", human: "The reviewer", custom: "The review check" } as const;

const wfTool = (hub: Hub): ReviewTool => hub.snap.config.workflow.review.tool;

export class GitHubSync {
  private prev = new Map<number, PullRequest>();
  private first = true;
  private timer: NodeJS.Timeout | null = null;
  private nudgeTimer: NodeJS.Timeout | null = null;
  private busy = false;
  private lastError: string | null = null;
  private lastFetch = 0;
  private interval = MIN_POLL_MS;
  private pausedUntil = 0;

  constructor(private hub: Hub, private planner: Planner, private repo: string | null, private source: PrSource = githubSource) {}

  start() {
    if (!this.repo) {
      log.warn(`No ${this.source.name} remote: PRs and reviews are off.`);
      return;
    }
    void this.tick();
    // Check sooner when an agent finishes a turn (it may have run `gh pr create`)
    // or reports a PR with set_my_status in-review.
    let reviewCfg = JSON.stringify(this.hub.snap.config.workflow.review);
    this.hub.subscribe((e) => {
      // A review-settings change re-labels existing PRs; take a fresh baseline
      // instead of treating that as new review activity.
      if (e.type === "config.updated" && JSON.stringify(e.config.workflow.review) !== reviewCfg) {
        reviewCfg = JSON.stringify(e.config.workflow.review);
        this.first = true;
        this.nudge(500);
      }
      if (e.type === "activity" && e.event.type === "agent.answered") this.nudge();
      if (e.type === "task.updated" && e.task.status === "in-review") this.nudge(1500);
    });
  }

  stop() {
    if (this.timer) clearTimeout(this.timer);
    if (this.nudgeTimer) clearTimeout(this.nudgeTimer);
  }

  /** One poll, then schedule the next at the current interval. */
  private async tick() {
    await this.refresh();
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.tick(), Math.max(this.interval, this.pausedUntil - Date.now()));
  }

  /** Refresh soon (debounced): an agent just opened a PR or finished a turn. Still respects the minimum gap and any pause. */
  nudge(delayMs = 3000) {
    if (!this.repo) return;
    if (this.nudgeTimer) clearTimeout(this.nudgeTimer);
    const wait = Math.max(delayMs, this.lastFetch + MIN_POLL_MS - Date.now(), this.pausedUntil - Date.now());
    this.nudgeTimer = setTimeout(() => void this.refresh(), wait);
  }

  /** Poll often enough to stay within HQ's share of the budget; slow down when it runs low. */
  private pace(rate: { cost: number; remaining: number } | null) {
    if (!rate) return;
    const forBudget = Math.ceil((Math.max(1, rate.cost) * 3_600_000) / this.source.budget);
    const low = rate.remaining < LOW_REMAINING ? 120_000 : 0;
    this.interval = Math.min(MAX_POLL_MS, Math.max(MIN_POLL_MS, forBudget, low));
  }

  async refresh() {
    if (!this.repo || this.busy || Date.now() < this.pausedUntil) return;
    // Never closer together than the minimum gap (a nudge can land right after a regular poll).
    if (Date.now() - this.lastFetch < MIN_POLL_MS - 1000) return;
    if (!this.hub.snap.setup.checks.find((c) => c.id === this.source.checkId && c.status === "ok")) return;
    this.busy = true;
    this.lastFetch = Date.now();
    try {
      const { open, merged, closed, rate } = await this.source.fetch(this.repo, wfTool(this.hub));
      if (this.lastError) log.info(`${this.source.name} reachable again`);
      this.lastError = null;
      this.pace(rate);
      const wf = this.hub.snap.config.workflow;
      const team = new Set(this.hub.snap.config.team.map((a) => a.id));
      const next = [...open, ...merged].map((gh) => {
        const taskId = taskIdOf(gh);
        const task = taskId ? this.planner.task(taskId) : undefined;
        const fromBranch = branchAgent(gh.headRefName);
        const authorId = task?.ownerId ?? (fromBranch && team.has(fromBranch) ? fromBranch : "");
        return toPullRequest(gh, wf.review.tool, wf.review.enabled, task?.id ?? taskId ?? "", authorId);
      });
      // PRs we showed as open that are now neither open nor recently merged were closed. A full page of
      // open PRs may have left older ones out, so then only the recently-closed list proves it.
      const seen = new Set(next.map((p) => p.number));
      const complete = open.length < OPEN_LIMIT;
      const recentlyClosed = new Set(closed);
      for (const old of this.prev.values())
        if (!seen.has(old.number) && !old.merged && !old.closed) next.push(complete || recentlyClosed.has(old.number) ? { ...old, closed: true } : old);

      for (const pr of next) {
        const old = this.prev.get(pr.number);
        if (JSON.stringify(old) !== JSON.stringify(pr)) this.hub.emit({ type: "pr.updated", pr: { ...pr } });
        if (!this.first) this.react(old, pr);
        this.syncTask(pr);
      }
      this.hub.snap.pullRequests = next;
      this.prev = new Map(next.map((p) => [p.number, p]));
      this.first = false;
    } catch (err) {
      if (err instanceof RateLimited) {
        this.pausedUntil = err.resetAt.getTime() + 5000;
        const at = err.resetAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
        const msg =
          this.source.provider === "github"
            ? `GitHub API rate limit reached (shared with your agents' gh commands). PR sync paused until ${at}.`
            : `Bitbucket API rate limit reached. PR sync paused until ${at}.`;
        if (msg !== this.lastError) {
          log.warn(msg);
          this.hub.activity("config", null, msg);
        }
        this.lastError = msg;
        return;
      }
      const msg = err instanceof Error ? err.message : String(err);
      if (msg !== this.lastError) log.warn(`${this.source.name}: ${msg}`);
      this.lastError = msg;
    } finally {
      this.busy = false;
    }
  }

  /** Keep the task board in line with its PR. */
  private syncTask(pr: PullRequest) {
    const task = pr.taskId ? this.planner.task(pr.taskId) : undefined;
    if (!task || pr.closed) return;
    if (pr.merged && task.status !== "done") this.planner.updateTask(task.id, { status: "done", prNumber: pr.number });
    else if (!pr.merged && (task.status === "todo" || task.status === "in-progress")) this.planner.updateTask(task.id, { status: "in-review", prNumber: pr.number });
    else if (!pr.merged && task.prNumber !== pr.number) this.planner.updateTask(task.id, { prNumber: pr.number });
  }

  private react(old: PullRequest | undefined, pr: PullRequest) {
    const hub = this.hub;
    const who = pr.authorId || null;
    const tool = label[hub.snap.config.workflow.review.tool];
    const lead = hub.snap.config.team.find((a) => a.isLead);
    const ref = `#${pr.number} ${pr.title}`;

    if (!old && !pr.merged && !pr.closed) hub.activity("pr.opened", who, `${hub.name(who)} opened PR ${ref}`);
    if (pr.closed && !old?.closed) return hub.activity("config", who, `PR #${pr.number} was closed without merging`);

    if (pr.merged && !old?.merged) {
      hub.activity("pr.merged", null, `PR ${ref} was merged`);
      if (lead) this.planner.notify(lead.id, `PR #${pr.number} (${pr.title}) was merged${pr.taskId ? `; ${pr.taskId} is done` : ""}. Assign the next task if anything is waiting.`);
      return;
    }
    if (pr.merged) return;

    if (pr.review === "reviewing" && old?.review !== "reviewing") hub.activity("review.started", null, `${tool} is reviewing #${pr.number}`);

    const newComments = pr.review === "changes-requested" && (old?.review !== "changes-requested" || pr.openComments > (old?.openComments ?? 0));
    if (newComments) {
      const n = pr.openComments;
      hub.activity("review.changes", who, `${tool} left ${n || "new"} comment${n === 1 ? "" : "s"} on #${pr.number}`);
      if (who)
        this.planner.notify(
          who,
          `${tool} reviewed your PR #${pr.number} (${pr.title}) and left ${n || "new"} open comment${n === 1 ? "" : "s"}. ` +
            (this.source.provider === "github"
              ? `Read them with \`gh pr view ${pr.number} --comments\` (or the GitHub API), fix them on the same branch, push, and resolve each thread you fixed.`
              : `Read them with the get_pr_comments tool (number ${pr.number}), fix them on the same branch, commit, and call open_pull_request again to push the fixes.`),
        );
    }

    if (pr.review === "passed" && old?.review !== "passed") {
      hub.activity("review.passed", who, `${tool} approved #${pr.number}`);
      if (lead) this.planner.notify(lead.id, passedNotice(pr, hub.name(who), hub.snap.config.workflow.merge.by, this.source.provider));
    }

    if (pr.conflict && !old?.conflict && who)
      this.planner.notify(who, `Your PR #${pr.number} has merge conflicts with main. Pull main, rebase or merge it into your branch, fix the conflicts, and push.`);
  }
}
