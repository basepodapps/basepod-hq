// Persistence in the repo: .jsmhq/config.json (team + workflow, safe to commit)
// and .jsmhq/plan.json (boards + tasks, owned by HQ).

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentConfig, Board, HqConfig, SandboxSettings, Task } from "../src/data/types";
import { LEAD_NAME, WORKER_NAMES } from "../src/data/names";
import { slugify } from "./paths";
import type { RepoInfo } from "./repo";

export interface PlanFile {
  boards: Board[];
  tasks: Task[];
}

const dir = (root: string) => join(root, ".jsmhq");

function readJson<T>(file: string): T | null {
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, "utf8")) as T;
}

/** Atomic write so a crash never leaves half a file. */
function writeJson(file: string, value: unknown) {
  mkdirSync(join(file, ".."), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n");
  renameSync(tmp, file);
}

export const defaultSandbox = (): SandboxSettings => ({
  resources: { cpus: null, memoryGb: null }, // sbx's own defaults
  allow: [],
  deny: [],
});

export function newAgent(id: string, name: string, role: string, color: string, isLead: boolean): AgentConfig {
  return {
    id,
    name,
    role,
    isLead,
    cli: "claude",
    model: "", // the CLI's default; users can pick with /model or "Start with model"
    mode: "sandbox",
    color,
    skills: [],
    roleMd: isLead
      ? `You are ${name}, the lead. You plan and assign work. You never write app code.`
      : `You are ${name}, a ${role.toLowerCase()} on the team. You build the tasks assigned to you.`,
    sandbox: defaultSandbox(),
    workspacePath: null,
    mcp: [],
  };
}

function defaultConfig(repo: RepoInfo, port: number): HqConfig {
  return {
    project: { id: slugify(repo.name), name: repo.name, repo: repo.github ?? repo.bitbucket ?? repo.name, path: repo.root, hqPort: port },
    team: [newAgent(slugify(LEAD_NAME), LEAD_NAME, "Lead", "#ff77a8", true), newAgent(slugify(WORKER_NAMES[0]), WORKER_NAMES[0], "Developer", "#29adff", false)],
    workflow: {
      review: { enabled: true, tool: repo.hasCodeRabbit ? "coderabbit" : "human", command: "" },
      merge: { by: "human" },
      deploy: { enabled: repo.hasInsta, tool: "instacloud", command: "", perAgentEnvironments: repo.hasInsta },
    },
  };
}

/** `isNew`: no config yet — the welcome screen fills it in, then it's saved. */
export function loadConfig(repo: RepoInfo, port: number): { config: HqConfig; isNew: boolean } {
  const file = join(dir(repo.root), "config.json");
  const found = readJson<HqConfig>(file);
  if (found) {
    // Older files may miss newer fields.
    for (const a of found.team) {
      a.workspacePath ??= null;
      a.mcp ??= [];
      a.cli ??= "claude";
      a.sandbox.resources ??= { cpus: null, memoryGb: null };
      // Phase D: policy level, proxy and secret names moved to sbx itself.
      const old = a.sandbox as unknown as Record<string, unknown>;
      delete old.policy;
      delete old.proxy;
      delete old.secrets;
    }
    // Configs from before project.id: their resources are named after the current name.
    // Slugified again in case the file was edited by hand: it ends up in paths and sandbox names.
    found.project.id = slugify(found.project.id ?? found.project.name);
    found.project.path = repo.root;
    return { config: found, isNew: false };
  }
  return { config: defaultConfig(repo, port), isNew: true };
}

export function saveConfig(root: string, cfg: HqConfig) {
  // The path is machine-specific; teammates get their own.
  const { path: _path, ...project } = cfg.project;
  writeJson(join(dir(root), "config.json"), { ...cfg, project: { ...project, path: "" } });
}

export function loadPlan(root: string): PlanFile {
  return readJson<PlanFile>(join(dir(root), "plan.json")) ?? { boards: [{ id: "B1", title: "Backlog", status: "active", order: 0 }], tasks: [] };
}

export function savePlan(root: string, plan: PlanFile) {
  writeJson(join(dir(root), "plan.json"), plan);
}
