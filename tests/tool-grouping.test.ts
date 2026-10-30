import assert from "node:assert/strict";
import test from "node:test";
import {
  AssistantMessageComponent,
  ToolExecutionComponent,
} from "@earendil-works/pi-coding-agent";
import { Container, visibleWidth, Spacer } from "@earendil-works/pi-tui";
import { DEFAULT_STEROIDS_CONFIG, type SteroidsConfig } from "../src/types.js";
import registerToolGrouping, { formatToolGroupSummary } from "../src/features/tool-grouping/index.js";

const theme = { fg: (_color: string, text: string) => text };

function tool(name: string, state: Record<string, unknown> = {}) {
  const component = Object.create(ToolExecutionComponent.prototype) as Record<string, unknown>;
  Object.assign(component, { toolName: name, isPartial: false, expanded: false, ...state });
  component.render = () => ["", `[${name}]`];
  return component;
}

function assistant(hasToolCalls: boolean, text: string, stopReason?: string) {
  const component = Object.create(AssistantMessageComponent.prototype) as Record<string, unknown>;
  Object.assign(component, { hasToolCalls, lastMessage: { stopReason } });
  component.render = () => ["", text];
  return component;
}

function setup(overrides: Partial<SteroidsConfig>) {
  const config = { ...DEFAULT_STEROIDS_CONFIG, ...overrides };
  const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<void>>();
  const pi = {
    on: (name: string, handler: (event: unknown, ctx: unknown) => Promise<void>) => handlers.set(name, handler),
  };
  registerToolGrouping(pi as never, () => config);
  return handlers.get("session_start")!({}, { ui: { theme } }).then(() => handlers.get("session_shutdown")!);
}

function renderChat(children: unknown[], width = 80): string[] {
  const container = new Container();
  for (const child of children) {
    container.addChild(child as never);
  }
  return container.render(width);
}

test("summary counts tools by kind and flags running/failed", () => {
  const line = formatToolGroupSummary(
    [tool("read"), tool("read"), tool("bash", { result: { isError: true } })] as never,
    theme,
  );
  assert.equal(line, "✓ 3 tools · 2 read · 1 bash · 1 failed • Ctrl+O to expand");
  assert.match(formatToolGroupSummary([tool("edit", { isPartial: true })] as never, theme), /^▸ 1 tool · 1 edit · 1 running$/);
});

test("grouping collapses consecutive tools and keeps the final reply", async () => {
  const shutdown = await setup({ groupToolCalls: true, hideAssistantCommentary: true });
  const lines = renderChat([
    assistant(true, "let me look"),
    tool("read"),
    new Spacer(1),
    tool("bash"),
    assistant(true, "now editing"),
    tool("edit"),
    assistant(false, "all done"),
  ]);
  assert.deepEqual(lines.filter((line) => line.trim()), [
    "✓ 3 tools · 1 read · 1 bash · 1 edit • Ctrl+O to expand",
    "all done",
  ]);
  await shutdown({ reason: "reload" }, {});
});

test("expanded runs render every tool again", async () => {
  const shutdown = await setup({ groupToolCalls: true });
  const lines = renderChat([tool("read", { expanded: true }), tool("bash", { expanded: true })]);
  assert.deepEqual(lines.filter((line) => line.trim()), ["[read]", "[bash]"]);
  await shutdown({ reason: "reload" }, {});
});

test("commentary hiding works without grouping and is restored on reload", async () => {
  const shutdown = await setup({ groupToolCalls: false, hideAssistantCommentary: true });
  const children = [assistant(true, "thinking out loud"), tool("read"), assistant(false, "answer")];
  assert.deepEqual(renderChat(children).filter((line) => line.trim()), ["[read]", "answer"]);
  await shutdown({ reason: "reload" }, {});
  assert.equal(renderChat(children).filter((line) => line.trim()).length, 3);
});

test("aborted, errored and truncated assistant rows stay visible", async () => {
  const shutdown = await setup({ groupToolCalls: false, hideAssistantCommentary: true });
  for (const stopReason of ["aborted", "error", "length"]) {
    const lines = renderChat([assistant(true, `notice ${stopReason}`, stopReason), tool("read")]);
    assert.ok(lines.some((line) => line.includes(`notice ${stopReason}`)), stopReason);
  }
  assert.equal(renderChat([assistant(true, "chatter", "toolUse"), tool("read")]).some((l) => l.includes("chatter")), false);
  await shutdown({ reason: "reload" }, {});
});

test("the collapsed summary line never exceeds the terminal width", async () => {
  await setup({ groupToolCalls: true });
  const tools = ["read", "grep", "find", "edit", "write", "bash"].map((name) => tool(name, { result: { isError: true } }));
  const lines = renderChat(tools, 30);
  const summary = lines.find((line) => line.includes("6 tools"))!;
  assert.ok(summary, "summary rendered");
  assert.ok(visibleWidth(summary) <= 30);
});
