// Facts about the repo HQ was started in.

import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import { run } from "./lib/exec";

export interface RepoInfo {
  root: string;
  name: string;
  originUrl: string | null;
  github: string | null; // "owner/name" when origin is GitHub
  bitbucket: string | null; // "workspace/repo" when origin is Bitbucket Cloud
  provider: "github" | "bitbucket" | null; // where PRs live
  hasCodeRabbit: boolean;
  hasInsta: boolean;
}

export async function detectRepo(start: string): Promise<RepoInfo> {
  const top = await run("git", ["rev-parse", "--show-toplevel"], { cwd: start });
  if (!top.ok) throw new Error(`${start} is not inside a git repository. Run HQ from your project folder or pass --repo <path>.`);
  const root = top.stdout.trim();
  const origin = await run("git", ["remote", "get-url", "origin"], { cwd: root });
  const originUrl = origin.ok ? origin.stdout.trim() : null;
  const m = originUrl?.match(/github\.com[:/]([^/]+\/[^/]+?)(\.git)?$/);
  const bb = originUrl?.match(/bitbucket\.org[:/]([^/]+\/[^/]+?)(\.git)?\/?$/);
  return {
    root,
    name: basename(root),
    originUrl,
    github: m ? m[1] : null,
    bitbucket: bb ? bb[1] : null,
    provider: m ? "github" : bb ? "bitbucket" : null,
    hasCodeRabbit: existsSync(join(root, ".coderabbit.yaml")) || existsSync(join(root, ".coderabbit.yml")),
    hasInsta: existsSync(join(root, ".insta")),
  };
}
