import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import {
  loadSteroidsConfig,
  normalizeSteroidsConfig,
  saveSteroidsConfig,
} from "./config-store.js";
import registerGoal from "./features/goal/index.js";
import registerCompactionHistory from "./features/compaction-history/index.js";
import registerBtw from "./features/btw/index.js";
import registerBackgroundTasks from "./features/bg-tasks/index.js";
import { registerToolRendering } from "./features/tool-rendering/tool-overrides.js";
import { registerSteroidsCommand } from "./steroids-command.js";
import { disposeAll, resetDisposed } from "./disposable.js";
import { onReloadShutdown } from "./extension-lifecycle.js";
import registerToolGrouping from "./features/tool-grouping/index.js";
import { registerThinkingLabeling } from "./features/thinking-label/index.js";
import registerNativeUserMessageBox from "./features/user-message-box/index.js";
import { FEATURE_TOGGLES } from "./steroids-settings.js";
import type { SteroidsConfig } from "./types.js";

function requiresReload(previous: SteroidsConfig, next: SteroidsConfig): boolean {
  return previous.enabled !== next.enabled || FEATURE_TOGGLES.some(({ key }) => previous[key] !== next[key]);
}

export default function steroidsExtension(pi: ExtensionAPI): void {
  const initial = loadSteroidsConfig();
  resetDisposed();

  onReloadShutdown(pi, disposeAll);

  let config: SteroidsConfig = initial.config;
  let pendingLoadError = initial.error;

  const getConfig = (): SteroidsConfig => config;

  const setConfig = (
    next: SteroidsConfig,
    ctx: ExtensionCommandContext,
  ): void => {
    const normalized = normalizeSteroidsConfig(next);
    const needsReload = requiresReload(config, normalized);
    config = normalized;

    const saved = saveSteroidsConfig(normalized);
    if (!saved.success && saved.error) {
      ctx.ui.notify(saved.error, "error");
    }

    if (needsReload) {
      ctx.ui.notify(
        "Feature changes apply after /reload.",
        "warning",
      );
    }
  };

  pi.on("session_start", async (_event, ctx) => {
    if (pendingLoadError) {
      ctx.ui.notify(pendingLoadError, "warning");
      pendingLoadError = undefined;
    }
  });

  if (!config.enabled) {
    // Stay reachable so /steroids on can re-enable everything.
    registerSteroidsCommand(pi, { getConfig, setConfig });
    return;
  }

  registerBackgroundTasks(pi, getConfig);
  registerBtw(pi, getConfig);
  registerGoal(pi, getConfig);
  registerCompactionHistory(pi, getConfig);
  registerToolRendering(pi, getConfig);
  registerNativeUserMessageBox(pi, getConfig);
  registerThinkingLabeling(pi);
  registerToolGrouping(pi, getConfig);

  registerSteroidsCommand(pi, { getConfig, setConfig });
}
