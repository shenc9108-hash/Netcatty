/**
 * Android implementation of `getServerStats` / `getSessionDistroInfo`.
 * Mirrors electron/bridges/sshBridge/sessionOps.cjs (collectServerStats), Linux only:
 * run the probe over an SSH exec channel, parse the `KEY:value|KEY:value` line, and derive
 * CPU % and network speed from the delta against the previous sample of the same session.
 * Not ported: macOS, GPU, disk-IO speed, SSH-ping latency.
 */
import { LINUX_DISK_COMMAND, LINUX_STATS_COMMAND } from './serverStatsCommands.generated';

export type ExecFn = (p: {
  sessionId: string;
  command: string;
  chatSessionId?: string;
  timeoutMs?: number;
}) => Promise<any>;

interface CoreRaw { total: number; idle: number }
interface IfaceRaw { name: string; rxBytes: number; txBytes: number }
export interface PrevSample {
  cpu: { total: number; idle: number; perCore: CoreRaw[] } | null;
  net: { at: number; ifaces: IfaceRaw[] } | null;
}

const STATS_CHANNEL = '__stats__'; // separate from AI exec so cancelling a chat never kills polling
const prevBySession = new Map<string, PrevSample>();
const inflight = new Map<string, Promise<any>>();

export const forgetServerStats = (sessionId: string) => {
  prevBySession.delete(sessionId);
  inflight.delete(sessionId);
};

const clampPct = (v: number) => Math.max(0, Math.min(100, Math.round(v)));
const num = (s: string | undefined) => {
  const n = parseInt(String(s ?? ''), 10);
  return Number.isNaN(n) ? null : n;
};

/** Pure parser: output of stats(+disk) command -> desktop-shaped `stats`, updating `prev`. */
export function parseServerStats(output: string, prev: PrevSample, now = Date.now()) {
  let cpuTotal: number | null = null;
  let cpuIdle: number | null = null;
  let perCoreRaw: CoreRaw[] = [];
  let cpuCores: number | null = null;
  let memTotal: number | null = null, memFree: number | null = null;
  let memBuffers: number | null = null, memCached: number | null = null, memUsed: number | null = null;
  let swapTotal: number | null = null, swapUsed: number | null = null;
  const topProcesses: { pid: string; memPercent: number; command: string }[] = [];
  const disks: any[] = [];
  const ifaces: IfaceRaw[] = [];
  let hostname = '', osName = '', kernelRelease = '';
  let uptimeSeconds: number | null = null;
  let loadAverage: number[] = [];

  for (const part of output.split('|')) {
    if (part.startsWith('CPURAW:')) {
      const p = part.slice(7).trim().split(/\s+/);
      if (p.length >= 2) { cpuTotal = parseInt(p[0], 10); cpuIdle = parseInt(p[1], 10); }
    } else if (part.startsWith('CORES:')) {
      const v = num(part.slice(6));
      if (v && v > 0) cpuCores = v;
    } else if (part.startsWith('PERCORERAW:')) {
      const s = part.slice(11).trim();
      if (s) {
        perCoreRaw = s.split(',').map((v) => {
          const [t, i] = v.trim().split(':');
          const total = parseInt(t, 10), idle = parseInt(i, 10);
          return Number.isNaN(total) || Number.isNaN(idle) ? null : { total, idle };
        }).filter((v): v is CoreRaw => v !== null);
      }
    } else if (part.startsWith('MEMINFO:')) {
      const m = part.slice(8).trim().split(/\s+/);
      if (m.length >= 4) {
        memTotal = num(m[0]); memFree = num(m[1]); memBuffers = num(m[2]); memCached = num(m[3]);
        if (memTotal !== null && memFree !== null && memBuffers !== null && memCached !== null) {
          memUsed = Math.max(0, memTotal - memFree - memBuffers - memCached);
        }
        if (m.length >= 6) {
          swapTotal = num(m[4]);
          const sf = num(m[5]);
          if (sf !== null) swapUsed = swapTotal !== null ? Math.max(0, swapTotal - sf) : null;
        }
      }
    } else if (part.startsWith('PROCS:')) {
      const s = part.slice(6).trim();
      if (s) {
        for (const entry of s.split(',')) {
          const f = entry.split(';');
          if (f.length >= 3) {
            const memPercent = parseFloat(f[1]);
            if (!Number.isNaN(memPercent)) topProcesses.push({ pid: f[0], memPercent, command: f.slice(2).join(';') });
          }
        }
      }
    } else if (part.startsWith('DISKS:')) {
      const s = part.slice(6).trim();
      if (s) {
        for (const entry of s.split(',')) {
          const f = entry.split(':');
          if (f.length < 4) continue;
          const used = parseFloat(f[1]), total = parseFloat(f[2]);
          let percent = parseInt(f[3], 10);
          if (Number.isNaN(percent) && Number.isFinite(used) && total > 0) percent = Math.round((used / total) * 100);
          if (Number.isNaN(used) || Number.isNaN(total) || Number.isNaN(percent) || total <= 0) continue;
          const meta = f.slice(4).join(':').trim();
          let capacityKey = meta;
          let filesystemType: string | undefined;
          if (meta.startsWith('fs=')) {
            const sep = meta.indexOf(':');
            if (sep > 3) { filesystemType = meta.slice(3, sep).trim(); capacityKey = meta.slice(sep + 1).trim(); }
          }
          disks.push({
            mountPoint: f[0], used, total, percent,
            ...(capacityKey ? { capacityKey } : {}),
            ...(filesystemType ? { filesystemType } : {}),
          });
        }
      }
    } else if (part.startsWith('NET:')) {
      const s = part.slice(4).trim();
      if (s) {
        for (const entry of s.split(',')) {
          const f = entry.split(':');
          if (f.length >= 3) {
            const rx = parseInt(f[1], 10), tx = parseInt(f[2], 10);
            if (!Number.isNaN(rx) && !Number.isNaN(tx)) ifaces.push({ name: f[0], rxBytes: rx, txBytes: tx });
          }
        }
      }
    } else if (part.startsWith('HOST:')) hostname = part.slice(5).trim();
    else if (part.startsWith('OS:')) osName = part.slice(3).trim();
    else if (part.startsWith('KERNEL:')) kernelRelease = part.slice(7).trim();
    else if (part.startsWith('UPTIME:')) {
      const t = part.slice(7).trim();
      if (t !== '' && Number.isFinite(Number(t)) && Number(t) >= 0) uptimeSeconds = Number(t);
    } else if (part.startsWith('LOAD:')) {
      const t = part.slice(5).trim();
      if (t) loadAverage = t.split(/\s+/).map(Number).filter((v) => Number.isFinite(v) && v >= 0).slice(0, 3);
    }
  }

  // ---- network speed from the previous sample ----
  const prevNet = prev.net;
  const dt = prevNet ? (now - prevNet.at) / 1000 : 0;
  let netRxSpeed = 0, netTxSpeed = 0;
  const netInterfaces = ifaces.map((i) => {
    const p = dt > 0 ? prevNet!.ifaces.find((x) => x.name === i.name) : undefined;
    const rxSpeed = p && i.rxBytes - p.rxBytes > 0 ? Math.round((i.rxBytes - p.rxBytes) / dt) : 0;
    const txSpeed = p && i.txBytes - p.txBytes > 0 ? Math.round((i.txBytes - p.txBytes) / dt) : 0;
    netRxSpeed += rxSpeed; netTxSpeed += txSpeed;
    return { ...i, rxSpeed, txSpeed };
  });
  const networkReady = !!prevNet && prevNet.ifaces.length > 0;
  prev.net = { at: now, ifaces };

  // ---- CPU % from the previous sample ----
  const pc = prev.cpu;
  let cpu: number | null = null;
  if (cpuTotal !== null && cpuIdle !== null && pc && pc.total > 0) {
    const td = cpuTotal - pc.total, id = cpuIdle - pc.idle;
    if (td > 0) cpu = clampPct(100 - (id / td) * 100);
  }
  let cpuPerCore: number[] = [];
  if (perCoreRaw.length > 0) {
    cpuPerCore = perCoreRaw.map((c, i) => {
      const p = pc?.perCore[i];
      if (!p) return 0;
      const td = c.total - p.total, id = c.idle - p.idle;
      return td > 0 ? clampPct(100 - (id / td) * 100) : 0;
    });
  }
  prev.cpu = { total: cpuTotal || 0, idle: cpuIdle || 0, perCore: perCoreRaw };

  const root = disks.find((d) => d.mountPoint === '/');

  if (cpu === null && memTotal === null && cpuCores === null) {
    return { success: false as const, error: 'Unable to parse server stats (unsupported OS or shell)' };
  }
  return {
    success: true as const,
    stats: {
      cpu, cpuCores, cpuPerCore,
      gpu: null, gpuName: null, gpuMemUsed: null, gpuMemTotal: null, gpus: [],
      memTotal, memUsed, memFree, memBuffers, memCached, swapTotal, swapUsed,
      topProcesses,
      diskPercent: root ? root.percent : null,
      diskUsed: root ? root.used : null,
      diskTotal: root ? root.total : null,
      disks,
      networkReady, netRxSpeed, netTxSpeed,
      latencyMs: null, responseLatencyMs: null,
      netInterfaces,
      hostname, osName, kernelRelease, uptimeSeconds, loadAverage,
    },
  };
}

