// Run: pnpm test:bitbucket   (node:test through tsx; no network, no Bitbucket account)
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

// Point HOME at a scratch folder BEFORE importing anything that reads ~/.jsmhq.
const home = mkdtempSync(join(tmpdir(), "hq-home-"));
process.env.HOME = home;
process.env.USERPROFILE = home;
mkdirSync(join(home, ".jsmhq"), { recursive: true });
writeFileSync(join(home, ".jsmhq", "bitbucket.json"), JSON.stringify({ user: "me@example.com", token: "tok" }), { mode: 0o600 });

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "init.defaultBranch=main", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const scratch = mkdtempSync(join(tmpdir(), "hq-bb-"));
after(() => {
  rmSync(scratch, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

const { detectRepo } = await import("../server/repo.ts");
const bb = await import("../server/bitbucket.ts");
const bg = await import("../server/bitbucketGit.ts");
const { reviewOf, taskIdOf, branchAgent } = await import("../server/github.ts");
const { passedNotice, mergeByNotice } = await import("../server/githubSync.ts");

describe("repo detection", () => {
  const cases: [string, string | null, string | null][] = [
    ["https://bitbucket.org/acme/widgets.git", null, "acme/widgets"],
    ["git@bitbucket.org:acme/widgets.git", null, "acme/widgets"],
    ["https://user@bitbucket.org/acme/widgets", null, "acme/widgets"],
    ["https://bitbucket.org/acme/widgets/", null, "acme/widgets"],
    ["git@github.com:acme/widgets.git", "acme/widgets", null],
    ["https://git.example.com/acme/widgets.git", null, null],
  ];
  for (const [url, gh, bitbucket] of cases)
    it(url, async () => {
      const d = mkdtempSync(join(scratch, "r-"));
      git(d, "init", "-q");
      git(d, "remote", "add", "origin", url);
      const r = await detectRepo(d);
      assert.equal(r.github, gh);
      assert.equal(r.bitbucket, bitbucket);
      assert.equal(r.provider, gh ? "github" : bitbucket ? "bitbucket" : null);
    });
});

const pr = (over: object = {}): import("../server/bitbucket.ts").BbPr => ({
  id: 7,
  title: "[P1-T02] Chat route",
  state: "OPEN",
  created_on: "2026-11-01T00:00:00Z",
  updated_on: "2026-11-02T00:00:00Z",
  links: { html: { href: "https://bitbucket.org/acme/widgets/pull-requests/7" } },
  source: { branch: { name: "ada/P1-T02-chat" } },
  participants: [],
  ...over,
});
const thread = (id: number, over: object = {}) => ({ id, user: { nickname: "rev" }, inline: { path: "a.ts", to: 4 }, content: { raw: "fix this" }, ...over });

describe("mapping to HQ's PR shape", () => {
  it("basic fields and task/author matching", () => {
    const g = bb.toGhPr(pr());
    assert.equal(g.number, 7);
    assert.equal(g.state, "OPEN");
    assert.equal(g.mergeable, "UNKNOWN");
    assert.equal(taskIdOf(g), "P1-T02");
    assert.equal(branchAgent(g.headRefName), "ada");
  });
  it("states", () => {
    assert.equal(bb.toGhPr(pr({ state: "MERGED" })).state, "MERGED");
    assert.equal(bb.toGhPr(pr({ state: "MERGED" })).mergedAt, "2026-11-02T00:00:00Z");
    assert.equal(bb.toGhPr(pr({ state: "DECLINED" })).state, "CLOSED");
    assert.equal(bb.toGhPr(pr({ state: "SUPERSEDED" })).state, "CLOSED");
    assert.equal(bb.toGhPr(pr({ draft: true })).isDraft, true);
  });
  it("human review: waiting, approved, changes requested", () => {
    assert.equal(reviewOf(bb.toGhPr(pr()), "human").review, "pending");
    const approved = bb.toGhPr(pr({ participants: [{ role: "REVIEWER", approved: true, state: "approved", user: { nickname: "rev" } }] }));
    assert.equal(reviewOf(approved, "human").review, "passed");
    const changes = bb.toGhPr(pr({ participants: [{ role: "REVIEWER", approved: false, state: "changes_requested", user: { nickname: "rev" } }] }));
    assert.equal(reviewOf(changes, "human").review, "changes-requested");
  });
  it("counts only open inline threads", () => {
    const comments = [
      thread(1),
      thread(2, { resolution: { type: "resolved" } }),
      thread(3, { deleted: true }),
      thread(4, { parent: { id: 1 } }),
      thread(5, { inline: { path: "b.ts", to: 1, outdated: true } }),
      { id: 6, user: { nickname: "rev" }, content: { raw: "general chatter" } },
    ];
    const g = bb.toGhPr(pr(), comments);
    assert.equal(reviewOf(g, "human").openComments, 1);
    assert.equal(reviewOf(g, "human").review, "changes-requested"); // the author can't click Request changes
    assert.equal(reviewOf(bb.toGhPr(pr(), [thread(2, { resolution: { type: "resolved" } })]), "human").review, "pending");
    assert.deepEqual(bb.openComments(comments), [{ file: "a.ts", line: 4, author: "rev", text: "fix this" }]);
  });
  it("bot review via build statuses", () => {
    const run = (state: string) => reviewOf(bb.toGhPr(pr(), [], [{ name: "CodeRabbit", state }]), "coderabbit").review;
    assert.equal(run("INPROGRESS"), "reviewing");
    assert.equal(run("SUCCESSFUL"), "passed");
    assert.equal(run("FAILED"), "changes-requested");
  });
});

describe("notices", () => {
  it("GitHub wording is unchanged by default", () => {
    assert.match(passedNotice({ number: 3, title: "t" }, "Ada", "lead"), /gh pr merge 3 --squash --delete-branch/);
    assert.match(mergeByNotice("lead", [1, 2]), /gh pr merge <number>/);
  });
  it("Bitbucket points at the merge tool", () => {
    const n = passedNotice({ number: 3, title: "t" }, "Ada", "lead", "bitbucket");
    assert.match(n, /merge_pull_request tool with number 3/);
    assert.doesNotMatch(n, /gh pr|GitHub/);
    assert.doesNotMatch(mergeByNotice("lead", [1], "bitbucket"), /gh pr/);
  });
});

describe("branch names", () => {
  it("accepts agent branches", () => assert.equal(bg.cleanBranch("ada/P1-T02-chat"), "ada/P1-T02-chat"));
  for (const bad of ["main", "-x/y", "a/../b", "a/b c", "a/b;rm", "a/b$(x)", "a/b.lock", "/a/b", "a//b", "x".repeat(130) + "/y"])
    it(`rejects ${bad.slice(0, 20)}`, () => assert.throws(() => bg.cleanBranch(bad)));
});

// A bare repo standing in for Bitbucket, a user's repo (root) cloned from it, and an agent clone of root.
function world() {
  const dir = mkdtempSync(join(scratch, "w-"));
  const remote = join(dir, "remote.git");
  const root = join(dir, "root");
  const agent = join(dir, "agent");
  git(dir, "init", "-q", "--bare", remote);
  git(dir, "clone", "-q", remote, root);
  writeFileSync(join(root, "a.txt"), "one\n");
  git(root, "add", "."), git(root, "commit", "-qm", "first"), git(root, "push", "-q", "origin", "HEAD:main");
  git(root, "remote", "set-head", "origin", "main");
  git(dir, "clone", "-q", root, agent);
  git(agent, "remote", "set-url", "origin", remote);
  return { dir, remote, root, agent };
}

describe("pushing an agent's branch", () => {
  it("fetches from the agent folder and pushes from the user's repo", async () => {
    const w = world();
    git(w.agent, "checkout", "-qb", "ada/P1-T02-chat");
    writeFileSync(join(w.agent, "b.txt"), "two\n");
    git(w.agent, "add", "."), git(w.agent, "commit", "-qm", "work");
    await bg.pushAgentBranch(w.root, w.agent, "ada", "ada/P1-T02-chat");
    assert.match(git(w.remote, "branch", "--list", "ada/P1-T02-chat"), /ada\/P1-T02-chat/);
    assert.equal(git(w.root, "for-each-ref", "refs/hq-submit").trim(), "", "temp ref cleaned up");
  });

  it("does not run hooks or config commands planted in the agent's repo", async () => {
    const w = world();
    const marker = join(w.dir, "PWNED");
    git(w.agent, "checkout", "-qb", "ada/T1-x");
    writeFileSync(join(w.agent, "c.txt"), "x\n");
    git(w.agent, "add", "."), git(w.agent, "commit", "-qm", "work");
    for (const hook of ["pre-push", "post-update", "pre-upload-pack", "reference-transaction", "pre-auto-gc"]) {
      mkdirSync(join(w.agent, ".git", "hooks"), { recursive: true });
      writeFileSync(join(w.agent, ".git", "hooks", hook), `#!/bin/sh\ntouch "${marker}"\n`, { mode: 0o755 });
    }
    git(w.agent, "config", "core.fsmonitor", `touch ${marker}`);
    git(w.agent, "config", "core.sshCommand", `touch ${marker}`);
    git(w.agent, "config", "uploadpack.packObjectsHook", `touch ${marker}`);
    await bg.pushAgentBranch(w.root, w.agent, "ada", "ada/T1-x");
    assert.equal(existsSync(marker), false, "planted command ran on the host");
    assert.match(git(w.remote, "branch", "--list", "ada/T1-x"), /ada\/T1-x/);
  });

  it("refuses a symlinked .git, a gitfile, and alternates", async () => {
    const w = world();
    const other = join(w.dir, "other");
    git(w.dir, "clone", "-q", w.root, other);
    const link = join(w.dir, "linked");
    mkdirSync(link);
    symlinkSync(join(other, ".git"), join(link, ".git"));
    await assert.rejects(bg.pushAgentBranch(w.root, link, "ada", "ada/x"), /plain directory|isn't a git/);
    const gf = join(w.dir, "gitfile");
    mkdirSync(gf);
    writeFileSync(join(gf, ".git"), `gitdir: ${join(other, ".git")}\n`);
    await assert.rejects(bg.pushAgentBranch(w.root, gf, "ada", "ada/x"), /plain directory/);
    writeFileSync(join(w.agent, ".git", "objects", "info", "alternates"), join(other, ".git", "objects") + "\n");
    await assert.rejects(bg.pushAgentBranch(w.root, w.agent, "ada", "ada/x"), /borrows objects/);
  });

  it("surfaces a missing branch plainly", async () => {
    const w = world();
    await assert.rejects(bg.pushAgentBranch(w.root, w.agent, "ada", "ada/nope"), /Commit your work/);
  });
});

describe("handing main to an agent as a bundle", () => {
  it("the agent can apply it inside its own clone, without network", async () => {
    const w = world();
    // main moves on after the agent cloned
    writeFileSync(join(w.root, "a.txt"), "one\ntwo\n");
    git(w.root, "commit", "-qam", "second"), git(w.root, "push", "-q", "origin", "HEAD:main");
    assert.equal(await bg.defaultBranch(w.root), "main");
    const cmd = await bg.writeBaseBundle(w.root, w.agent, "main");
    assert.equal(cmd, "git fetch .hq/main.bundle +refs/remotes/origin/main:refs/remotes/origin/main");
    git(w.agent, "remote", "set-url", "origin", "/nonexistent"); // prove no network/remote is needed
    git(w.agent, "fetch", "-q", ".hq/main.bundle", "+refs/remotes/origin/main:refs/remotes/origin/main");
    assert.equal(git(w.agent, "show", "origin/main:a.txt"), "one\ntwo\n");
    assert.match(readFileSync(join(w.agent, ".git", "info", "exclude"), "utf8"), /\.hq\//);
  });
});

describe("API client against a local fake", () => {
  let server: ReturnType<typeof createServer>;
  const seen: { method: string; url: string; auth: string | undefined; body: string }[] = [];
  before(async () => {
    server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        seen.push({ method: req.method ?? "", url: req.url ?? "", auth: req.headers.authorization, body });
        const u = req.url ?? "";
        const json = (code: number, v: unknown, h: Record<string, string> = {}) => (res.writeHead(code, { "content-type": "application/json", ...h }), res.end(JSON.stringify(v)));
        if (u.includes("/pullrequests?state=OPEN")) return json(200, { values: [pr({ participants: [{ approved: true, state: "approved", user: { nickname: "rev" } }] })] });
        if (u.includes("/pullrequests?state=MERGED")) return json(200, { values: [pr({ id: 5, state: "MERGED" })] });
        if (u.includes("/pullrequests?state=DECLINED")) return json(200, { values: [pr({ id: 4, state: "DECLINED" })] });
        if (u.includes("/7/comments")) return json(200, { values: [thread(1)] });
        if (u.includes("/pullrequests?q=") && u.includes("exists")) return json(200, { values: [pr({ id: 9 })] });
        if (u.includes("/pullrequests?q=")) return json(200, { values: [] });
        if (req.method === "POST" && u.endsWith("/pullrequests")) return json(201, pr({ id: 11 }));
        if (req.method === "POST" && u.endsWith("/7/merge")) return json(200, {});
        if (u.includes("/ratelimited")) return json(429, {}, { "retry-after": "30" });
        json(404, { error: { message: "nope" } });
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    process.env.HQ_BITBUCKET_API = `http://127.0.0.1:${(server.address() as { port: number }).port}/2.0`;
  });
  after(() => server.close());

  it("fetchPrs maps open (with comments), merged and declined; sends basic auth", async () => {
    const r = await bb.fetchPrs("acme/widgets", "human");
    assert.equal(r.open.length, 1);
    assert.equal(reviewOf(r.open[0], "human").review, "passed");
    assert.equal(reviewOf(r.open[0], "human").openComments, 1);
    assert.equal(r.merged[0].state, "MERGED");
    assert.deepEqual(r.closed, [4]);
    assert.equal(r.rate.cost, 4);
    assert.equal(seen[0].auth, "Basic " + Buffer.from("me@example.com:tok").toString("base64"));
    assert.ok(seen.every((s) => s.url.startsWith("/2.0/repositories/acme/widgets/")));
  });
  it("openOrFindPr creates when none is open, reuses when one is", async () => {
    const made = await bb.openOrFindPr("acme/widgets", { title: "T", description: "D", source: "ada/T1-x", destination: "main" });
    assert.deepEqual(made, { number: 11, url: "https://bitbucket.org/acme/widgets/pull-requests/7", created: true });
    const post = seen.find((s) => s.method === "POST" && s.url.endsWith("/pullrequests"))!;
    assert.deepEqual(JSON.parse(post.body), { title: "T", description: "D", source: { branch: { name: "ada/T1-x" } }, destination: { branch: { name: "main" } }, close_source_branch: true });
  });
  it("mergePr squashes and closes the branch", async () => {
    await bb.mergePr("acme/widgets", 7);
    const m = seen.find((s) => s.url.endsWith("/7/merge"))!;
    assert.deepEqual(JSON.parse(m.body), { merge_strategy: "squash", close_source_branch: true });
  });
  it("only a loopback override is honoured (the token never goes elsewhere)", async () => {
    const local = process.env.HQ_BITBUCKET_API;
    process.env.HQ_BITBUCKET_API = "https://evil.example.com/2.0";
    assert.equal(bb.apiBase(), "https://api.bitbucket.org/2.0");
    process.env.HQ_BITBUCKET_API = "http://localhost:1234/2.0/";
    assert.equal(bb.apiBase(), "http://localhost:1234/2.0");
    process.env.HQ_BITBUCKET_API = local;
  });
});
