import { AssistantMessageComponent, ToolExecutionComponent, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Container, Spacer, truncateToWidth } from "@earendil-works/pi-tui";
import { createRegistrationGuard, onReloadShutdown } from "../../extension-lifecycle.js";
import type { SteroidsConfig } from "../../types.js";

type RenderFn = (width: number) => string[];

interface ToolLike {
  toolName?: string;
  result?: { isError?: boolean };
  isPartial?: boolean;
  expanded?: boolean;
}

interface AssistantLike {
  hasToolCalls?: boolean;
  lastMessage?: { stopReason?: string };
}

interface ThemeLike {
  fg(color: string, text: string): string;
}

type Patchable<T> = {
  render: RenderFn;
  __piToolGroupOriginalRender?: RenderFn;
} & T;

const SUMMARY_MAX_KINDS = 5;
const registration = createRegistrationGuard();

let activeTheme: ThemeLike | undefined;
let activeConfig: (() => SteroidsConfig) | undefined;

function isTool(child: unknown): child is ToolLike {
  return child instanceof ToolExecutionComponent;
}

function isAssistant(child: unknown): child is AssistantLike {
  return child instanceof AssistantMessageComponent;
}

/** Assistant rows that precede tool calls render nothing when commentary is hidden. */
function isHiddenCommentary(child: unknown): boolean {
  if (!activeConfig?.().hideAssistantCommentary || !isAssistant(child)) {
    return false;
  }
  // Truncated, aborted and failed turns carry a visible notice, so they are never hidden.
  const stopReason = child.lastMessage?.stopReason;
  return child.hasToolCalls === true && stopReason !== "length" && stopReason !== "aborted" && stopReason !== "error";
}

export function formatToolGroupSummary(
  tools: readonly ToolLike[],
  theme: ThemeLike,
): string {
  const counts = new Map<string, number>();
  for (const tool of tools) {
    const kind = tool.toolName ?? "tool";
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }

  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const shown = sorted.slice(0, SUMMARY_MAX_KINDS).map(([kind, n]) => `${n} ${kind}`);
  const rest = sorted.slice(SUMMARY_MAX_KINDS).reduce((sum, [, n]) => sum + n, 0);
  if (rest > 0) {
    shown.push(`${rest} other`);
  }

  const running = tools.filter((tool) => tool.isPartial !== false).length;
  const failed = tools.filter((tool) => tool.result?.isError).length;
  const noun = tools.length === 1 ? "tool" : "tools";

  let line = theme.fg("toolTitle", `${running > 0 ? "▸" : "✓"} ${tools.length} ${noun}`);
  line += theme.fg("muted", ` · ${shown.join(" · ")}`);
  if (running > 0) {
    line += theme.fg("muted", ` · ${running} running`);
  }
  if (failed > 0) {
    line += theme.fg("error", ` · ${failed} failed`);
  }
  if (running === 0) {
    line += theme.fg("muted", " • Ctrl+O to expand");
  }
  return line;
}

/**
 * Splits children into runs of consecutive tool rows. Spacers, empty rows and
 * hidden commentary are transparent; anything else (user prompt, final reply)
 * ends the run.
 */
function findToolRuns(children: readonly unknown[]): ToolLike[][] {
  const runs: ToolLike[][] = [];
  let current: ToolLike[] | undefined;

  for (const child of children) {
    if (isTool(child)) {
      current ??= [];
      current.push(child);
      continue;
    }
    if (isHiddenCommentary(child) || child instanceof Spacer) {
      continue;
    }
    if (current) {
      runs.push(current);
      current = undefined;
    }
  }
  if (current) {
    runs.push(current);
  }
  return runs;
}

function patchContainerRender(): void {
  const prototype = Container.prototype as unknown as Patchable<object>;
  if (prototype.__piToolGroupOriginalRender) {
    return;
  }
  const original = prototype.render;
  prototype.__piToolGroupOriginalRender = original;

  prototype.render = function patchedRender(this: Container, width: number): string[] {
    const config = activeConfig?.();
    const active = config?.groupToolCalls || config?.hideAssistantCommentary;
    if (!active || !activeTheme || !this.children.some((child) => isTool(child) || isAssistant(child))) {
      return original.call(this, width);
    }

    const collapsedHeads = new Map<unknown, string>();
    const collapsedMembers = new Set<unknown>();
    const runs = config.groupToolCalls ? findToolRuns(this.children) : [];
    for (const run of runs) {
      if (run.some((tool) => tool.expanded)) {
        continue;
      }
      collapsedHeads.set(run[0], formatToolGroupSummary(run, activeTheme));
      for (const tool of run) {
        collapsedMembers.add(tool);
      }
    }

    const lines: string[] = [];
    for (const child of this.children) {
      const head = collapsedHeads.get(child);
      if (head !== undefined) {
        // pi-tui throws on lines wider than the terminal.
        lines.push("", truncateToWidth(head, width));
      } else if (!collapsedMembers.has(child) && !isHiddenCommentary(child)) {
        lines.push(...child.render(width));
      }
    }
    return lines;
  };
}

function restore(): void {
  const prototype = Container.prototype as unknown as Patchable<object>;
  if (prototype.__piToolGroupOriginalRender) {
    prototype.render = prototype.__piToolGroupOriginalRender;
    delete prototype.__piToolGroupOriginalRender;
  }
}

export default function registerToolGrouping(
  pi: ExtensionAPI,
  getConfig: () => SteroidsConfig,
): void {
  if (!registration.claim(pi)) {
    return;
  }
  activeConfig = getConfig;

  patchContainerRender();

  onReloadShutdown(pi, () => {
    restore();
    activeConfig = undefined;
    activeTheme = undefined;
    registration.release(pi);
  });

  const refreshTheme = async (_event: unknown, ctx: { ui?: { theme?: unknown } }): Promise<void> => {
    activeTheme = ctx?.ui?.theme as ThemeLike;
  };
  pi.on("session_start", refreshTheme);
  // Re-read the theme each run so summary lines follow a theme switch.
  pi.on("before_agent_start", refreshTheme as never);
}
