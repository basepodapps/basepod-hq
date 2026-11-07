import { execFile } from "node:child_process";

export interface RunResult {
  ok: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Runs a program without a shell. Never throws; check `ok`. */
export function run(cmd: string, args: string[], opts: { cwd?: string; timeoutMs?: number; input?: string; env?: Record<string, string> } = {}): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = execFile(
      cmd,
      args,
      { cwd: opts.cwd, timeout: opts.timeoutMs ?? 20_000, maxBuffer: 8 * 1024 * 1024, env: opts.env ? { ...process.env, ...opts.env } : process.env },
      (err, stdout, stderr) => {
        const code = err && typeof (err as NodeJS.ErrnoException).code === "number" ? Number((err as NodeJS.ErrnoException).code) : err ? null : 0;
        resolve({ ok: !err, code: err ? (code ?? 1) : 0, stdout: String(stdout), stderr: String(stderr || (err && !stderr ? err.message : "")) });
      },
    );
    if (opts.input !== undefined) child.stdin?.end(opts.input);
  });
}

/** True when `cmd` is on PATH. */
export async function has(cmd: string): Promise<boolean> {
  const r = process.platform === "win32" ? await run("where", [cmd], { timeoutMs: 5000 }) : await run("sh", ["-c", `command -v ${cmd}`], { timeoutMs: 5000 });
  return r.ok && r.stdout.trim().length > 0;
}

/** Quotes a value for a POSIX shell command line. */
export function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
