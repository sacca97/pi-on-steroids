import { Type } from "typebox";
import { formatDuration, jobName, type BackgroundJob, type JobRegistry } from "./registry.js";

export interface TextToolResult {
  content: { type: "text"; text: string }[];
  details: undefined;
}

function text(value: string): TextToolResult {
  return { content: [{ type: "text", text: value }], details: undefined };
}

export function describeJob(job: BackgroundJob, now = Date.now()): string {
  const elapsed = formatDuration((job.endedAt ?? now) - job.startedAt);
  const exit = job.status === "running" ? "" : ` exit=${job.exitCode ?? "n/a"}`;
  const unread = job.status !== "running" && !job.read ? " [unread]" : "";
  return `${job.id} ${job.status}${exit} ${elapsed}${unread} — ${job.name}`;
}

export const BASH_BG_PARAMETERS = Type.Object({
  command: Type.String({ description: "Shell command to run in the background" }),
  name: Type.Optional(Type.String({ description: "Short label shown in the jobs list" })),
  timeout: Type.Optional(Type.Number({ description: "Kill the job after this many seconds" })),
  notify: Type.Optional(Type.Boolean({ description: "Notify when the job finishes (default true)" })),
});

export const JOBS_PARAMETERS = Type.Object({
  action: Type.Union(
    [Type.Literal("list"), Type.Literal("output"), Type.Literal("kill"), Type.Literal("cleanup")],
    { description: "What to do" },
  ),
  id: Type.Optional(Type.String({ description: "Job id (required for output and kill)" })),
  tail_bytes: Type.Optional(Type.Number({ description: "Maximum trailing bytes to return (output action)" })),
});

export function runBashBg(
  registry: JobRegistry,
  params: { command: string; name?: string; timeout?: number; notify?: boolean },
  cwd: string,
  shell: { shellPath?: string; commandPrefix?: string } = {},
): TextToolResult {
  if (/^\s*sleep\s+\d+(\.\d+)?[smhd]?\s*;?\s*$/.test(params.command)) {
    throw new Error("Do not use a bare sleep as a background job. Use the jobs tool to check on a running job instead.");
  }
  const job = registry.spawn({
    // Same prefix handling as Pi's foreground bash tool; the job keeps the bare command as its name.
    command: shell.commandPrefix ? `${shell.commandPrefix}\n${params.command}` : params.command,
    cwd,
    name: jobName(params.name, params.command),
    timeoutMs: params.timeout ? params.timeout * 1000 : undefined,
    notify: params.notify,
    shellPath: shell.shellPath,
  });
  return text(`Started background job ${job.id} (${job.name}). Output: ${job.logPath}`);
}

export function runJobs(
  registry: JobRegistry,
  params: { action: string; id?: string; tail_bytes?: number },
): TextToolResult {
  switch (params.action) {
    case "list": {
      const jobs = registry.list();
      return text(jobs.length === 0 ? "No background jobs." : jobs.map((job) => describeJob(job)).join("\n"));
    }
    case "output": {
      if (!params.id) throw new Error("jobs output requires an id");
      const output = registry.readOutput(params.id, params.tail_bytes);
      if (output === undefined) throw new Error(`Unknown job ${params.id}`);
      const job = registry.get(params.id)!;
      return text(`${describeJob(job)}\n---\n${output || "(no output yet)"}`);
    }
    case "kill": {
      if (!params.id) throw new Error("jobs kill requires an id");
      if (!registry.get(params.id)) throw new Error(`Unknown job ${params.id}`);
      return text(registry.kill(params.id) ? `Killed ${params.id}.` : `${params.id} is not running.`);
    }
    case "cleanup":
      return text(`Removed ${registry.cleanup()} finished job(s) from the list.`);
    default:
      throw new Error(`Unknown action ${params.action}`);
  }
}
