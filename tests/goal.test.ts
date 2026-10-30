import assert from "node:assert/strict";
import test from "node:test";
import registerGoal, { supportsGoalMode } from "../src/features/goal/index.ts";
import {
  MAX_GOAL_TURNS,
  OBJECTIVE_MAX_CHARS,
  blockGoal,
  completeGoal,
  continuationPrompt,
  createGoal,
  escapeXml,
  formatGoalStatus,
  pauseGoal,
  recordTurn,
  resumeGoal,
} from "../src/features/goal/goal.ts";
import { DEFAULT_STEROIDS_CONFIG } from "../src/types.ts";

test("goal lifecycle: create, pause, resume, block, complete", () => {
  const goal = createGoal("  ship it  ", 0);
  assert.deepEqual([goal.objective, goal.status, goal.turns], ["ship it", "active", 0]);
  assert.equal(createGoal("x".repeat(OBJECTIVE_MAX_CHARS + 50)).objective.length, OBJECTIVE_MAX_CHARS);

  const paused = pauseGoal(recordTurn(goal, 500), "stop");
  assert.equal(paused.status, "paused");
  assert.equal(pauseGoal(paused, "again"), paused);
  const resumed = resumeGoal(paused);
  // Resume restarts the cap but keeps total progress.
  assert.deepEqual([resumed.status, resumed.turns, resumed.turnsSinceResume, resumed.reason, resumed.tokens], ["active", 1, 0, undefined, 500]);

  const blocked = blockGoal(resumed, "  ");
  assert.equal(blocked.reason, "unspecified blocker");
  assert.equal(completeGoal(blocked).status, "complete");
  assert.equal(resumeGoal(completeGoal(blocked)).status, "complete");
});

test("recordTurn accumulates usage and pauses at the turn cap", () => {
  let goal = createGoal("x", 0);
  goal = recordTurn(goal, 1200);
  assert.deepEqual([goal.turns, goal.tokens], [1, 1200]);
  assert.equal(recordTurn(pauseGoal(goal), 5).turns, 1);
  goal = { ...goal, turns: 120, turnsSinceResume: MAX_GOAL_TURNS - 1 };
  const capped = recordTurn(goal, 0);
  assert.equal(capped.status, "paused");
  assert.match(capped.reason!, /turn limit/);
  assert.equal(capped.turns, 121);
  // Goals saved before turnsSinceResume existed fall back to the total.
  const legacy = recordTurn({ ...createGoal("x", 0), turns: MAX_GOAL_TURNS - 1, turnsSinceResume: undefined }, 0);
  assert.equal(legacy.status, "paused");
  const resumed = recordTurn(resumeGoal(capped), 0);
  assert.deepEqual([resumed.status, resumed.turns, resumed.turnsSinceResume], ["active", 122, 1]);
});

test("status line and continuation prompt", () => {
  const goal = { ...createGoal("fix <bug> & ship", 0), turns: 3, tokens: 12_345 };
  assert.equal(formatGoalStatus(goal, 5 * 60_000), "Pursuing goal (3 turns · 12k tokens · 5m)");
  assert.equal(formatGoalStatus(pauseGoal(goal, "stop")), "Goal paused (/goal resume): stop");
  assert.match(formatGoalStatus(blockGoal(goal, "no creds")), /^Goal blocked: no creds/);
  assert.match(formatGoalStatus(completeGoal(goal), 0), /^Goal achieved/);

  const prompt = continuationPrompt(goal);
  assert.ok(prompt.includes("<untrusted_objective>fix &lt;bug&gt; &amp; ship</untrusted_objective>"));
  assert.ok(prompt.includes('"complete"') && prompt.includes('"blocked"'));
  assert.equal(escapeXml("</untrusted_objective>"), "&lt;/untrusted_objective&gt;");
});

type Handler = (event: any, ctx: any) => Promise<void> | void;

function harness(overrides: { entries?: unknown[]; idle?: boolean; version?: string } = {}) {
  const handlers = new Map<string, Handler>();
  const tools = new Map<string, any>();
  const commands = new Map<string, Handler>();
  const sent: { message: any; options: any }[] = [];
  const entries: unknown[] = [];
  const statuses: (string | undefined)[] = [];
  const notes: string[] = [];
  const pi = {
    on: (name: string, handler: Handler) => handlers.set(name, handler),
    registerTool: (tool: any) => tools.set(tool.name, tool),
    registerCommand: (name: string, options: any) => commands.set(name, options.handler),
    sendMessage: async (message: any, options: any) => { sent.push({ message, options }); },
    appendEntry: (customType: string, data: unknown) => entries.push({ customType, data }),
  };
  const ctx = {
    isIdle: () => overrides.idle ?? true,
    ui: { setStatus: (_k: string, text: string | undefined) => statuses.push(text), notify: (m: string) => notes.push(m) },
    sessionManager: { getBranch: () => overrides.entries ?? [] },
  };
  registerGoal(pi as never, () => ({ ...DEFAULT_STEROIDS_CONFIG, goalMode: true }), overrides.version ?? "1.4.0");
  return {
    sent, entries, statuses, notes, tools, ctx,
    command: (args: string) => commands.get("goal")!(args, ctx),
    emit: (name: string, event: unknown = {}) => handlers.get(name)!(event, ctx),
  };
}

