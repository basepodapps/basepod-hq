# BasePod HQ

**Run a team of AI coding agents on your repo, and watch them work in a pixel-art office. Now with Bitbucket.**

BasePod HQ is a fork of [JSM HQ](https://github.com/jsmastery-pro/jsm-hq) by JavaScript Mastery (MIT). All the credit for the idea, the pixel office and the agent team goes to them. This fork adds **Bitbucket Cloud support**, so you can use it without GitHub.

## The story

One early morning, someone woke up to an email about a fun AI tool for running a team of coding agents. She read it with her coffee-free brain and thought *this is great*, then found out it only works with GitHub. Her repos had moved to Bitbucket.

So she did what anyone with an AI at hand would do: asked it to write a patch. A few hours, two live test runs and one very patient pair of agents later, the office had Bitbucket pull requests on its wall. If you're also a Bitbucket person who wants the nice AI goodies, this is for you.

## What this fork adds

- **Bitbucket Cloud mode.** HQ detects a `bitbucket.org` origin and switches over. PRs, approvals, review comments and merges are read from the Bitbucket REST API, and the task board follows along (To do, Doing, Review, Done).
- **Agents never hold your credentials.** Your Bitbucket token stays in `~/.jsmhq/bitbucket.json` on your machine. Agents ask HQ, through the Team MCP, to push their branch (`open_pull_request`), read review comments (`get_pr_comments`), update from main (`sync_main`), and (lead only, if you choose) merge (`merge_pull_request`). Agent folders are treated as untrusted.
- **Comments close the loop.** An unresolved review comment sends the PR back to its author to fix on the same PR. Bitbucket hides "Request changes" from a PR's author, and agents open PRs with your token, so an open comment counts as changes requested.
- **33 tests** covering the mapping, branch-name safety, git hardening and the API client.

Setup, differences from GitHub mode and the security reasoning are in **[docs/bitbucket.md](docs/bitbucket.md)**. GitHub mode still works as in upstream.

## Quick start

BasePod HQ isn't on npm yet, so run it from a clone. You need Node.js 20+, pnpm, git, tmux, and Docker Sandboxes (`sbx`). The [getting-started guide](docs/getting-started.md) covers each of these.

```bash
git clone https://github.com/basepodapps/basepod-hq && cd basepod-hq
pnpm install
pnpm build
```

Then, in the repo you want a team to work on (a Bitbucket one, after the setup in [docs/bitbucket.md](docs/bitbucket.md)):

```bash
node /path/to/basepod-hq/bin/basepod-hq.mjs
```

HQ opens in your browser: name the project, pick a lead and workers, follow the setup checklist, press **Start team**, and message the lead. Try it on a throwaway repo first.

```
basepod-hq --repo <path>   the repo to manage (default: current folder)
           --port <n>      HQ port (default: 7420)
           --no-open       don't open the browser
           --version, --help
```

## Honest caveats

- **Tested with Claude Code on a Claude subscription only.** We haven't tried Codex, so we can't say how it behaves in Bitbucket mode or how it uses tokens. Codex agents keep the upstream behavior.
- **Bitbucket Cloud only.** Bitbucket Server and Data Center are not supported.
- **Agents use your usage.** A team of agents burns through a Claude plan quickly. On a Pro plan, set agents to Sonnet while you try it out.
- **The hidden `.jsmhq` folders keep their upstream name** so this fork stays easy to merge with upstream and existing data keeps working.

## Planned

Not built yet, so please don't count on them:

- **Lite and Full team presets.** Lite keeps sub-agents on cheaper models, and Full runs the orchestrator's model everywhere. Full mode would carry a warning for Pro plans.
- **Preset skills per agent role**, with a project's own skills taking priority.
- **Re-notify after a restart** when a PR is still waiting on fixes (today a restart swallows it).

## Docs

- [Bitbucket Cloud](docs/bitbucket.md)
- [Getting started](docs/getting-started.md) and [How it works](docs/how-it-works.md) (from upstream, renamed)
- [Contributing](CONTRIBUTING.md)

## License

Code: [MIT](LICENSE), copyright JavaScript Mastery and BasePod Apps LLC. The names **JSM HQ**, **JavaScript Mastery** and **JSM** and their logos belong to JavaScript Mastery and are not covered by the license; see [TRADEMARKS.md](TRADEMARKS.md). BasePod HQ is an independent fork and isn't made, endorsed or supported by JavaScript Mastery.
