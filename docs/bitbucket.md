# Using BasePod HQ with Bitbucket Cloud

HQ was built around GitHub. With a Bitbucket Cloud `origin`, it switches to a Bitbucket mode:

- **HQ talks to Bitbucket, the agents don't.** Agents get no Bitbucket credentials and no `gh`. They ask HQ (through the Team MCP) to push their branch, open the PR, read review comments, and (for the lead) merge.
- **PRs, reviews and the task board** are read from the Bitbucket REST API 2.0 with a token you give HQ.

Detection is automatic: `git remote get-url origin` must point at `bitbucket.org`. (Bitbucket Server / Data Center is not supported.)

## Setup (once)

1. Create a credential with pull request and repository access:
   - an **Atlassian API token** (https://id.atlassian.com/manage-profile/security/api-tokens), user = your Atlassian email, or
   - a Bitbucket **app password**, user = your Bitbucket username.
2. Save it where only you can read it:

   ```sh
   mkdir -p ~/.jsmhq
   printf '{"user":"YOU@EXAMPLE.COM","token":"YOUR_TOKEN"}' > ~/.jsmhq/bitbucket.json
   chmod 600 ~/.jsmhq/bitbucket.json
   ```

   HQ only reads this file. It never writes it into an agent's folder, passes it to a sandbox, or puts it in an environment variable.
3. Your normal git access to the repo (SSH key or credential helper) must work from the host: HQ uses it to push agents' branches.
4. Check it, read-only:

   ```sh
   pnpm exec tsx scripts/bitbucket-smoke.ts YOUR_WORKSPACE/YOUR_REPO
   ```

Then run HQ as usual. The setup checklist shows "Bitbucket API token" and "Bitbucket remote" instead of the GitHub checks.

## What agents do differently

| Step | GitHub | Bitbucket |
| --- | --- | --- |
| Get latest main | `git pull origin main` | `sync_main`, then the git command it returns (HQ hands main over as a bundle file) |
| Open a PR | `gh pr create` | `open_pull_request` (HQ pushes, then calls the API; calling it again pushes fixes) |
| Read review comments | `gh pr view --comments` | `get_pr_comments` |
| Lead merges | `gh pr merge --squash --delete-branch` | `merge_pull_request` (only when Settings → Workflow → Merge is set to the lead) |

## Why HQ does the git work (security)

An agent's folder is untrusted: it is mounted into the sandbox, so the agent can write anything in it, including `.git/hooks` and `.git/config`. So HQ never runs git *inside* an agent folder. It fetches *from* it into your own repo and pushes from there, after checking `.git` is a plain directory (no symlink, no gitfile, no alternates). `scripts/bitbucket.test.ts` plants hooks and config commands in an agent repo and checks they never run.

## Limits

- **Reviews:** "human" review (reviewer approvals and unresolved inline comments) is the one that fits Bitbucket. Bot review tools (CodeRabbit, etc.) only work if the bot posts a build status to the PR.
- **Merge conflicts** aren't detected (the API doesn't say in the list view), so agents aren't told about them automatically. Bitbucket shows them on the PR.
- **Comment threads** are not resolved by agents; resolve them in Bitbucket.
- **Rate limit:** Bitbucket Cloud allows roughly 1,000 API calls an hour. HQ budgets 600 and slows its polling to fit (about one call per open PR per comment fetch).
- **sync_main** sends the full history of main as a bundle each time. Fine for normal repos; slow for very large ones.
- Tested with fixtures, a fake local API and local git remotes. Not yet run against live Bitbucket: run the smoke script first.
