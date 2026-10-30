import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createForegroundController } from "../src/features/bg-tasks/foreground.js";
import { JobRegistry, MAX_BACKGROUND_JOBS } from "../src/features/bg-tasks/registry.js";
import { runBashBg, runJobs } from "../src/features/bg-tasks/tools.js";

function makeRegistry() {
  const dir = mkdtempSync(join(tmpdir(), "pi-bg-test-"));
  const registry = new JobRegistry(dir);
  return { registry, dispose: () => { registry.killAll(); rmSync(dir, { recursive: true, force: true }); } };
}

const until = async (condition: () => boolean, timeoutMs = 5000) => {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

test("spawned job completes, captures output and notifies once", async () => {
  const { registry, dispose } = makeRegistry();
  const completed: string[] = [];
  registry.onCompletion((job) => completed.push(job.id));
  const job = registry.spawn({ command: "echo hello; echo oops >&2", cwd: process.cwd() });
  await until(() => job.status !== "running");
  assert.equal(job.status, "completed");
  assert.deepEqual(completed, [job.id]);
  const output = registry.readOutput(job.id)!;
  assert.match(output, /hello/);
  assert.match(output, /oops/);
  assert.equal(job.read, true);
  dispose();
});

test("failed and killed jobs report their status", async () => {
  const { registry, dispose } = makeRegistry();
  const failing = registry.spawn({ command: "exit 3", cwd: process.cwd() });
  const sleeper = registry.spawn({ command: "sleep 30", cwd: process.cwd() });
  await until(() => failing.status !== "running");
  assert.equal(failing.status, "failed");
  assert.equal(failing.exitCode, 3);
  assert.equal(registry.kill(sleeper.id), true);
  assert.equal(sleeper.status, "killed");
  assert.equal(registry.kill(sleeper.id), false);
  dispose();
});

test("jobs tool lists, reads output, and rejects unknown ids", async () => {
  const { registry, dispose } = makeRegistry();
  const result = runBashBg(registry, { command: "echo from-bg", name: "greeter" }, process.cwd());
  assert.match(result.content[0].text, /Started background job b/);
  const job = registry.list()[0];
  await until(() => job.status !== "running");
  assert.match(runJobs(registry, { action: "list" }).content[0].text, /greeter/);
  assert.match(runJobs(registry, { action: "output", id: job.id }).content[0].text, /from-bg/);
  assert.throws(() => runJobs(registry, { action: "output", id: "nope" }), /Unknown job/);
  assert.throws(() => runBashBg(registry, { command: "sleep 30" }, process.cwd()), /bare sleep/);
  dispose();
});

test("foreground command streams output and returns its exit code", async () => {
  const { registry, dispose } = makeRegistry();
  const controller = createForegroundController(registry, () => 0);
  const chunks: string[] = [];
  const { exitCode } = await controller.operations.exec("echo fg; exit 2", process.cwd(), {
    onData: (data) => chunks.push(data.toString()),
  });
  assert.equal(exitCode, 2);
  assert.match(chunks.join(""), /fg/);
  assert.equal(controller.activeCount(), 0);
  dispose();
});

test("foreground command moves to background after the auto delay", async () => {
  const { registry, dispose } = makeRegistry();
  const controller = createForegroundController(registry, () => 300);
  const chunks: string[] = [];
  const { exitCode } = await controller.operations.exec("echo started; sleep 30", process.cwd(), {
    onData: (data) => chunks.push(data.toString()),
  });
  assert.equal(exitCode, 0);
  assert.match(chunks.join(""), /started/);
  assert.match(chunks.join(""), /moved to background as b/);
  assert.equal(registry.running().length, 1);
  assert.equal(registry.running()[0].notify, true);
  dispose();
});

test("backgroundAll moves an in-flight command immediately", async () => {
  const { registry, dispose } = makeRegistry();
  const controller = createForegroundController(registry, () => 0);
  const pending = controller.operations.exec("sleep 30", process.cwd(), { onData: () => {} });
  await until(() => controller.activeCount() === 1);
  assert.equal(controller.backgroundAll(), 1);
  assert.deepEqual(await pending, { exitCode: 0 });
  dispose();
});

test("abort kills a foreground command and explicit timeout kills with a timeout error", async () => {
  const { registry, dispose } = makeRegistry();
  const controller = createForegroundController(registry, () => 0);
  const abort = new AbortController();
  const aborted = controller.operations.exec("sleep 30", process.cwd(), { onData: () => {}, signal: abort.signal });
  await until(() => controller.activeCount() === 1);
  abort.abort();
  await assert.rejects(aborted, /aborted/);
  assert.equal(controller.activeCount(), 0);
  await assert.rejects(
    controller.operations.exec("sleep 30", process.cwd(), { onData: () => {}, timeout: 0.3 }),
    /timeout:0.3/,
  );
  dispose();
});

test("foreground commands leave no job or log behind, backgrounded ones stay", async () => {
  const { registry, dispose } = makeRegistry();
  const controller = createForegroundController(registry, () => 0);
  await controller.operations.exec("echo quick", process.cwd(), { onData: () => {} });
  assert.deepEqual(registry.list(), []);

  const pending = controller.operations.exec("sleep 30", process.cwd(), { onData: () => {} });
  await until(() => controller.activeCount() === 1);
  controller.backgroundAll();
  await pending;
  assert.equal(registry.list().length, 1);
  dispose();
});

test("timeout kills of background jobs notify; explicit kills stay quiet", async () => {
  const { registry, dispose } = makeRegistry();
  const completed: string[] = [];
  registry.onCompletion((job) => completed.push(`${job.id}:${job.status}`));
  const timed = registry.spawn({ command: "sleep 30", cwd: process.cwd(), timeoutMs: 200 });
  const manual = registry.spawn({ command: "sleep 30", cwd: process.cwd() });
  await until(() => timed.status !== "running");
  registry.kill(manual.id);
  assert.deepEqual(completed, [`${timed.id}:killed`]);
  assert.equal(timed.read, false);
  assert.equal(manual.read, true);
  dispose();
});

test("quick foreground commands do not wait for the poll interval", async () => {
  const { registry, dispose } = makeRegistry();
  const controller = createForegroundController(registry, () => 0);
  const start = Date.now();
  await controller.operations.exec("true", process.cwd(), { onData: () => {} });
  assert.ok(Date.now() - start < 120, `took ${Date.now() - start}ms`);
  dispose();
});

test("foreground commands stay out of the job list and the background job limit", async () => {
  const { registry, dispose } = makeRegistry();
  const controller = createForegroundController(registry, () => 0);
  for (let i = 0; i < MAX_BACKGROUND_JOBS; i += 1) registry.spawn({ command: "sleep 30", cwd: process.cwd(), notify: false });
  assert.throws(() => registry.spawn({ command: "sleep 30", cwd: process.cwd() }), /Too many background jobs/);

  const pending = controller.operations.exec("sleep 30", process.cwd(), { onData: () => {} });
  await until(() => controller.activeCount() === 1);
  assert.equal(registry.running().length, MAX_BACKGROUND_JOBS);
  assert.match(runJobs(registry, { action: "list" }).content[0].text.split("\n")[0], /^b/);
  assert.ok(registry.running().every((job) => !job.foreground));

  controller.backgroundAll();
  await pending;
  assert.equal(registry.running().length, MAX_BACKGROUND_JOBS + 1);
  dispose();
});

test("running jobs are listed newest first", async () => {
  const { registry, dispose } = makeRegistry();
  const older = registry.spawn({ command: "sleep 30", cwd: process.cwd() });
  older.startedAt -= 60_000;
  const newer = registry.spawn({ command: "sleep 30", cwd: process.cwd() });
  assert.deepEqual(registry.running().map((job) => job.id), [newer.id, older.id]);
  dispose();
});

test("readOutput returns only the tail of a large log", async () => {
  const { registry, dispose } = makeRegistry();
  const job = registry.spawn({ command: "head -c 100000 /dev/zero | tr '\\0' a; printf END", cwd: process.cwd() });
  await until(() => job.status !== "running");
  const output = registry.readOutput(job.id, 1000)!;
  assert.match(output, /^\[\.\.\. 99003 earlier bytes omitted\]\n/);
  assert.ok(output.endsWith("aEND"));
  assert.equal(output.split("\n")[1].length, 1000);
  dispose();
});

test("bash_bg rejects only a bare sleep and applies the shell command prefix", async () => {
  const { registry, dispose } = makeRegistry();
  for (const command of ["sleep 5", " sleep 2s ;", "sleep 1.5"]) {
    assert.throws(() => runBashBg(registry, { command }, process.cwd()), /bare sleep/);
  }
  runBashBg(registry, { command: "sleep 0 && echo delayed" }, process.cwd());
  runBashBg(registry, { command: "echo $PREFIXED" }, process.cwd(), { commandPrefix: "export PREFIXED=yes" });
  await until(() => registry.running().length === 0);
  const [prefixed, delayed] = registry.list();
  assert.equal(prefixed.name, "echo $PREFIXED");
  assert.match(registry.readOutput(prefixed.id)!, /yes/);
  assert.match(registry.readOutput(delayed.id)!, /delayed/);
  dispose();
});

test("reading output refreshes the status once and clamps tail_bytes", async () => {
  const { registry, dispose } = makeRegistry();
  const job = registry.spawn({ command: "printf abcdef", cwd: process.cwd() });
  await until(() => job.status !== "running");
  let changes = 0;
  registry.onChange(() => { changes += 1; });
  assert.equal(registry.readOutput(job.id, -100), "[... 5 earlier bytes omitted]\nf");
  assert.equal(changes, 1);
  assert.equal(registry.readOutput(job.id, 2.7), "[... 4 earlier bytes omitted]\nef");
  assert.equal(registry.readOutput(job.id, Number.NaN), "abcdef");
  assert.equal(changes, 1);
  dispose();
});

test("a size-guard kill is not reported as a timeout", async () => {
  const { registry, dispose } = makeRegistry();
  const controller = createForegroundController(registry, () => 0);
  const pending = controller.operations.exec("sleep 30", process.cwd(), { onData: () => {}, timeout: 600 });
  await until(() => controller.activeCount() === 1);
  // Simulate the size guard on the hidden foreground job.
  const job = [...(registry as unknown as { jobs: Map<string, { id: string }> }).jobs.values()][0];
  registry.kill(job.id, "killed", { notify: true, reason: "size" });
  await assert.rejects(pending, /output exceeded 64 MB/);
  dispose();
});

test("the default log directory is private to this registry and removed on dispose", () => {
  const first = new JobRegistry();
  const second = new JobRegistry();
  assert.notEqual(first.logDir, second.logDir);
  assert.equal(statSync(first.logDir).mode & 0o777, 0o700);
  const dir = first.logDir;
  first.dispose();
  second.dispose();
  assert.equal(existsSync(dir), false);
});

test("a foreground command killed by session cleanup is reported as aborted, not success", async () => {
  const { registry, dispose } = makeRegistry();
  const controller = createForegroundController(registry, () => 0);
  const pending = controller.operations.exec("sleep 30", process.cwd(), { onData: () => {} });
  await until(() => controller.activeCount() === 1);
  registry.killAll();
  await assert.rejects(pending, /aborted/);
  dispose();
});

test("an exit hook kills running jobs until the registry is disposed", async () => {
  const { registry, dispose } = makeRegistry();
  const before = process.listenerCount("exit");
  const job = registry.spawn({ command: "sleep 30", cwd: process.cwd() });
  registry.spawn({ command: "sleep 30", cwd: process.cwd() });
  assert.equal(process.listenerCount("exit"), before + 1);
  (registry as unknown as { exitHook: () => void }).exitHook();
  await until(() => job.status !== "running");
  registry.dispose();
  assert.equal(process.listenerCount("exit"), before);
  dispose();
});

test("peeking at a running job keeps its completion notification", async () => {
  const { registry, dispose } = makeRegistry();
  const completed: string[] = [];
  registry.onCompletion((job) => { if (!job.read) completed.push(job.id); });
  const job = registry.spawn({ command: "echo started; sleep 0.3", cwd: process.cwd() });
  registry.readOutput(job.id);
  assert.equal(job.read, false);
  await until(() => job.status !== "running");
  assert.deepEqual(completed, [job.id]);
  registry.readOutput(job.id);
  assert.equal(job.read, true);
  dispose();
});

test("a missing working directory is reported like Pi's bash, and spawn errors are not silent", async () => {
  const { registry, dispose } = makeRegistry();
  const controller = createForegroundController(registry, () => 0);
  const missing = join(tmpdir(), "pi-bg-missing-cwd-does-not-exist");
  await assert.rejects(controller.operations.exec("echo hi", missing, { onData: () => {} }), /Working directory does not exist: .*\nCannot execute bash commands\./);
  assert.throws(() => runBashBg(registry, { command: "echo hi" }, missing), /Working directory does not exist/);

  // Failures that throw synchronously reject with the real error and leave no log behind.
  const file = join(registry.logDir, "not-a-dir");
  writeFileSync(file, "");
  await assert.rejects(controller.operations.exec("echo hi", file, { onData: () => {} }), /ENOTDIR/);
  const missingShell = createForegroundController(registry, () => 0, () => "/nonexistent/shell");
  await assert.rejects(missingShell.operations.exec("echo hi", process.cwd(), { onData: () => {} }), /Custom shell path not found/);
  assert.deepEqual(readdirSync(registry.logDir), ["not-a-dir"]);
  dispose();
});
test("large foreground output streams in bounded chunks and arrives complete", async () => {
  const { registry, dispose } = makeRegistry();
  const controller = createForegroundController(registry, () => 0);
  const chunks: number[] = [];
  const result = await controller.operations.exec("head -c 3000000 /dev/zero", process.cwd(), { onData: (chunk) => chunks.push(chunk.length) });
  assert.equal(result.exitCode, 0);
  assert.equal(chunks.reduce((sum, n) => sum + n, 0), 3_000_000);
  assert.ok(Math.max(...chunks) <= 1024 * 1024);
  dispose();
});

test("kills send SIGTERM first and SIGKILL only after the grace period", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-bg-test-"));
  const registry = new JobRegistry(dir, 300);
  const polite = registry.spawn({ command: "trap 'echo got-term; exit 0' TERM; echo ready; while :; do sleep 0.05; done", cwd: process.cwd() });
  const stubborn = registry.spawn({ command: "trap '' TERM; echo ready; while :; do sleep 0.05; done", cwd: process.cwd() });
  await until(() => [polite, stubborn].every((job) => (registry.readOutput(job.id) ?? "").includes("ready")));
  registry.kill(polite.id);
  registry.kill(stubborn.id);
  await until(() => (registry.readOutput(polite.id) ?? "").includes("got-term"));
  const pid = stubborn.process.pid!;
  const alive = () => { try { process.kill(-pid, 0); return true; } catch { return false; } };
  assert.equal(alive(), true, "a TERM-ignoring job survives the grace period");
  await until(() => !alive(), 3000);
  registry.dispose();
  rmSync(dir, { recursive: true, force: true });
});

test("the size guard spares foreground commands and blank job names use the bare command", () => {
  const { registry, dispose } = makeRegistry();
  const job = registry.spawn({ command: "sleep 30", cwd: process.cwd(), foreground: true });
  assert.equal(job.foreground, true);
  runBashBg(registry, { command: "sleep 30 && true", name: "  " }, process.cwd(), { commandPrefix: "export X=1" });
  assert.equal(registry.list()[0].name, "sleep 30 && true");
  dispose();
});

test("kill notifications say why the job was killed", async () => {
  const { formatNotification } = await import("../src/features/bg-tasks/index.js");
  const base = { id: "b1", name: "build", startedAt: 0, endedAt: 40_000, status: "killed" as const };
  assert.match(formatNotification({ ...base, killReason: "size" } as never), /killed after 40s because its output exceeded 64 MB\./);
  assert.match(formatNotification({ ...base, killReason: "timeout" } as never), /because it hit its timeout\./);
  assert.match(formatNotification({ ...base, killReason: "user" } as never), /killed after 40s\./);
});
