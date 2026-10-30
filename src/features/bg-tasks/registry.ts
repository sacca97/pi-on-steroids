import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, closeSync, existsSync, fstatSync, mkdirSync, mkdtempSync, openSync, readSync, rmSync, statSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { getShellConfig } from "@earendil-works/pi-coding-agent";

export const MAX_BACKGROUND_JOBS = 16;
export const MAX_LOG_BYTES = 64 * 1024 * 1024;
const OUTPUT_TAIL_BYTES = 30 * 1024;

/** Milliseconds a killed job gets to shut down cleanly (SIGTERM) before it is force-killed. */
const KILL_GRACE_MS = 2_000;

function signalProcessTree(pid: number, signal: NodeJS.Signals): void {
  try {
    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" }).unref();
    } else {
      process.kill(-pid, signal);
    }
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // already gone
    }
  }
}

function processGroupAlive(pid: number): boolean {
  try {
    process.kill(process.platform === "win32" ? pid : -pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** A job label: the given name, or the first line of the command. */
export function jobName(name: string | undefined, command: string): string {
  return name?.trim() || command.split("\n")[0].slice(0, 60);
}

export type JobStatus = "running" | "completed" | "failed" | "killed";
/** Why a job was killed: its timeout, the log size guard, or an explicit kill. */
export type KillReason = "timeout" | "size" | "user";

export interface BackgroundJob {
  id: string;
  name: string;
  command: string;
  cwd: string;
  status: JobStatus;
  startedAt: number;
  endedAt?: number;
  exitCode?: number | null;
  killReason?: KillReason;
  logPath: string;
  /** True once the agent or user has read the output, which suppresses the pending notice. */
  read: boolean;
  notify: boolean;
  /** A foreground bash command: hidden from the job list and limit until it moves to the background. */
  foreground: boolean;
  process: ChildProcess;
}

export interface SpawnJobOptions {
  command: string;
  cwd: string;
  name?: string;
  timeoutMs?: number;
  notify?: boolean;
  env?: NodeJS.ProcessEnv;
  shellPath?: string;
  foreground?: boolean;
}

export class JobRegistry {
  private readonly jobs = new Map<string, BackgroundJob>();
  private readonly listeners = new Set<(job: BackgroundJob) => void>();
  private readonly exitListeners = new Set<(job: BackgroundJob) => void>();
  private readonly changeListeners = new Set<() => void>();
  private dir: string | undefined;
  private readonly ownsDir: boolean;
  /** Process groups sent SIGTERM that may still need a SIGKILL. */
  private readonly terminating = new Set<number>();
  /** Force-kills every job if the process exits without a session_shutdown (crash, signal, closed terminal). */
  private readonly exitHook = (): void => {
    for (const job of this.jobs.values()) {
      if (job.status === "running" && job.process.pid) signalProcessTree(job.process.pid, "SIGKILL");
    }
    for (const pid of this.terminating) signalProcessTree(pid, "SIGKILL");
  };
  private exitHookInstalled = false;

  /** Without `logDir`, logs go to a private directory created on first use (never a shared fixed path). */
  constructor(logDir?: string, private readonly killGraceMs = KILL_GRACE_MS) {
    this.dir = logDir;
    this.ownsDir = logDir === undefined;
  }

  /** The exit hook stays installed while any job runs or any killed group may still need a SIGKILL. */
  private syncExitHook(): void {
    const needed = this.terminating.size > 0 || [...this.jobs.values()].some((job) => job.status === "running");
    if (needed && !this.exitHookInstalled) process.once("exit", this.exitHook);
    if (!needed && this.exitHookInstalled) process.removeListener("exit", this.exitHook);
    this.exitHookInstalled = needed;
  }

  private terminate(pid: number): void {
    signalProcessTree(pid, "SIGTERM");
    if (process.platform === "win32") return;
    this.terminating.add(pid);
    const timer = setTimeout(() => {
      if (processGroupAlive(pid)) signalProcessTree(pid, "SIGKILL");
      this.terminating.delete(pid);
      this.syncExitHook();
    }, this.killGraceMs);
    timer.unref();
  }

  get logDir(): string {
    if (this.dir === undefined) {
      this.dir = mkdtempSync(join(tmpdir(), "pi-bg-"));
    } else {
      mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    }
    return this.dir;
  }

  onCompletion(listener: (job: BackgroundJob) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Fires for every transition out of "running", including kills (unlike onCompletion, which drives notifications). */
  onExit(listener: (job: BackgroundJob) => void): () => void {
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }

  onChange(listener: () => void): () => void {
    this.changeListeners.add(listener);
    return () => this.changeListeners.delete(listener);
  }

  /** Background jobs, newest first. Foreground commands are excluded until they are backgrounded. */
  list(): BackgroundJob[] {
    return [...this.jobs.values()].filter((job) => !job.foreground).sort((a, b) => b.startedAt - a.startedAt);
  }

  get(id: string): BackgroundJob | undefined {
    const job = this.jobs.get(id);
    return job && !job.foreground ? job : undefined;
  }

  /** Running background jobs, newest first. */
  running(): BackgroundJob[] {
    return this.list().filter((job) => job.status === "running");
  }

  /** Turns a running foreground command into a listed background job. */
  promote(id: string): void {
    const job = this.jobs.get(id);
    if (!job?.foreground) return;
    job.foreground = false;
    this.emitChange();
  }

  spawn(options: SpawnJobOptions): BackgroundJob {
    if (!existsSync(options.cwd)) {
      throw new Error(`Working directory does not exist: ${options.cwd}\nCannot execute bash commands.`);
    }
    if (!options.foreground && this.running().length >= MAX_BACKGROUND_JOBS) {
      throw new Error(`Too many background jobs (max ${MAX_BACKGROUND_JOBS}). Kill or wait for one first.`);
    }

    const shellConfig = getShellConfig(options.shellPath);
    const viaStdin = shellConfig.commandTransport === "stdin";
    const id = `b${randomBytes(6).toString("hex").slice(0, 8)}`;
    const logPath = join(this.logDir, `${id}.log`);
    const fd = openSync(logPath, "a", 0o600);

    let child: ChildProcess;
    try {
      child = spawn(shellConfig.shell, viaStdin ? shellConfig.args : [...shellConfig.args, options.command], {
        cwd: options.cwd,
        env: options.env ?? process.env,
        detached: process.platform !== "win32",
        stdio: [viaStdin ? "pipe" : "ignore", fd, fd],
        windowsHide: true,
      });
    } catch (error) {
      // Some failures (e.g. a cwd that is not a directory) throw here instead of emitting "error".
      closeSync(fd);
      try {
        unlinkSync(logPath);
      } catch {
        // already gone
      }
      throw error;
    }
    if (viaStdin) {
      child.stdin?.on("error", () => {});
      child.stdin?.end(options.command);
    }
    closeSync(fd);

    const job: BackgroundJob = {
      id,
      name: jobName(options.name, options.command),
      command: options.command,
      cwd: options.cwd,
      status: "running",
      startedAt: Date.now(),
      logPath,
      read: false,
      notify: options.notify !== false,
      foreground: options.foreground === true,
      process: child,
    };
    this.jobs.set(id, job);
    this.syncExitHook();

    let timer: NodeJS.Timeout | undefined;
    const sizeGuard = setInterval(() => {
      // Foreground commands behave like Pi's bash: no output cap until they move to the background.
      if (job.status === "running" && !job.foreground && this.logSize(job) > MAX_LOG_BYTES) {
        this.kill(id, "killed", { notify: true, reason: "size" });
      }
    }, 5_000);
    sizeGuard.unref();

    if (options.timeoutMs && options.timeoutMs > 0) {
      timer = setTimeout(() => this.kill(id, "killed", { notify: true, reason: "timeout" }), options.timeoutMs);
      timer.unref();
    }

    const finish = (exitCode: number | null) => {
      clearInterval(sizeGuard);
      if (timer) clearTimeout(timer);
      if (job.status !== "running") return;
      job.status = exitCode === 0 ? "completed" : "failed";
      job.exitCode = exitCode;
      job.endedAt = Date.now();
      this.syncExitHook();
      this.emitChange();
      this.emitExit(job);
      for (const listener of this.listeners) listener(job);
    };
    child.once("exit", (code) => finish(code));
    child.once("error", (error) => {
      try {
        appendFileSync(logPath, `Failed to start shell: ${error.message}\n`);
      } catch {
        // log directory gone
      }
      finish(1);
    });

    child.unref();
    this.emitChange();
    return job;
  }

  /** Kills a running job. With `notify`, the completion listeners fire (timeouts and the size guard); explicit kills stay quiet. */
  kill(id: string, status: JobStatus = "killed", options: { notify?: boolean; reason?: KillReason } = {}): boolean {
    const job = this.jobs.get(id);
    if (!job || job.status !== "running") return false;
    job.status = status;
    job.killReason = options.reason ?? "user";
    job.endedAt = Date.now();
    job.read = !options.notify;
    if (job.process.pid) this.terminate(job.process.pid);
    this.emitChange();
    this.emitExit(job);
    if (options.notify) {
      for (const listener of this.listeners) listener(job);
    }
    return true;
  }

  /** Forgets a finished job and deletes its log; used for foreground commands that never went to the background. */
  discard(id: string): void {
    const job = this.jobs.get(id);
    if (!job || job.status === "running") return;
    this.jobs.delete(id);
    this.removeLog(job);
    this.emitChange();
  }

  killAll(): void {
    for (const job of this.jobs.values()) this.kill(job.id);
  }

  /** Kills every job and deletes all logs; nothing outlives the session. */
  dispose(): void {
    this.killAll();
    this.syncExitHook();
    for (const job of this.jobs.values()) this.removeLog(job);
    this.jobs.clear();
    if (this.ownsDir && this.dir !== undefined) {
      rmSync(this.dir, { recursive: true, force: true });
      this.dir = undefined;
    }
    this.emitChange();
  }

  private removeLog(job: BackgroundJob): void {
    try {
      unlinkSync(job.logPath);
    } catch {
      // log already gone
    }
  }

  readOutput(id: string, tailBytes = OUTPUT_TAIL_BYTES): string | undefined {
    const job = this.get(id);
    if (!job) return undefined;
    // Peeking at a running job must not suppress its completion notification.
    if (job.status !== "running" && !job.read) {
      job.read = true;
      this.emitChange();
    }
    tailBytes = Number.isFinite(tailBytes) ? Math.max(1, Math.floor(tailBytes)) : OUTPUT_TAIL_BYTES;
    // Read only the tail: logs can grow to MAX_LOG_BYTES.
    const fd = openSync(job.logPath, "r");
    try {
      const size = fstatSync(fd).size;
      const length = Math.min(size, tailBytes);
      const buffer = Buffer.alloc(length);
      const read = readSync(fd, buffer, 0, length, size - length);
      const prefix = size > tailBytes ? `[... ${size - tailBytes} earlier bytes omitted]\n` : "";
      return prefix + buffer.subarray(0, read).toString("utf-8");
    } finally {
      closeSync(fd);
    }
  }

  cleanup(): number {
    const finished = this.list().filter((job) => job.status !== "running");
    for (const job of finished) this.discard(job.id);
    return finished.length;
  }

  private logSize(job: BackgroundJob): number {
    try {
      return statSync(job.logPath).size;
    } catch {
      return 0;
    }
  }

  private emitExit(job: BackgroundJob): void {
    for (const listener of this.exitListeners) listener(job);
  }

  private emitChange(): void {
    for (const listener of this.changeListeners) listener();
  }
}

export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return minutes < 60 ? `${minutes}m${seconds % 60}s` : `${Math.floor(minutes / 60)}h${minutes % 60}m`;
}
