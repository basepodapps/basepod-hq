import { useState } from "react";
import type { SetupCheck, SetupStatus } from "../../data/types";
import { officeActions, useOffice } from "../../store/office";
import { ui } from "../../store/ui";
import { TerminalView } from "../drawers/TerminalView";

const ICON: Record<SetupStatus, [string, string]> = {
  ok: ["✓", "#00a83a"],
  missing: ["✗", "#ff004d"],
  unsupported: ["✗", "#ff004d"],
  warning: ["!", "#d48a1a"],
};

const NEEDED: Record<SetupCheck["neededFor"], string> = {
  sandbox: "for sandboxes",
  local: "for Local mode",
  all: "required",
  github: "for PRs & reviews",
};

function CheckRow({ c, running, onRun }: { c: SetupCheck; running: boolean; onRun: () => void }) {
  const [copied, setCopied] = useState(false);
  const [icon, color] = ICON[c.status];
  return (
    <li className="border-t-2 border-dashed border-cream-3 py-2.5 first:border-t-0">
      <div className="flex items-start gap-2.5">
        <span className="w-4 shrink-0 text-center text-[18px] font-bold leading-6" style={{ color }} aria-label={c.status}>
          {icon}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <b className="text-[16px]">{c.label}</b>
            <span className="text-[12px] text-muted">{NEEDED[c.neededFor]}</span>
          </div>
          <div className="text-[14px] text-muted">{c.detail}</div>
          {c.fix && c.status !== "ok" && (
            <div className="mt-1.5 flex flex-wrap items-center gap-2">
              {c.fix.command && (
                <>
                  <code className="max-w-full truncate border-2 border-ink bg-navy-2 px-2 py-0.5 font-term text-[17px] text-[#dfe6ff]">{c.fix.command}</code>
                  <button
                    className="btn px-2 text-[12px]"
                    onClick={() => {
                      void navigator.clipboard?.writeText(c.fix?.command ?? "");
                      setCopied(true);
                      window.setTimeout(() => setCopied(false), 1200);
                    }}
                  >
                    {copied ? "Copied" : "Copy"}
                  </button>
                  {c.fix.runnable && (
                    <button className="btn px-2 text-[12px]" disabled={running} onClick={onRun}>
                      {running ? "Running…" : "Run in terminal"}
                    </button>
                  )}
                </>
              )}
              {c.fix.docs && (
                <a className="text-[13px] font-semibold underline" href={c.fix.docs} target="_blank" rel="noreferrer">
                  Docs ↗
                </a>
              )}
            </div>
          )}
        </div>
      </div>
    </li>
  );
}

/** "Get BasePod HQ ready": what's missing on this machine and how to fix it. */
export function SetupChecklist() {
  const setup = useOffice((s) => s.snap?.setup);
  const [runningId, setRunningId] = useState<string | null>(null);
  if (!setup) return null;

  return (
    <div className="fixed inset-0 z-40 grid place-items-center bg-[rgba(36,26,46,0.55)] p-4" role="dialog" aria-modal="true" aria-label="Setup checklist">
      <div className="panel flex max-h-[calc(100dvh-2rem)] w-[min(760px,100%)] flex-col">
        <div className="flex items-center gap-3 border-b-[3px] border-ink px-4 py-2">
          <h2 className="m-0 flex-1 text-[22px] font-bold">Get BasePod HQ ready</h2>
          <button className="btn text-[14px]" onClick={() => officeActions.recheckSetup()}>
            Check again
          </button>
        </div>
        <div className="scroll-thin min-h-0 overflow-y-auto px-4 py-2">
          <div className="mb-2 flex flex-wrap gap-2 text-[14px]">
            <span className="chip chip-dot" style={{ ["--c" as string]: setup.sandboxReady ? "#00e436" : "#ff004d" }}>
              Sandboxes {setup.sandboxReady ? "ready" : "not ready"}
            </span>
            <span className="chip chip-dot" style={{ ["--c" as string]: setup.localReady ? "#00e436" : "#83769c" }}>
              Local mode {setup.localReady ? "ready" : "not ready"}
            </span>
          </div>
          <ul>
            {setup.checks.map((c) => (
              <CheckRow
                key={c.id}
                c={c}
                running={runningId === c.id}
                onRun={() => {
                  setRunningId(c.id);
                  officeActions.runSetupFix(c.id);
                }}
              />
            ))}
          </ul>
          {runningId && (
            <div className="mb-2 mt-1 border-[3px] border-ink">
              <div className="flex items-center justify-between bg-navy px-2 py-1 text-[13px] text-cream">
                <span>Running · type here if it asks for input</span>
                <button className="text-[12px] underline" onClick={() => setRunningId(null)}>
                  Hide
                </button>
              </div>
              <div className="h-[220px]">
                <TerminalView key={runningId} agentId={`setup:${runningId}`} />
              </div>
            </div>
          )}
          {!setup.sandboxReady && setup.localReady && (
            <p className="mb-2 border-[3px] border-orange bg-[#fff1d6] px-3 py-2 text-[14px]">
              Sandboxes aren't available here, but Local mode is. Set agents to <b>Local</b> in Settings → Team. They run plain Claude Code in their own folder, with permission prompts on.
            </p>
          )}
        </div>
        <div className="flex items-center justify-between gap-3 border-t-[3px] border-ink px-4 py-2">
          <span className="text-[12px] text-muted">HQ never runs sudo or install scripts for you. "Run in terminal" shows exactly what runs.</span>
          <button className="btn" onClick={() => ui.closeSetup()}>
            Continue to the office
          </button>
        </div>
      </div>
    </div>
  );
}
