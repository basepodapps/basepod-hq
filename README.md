# JSM HQ

**Run a team of AI coding agents on your repo, and watch them work in a pixel-art office.**

[![npm](https://img.shields.io/npm/v/@therealjsmastery/jsm-hq?color=cb3837&label=npm)](https://www.npmjs.com/package/@therealjsmastery/jsm-hq)
[![license](https://img.shields.io/npm/l/@therealjsmastery/jsm-hq)](LICENSE)
[![node](https://img.shields.io/node/v/@therealjsmastery/jsm-hq)](https://nodejs.org)

![The JSM HQ office: a lead and two developers at their desks, the task board on the wall, pull requests on the board and the review gate on the belt](docs/images/office.png)

One **lead** agent plans the work and hands out tasks. Each **worker** gets its own desk, its own copy of your repo and its own Docker Sandbox, then opens a pull request. You see it all happen: the plan on the wall, agents at their desks, PRs moving through review.

Agents run **Claude Code** or **Codex**. Everything runs on your machine.

## Why use it

- **A real team, not one chat.** The lead splits the work into small tasks (one task, one branch, one PR) and assigns them. Agents message each other through HQ.
- **Safe by default.** Each agent works in its own Docker Sandbox, a small VM that can't touch the rest of your computer. Websites are blocked until you allow them.
- **You stay in charge.** Anything an agent needs from you (a decision, an API key, a blocked website) shows up in **Action items**. HQ never merges for you.
- **Your workflow.** Pull requests on GitHub, reviewed by CodeRabbit, Greptile, Copilot or you.
- **Knows your stack.** Pick your tools (Next.js, Clerk, Stripe, Supabase…) and agents get their official agent skills and docs access.

## Quick start

From inside a git repo that has a GitHub remote (Bitbucket Cloud works too: see [docs/bitbucket.md](docs/bitbucket.md)):

```bash
npx @therealjsmastery/jsm-hq@latest
```

HQ opens in your browser and walks you through the rest:

1. **Welcome:** name the project and pick a lead and workers (Claude Code or Codex for each).
2. **Setup checklist:** anything missing on your machine is listed with the command to fix it.
3. **Start team** in the top bar, then message the lead, for example: *"Plan two small tasks for Dwight and assign the first one."*

**First time?** The [getting-started guide](docs/getting-started.md) takes you from a fresh machine to a working team in about 15 minutes, on macOS, Linux and Windows.

**Just trying it?** Use a throwaway repo:

```bash
mkdir hq-test && cd hq-test
git init -b main && echo "# HQ test" > README.md && git add . && git commit -m init
npx @therealjsmastery/jsm-hq@latest
```

### Options

```
jsm-hq --repo <path>   the repo to manage (default: current folder)
       --port <n>      HQ port (default: 7420)
       --no-open       don't open the browser
       --version, --help
```

Use it often? `npm install -g @therealjsmastery/jsm-hq`, then run `jsm-hq` in any repo.

## Requirements

| What | Why |
| --- | --- |
| Node.js 20+ | Runs HQ |
| git and a GitHub repo | Each agent clones it, pushes a branch and opens a PR |
| GitHub CLI (`gh`) | Reads PRs and reviews |
| Docker Sandboxes (`sbx`) | Each agent runs in its own VM |
| tmux (macOS, Linux) | Agents keep running if you close HQ |
| A Claude or ChatGPT account | For the agents themselves |

Sandboxes need **macOS 14+ on Apple silicon, Windows 11, or Ubuntu 24.04+**. On other machines, set agents to **Local** in Settings → Team: they run Claude Code or Codex directly on your machine, with permission prompts on.

You don't need to install these by hand first. HQ checks for each one and shows the exact command. The [getting-started guide](docs/getting-started.md) has every step.

## How it works

![An agent's drawer: its live terminal, its sandbox, websites it tried to reach, and tabs for its task and messages](docs/images/agent-drawer.png)

1. **You tell the lead what to build.** It creates a board of small tasks, each with the files it may touch, and assigns them.
2. **Workers build in their own sandboxes.** Each one pulls `main`, makes a branch, writes the code and opens a PR titled `[TASK-ID] …`.
3. **HQ follows the PRs on GitHub.** Review comments go back to the author; a passing PR is reported to the lead; a merged PR marks the task done.
4. **Agents ask when they're stuck.** A question, a blocked website or a missing key shows up in **Action items** and on the agent's card.
5. **You review and merge.**

Click any agent to open its drawer: its live terminal, a shell inside its sandbox, its task, its messages, and the websites it tried to reach. Drag the drawer's edge to make it wider, or maximize it. **Terminal** in the top bar opens your own shell in the repo or any agent's folder.

More detail on workspaces, sandboxes, MCP servers, app variables and what HQ saves: **[How it works](docs/how-it-works.md)**.

## Troubleshooting

| Problem | Fix |
| --- | --- |
| A setup check shows "!" but the tool works | You may be on an old HQ. Run `npx @therealjsmastery/jsm-hq@latest` (npx can keep an old version cached). |
| Start fails: "network policy has not been initialized" | A new Docker Sandboxes install needs a base policy once: `sbx policy init balanced`. |
| Agents fail to start with a sign-in error | Your Docker sign-in expired. Run `sbx login`, then **Check again** in the setup checklist. |
| Agents can't push or open PRs | Run `sbx secret set github --command "gh auth token"`, and check the repo has a GitHub `origin`. |
| A Codex agent waits on "Do you trust this folder?" | Answer it once in the agent's terminal. HQ never answers trust prompts for you. |
| A CLI sign-in in a sandbox opens the browser, then fails on `localhost:<port>` | Press **Forward port** in the agent's drawer, then reload the page. |
| An agent's state never changes | The sandbox can't reach HQ. `sbx policy ls` should show `localhost:<port>` and `host.docker.internal:<port>` allowed; HQ adds them on start. |
| "Port 7420 is in use" | Another HQ is running. Stop it, or use `--port 7421`. |
| Windows: `listen EACCES` on start | Windows reserved that port. Use `--port 8420`. |
| `posix_spawnp failed` when opening a terminal | Run `npx clear-npx-cache`, then `npx @therealjsmastery/jsm-hq@latest`. |

**Remove a project:** delete each agent in Settings → Team (this removes its sandbox and, if you choose, its folder), then delete `~/.jsmhq/<project>`.

## Docs

- [Getting started](docs/getting-started.md): install everything and run your first team.
- [How it works](docs/how-it-works.md): workspaces, sandboxes, GitHub, MCP, settings and files.
- [Contributing](CONTRIBUTING.md): run HQ from source and release it.

## License

Code: [MIT](LICENSE). The JSM HQ name and logo are not covered by the license; see [TRADEMARKS.md](TRADEMARKS.md).
