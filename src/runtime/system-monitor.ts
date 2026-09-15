/**
 * Lightweight resource-usage sampler backing GET /api/system.
 *
 * Cost profile (this exists because users reasonably ask "does showing
 * resource usage itself cost much?"):
 *  - node service CPU/RAM/heap: read in-process from process.cpuUsage() /
 *    memoryUsage() deltas — effectively free.
 *  - system memory/CPU: os.freemem() / os.cpus() deltas — free.
 *  - claude.exe child processes: one `powershell Get-Process` query per
 *    sample tick (default every 5s), result cached — the panel only ever
 *    reads the cache, so browser polling adds zero process spawns.
 */

import os from "node:os";
import { spawn } from "node:child_process";

export interface SystemSnapshot {
  sampledAt: string;
  node: {
    pid: number;
    /** 0-100+ per-core scale; null before the second sample. */
    cpuPercent: number | null;
    rssMb: number;
    heapUsedMb: number;
    uptimeSec: number;
  };
  claude: {
    count: number;
    cpuPercent: number | null;
    rssMb: number;
    pids: number[];
  };
  system: {
    totalMemMb: number;
    freeMemMb: number;
    cpuPercent: number | null;
  };
}

interface ClaudeProcSample {
  pid: number;
  cpuSeconds: number;
  rssBytes: number;
}

const MB = 1024 * 1024;

export class SystemMonitor {
  private timer: NodeJS.Timeout | null = null;
  private lastCpuUsage = process.cpuUsage();
  private lastCpuAtMs = Date.now();
  private lastCpus = os.cpus();
  private lastClaude: ClaudeProcSample[] = [];
  private snapshot: SystemSnapshot = {
    sampledAt: new Date().toISOString(),
    node: {
      pid: process.pid,
      cpuPercent: null,
      rssMb: process.memoryUsage().rss / MB,
      heapUsedMb: process.memoryUsage().heapUsed / MB,
      uptimeSec: Math.round(process.uptime()),
    },
    claude: { count: 0, cpuPercent: null, rssMb: 0, pids: [] },
    system: {
      totalMemMb: os.totalmem() / MB,
      freeMemMb: os.freemem() / MB,
      cpuPercent: null,
    },
  };

  start(intervalMs = 5000): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.sample(), intervalMs);
    this.timer.unref?.();
    void this.sample();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  getSnapshot(): SystemSnapshot {
    return { ...this.snapshot, node: { ...this.snapshot.node } };
  }

  private async sample(): Promise<void> {
    const now = Date.now();
    const elapsedMs = Math.max(1, now - this.lastCpuAtMs);

    // node process CPU (per-core scale).
    const usage = process.cpuUsage(this.lastCpuUsage);
    const nodeCpu = ((usage.user + usage.system) / 1000 / elapsedMs) * 100;
    this.lastCpuUsage = process.cpuUsage();
    this.lastCpuAtMs = now;

    // Whole-system CPU from per-core idle-time deltas.
    const cpus = os.cpus();
    const cpuPercent = cpuDeltaPercent(this.lastCpus, cpus);
    this.lastCpus = cpus;

    const mem = process.memoryUsage();

    // claude.exe children: one PowerShell query per tick, cached for readers.
    const procs = await queryClaudeProcesses().catch(() => [] as ClaudeProcSample[]);
    const claudeCpu = deltaSumPercent(
      this.lastClaude,
      procs,
      elapsedMs,
    );
    this.lastClaude = procs;

    this.snapshot = {
      sampledAt: new Date(now).toISOString(),
      node: {
        pid: process.pid,
        cpuPercent: round1(nodeCpu),
        rssMb: round1(mem.rss / MB),
        heapUsedMb: round1(mem.heapUsed / MB),
        uptimeSec: Math.round(process.uptime()),
      },
      claude: {
        count: procs.length,
        cpuPercent: claudeCpu,
        rssMb: round1(procs.reduce((sum, p) => sum + p.rssBytes, 0) / MB),
        pids: procs.map((p) => p.pid),
      },
      system: {
        totalMemMb: round1(os.totalmem() / MB),
        freeMemMb: round1(os.freemem() / MB),
        cpuPercent,
      },
    };
  }
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function cpuDeltaPercent(
  before: os.CpuInfo[],
  after: os.CpuInfo[],
): number | null {
  if (before.length !== after.length || before.length === 0) return null;
  let idleDelta = 0;
  let totalDelta = 0;
  for (let i = 0; i < after.length; i++) {
    const b = cpuTimes(before[i]);
    const a = cpuTimes(after[i]);
    if (!b || !a) return null;
    idleDelta += a.idle - b.idle;
    totalDelta += a.total - b.total;
  }
  if (totalDelta <= 0) return null;
  return round1(Math.max(0, (1 - idleDelta / totalDelta)) * 100);
}

function cpuTimes(cpu: os.CpuInfo): { idle: number; total: number } | null {
  const t = cpu.times;
  if (!t) return null;
  return { idle: t.idle, total: t.user + t.nice + t.sys + t.idle + t.irq };
}

/** Aggregate CPU% of surviving pids via per-pid CPU-second deltas. */
function deltaSumPercent(
  before: ClaudeProcSample[],
  after: ClaudeProcSample[],
  elapsedMs: number,
): number | null {
  if (after.length === 0) return 0;
  const beforeMap = new Map(before.map((p) => [p.pid, p.cpuSeconds]));
  let total = 0;
  let matched = false;
  for (const p of after) {
    const prev = beforeMap.get(p.pid);
    if (prev === undefined) continue;
    matched = true;
    const deltaSeconds = p.cpuSeconds - prev;
    if (deltaSeconds > 0) total += deltaSeconds;
  }
  if (!matched) return null;
  return round1((total / (elapsedMs / 1000)) * 100);
}

/** Single PowerShell round-trip; JSON keeps parsing unambiguous. */
function queryClaudeProcesses(): Promise<ClaudeProcSample[]> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "powershell",
      [
        "-NoProfile", "-Command",
        "Get-Process -Name claude -ErrorAction SilentlyContinue | "
          + "Select-Object Id,CPU,WorkingSet64 | ConvertTo-Json -Compress",
      ],
      { windowsHide: true, timeout: 4000 },
    );
    let out = "";
    let err = "";
    child.stdout?.on("data", (d) => (out += String(d)));
    child.stderr?.on("data", (d) => (err += String(d)));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(err || `exit ${code}`));
        return;
      }
      const text = out.trim();
      if (!text) {
        resolve([]);
        return;
      }
      try {
        const parsed = JSON.parse(text);
        const rows = Array.isArray(parsed) ? parsed : [parsed];
        resolve(
          rows
            .filter((r) => r && typeof r.Id === "number")
            .map((r) => ({
              pid: r.Id,
              cpuSeconds: typeof r.CPU === "number" ? r.CPU : 0,
              rssBytes: typeof r.WorkingSet64 === "number" ? r.WorkingSet64 : 0,
            })),
        );
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  });
}
