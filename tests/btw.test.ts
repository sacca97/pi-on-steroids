import assert from "node:assert/strict";
import test from "node:test";
import { READ_ONLY_TOOLS } from "../src/features/btw/index.js";
import { BtwOverlay } from "../src/features/btw/overlay.js";
import { SideThread, type SideSessionEvent, type SideSessionLike } from "../src/features/btw/thread.js";

function fakeSession(script: (emit: (event: SideSessionEvent) => void, text: string) => Promise<void>) {
  const listeners = new Set<(event: SideSessionEvent) => void>();
  const state = { disposed: 0, aborted: 0 };
  const session: SideSessionLike = {
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    prompt: (text) => script((event) => listeners.forEach((l) => l(event)), text),
    abort: async () => { state.aborted += 1; },
    dispose: () => { state.disposed += 1; },
  };
  return { session, state };
}

const delta = (value: string): SideSessionEvent => ({
  type: "message_update",
  assistantMessageEvent: { type: "text_delta", delta: value },
});

test("side-chat tools are read-only", () => {
  assert.deepEqual([...READ_ONLY_TOOLS], ["read", "grep", "find", "ls"]);
});

test("thread streams deltas, tool calls and keeps context across asks", async () => {
  let created = 0;
  const { session } = fakeSession(async (emit, text) => {
    emit({ type: "tool_execution_start", toolName: "read", args: { path: "a.ts" } });
    emit(delta("answer "));
    emit(delta(`to ${text}`));
  });
  const thread = new SideThread(async () => { created += 1; return session; });
  let renders = 0;
  thread.onChange(() => { renders += 1; });

  assert.equal(await thread.ask("one"), "answer to one");
  await thread.ask("two");
  assert.equal(created, 1);
  assert.deepEqual(thread.blocks.map((b) => b.kind), ["user", "tool", "assistant", "user", "tool", "assistant"]);
  assert.equal(thread.blocks[1].text, "read a.ts");
  assert.equal(thread.transcriptText(), "Q: one\n\nA: answer to one\n\nQ: two\n\nA: answer to two");
  assert.ok(renders > 4);
});

test("asking fresh starts a new session and disposes the old one", async () => {
  const made: ReturnType<typeof fakeSession>[] = [];
  const thread = new SideThread(async () => {
    const fake = fakeSession(async (emit) => emit(delta("ok")));
    made.push(fake);
    return fake.session;
  });
  await thread.ask("a");
  await thread.ask("b", true);
  await thread.ask("c", true);
  assert.equal(made.length, 3);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(made.map((m) => m.state.disposed), [1, 1, 0]);
  assert.deepEqual(thread.blocks.map((b) => b.text), ["c", "ok"]);
});

test("prompt failures become error blocks and concurrent asks are rejected", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const { session } = fakeSession(async (_emit, text) => {
    if (text === "boom") throw new Error("model unavailable");
    await gate;
  });
  const thread = new SideThread(async () => session);
  await thread.ask("boom");
  assert.deepEqual(thread.blocks.map((b) => b.kind), ["user", "error"]);
  assert.equal(thread.streaming, false);

  const pending = thread.ask("slow");
  await assert.rejects(thread.ask("again"), /still answering/);
  release();
  await pending;
});

test("overlay closes on escape and submits a typed follow-up", async () => {
  const { session } = fakeSession(async (emit) => emit(delta("ok")));
  const thread = new SideThread(async () => session);
  await thread.ask("first");
  const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t };
  const closed: string[] = [];
  const submitted: string[] = [];
  const overlay = new BtwOverlay(thread, theme, () => 12, {
    onClose: () => closed.push("closed"),
    onSubmit: (text) => submitted.push(text),
  });

  overlay.handleInput("\x1b");
  assert.deepEqual(closed, ["closed"]);

  for (const char of "next") overlay.handleInput(char);
  overlay.handleInput("\r");
  assert.deepEqual(submitted, ["next"]);
});

test("overlay renders a bordered, width-bounded transcript tail", async () => {
  const { session } = fakeSession(async (emit) => emit(delta("line ".repeat(60))));
  const thread = new SideThread(async () => session);
  await thread.ask("what?");
  const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t };
  const lines = new BtwOverlay(thread, theme, () => 8).render(40);
  const plain = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""));
  assert.ok(lines.length <= 8);
  assert.match(plain[0], /^┌/);
  assert.match(plain.at(-1)!, /^└/);
  assert.ok(lines.some((line) => line.includes("pi-on-steroids /btw")));
  assert.ok(plain.some((line) => line.includes("read-only │ enter send")));
  assert.ok(lines.some((line) => line.replace(/\x1b\[[0-9;]*m/g, "").includes("Ask a side question…")));
  assert.ok(lines.every((line) => line.replace(/\x1b\[[0-9;]*m/g, "").length === 40));
  assert.ok(lines.some((line) => line.includes("earlier lines")));
});

test("a reset during an answer does not corrupt the replacement thread", async () => {
  let rejectFirst!: (error: Error) => void;
  let first = true;
  const make = () => {
    const isFirst = first;
    first = false;
    return fakeSession(async (emit) => {
      if (isFirst) await new Promise<void>((_resolve, reject) => { rejectFirst = reject; });
      else emit(delta("fresh answer"));
    }).session;
  };
  const thread = new SideThread(async () => make());
  const stale = thread.ask("old");
  await new Promise((resolve) => setTimeout(resolve, 5));
  const replacement = thread.ask("new", true);
  await replacement;
  rejectFirst(new Error("aborted"));
  assert.equal(await stale, "");
  assert.equal(thread.streaming, false);
  assert.deepEqual(thread.blocks.map((b) => b.kind), ["user", "assistant"]);
});

test("overlapping asks create one session, and a reset during creation disposes the late session", async () => {
  let created = 0;
  let finishCreate!: () => void;
  const fake = fakeSession(async (emit) => emit(delta("ok")));
  const thread = new SideThread(async () => {
    created += 1;
    await new Promise<void>((resolve) => { finishCreate = resolve; });
    return fake.session;
  });
  const first = thread.ask("one");
  await assert.rejects(thread.ask("two"), /still answering/);
  thread.reset();
  finishCreate();
  assert.equal(await first, "");
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(created, 1);
  assert.equal(fake.state.disposed, 1);
  assert.equal(thread.active, false);
  assert.equal(thread.streaming, false);
});

test("a failed session start becomes an error block and frees the thread", async () => {
  const thread = new SideThread(async () => { throw new Error("no model"); });
  assert.equal(await thread.ask("hi"), "");
  assert.deepEqual(thread.blocks.map((b) => [b.kind, b.text]), [["user", "hi"], ["error", "no model"]]);
  assert.equal(thread.streaming, false);
});

test("the overlay's truncation notice counts every hidden line", async () => {
  const { session } = fakeSession(async (emit) => emit(delta(Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n"))));
  const thread = new SideThread(async () => session);
  await thread.ask("q");
  const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t };
  const overlay = new BtwOverlay(thread, theme, () => 20);
  const plain = overlay.render(40).map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""));
  const notice = plain.find((line) => line.includes("earlier lines"))!;
  const hidden = Number(notice.match(/… (\d+) earlier lines/)![1]);
  const shown = plain.filter((line) => /line \d+/.test(line)).length;
  // 1 user line + 30 answer lines in the body.
  assert.equal(hidden + shown, 31);
});