const assistant = (stopReason: string, totalTokens = 100) => ({ role: "assistant", stopReason, usage: { totalTokens } });

test("goal mode is off by default", () => {
  const registered: string[] = [];
  registerGoal({ registerTool: (t: any) => registered.push(t.name) } as never, () => DEFAULT_STEROIDS_CONFIG);
  assert.deepEqual(registered, []);
});

test("/goal creates a goal, continues after each settled turn and stops on completion", async () => {
  const h = harness();
  await h.command("ship the feature");
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].message.display, false);
  assert.equal(h.sent[0].options.triggerTurn, true);
  assert.ok(h.sent[0].message.content.includes("ship the feature"));
  assert.match(h.statuses.at(-1)!, /^Pursuing goal/);

  await h.emit("agent_end", { messages: [assistant("stop", 700)] });
  await h.emit("agent_settled");
  assert.equal(h.sent.length, 2);
  assert.match(h.statuses.at(-1)!, /1 turns/);

  const result = await h.tools.get("update_goal").execute("id", { status: "complete" });
  assert.match(result.content[0].text, /complete/);
  await h.emit("agent_settled");
  assert.equal(h.sent.length, 2);
  assert.match(h.statuses.at(-1)!, /^Goal achieved/);
});

test("an interrupted or failed turn pauses the goal and /goal resume continues it", async () => {
  const h = harness();
  await h.command("do work");
  await h.emit("agent_end", { messages: [assistant("aborted")] });
  await h.emit("agent_settled");
  assert.equal(h.sent.length, 1);
  assert.match(h.statuses.at(-1)!, /Goal paused.*user interrupted/);

  await h.command("resume");
  assert.equal(h.sent.length, 2);
  await h.emit("agent_end", { messages: [assistant("error")] });
  assert.doesNotMatch(h.statuses.at(-1)!, /paused/, "Pi may still retry the failed run");
  await h.emit("agent_settled");
  assert.match(h.statuses.at(-1)!, /turn failed/);
  assert.equal(h.sent.length, 2);
});

test("a failed run that Pi retries successfully keeps the goal going", async () => {
  const h = harness();
  await h.command("do work");
  await h.emit("agent_end", { messages: [assistant("error", 50)] });
  await h.emit("agent_end", { messages: [assistant("stop", 100)] });
  await h.emit("agent_settled");
  assert.equal(h.sent.length, 2);
  assert.match(h.statuses.at(-1)!, /^Pursuing goal \(1 turns · 150 tokens/);
});

test("pause, clear and blocked stop continuation; busy sessions are not interrupted", async () => {
  const h = harness();
  await h.command("goal text");
  await h.command("pause");
  await h.emit("agent_settled");
  assert.equal(h.sent.length, 1);

  await h.command("resume");
  await assert.rejects(h.tools.get("update_goal").execute("id", { status: "blocked" }), /needs a reason/);
  await h.tools.get("update_goal").execute("id", { status: "blocked", reason: "no access" });
  await h.emit("agent_settled");
  assert.equal(h.sent.length, 2);
  await assert.rejects(h.tools.get("update_goal").execute("id", { status: "complete" }), /no active goal/);

  await h.command("clear");
  assert.equal(h.statuses.at(-1), undefined);
  assert.match((await h.tools.get("get_goal").execute()).content[0].text, /No goal/);

  const busy = harness({ idle: false });
  await busy.command("busy goal");
  const before = busy.sent.length;
  await busy.emit("agent_settled");
  assert.equal(busy.sent.length, before);
});

test("the goal is restored from session entries on start and stays paused", async () => {
  const goal = { ...createGoal("restored goal", 0), turns: 2 };
  const h = harness({ entries: [{ type: "custom", customType: "goal", data: null }, { type: "custom", customType: "goal", data: goal }] });
  await h.emit("session_start");
  assert.equal(h.sent.length, 0);
  assert.match((await h.tools.get("get_goal").execute()).content[0].text, /restored goal/);
  assert.match((await h.tools.get("get_goal").execute()).content[0].text, /paused/);

  const cleared = harness({ entries: [{ type: "custom", customType: "goal", data: goal }, { type: "custom", customType: "goal", data: null }] });
  await cleared.emit("session_start");
  assert.equal(cleared.sent.length, 0);
});

test("goal mode refuses to start on Pi versions without agent_settled", async () => {
  assert.equal(supportsGoalMode("0.80.3"), false);
  assert.equal(supportsGoalMode("0.74.0"), false);
  assert.equal(supportsGoalMode("0.80.4"), true);
  assert.equal(supportsGoalMode("0.81.0"), true);
  assert.equal(supportsGoalMode("1.4.0"), true);
  const h = harness({ version: "0.80.3" });
  await h.command("ship it");
  assert.equal(h.sent.length, 0);
  assert.match(h.notes.at(-1)!, /needs Pi 0.80.4 or newer \(running 0.80.3\)/);
});
