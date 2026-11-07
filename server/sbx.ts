// Real sandbox settings through the sbx CLI. HQ reads back what sbx has (rules,
// keys, proxy) and syncs each agent's allowed/blocked domains. It only ever
// removes rules it added itself (tracked in ~/.jsmhq/<project>/sbx-owned.json).

import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BasePolicy, SbxAgentState, SbxPort, SbxRule, SbxState } from "../src/data/types";
import type { Hub } from "./hub";
import { parseCliJson, sandboxList } from "./lib/json";
import { run } from "./lib/exec";
import { log } from "./lib/log";
import { projectHome, sessionName } from "./paths";
import { policyVerdict } from "./setup";

interface RawRule {
  id: string;
  applies_to: string;
  resource_type: string;
  decision: "allow" | "deny";
  resources: string[];
  layer: string; // local | org | …
  origin?: string;
  status?: string;
  provenance?: { created_via?: string };
}

const key = (decision: string, resource: string) => `${decision} ${resource}`;

/**
 * The resource an approval is for, as an allow rule: "mcp.notion.com:443". The port is kept so Allow
 * opens exactly what was blocked. HTTP-style titles ("GET host:443/path") keep only host:port.
 */
export function approvalHost(title: string): string {
  const m = title.trim().match(/^(?:[A-Z]+\s+)?(?:[a-z]+:\/\/)?([^/\s?#]+)/);
  return (m?.[1] ?? title.trim()).toLowerCase();
}

export class Sbx {
  state: SbxState;
  private ownedFile: string;
  private owned: Record<string, string[]>; // sandbox name → "allow foo.com" entries HQ added

  constructor(private hub: Hub) {
    this.ownedFile = join(projectHome(hub.slug), "sbx-owned.json");
    this.owned = (existsSync(this.ownedFile) && parseCliJson<Record<string, string[]>>(readFileSync(this.ownedFile, "utf8"))) || {};
    this.state = { basePolicy: "unknown", proxy: null, globalKeys: [], agents: {}, checkedAt: new Date().toISOString() };
  }

  private saveOwned() {
    writeFileSync(this.ownedFile, JSON.stringify(this.owned, null, 2));
  }

  private name(agentId: string) {
    return sessionName(this.hub.slug, agentId);
  }

  envFile(agentId: string) {
    return join(projectHome(this.hub.slug), `${agentId}.env`);
  }

  private publish() {
    this.state.checkedAt = new Date().toISOString();
    this.hub.snap.sbx = this.state;
    this.hub.emit({ type: "sbx.updated", sbx: structuredClone(this.state) });
  }

  // ------------------------------------------------------------ read back

  /** Network rules in effect, or null when sbx's list couldn't be read (not the same as "no rules"). */
  private async rules(): Promise<RawRule[] | null> {
    const r = await run("sbx", ["policy", "ls", "--json", "--type", "network"], { timeoutMs: 15_000 });
    if (!r.ok) return null;
    const data = parseCliJson<{ rules?: RawRule[] }>(r.stdout);
    if (!data) return null;
    return (data.rules ?? []).filter((x) => x.resource_type === "network" && x.status !== "inactive");
  }

  private async basePolicy(): Promise<BasePolicy> {
    const allowed = async (target: string) => (await policyVerdict(target)).verdict === "allowed";
    // A made-up host is only allowed under allow-all; a registry is allowed under balanced too.
    if (await allowed("hq-probe.invalid")) return "allow-all";
    if (await allowed("registry.npmjs.org")) return "balanced";
    return "deny-all";
  }

  /** Re-reads everything from sbx and publishes it. */
  async refresh() {
    if (!this.hub.snap.setup.sandboxReady) {
      this.state.agents = Object.fromEntries(this.hub.snap.config.team.map((a) => [a.id, this.emptyAgent(a.id)]));
      return this.publish();
    }
    const [rules, keysOut, proxyOut, base] = await Promise.all([
      this.rules().then((list) => list ?? []),
      run("sbx", ["secret", "ls", "--json"], { timeoutMs: 15_000 }),
      run("sbx", ["settings", "get", "proxy.sandbox"], { timeoutMs: 10_000 }),
      this.basePolicy(),
    ]);
    let secrets: { scope: string; type: string; name: string }[] = [];
    try {
      secrets = parseCliJson<{ secrets?: typeof secrets }>(keysOut.stdout)?.secrets ?? [];
    } catch {
      /* sbx down */
    }
    this.state.basePolicy = base;
    this.state.proxy = proxyOut.stdout.trim() || null;
    this.state.globalKeys = secrets.filter((s) => s.type === "service" && s.scope === "global").map((s) => s.name);
    const prevErrors = this.state.agents;
    this.state.agents = {};
    for (const a of this.hub.snap.config.team) {
      const name = this.name(a.id);
      const mine = new Set(this.owned[name] ?? []);
      const sandboxRules: SbxRule[] = rules
        .filter((r) => r.applies_to === `sandbox:${name}`)
        .map((r) => ({
          id: r.id,
          decision: r.decision,
          resources: r.resources,
          source: r.layer === "org" ? "org" : r.origin === "kit" || ["default", "provisioned"].includes(r.provenance?.created_via ?? "") ? "kit" : r.resources.every((x) => mine.has(key(r.decision, x))) ? "hq" : "cli",
        }));
      this.state.agents[a.id] = {
        rules: sandboxRules,
        // sbx reports a sandbox scope as the bare sandbox name.
        keys: secrets.filter((s) => s.type === "service" && (s.scope === name || s.scope === `sandbox:${name}`)).map((s) => s.name),
        envFile: { path: this.envFile(a.id), exists: existsSync(this.envFile(a.id)) },
        syncError: prevErrors[a.id]?.syncError ?? null,
        approvals: prevErrors[a.id]?.approvals ?? [],
        ports: prevErrors[a.id]?.ports ?? [],
      };
    }
    this.publish();
    await this.refreshPorts();
  }

  private emptyAgent(agentId: string): SbxAgentState {
    return { rules: [], keys: [], envFile: { path: this.envFile(agentId), exists: existsSync(this.envFile(agentId)) }, syncError: null, approvals: [], ports: [] };
  }

  // ------------------------------------------------------------ ports

  /** Published ports of one sandbox, or null if sbx couldn't list them (e.g. the sandbox is gone). */
  private async readPorts(agentId: string): Promise<SbxPort[] | null> {
    const r = await run("sbx", ["ports", this.name(agentId), "--json"], { timeoutMs: 10_000 });
    type Row = { host_port?: number; sandbox_port?: number };
    const data = r.ok ? parseCliJson<Row[] | { ports?: Row[] }>(r.stdout) : null;
    if (!data) return null;
    const rows = Array.isArray(data) ? data : (data.ports ?? []);
    // tcp4 and tcp6 bindings of the same port are listed separately.
    const seen = new Map<number, SbxPort>();
    for (const p of rows) if (p.sandbox_port && p.host_port) seen.set(p.sandbox_port, { sandbox: p.sandbox_port, host: p.host_port });
    return [...seen.values()].sort((a, b) => a.sandbox - b.sandbox);
  }

  /** Re-reads forwarded ports for running sandboxed agents. */
  async refreshPorts(agentId?: string) {
    const ids = agentId ? [agentId] : this.hub.snap.config.team.map((a) => a.id);
    let changed = false;
    for (const id of ids) {
      const a = this.hub.cfg(id);
      const st = this.state.agents[id];
      if (!a || !st) continue;
      const running = a.mode === "sandbox" && this.hub.status(id)?.session.state === "running";
      const ports = running ? ((await this.readPorts(id)) ?? []) : [];
      if (JSON.stringify(ports) !== JSON.stringify(st.ports ?? [])) (st.ports = ports), (changed = true);
    }
    if (changed) this.publish();
  }

  /**
   * Makes a port inside the agent's sandbox reachable at the same port on this machine (loopback
   * only), e.g. for a CLI sign-in whose browser callback goes to localhost:<port>.
   */
  async forwardPort(agentId: string, port: number) {
    const a = this.hub.cfg(agentId);
    if (!a || a.mode !== "sandbox" || !Number.isInteger(port) || port < 1 || port > 65535) return;
    const r = await run("sbx", ["ports", this.name(agentId), "--publish", `127.0.0.1:${port}:${port}`], { timeoutMs: 30_000 });
    if (r.ok) this.hub.activity("config", agentId, `Forwarded port ${port} from ${a.name}'s sandbox to localhost:${port} on this machine.`);
    else {
      const why = `${r.stdout}\n${r.stderr}`.trim().split("\n").filter(Boolean).pop()?.replace(/^error: /i, "") ?? "";
      const inUse = /in use|already allocated|address already/i.test(why);
      this.hub.activity(
        "config",
        agentId,
        `Couldn't forward port ${port} from ${a.name}'s sandbox: ${inUse ? `something on this machine already uses port ${port}. Stop it and try again.` : why.slice(0, 160)}`,
      );
    }
    await this.refreshPorts(agentId);
  }

  async unforwardPort(agentId: string, port: number) {
    const a = this.hub.cfg(agentId);
    if (!a || !Number.isInteger(port) || port < 1 || port > 65535) return;
    const host = this.state.agents[agentId]?.ports?.find((p) => p.sandbox === port)?.host ?? port;
    const r = await run("sbx", ["ports", this.name(agentId), "--unpublish", `127.0.0.1:${host}:${port}`], { timeoutMs: 30_000 });
    if (!r.ok) this.hub.activity("config", agentId, `Couldn't stop forwarding port ${port}: ${(r.stderr || r.stdout).trim().split("\n").pop()?.slice(0, 160)}`);
    await this.refreshPorts(agentId);
  }

  // ------------------------------------------------------------ approvals

  private seenApprovals = new Set<string>();
  private approvalTimer: NodeJS.Timeout | null = null;

  /** sbx's queue of blocked requests. It has no JSON output, so the table is read by its header's columns. */
  private async readApprovals(): Promise<{ id: string; sandbox: string; title: string; detail: string }[] | null> {
    const r = await run("sbx", ["policy", "approval", "ls"], { timeoutMs: 10_000 });
    if (!r.ok) return null;
    const lines = r.stdout.split("\n").filter((l) => l.trim());
    const head = lines.findIndex((l) => /^APPROVAL\s+SANDBOX\s+TITLE\s+DETAIL/.test(l));
    // An empty queue prints a sentence ("No pending approvals.") instead of a table.
    if (head === -1) return lines.every((l) => /no pending approvals/i.test(l)) ? [] : null;
    const at = ["APPROVAL", "SANDBOX", "TITLE", "DETAIL", "OPTIONS"].map((c) => lines[head].indexOf(c));
    const cell = (l: string, i: number) => l.slice(at[i], at[i + 1] > 0 ? at[i + 1] : undefined).trim();
    return lines
      .slice(head + 1)
      .map((l) => ({ id: cell(l, 0), sandbox: cell(l, 1), title: cell(l, 2), detail: cell(l, 3) }))
      .filter((a) => /^network:\S+$/.test(a.id));
  }

  private approvalReads: Promise<void> = Promise.resolve();
  private approvalReadsPending = 0;

  /** Reads run one at a time, in order, so an older, slower read can't overwrite a newer one. */
  refreshApprovals(): Promise<void> {
    this.approvalReadsPending++;
    const next = this.approvalReads.then(() => this.readAndShowApprovals());
    this.approvalReads = next.catch(() => {}).finally(() => this.approvalReadsPending--);
    return next;
  }

  /** Re-reads the approval queue and shows each HQ agent's blocked requests (new ones once in the activity feed). */
  private async readAndShowApprovals() {
    if (!this.hub.snap.setup.sandboxReady) return;
    const all = await this.readApprovals();
    if (!all) return;
    let changed = false;
    const fresh: { agentId: string; host: string }[] = [];
    for (const a of this.hub.snap.config.team) {
      const name = this.name(a.id);
      const list = all
        .filter((x) => x.sandbox === name)
        .map((x) => ({
          id: x.id,
          host: approvalHost(x.title),
          title: x.title.trim(),
          detail: x.detail.replace(/^Protocol: \S+ Resource type: \S+ /, ""),
          hostWide: approvalHost(x.title) === x.title.trim().toLowerCase(),
          protocol: x.detail.match(/Protocol:\s*(\S+)/i)?.[1]?.toUpperCase(),
        }));
      const st = (this.state.agents[a.id] ??= this.emptyAgent(a.id));
      if (JSON.stringify(st.approvals) !== JSON.stringify(list)) {
        st.approvals = list;
        changed = true;
      }
      for (const x of list) if (!this.seenApprovals.has(x.id)) (this.seenApprovals.add(x.id), fresh.push({ agentId: a.id, host: x.host }));
    }
    if (changed) this.publish();
    const byAgent = new Map<string, string[]>();
    for (const f of fresh) byAgent.set(f.agentId, [...(byAgent.get(f.agentId) ?? []), f.host]);
    for (const [id, hosts] of byAgent)
      this.hub.activity("agent.needs-input", id, `${this.hub.name(id)}'s sandbox blocked ${hosts.slice(0, 3).join(", ")}${hosts.length > 3 ? ` and ${hosts.length - 3} more` : ""}. Allow or dismiss in the agent's drawer.`);
  }

  startApprovalPolling(ms = 5000) {
    if (this.approvalTimer) return;
    // Skip a tick while a read is still queued or running.
    const tick = () => void (this.approvalReadsPending ? Promise.resolve() : this.refreshApprovals()).catch((e) => log.warn("approvals:", e));
    tick();
    this.approvalTimer = setInterval(tick, ms);
  }

  stopApprovalPolling() {
    if (this.approvalTimer) clearInterval(this.approvalTimer);
    this.approvalTimer = null;
  }

  private answering = new Set<string>(); // agents with an answer in flight

  /**
   * Answers blocked requests. Allow adds an HQ-owned allow rule for exactly that host:port (shown and
   * removable in Settings → Sandbox) and clears every queued request for it; Dismiss clears only the one.
   * "all" answers every listed request the same way. One answer per agent at a time; a second click meanwhile is ignored.
   */
  async answerApproval(agentId: string, approvalId: string | "all", decision: "allow" | "dismiss") {
    if (this.answering.has(agentId)) return;
    this.answering.add(agentId);
    try {
      await this.answer(agentId, approvalId, decision);
    } finally {
      this.answering.delete(agentId);
    }
  }

  private async respondApproval(id: string, option: "allow" | "dismiss"): Promise<boolean> {
    return (await run("sbx", ["policy", "approval", "respond", id, "--option", option], { timeoutMs: 10_000 })).ok;
  }

  private async answer(agentId: string, approvalId: string | "all", decision: "allow" | "dismiss") {
    const list = [...(this.state.agents[agentId]?.approvals ?? [])];
    const target = approvalId === "all" ? null : list.find((a) => a.id === approvalId);
    if (approvalId !== "all" && !target) return;
    const respond = (id: string, option: "allow" | "dismiss") => this.respondApproval(id, option);
    if (decision === "allow" && approvalId === "all") return this.allowAll(agentId, list);

    if (decision === "allow" && target) {
      const who = this.hub.name(agentId);
      // Blocked by an organization policy (a local rule wouldn't apply), or narrower than host:port
      // (a rule would allow more than was asked): answer sbx's own approval, which keeps its scope.
      // Same for anything but TCP (sbx rules are TCP; a UDP request would stay blocked).
      const tcp = !target.protocol || target.protocol === "TCP";
      if (/required by policy|organi[sz]ation/i.test(target.detail) || target.hostWide === false || !tcp) {
        if (await respond(target.id, "allow")) this.hub.activity("config", agentId, `You approved ${target.host} for ${who}'s sandbox`);
        else this.hub.activity("config", agentId, `Couldn't approve ${target.host}: sbx refused it.`);
        return this.refreshApprovals();
      }
      const agent = this.hub.cfg(agentId);
      if (!agent) return;
      const added = !agent.sandbox.allow.includes(target.host);
      if (added) {
        agent.sandbox.allow = [...agent.sandbox.allow, target.host];
        this.hub.configChanged();
      }
      await this.syncRules(agentId);
      // Success only when sbx now lists the rule for this sandbox (syncRules skips a Local-mode agent
      // or a missing sandbox without an error).
      const err = this.state.agents[agentId]?.syncError;
      const applied = this.state.agents[agentId]?.rules.some((r) => r.decision === "allow" && r.resources.includes(target.host));
      if (!applied || err?.includes(target.host)) {
        if (added) {
          agent.sandbox.allow = agent.sandbox.allow.filter((h) => h !== target.host);
          this.hub.configChanged();
          await this.syncRules(agentId);
        }
        const why = err ? err.slice(0, 160) : agent.mode !== "sandbox" ? `${who} isn't in Sandbox mode` : "sbx didn't apply the rule";
        this.hub.activity("config", agentId, `Couldn't allow ${target.host}: ${why}. The request is still listed.`);
        return;
      }
      // The rule covers TCP to that host:port: clear those entries only (a UDP one stays listed).
      for (const a of list.filter((x) => x.host === target.host && (!x.protocol || x.protocol === "TCP") && x.hostWide !== false)) await respond(a.id, "dismiss");
      this.hub.activity("config", agentId, `You allowed ${target.host} for ${who}'s sandbox`);
    } else {
      for (const a of approvalId === "all" ? list : [target!]) await respond(a.id, "dismiss");
    }
    await this.refreshApprovals();
  }

  /** Allow all: one sync for every host:port rule, then sbx's own approval for the rest (same split as one Allow). */
  private async allowAll(agentId: string, list: SbxAgentState["approvals"]) {
    const agent = this.hub.cfg(agentId);
    if (!agent || !list.length) return;
    const who = this.hub.name(agentId);
    const viaRule = (a: (typeof list)[number]) =>
      (!a.protocol || a.protocol === "TCP") && a.hostWide !== false && !/required by policy|organi[sz]ation/i.test(a.detail);
    const failed: string[] = [];
    for (const a of list.filter((x) => !viaRule(x))) if (!(await this.respondApproval(a.id, "allow"))) failed.push(a.host);

    const hosts = [...new Set(list.filter(viaRule).map((a) => a.host))];
    const added = hosts.filter((h) => !agent.sandbox.allow.includes(h));
    if (added.length) {
      agent.sandbox.allow = [...agent.sandbox.allow, ...added];
      this.hub.configChanged();
    }
    if (hosts.length) await this.syncRules(agentId);
    const st = this.state.agents[agentId];
    const applied = (h: string) => st?.rules.some((r) => r.decision === "allow" && r.resources.includes(h)) && !st?.syncError?.includes(h);
    const notApplied = hosts.filter((h) => !applied(h));
    // Hosts sbx didn't take come back off the list (and stay listed as blocked), as with one Allow.
    const undo = added.filter((h) => notApplied.includes(h));
    if (undo.length) {
      agent.sandbox.allow = agent.sandbox.allow.filter((h) => !undo.includes(h));
      this.hub.configChanged();
      await this.syncRules(agentId);
    }
    failed.push(...notApplied);
    for (const a of list.filter((x) => viaRule(x) && !notApplied.includes(x.host))) await this.respondApproval(a.id, "dismiss");

    const ok = new Set(list.map((a) => a.host).filter((h) => !failed.includes(h))).size;
    if (ok) this.hub.activity("config", agentId, `You allowed ${ok} site${ok === 1 ? "" : "s"} for ${who}'s sandbox`);
    if (failed.length) {
      const why = agent.mode !== "sandbox" ? `${who} isn't in Sandbox mode` : st?.syncError?.slice(0, 120) || "sbx didn't apply them";
      this.hub.activity("config", agentId, `Couldn't allow ${failed.slice(0, 3).join(", ")}${failed.length > 3 ? ` and ${failed.length - 3} more` : ""}: ${why}. They're still listed.`);
    }
    await this.refreshApprovals();
  }

  // ------------------------------------------------------------ apply

  /** True if sbx knows a sandbox with this name. */
  async exists(agentId: string): Promise<boolean> {
    const r = await run("sbx", ["ls", "--json"], { timeoutMs: 10_000 });
    try {
      return (sandboxList(r.stdout) ?? []).some((s) => s.name === this.name(agentId));
    } catch {
      return false;
    }
  }

  /**
   * Makes the sandbox's allow/deny rules match the agent's lists. Adds what's
   * missing; removes only rules HQ added earlier. Needs the sandbox to exist.
   */
  async syncRules(agentId: string): Promise<void> {
    const agent = this.hub.cfg(agentId);
    if (!agent || agent.mode !== "sandbox" || !(await this.exists(agentId))) return;
    const name = this.name(agentId);
    const want = new Set([...agent.sandbox.allow.map((r) => key("allow", r)), ...agent.sandbox.deny.map((r) => key("deny", r))]);
    const owned = new Set(this.owned[name] ?? []);
    const all = await this.rules();
    if (!all) {
      // Can't tell what's there: change nothing, and keep the record of rules HQ added, so they can
      // still be removed later.
      log.warn(`sbx rules for ${name}: couldn't read sbx's rule list; nothing changed`);
      (this.state.agents[agentId] ??= this.emptyAgent(agentId)).syncError = "Couldn't read sbx's rules; nothing was changed. Try again.";
      this.publish();
      return;
    }
    const rules = all.filter((r) => r.applies_to === `sandbox:${name}`);
    const have = new Set(rules.flatMap((r) => r.resources.map((x) => key(r.decision, x))));
    const errors: string[] = [];

    for (const entry of want) {
      if (have.has(entry)) continue;
      const [decision, resource] = entry.split(" ");
      const r = await run("sbx", ["policy", decision, "network", "--sandbox", name, resource], { timeoutMs: 15_000 });
      if (r.ok) owned.add(entry);
      else errors.push(`${decision} ${resource}: ${r.stderr.trim().split("\n")[0]}`);
    }
    for (const entry of [...owned]) {
      if (want.has(entry)) continue;
      const [decision, resource] = entry.split(" ");
      const rule = rules.find((r) => r.decision === decision && r.resources.includes(resource));
      const r = rule
        ? await run("sbx", ["policy", "rm", "network", "--sandbox", name, "--id", rule.id, "--force"], { timeoutMs: 15_000 })
        : { ok: true, stderr: "" };
      if (r.ok) owned.delete(entry);
      else errors.push(`remove ${resource}: ${r.stderr.trim().split("\n")[0]}`);
    }
    this.owned[name] = [...owned];
    this.saveOwned();
    if (errors.length) log.warn(`sbx rules for ${name}:`, errors.join("; "));
    await this.refresh();
    if (this.state.agents[agentId]) {
      this.state.agents[agentId].syncError = errors.length ? errors.join("; ") : null;
      this.publish();
    }
  }

  /** Stores a service key (value via stdin, never kept). agentId null = every sandbox. */
  async setKey(agentId: string | null, service: string, value: string) {
    const args = ["secret", "set", service, ...(agentId ? ["--sandbox", this.name(agentId)] : []), "--force"];
    const r = await run("sbx", args, { timeoutMs: 20_000, input: value.trim() + "\n" });
    if (!r.ok) throw new Error(r.stderr.trim().split("\n")[0] || "sbx secret set failed");
    await this.refresh();
  }

  async removeKey(agentId: string | null, service: string) {
    const r = await run("sbx", ["secret", "rm", service, ...(agentId ? ["--sandbox", this.name(agentId)] : []), "--force"], { timeoutMs: 20_000 });
    if (!r.ok) throw new Error(r.stderr.trim().split("\n")[0] || "sbx secret rm failed");
    await this.refresh();
  }

  async setProxy(url: string | null) {
    const r = url
      ? await run("sbx", ["settings", "set", "proxy.sandbox", url], { timeoutMs: 15_000 })
      : await run("sbx", ["settings", "unset", "proxy.sandbox"], { timeoutMs: 15_000 });
    if (!r.ok) throw new Error(r.stderr.trim().split("\n")[0] || "sbx settings failed");
    await this.refresh();
  }

  /** Creates the agent's env file (0600) if missing. Returns its path. Never reads values. */
  ensureEnvFile(agentId: string): string {
    const file = this.envFile(agentId);
    if (!existsSync(file)) {
      writeFileSync(
        file,
        `# App variables for ${this.hub.name(agentId)} (${this.hub.snap.config.project.name}).\n` +
          "# One KEY=value per line. These values ENTER the agent's VM — use test/dev credentials.\n" +
          "# Restart the agent after editing. BasePod HQ never reads or commits this file.\n",
        { mode: 0o600 },
      );
    }
    chmodSync(file, 0o600);
    return file;
  }
}
