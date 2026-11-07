import { useState } from "react";
import { LEAD_NAME, nextAgentName, WORKER_NAMES } from "../../data/names";
import { EMPTY_STACK, frameworks, STACK_CATEGORIES, toolsIn, type StackConfig } from "../../data/stack";
import type { AgentCli, ReviewTool } from "../../data/types";
import { officeActions, reviewToolLabel, useOffice } from "../../store/office";
import { agentPalette } from "../../theme/tokens";
import { Field, Portrait } from "../kit";
import { CliSelect, ROLE_SUGGESTIONS } from "../settings/TeamSettings";

interface WorkerDraft {
  name: string;
  role: string;
  cli: AgentCli;
}

const MAX_WORKERS = 11;

/** First run on a repo: name the project and pick the team. Nothing is saved until "Create team". */
export function WelcomeModal() {
  const snap = useOffice((s) => s.snap);
  const [projectName, setProjectName] = useState(snap?.config.project.name ?? "");
  const [lead, setLead] = useState<{ name: string; cli: AgentCli }>({ name: LEAD_NAME, cli: "claude" });
  const [workers, setWorkers] = useState<WorkerDraft[]>([{ name: WORKER_NAMES[0], role: "Developer", cli: "claude" }]);
  // Defaults come from what HQ detected in the repo (e.g. a CodeRabbit config).
  const [reviewEnabled, setReviewEnabled] = useState(snap?.config.workflow.review.enabled ?? true);
  const [reviewTool, setReviewTool] = useState<ReviewTool>(snap?.config.workflow.review.tool ?? "human");
  const [sending, setSending] = useState(false);
  const [stack, setStack] = useState<StackConfig>(EMPTY_STACK);
  if (!snap) return null;

  const setWorker = (i: number, patch: Partial<WorkerDraft>) => setWorkers((ws) => ws.map((w, j) => (j === i ? { ...w, ...patch } : w)));
  const addWorker = () =>
    setWorkers((ws) => [...ws, { name: nextAgentName([lead.name, ...ws.map((w) => w.name)]), role: "Developer", cli: "claude" }]);
  const valid = lead.name.trim() && workers.length > 0 && workers.every((w) => w.name.trim());

  const submit = () => {
    if (!valid) return;
    setSending(true);
    const hasStack = stack.frameworks.length > 0 || Object.values(stack.tools).some(Boolean);
    officeActions.completeWelcome({ projectName: projectName.trim(), lead, workers, reviewTool, reviewEnabled, ...(hasStack ? { stack } : {}) });
  };

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-[rgba(36,26,46,0.55)] p-4" role="dialog" aria-modal="true" aria-label="Welcome to BasePod HQ">
      <div className="panel flex max-h-[calc(100dvh-2rem)] w-[min(720px,100%)] flex-col">
        <div className="border-b-[3px] border-ink px-4 py-2">
          <h2 className="m-0 text-[22px] font-bold">Welcome to BasePod HQ</h2>
          <p className="m-0 text-[14px] text-muted">
            Set up the team for <b className="text-ink">{snap.config.project.repo || snap.config.project.name}</b>. You can change all of this later in Settings.
          </p>
        </div>

        <div className="scroll-thin flex min-h-0 flex-col gap-4 overflow-y-auto px-4 py-3">
          <Field label="Project name">
            <input className="field w-full" value={projectName} maxLength={80} onChange={(e) => setProjectName(e.target.value)} />
          </Field>

          <section>
            <h3 className="mb-1 text-[16px] font-bold">Lead</h3>
            <p className="mb-2 text-[13px] text-muted">Plans the work, creates tasks and assigns them to workers.</p>
            <div className="grid grid-cols-[40px_1fr_150px] items-end gap-2">
              <Portrait color={agentPalette[0]} lead />
              <Field label="Name">
                <input className="field w-full" value={lead.name} maxLength={40} onChange={(e) => setLead({ ...lead, name: e.target.value })} />
              </Field>
              <Field label="Agent">
                <CliSelect value={lead.cli} onChange={(cli) => setLead({ ...lead, cli })} />
              </Field>
            </div>
          </section>

          <section>
            <h3 className="mb-1 text-[16px] font-bold">Workers · {workers.length}</h3>
            <p className="mb-2 text-[13px] text-muted">Each worker gets its own desk, copy of the repo and sandbox.</p>
            <datalist id="welcome-roles">
              {ROLE_SUGGESTIONS.map((r) => (
                <option key={r} value={r} />
              ))}
            </datalist>
            <div className="flex flex-col gap-2">
              {workers.map((w, i) => (
                <div key={i} className="grid grid-cols-[40px_1fr_1fr_150px_auto] items-end gap-2">
                  <Portrait color={agentPalette[(i + 1) % agentPalette.length]} lead={false} />
                  <Field label="Name">
                    <input className="field w-full" value={w.name} maxLength={40} onChange={(e) => setWorker(i, { name: e.target.value })} />
                  </Field>
                  <Field label="Role">
                    <input className="field w-full" list="welcome-roles" value={w.role} maxLength={40} onChange={(e) => setWorker(i, { role: e.target.value })} />
                  </Field>
                  <Field label="Agent">
                    <CliSelect value={w.cli} onChange={(cli) => setWorker(i, { cli })} />
                  </Field>
                  <button
                    className="btn px-2 text-[13px]"
                    disabled={workers.length === 1}
                    aria-label={`Remove ${w.name || "worker"}`}
                    onClick={() => setWorkers((ws) => ws.filter((_, j) => j !== i))}
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
            <button className="btn mt-2 text-[13px]" disabled={workers.length >= MAX_WORKERS} onClick={addWorker}>
              + Add worker
            </button>
          </section>

          <WelcomeStack stack={stack} setStack={setStack} />

          <section>
            <h3 className="mb-1 text-[16px] font-bold">Code review</h3>
            <div className="flex flex-wrap items-center gap-3">
              <label className="flex items-center gap-2 text-[14px]">
                <input type="checkbox" checked={reviewEnabled} onChange={(e) => setReviewEnabled(e.target.checked)} />
                Review PRs before merge
              </label>
              <select className="field w-[220px]" value={reviewTool} disabled={!reviewEnabled} onChange={(e) => setReviewTool(e.target.value as ReviewTool)} aria-label="Review tool">
                {(Object.keys(reviewToolLabel) as ReviewTool[]).map((t) => (
                  <option key={t} value={t}>
                    {reviewToolLabel[t]}
                  </option>
                ))}
              </select>
            </div>
          </section>
        </div>

        <div className="flex items-center justify-between gap-3 border-t-[3px] border-ink px-4 py-2">
          <span className="text-[12px] text-muted">Saved to .jsmhq/config.json in your repo. Agents don't start until you press Start.</span>
          <button className="btn" disabled={!valid || sending} onClick={submit}>
            {sending ? "Creating…" : "Create team"}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Optional, collapsed by default: frameworks and tools. Everything else is in Settings → Stack. */
function WelcomeStack({ stack, setStack }: { stack: StackConfig; setStack: (s: StackConfig) => void }) {
  const [open, setOpen] = useState(false);
  const chosen = (id: string) => stack.frameworks.some((f) => f.id === id);
  return (
    <section>
      <div className="flex items-center gap-3">
        <h3 className="m-0 text-[16px] font-bold">Stack</h3>
        <span className="text-[13px] text-muted">Optional. Agents get the tools' skills and docs access.</span>
        <button className="btn ml-auto px-2 text-[12px]" aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? "Hide" : "Choose"}
        </button>
      </div>
      {open && (
        <div className="mt-2 flex flex-col gap-2">
          <div className="flex flex-wrap gap-1.5">
            {frameworks().map((f) => (
              <button
                key={f.id}
                className="btn px-2 py-0.5 text-[12px]"
                aria-pressed={chosen(f.id)}
                onClick={() => setStack({ ...stack, frameworks: chosen(f.id) ? stack.frameworks.filter((x) => x.id !== f.id) : [...stack.frameworks, { id: f.id }] })}
              >
                {f.name}
              </button>
            ))}
          </div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {STACK_CATEGORIES.map((c) => (
              <label key={c.id} className="flex flex-col gap-0.5 text-[12px] font-semibold">
                {c.label}
                <select
                  className="field"
                  value={stack.tools[c.id]?.id ?? ""}
                  onChange={(e) => {
                    const tools = { ...stack.tools };
                    if (e.target.value) tools[c.id] = { id: e.target.value };
                    else delete tools[c.id];
                    setStack({ ...stack, tools });
                  }}
                >
                  <option value="">None</option>
                  {toolsIn(c.id).map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </select>
              </label>
            ))}
          </div>
          <span className="text-[12px] text-muted">"Other" tools, where each framework lives, and network access are in Settings → Stack.</span>
        </div>
      )}
    </section>
  );
}
