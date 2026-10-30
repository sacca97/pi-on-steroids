import { closeSync, openSync, readSync, statSync } from "node:fs";
import type { BashOperations } from "@earendil-works/pi-coding-agent";
import { MAX_LOG_BYTES, type BackgroundJob, type JobRegistry } from "./registry.js";

const POLL_INTERVAL_MS = 150;
/** Most bytes streamed per poll, so a flood of output cannot stall the TUI in one synchronous read. */
const MAX_FLUSH_BYTES = 1024 * 1024;

interface ForegroundRun {
  job: BackgroundJob;
  background: () => void;
}

export interface ForegroundController {
  operations: BashOperations;
  /** Moves every running foreground command to the background. Returns how many were moved. */
  backgroundAll: () => number;
  activeCount: () => number;
}

export function createForegroundController(
  registry: JobRegistry,
  getAutoBackgroundMs: () => number,
  shellPath?: () => string | undefined,
): ForegroundController {
  const active = new Set<ForegroundRun>();

  const operations: BashOperations = {
    exec(command, cwd, { onData, signal, timeout, env }) {
      if (signal?.aborted) {
        return Promise.reject(new Error("aborted"));
      }

      const timeoutMs = timeout !== undefined && timeout > 0 ? timeout * 1000 : undefined;
      let job: BackgroundJob;
      try {
        job = registry.spawn({
          command,
          cwd,
          env,
          timeoutMs,
          notify: false,
          shellPath: shellPath?.(),
          foreground: true,
        });
      } catch (error) {
        return Promise.reject(error);
      }

      return new Promise((resolve, reject) => {
        let offset = 0;
        let settled = false;
        let backgrounded = false;

        /** Streams up to MAX_FLUSH_BYTES of new output; returns how many bytes it read. */
        const flush = (): number => {
          let size = 0;
          try {
            size = statSync(job.logPath).size;
          } catch {
            return 0;
          }
          if (size <= offset) return 0;
          const fd = openSync(job.logPath, "r");
          try {
            const buffer = Buffer.alloc(Math.min(size - offset, MAX_FLUSH_BYTES));
            const read = readSync(fd, buffer, 0, buffer.length, offset);
            offset += read;
            if (read > 0) onData(buffer.subarray(0, read));
            return read;
          } finally {
            closeSync(fd);
          }
        };
        const drain = (): void => {
          while (flush() > 0) {
            // keep streaming until caught up
          }
        };

        const cleanup = (): void => {
          settled = true;
          clearInterval(poll);
          stopListening();
          if (autoTimer) clearTimeout(autoTimer);
          signal?.removeEventListener("abort", onAbort);
          active.delete(run);
        };

        const background = (): void => {
          if (settled || job.status !== "running") return;
          backgrounded = true;
          job.notify = true;
          registry.promote(job.id);
          drain();
          onData(Buffer.from(
            `\n[Command still running; moved to background as ${job.id}. ` +
            `Use the jobs tool (output/kill) to inspect it. You will be notified when it finishes.]\n`,
          ));
          cleanup();
          resolve({ exitCode: 0 });
        };

        const onAbort = (): void => {
          if (settled) return;
          // Clean up first: killing emits an exit event that must not settle this promise as a normal exit.
          cleanup();
          registry.kill(job.id);
          registry.discard(job.id);
          reject(new Error("aborted"));
        };

        const run: ForegroundRun = { job, background };
        active.add(run);

        const finishIfExited = (): void => {
          if (job.status === "running" || settled || backgrounded) return;
          drain();
          cleanup();
          const killReason = job.status === "killed" ? job.killReason : undefined;
          const exitCode = job.exitCode ?? null;
          // Foreground commands never join the background job list or leave logs behind.
          registry.discard(job.id);
          if (killReason === "timeout") {
            reject(new Error(`timeout:${timeout}`));
          } else if (killReason === "size") {
            reject(new Error(`Command killed: its output exceeded ${MAX_LOG_BYTES / (1024 * 1024)} MB.`));
          } else if (killReason) {
            // Killed by session shutdown or another explicit kill. Pi treats a null exit code as success.
            reject(new Error("aborted"));
          } else {
            resolve({ exitCode });
          }
        };

        // Polling only streams new output; completion is event-driven so quick commands return immediately.
        const poll = setInterval(() => flush(), POLL_INTERVAL_MS);
        const stopListening = registry.onExit((exited) => {
          if (exited.id === job.id) finishIfExited();
        });

        const autoMs = timeoutMs === undefined ? getAutoBackgroundMs() : 0;
        const autoTimer = autoMs > 0 ? setTimeout(background, autoMs) : undefined;

        signal?.addEventListener("abort", onAbort, { once: true });
      });
    },
  };

  return {
    operations,
    backgroundAll() {
      const runs = [...active];
      for (const run of runs) run.background();
      return runs.length;
    },
    activeCount: () => active.size,
  };
}
