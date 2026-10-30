import { VERSION, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createRegistrationGuard, onReloadShutdown } from "../../extension-lifecycle.js";
import type { SteroidsConfig } from "../../types.js";
import {
  blockGoal,
  completeGoal,
  continuationPrompt,
  createGoal,
  describeGoal,
  formatGoalStatus,
  pauseGoal,
  recordTurn,
  resumeGoal,
  type Goal,
} from "./goal.js";

const ENTRY_TYPE = "goal";
const CONTINUE_TYPE = "goal-continue";
const STATUS_KEY = "goal";
const registration = createRegistrationGuard();

interface AssistantUsageMessage {
  role?: string;
  stopReason?: string;
  usage?: { totalTokens?: number; input?: number; output?: number };
}

function turnOutcome(messages: readonly unknown[]): { tokens: number; stopReason?: string } {
  let tokens = 0;
  let stopReason: string | undefined;
  for (const message of messages as AssistantUsageMessage[]) {
    if (message?.role !== "assistant") continue;
    stopReason = message.stopReason;
    const usage = message.usage;
    tokens += usage?.totalTokens ?? (usage?.input ?? 0) + (usage?.output ?? 0);
  }
  return { tokens, stopReason };
}

/** Goal continuation relies on `agent_settled`, added in Pi 0.80.4. */
export function supportsGoalMode(version: string): boolean {
  const [major = 0, minor = 0, patch = 0] = version.split(/[.-]/).map((part) => Number.parseInt(part, 10) || 0);
  return major > 0 || minor > 80 || (minor === 80 && patch >= 4);
}

export default function registerGoal(pi: ExtensionAPI, getConfig: () => SteroidsConfig, piVersion = VERSION): void {
  if (!getConfig().goalMode || !registration.claim(pi)) {
    return;
  }
  const supported = supportsGoalMode(piVersion);

  let goal: Goal | undefined;
  let activeContext: ExtensionContext | undefined;

  const refreshStatus = (): void => {
    activeContext?.ui?.setStatus(STATUS_KEY, goal ? formatGoalStatus(goal) : undefined);
  };

  const setGoal = (next: Goal | undefined): void => {
    goal = next;
    pi.appendEntry(ENTRY_TYPE, next ?? null);
    refreshStatus();
  };

  const queueContinuation = (): void => {
    if (goal?.status !== "active") return;
    void pi.sendMessage(
      { customType: CONTINUE_TYPE, content: continuationPrompt(goal), display: false, details: undefined },
      { triggerTurn: true },
    );
  };

  pi.registerTool({
    name: "get_goal",
    label: "get_goal",
    description: "Return the current goal, its status and progress.",
    parameters: Type.Object({}),
    async execute() {
      return { content: [{ type: "text", text: goal ? describeGoal(goal) : "No goal is set." }], details: undefined };
    },
  });

  pi.registerTool({
    name: "update_goal",
    label: "update_goal",
    description: "Mark the active goal complete once you have verified it, or blocked after the same obstacle recurs for several consecutive goal turns.",
    parameters: Type.Object({
      status: Type.Union([Type.Literal("complete"), Type.Literal("blocked")], { description: "New goal status" }),
      reason: Type.Optional(Type.String({ description: "Required for blocked: what is blocking progress" })),
    }),
    async execute(_toolCallId, params) {
      if (!goal || goal.status !== "active") {
        throw new Error("There is no active goal to update.");
      }
      if (params.status === "blocked") {
        if (!params.reason?.trim()) throw new Error("A blocked goal needs a reason.");
        setGoal(blockGoal(goal, params.reason));
        return { content: [{ type: "text", text: "Goal marked blocked." }], details: undefined };
      }
      setGoal(completeGoal(goal));
      return { content: [{ type: "text", text: "Goal marked complete." }], details: undefined };
    },
  });

  pi.registerCommand("goal", {
    description: "Set a goal the agent keeps pursuing: /goal <objective>, or pause | resume | clear",
    handler: async (args, ctx) => {
      activeContext = ctx;
      const text = args.trim();
      const command = text.toLowerCase();

      if (!supported) {
        ctx.ui.notify(`Goal mode needs Pi 0.80.4 or newer (running ${piVersion}).`, "error");
      } else if (!text) {
        ctx.ui.notify(goal ? describeGoal(goal) : "No goal set. Use /goal <objective>.", "info");
      } else if (command === "clear") {
        setGoal(undefined);
        ctx.ui.notify("Goal cleared.", "info");
      } else if (command === "pause" || command === "resume") {
        if (!goal) {
          ctx.ui.notify("No goal set.", "warning");
        } else if (command === "pause") {
          setGoal(pauseGoal(goal, "paused by user"));
        } else if (goal.status === "complete") {
          ctx.ui.notify("The goal is already complete. Set a new one with /goal <objective>.", "info");
        } else {
          setGoal(resumeGoal(goal));
          queueContinuation();
        }
      } else {
        setGoal(createGoal(text));
        queueContinuation();
      }
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    activeContext = ctx;
    // Only the active branch: a goal set or cleared on another branch does not apply here.
    const entries = ctx.sessionManager.getBranch() as { type?: string; customType?: string; data?: Goal | null }[];
    const last = entries.findLast((entry) => entry.type === "custom" && entry.customType === ENTRY_TYPE);
    goal = last?.data ?? undefined;
    refreshStatus();
    // Never start work unprompted: a goal that was mid-flight waits for /goal resume.
    if (goal?.status === "active") setGoal(pauseGoal(goal, "session restarted"));
  });

  // Extensions are not told whether Pi will retry a failed run, so an error only pauses the goal
  // once the run has settled without a successful retry.
  let failedRun = false;

  pi.on("agent_end", async (event) => {
    if (goal?.status !== "active") return;
    const { tokens, stopReason } = turnOutcome(event.messages);
    if (stopReason === "aborted") {
      setGoal(pauseGoal({ ...goal, tokens: goal.tokens + tokens }, "user interrupted the turn"));
      return;
    }
    if (stopReason === "error") {
      failedRun = true;
      setGoal({ ...goal, tokens: goal.tokens + tokens });
      return;
    }
    failedRun = false;
    setGoal(recordTurn(goal, tokens));
  });

  // `agent_settled` exists from Pi 0.80.4; older typings do not declare it.
  (pi as unknown as { on(event: "agent_settled", handler: (event: unknown, ctx: ExtensionContext) => Promise<void>): void }).on(
    "agent_settled",
    async (_event, ctx) => {
      activeContext = ctx;
      if (failedRun) {
        failedRun = false;
        if (goal?.status === "active") setGoal(pauseGoal(goal, "the turn failed"));
        return;
      }
      if (ctx.isIdle()) queueContinuation();
    },
  );

  pi.on("session_shutdown", async () => {
    activeContext?.ui?.setStatus(STATUS_KEY, undefined);
  });
  onReloadShutdown(pi, () => registration.release(pi));
}