async function run(sessionId: string, command: string, exec: ExecFn, timeoutMs: number) {
  const r = await exec({ sessionId, command, chatSessionId: STATS_CHANNEL, timeoutMs });
  if (!r || r.ok === false) throw new Error(r?.error || 'exec failed');
  return String(r.stdout || '').trim();
}

export function getServerStats(sessionId: string, exec: ExecFn) {
  const pending = inflight.get(sessionId); // never stack polls on one session
  if (pending) return pending;
  const p = (async () => {
    try {
      let out = await run(sessionId, LINUX_STATS_COMMAND, exec, 12000);
      if (out.startsWith('UNSUPPORTED_OS:')) {
        return { success: false, error: `Server stats not supported on this OS (${out.slice(15)})` };
      }
      if (out.startsWith('CPURAW:')) {
        const disk = await run(sessionId, LINUX_DISK_COMMAND, exec, 12000).catch(() => '');
        if (disk) out = `${out}|${disk}`;
      }
      let prev = prevBySession.get(sessionId);
      if (!prev) { prev = { cpu: null, net: null }; prevBySession.set(sessionId, prev); }
      return parseServerStats(out, prev);
    } catch (e: any) {
      const m = String(e?.message || e);
      return { success: false, error: /timed out/i.test(m) ? 'Timeout getting server stats' : m };
    } finally {
      inflight.delete(sessionId);
    }
  })();
  inflight.set(sessionId, p);
  return p;
}

/** Used by the renderer to auto-detect the distro (host OS "auto" -> linux), which gates stats. */
export async function getSessionDistroInfo(sessionId: string, exec: ExecFn) {
  try {
    const r = await exec({
      sessionId, command: 'cat /etc/os-release 2>/dev/null || uname -a', chatSessionId: STATS_CHANNEL, timeoutMs: 8000,
    });
    if (!r || r.ok === false) return { success: false, error: r?.error || 'exec failed' };
    return { success: true, stdout: r.stdout || '', stderr: r.stderr || '' };
  } catch (e: any) {
    return { success: false, error: String(e?.message || e) };
  }
}
