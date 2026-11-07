// Optional: mirror the plan to docs/plan.md so it can be read (and committed)
// outside HQ. Opt-in per project; HQ only ever writes this one file.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { HqConfig, TaskStatus } from "../src/data/types";
import type { PlanFile } from "./store";

export const PLAN_EXPORT_PATH = "docs/plan.md";

const BOX: Record<TaskStatus, string> = { todo: "[ ]", "in-progress": "[ ]", "in-review": "[ ]", blocked: "[ ]", done: "[x]" };
const STATUS: Record<TaskStatus, string> = { todo: "", "in-progress": "in progress", "in-review": "in review", blocked: "blocked", done: "" };

export function planMarkdown(config: HqConfig, plan: PlanFile): string {
  const name = (id: string | null) => (id ? (config.team.find((a) => a.id === id)?.name ?? id) : null);
  const lines = [`# ${config.project.name} plan`, "", "_Written by BasePod HQ from .jsmhq/plan.json. Edits here are overwritten; change the plan in HQ._", ""];
  for (const b of [...plan.boards].sort((x, y) => x.order - y.order)) {
    lines.push(`## ${b.title} (${b.status})`, "");
    const tasks = plan.tasks.filter((t) => t.boardId === b.id);
    if (!tasks.length) lines.push("_No tasks._");
    for (const t of tasks) {
      const meta = [name(t.ownerId), STATUS[t.status], t.prNumber ? `PR #${t.prNumber}` : "", t.needs.length ? `needs ${t.needs.join(", ")}` : ""].filter(Boolean);
      lines.push(`- ${BOX[t.status]} **${t.id}** ${t.title}${meta.length ? ` — ${meta.join(" · ")}` : ""}`);
      if (t.description) lines.push(`  - ${t.description.replace(/\s*\n\s*/g, " ")}`);
      if (t.doneWhen) lines.push(`  - Done when: ${t.doneWhen.replace(/\s*\n\s*/g, " ")}`);
      if (t.note) lines.push(`  - Note: ${t.note}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

export function writePlanExport(root: string, config: HqConfig, plan: PlanFile) {
  const file = join(root, PLAN_EXPORT_PATH);
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, planMarkdown(config, plan));
}
