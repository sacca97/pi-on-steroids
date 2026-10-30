import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadBashToolOverrideOptions } from "../tool-rendering/tool-overrides.js";
import type { SteroidsConfig } from "../../types.js";
import { createForegroundController } from "./foreground.js";
import { formatDuration, JobRegistry, MAX_LOG_BYTES, type BackgroundJob } from "./registry.js";
import { setBgRuntime } from "./runtime.js";
import { BASH_BG_PARAMETERS, describeJob, JOBS_PARAMETERS, runBashBg, runJobs } from "./tools.js";
import { createRegistrationGuard, onReloadShutdown } from "../../extension-lifecycle.js";

const STATUS_KEY = "bg-tasks";
const registration = createRegistrationGuard();

const KILL_REASONS = {
  timeout: "it hit its timeout",
  size: `its output exceeded ${MAX_LOG_BYTES / (1024 * 1024)} MB`,
} as const;

export function formatNotification(job: BackgroundJob): string {
  const elapsed = formatDuration((job.endedAt ?? Date.now()) - job.startedAt);
  const reason = job.status === "killed" && (job.killReason === "timeout" || job.killReason === "size")
    ? ` because ${KILL_REASONS[job.killReason]}`
    : "";
  return `<task-notification>\nBackground job ${job.id} (${job.name}) ${job.status} after ${elapsed}${reason}` +
    `${job.exitCode !== undefined && job.exitCode !== null ? ` with exit code ${job.exitCode}` : ""}.\n` +
    `Use the jobs tool with action "output" and id "${job.id}" to read its output.\n</task-notification>`;
}

export default function registerBackgroundTasks(
  pi: ExtensionAPI,
  getConfig: () => SteroidsConfig,
): void {
  if (!getConfig().backgroundTasks || !registration.claim(pi)) {
    return;
  }

  const registry = new JobRegistry();
  const foreground = createForegroundController(
    registry,
    () => getConfig().backgroundAutoSeconds * 1000,
    () => loadBashToolOverrideOptions().shellPath,
  );
  setBgRuntime({ registry, foreground });

  let activeContext: ExtensionContext | undefined;

  const refreshStatus = (): void => {
    const ui = activeContext?.ui;
    if (!ui) return;
    const running = registry.running();
    const unread = registry.list().filter((job) => job.status !== "running" && !job.read).length;
    if (running.length === 0 && unread === 0) {
      ui.setStatus(STATUS_KEY, undefined);
      return;
    }
    const oldest = running.at(-1); // running() is newest first
    let text = running.length > 0 ? `⚙ ${running.length} bg` : "";
    if (oldest) text += ` (${formatDuration(Date.now() - oldest.startedAt)})`;
    if (unread > 0) text += `${text ? " · " : ""}${unread} done`;
    ui.setStatus(STATUS_KEY, text);
  };

  // The status line shows elapsed time, so it only needs a periodic refresh while a job is running.
  let ticker: NodeJS.Timeout | undefined;
  const syncTicker = (): void => {
    const shouldTick = registry.running().length > 0;
    if (shouldTick && !ticker) {
      ticker = setInterval(refreshStatus, 5_000);
      ticker.unref();
    } else if (!shouldTick && ticker) {
      clearInterval(ticker);
      ticker = undefined;
    }
  };
  registry.onChange(() => {
    syncTicker();
    refreshStatus();
  });

  registry.onCompletion((job) => {
    if (!job.notify || job.read) return;
    void pi.sendMessage(
      { customType: "bg-task", content: formatNotification(job), display: true, details: { id: job.id } },
      { triggerTurn: true, deliverAs: "followUp" },
    );
  });

  pi.registerTool({
    name: "bash_bg",
    label: "bash_bg",
    description: "Start a shell command in the background and return immediately with a job id. Use for servers, watchers and long builds; check on it with the jobs tool.",
    parameters: BASH_BG_PARAMETERS,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      return runBashBg(registry, params, ctx.cwd, loadBashToolOverrideOptions());
    },
  });

  pi.registerTool({
    name: "jobs",
    label: "jobs",
    description: "Inspect and control background jobs: list them, read a job's output, kill a job, or clean finished ones from the list.",
    parameters: JOBS_PARAMETERS,
    async execute(_toolCallId, params) {
      return runJobs(registry, params);
    },
  });

  const backgroundNow = (ctx: ExtensionContext): void => {
    const moved = foreground.backgroundAll();
    ctx.ui.notify(moved > 0 ? `Moved ${moved} command(s) to the background.` : "No foreground command to background.", "info");
  };

  pi.registerCommand("bg", {
    description: "Move running foreground commands to the background",
    handler: async (_args, ctx) => backgroundNow(ctx),
  });

  pi.registerCommand("bg-list", {
    description: "List background jobs and read or kill them",
    handler: async (_args, ctx) => {
      const jobs = registry.list();
      if (jobs.length === 0) {
        ctx.ui.notify("No background jobs.", "info");
        return;
      }
      const labels = jobs.map((job) => describeJob(job));
      const picked = await ctx.ui.select("Background jobs", labels);
      const job = picked ? jobs[labels.indexOf(picked)] : undefined;
      if (!job) return;
      const action = await ctx.ui.select(job.name, job.status === "running" ? ["output", "kill"] : ["output"]);
      if (action === "kill") {
        registry.kill(job.id);
        ctx.ui.notify(`Killed ${job.id}.`, "info");
      } else if (action === "output") {
        ctx.ui.notify(registry.readOutput(job.id, 4000) || "(no output yet)", "info");
      }
    },
  });

  pi.registerShortcut("ctrl+shift+b", {
    description: "Move running foreground commands to the background",
    handler: backgroundNow,
  });

  pi.registerShortcut("ctrl+shift+x", {
    description: "Kill the most recent background job",
    handler: (ctx) => {
      const job = registry.running()[0]; // newest first
      ctx.ui.notify(job && registry.kill(job.id) ? `Killed ${job.id}.` : "No running background job.", "info");
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    activeContext = ctx;
    refreshStatus();
  });

  // Jobs never outlive a session, but the runtime and tools stay usable unless this is a reload.
  pi.on("session_shutdown", async () => registry.dispose());
  onReloadShutdown(pi, () => {
    if (ticker) clearInterval(ticker);
    setBgRuntime(undefined);
    registration.release(pi);
  });
}
