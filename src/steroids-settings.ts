import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { getSteroidsConfigPath } from "./config-store.js";
import { shortenPath } from "./features/tool-rendering/render-utils.js";
import {
  applyProfile,
  describeProfile,
  listProfileNames,
  nextCustomProfileName,
  saveProfile,
} from "./profiles.js";
import type { InspectorSettingItem } from "./settings-inspector-modal.js";
import type { SteroidsConfig } from "./types.js";

export interface SteroidsController {
  getConfig(): SteroidsConfig;
  setConfig(next: SteroidsConfig, ctx: ExtensionCommandContext): void;
}

const DISPLAY = "Display";
const FEATURES = "Features";

export const FEATURE_TOGGLES = [
  {
    key: "backgroundTasks",
    label: "Background tasks",
    summary: [
      "Lets bash commands run in the background: they move there automatically after backgroundAutoSeconds, or immediately with Ctrl+Shift+B or /bg.",
      "Adds the bash_bg and jobs tools, completion notifications, a status-bar count and /bg-list.",
    ],
    on: "background execution and the jobs tools",
    off: "bash runs in the foreground only",
    terms: ["background", "bg", "jobs", "tasks", "bash"],
  },
  {
    key: "btwSideChat",
    label: "Side chat (/btw)",
    summary: [
      "Adds /btw: open a read-only side chat in an overlay prompt while the main agent keeps working. Esc closes it, Enter sends a follow-up.",
      "Use /btw:new for a fresh thread and /btw:inject to hand the thread to the main agent.",
    ],
    on: "/btw commands available",
    off: "no side chat",
    terms: ["btw", "side", "chat", "question"],
  },
  {
    key: "goalMode",
    label: "Goal mode (/goal)",
    summary: [
      "Adds /goal <objective>: the agent keeps working toward the goal, turn after turn, until it verifies completion or reports a blocker.",
      "/goal shows the goal, /goal pause, /goal resume and /goal clear control it. Goals pause after 50 turns or when you interrupt a turn.",
    ],
    on: "/goal command and goal tools available",
    off: "no goal mode",
    terms: ["goal", "objective", "continue", "autonomous", "codex"],
  },
  {
    key: "compactionHistory",
    label: "Compaction history",
    summary: [
      "Keeps compaction summaries brief and points the agent at the full earlier conversation, which Pi preserves in the session file.",
      "Adds the history_search and history_read tools: search past messages and tool calls (outcomes shown as SUCCESS, FAILURE or UNKNOWN) and read around a match.",
    ],
    on: "brief compaction summaries and the history tools",
    off: "Pi's default compaction",
    terms: ["compaction", "compact", "history", "context", "search", "memory"],
  },
] as const;

const SAVE_NEW = "save-new";
const SAVE_ACTIVE = "save-active";

export function buildSettingsItems(config: SteroidsConfig): InspectorSettingItem[] {
  const configPath = shortenPath(getSteroidsConfigPath());
  const activeIsCustom = Object.hasOwn(config.customProfiles, config.profile);
  const fresh = nextCustomProfileName(config);

  return [
    {
      id: "profile",
      category: DISPLAY,
      label: describeProfile(config).endsWith("(modified)") ? "Profile (modified)" : "Profile",
      currentValue: config.profile,
      values: listProfileNames(config),
      inspectorTitle: "Display Profile",
      inspectorSummary: [
        "A profile is a named set of display settings: output modes, previews, diffs, grouped tool calls, hidden commentary and the user message box.",
        "Press Enter to cycle through the profiles. Switching never changes the Features section.",
      ],
      inspectorOptions: [
        "hidden — grouped tool calls, only the final reply",
        "balanced — compact summaries with counts",
        "verbose — larger previews",
        "custom-A, custom-B, … — profiles you saved",
      ],
      inspectorAdvanced: [
        "Tweak individual display settings in config.json; the profile then shows as (modified) until you save it.",
        "Delete a custom profile with /steroids delete <name>.",
      ],
      inspectorPath: configPath,
      searchTerms: ["profile", "display", "hidden", "balanced", "verbose", "custom"],
    },
    {
      id: activeIsCustom ? SAVE_ACTIVE : SAVE_NEW,
      category: DISPLAY,
      label: activeIsCustom ? `Update ${config.profile}` : "Save as new profile",
      currentValue: activeIsCustom ? "↵ update" : `↵ ${fresh}`,
      values: [activeIsCustom ? "update" : "new"],
      inspectorTitle: "Save Display Settings",
      inspectorSummary: [
        activeIsCustom
          ? `Overwrite ${config.profile} with the current display settings.`
          : `Save the current display settings as ${fresh} and switch to it.`,
      ],
      inspectorPath: configPath,
      searchTerms: ["save", "profile", "custom"],
    },
    ...(activeIsCustom
      ? [{
          id: SAVE_NEW,
          category: DISPLAY,
          label: "Save as new profile",
          currentValue: `↵ ${fresh}`,
          values: ["new"],
          inspectorTitle: "Save As New Profile",
          inspectorSummary: [`Save the current display settings as ${fresh} and switch to it.`],
          inspectorPath: configPath,
          searchTerms: ["save", "new", "profile", "custom"],
        } satisfies InspectorSettingItem]
      : []),
    ...FEATURE_TOGGLES.map((toggle): InspectorSettingItem => ({
      id: toggle.key,
      category: FEATURES,
      label: toggle.label,
      currentValue: config[toggle.key] ? "on" : "off",
      values: ["on", "off"],
      inspectorTitle: toggle.label,
      inspectorSummary: toggle.summary,
      inspectorOptions: [`on — ${toggle.on}`, `off — ${toggle.off}`],
      inspectorAdvanced: ["Takes effect after /reload. Running background jobs are killed when the session ends."],
      inspectorPath: configPath,
      searchTerms: toggle.terms,
    })),
  ];
}

export function applySettingChange(config: SteroidsConfig, id: string, value: string): SteroidsConfig {
  switch (id) {
    case "profile":
      return applyProfile(config, value);
    case SAVE_ACTIVE:
      return saveProfile(config, config.profile);
    case SAVE_NEW:
      return saveProfile(config, nextCustomProfileName(config));
    default:
      return FEATURE_TOGGLES.some((toggle) => toggle.key === id) ? { ...config, [id]: value === "on" } : config;
  }
}

export function resolveOverlayOptions() {
  const columns = Number.isFinite(process.stdout.columns) ? process.stdout.columns : 120;
  const rows = Number.isFinite(process.stdout.rows) ? process.stdout.rows : 36;
  const margin = 1;
  const preferredWidth = columns >= 170 ? 128 : columns >= 145 ? 118 : columns >= 120 ? 106 : 92;
  const width = Math.max(72, Math.min(preferredWidth, Math.max(72, columns - margin * 2)));
  const maxHeight = Math.min(Math.max(14, Math.floor(rows * 0.78)), Math.max(14, rows - margin * 2));
  return { anchor: "center" as const, width, maxHeight, margin };
}

export async function openSettingsOverlay(ctx: ExtensionCommandContext, controller: SteroidsController): Promise<void> {
  const overlayOptions = resolveOverlayOptions();
  const [{ ZellijModal }, { SplitPaneInspectorModal }] = await Promise.all([
    import("./zellij-modal.js"),
    import("./settings-inspector-modal.js"),
  ]);

  await ctx.ui.custom<void>(
    (tui, theme, _keybindings, done) => {
      const inspector = new SplitPaneInspectorModal(
        {
          getSettings: () => buildSettingsItems(controller.getConfig()),
          onChange: (id, value) => {
            try {
              controller.setConfig(applySettingChange(controller.getConfig(), id, value), ctx);
            } catch (error) {
              ctx.ui.notify(error instanceof Error ? error.message : String(error), "warning");
            }
          },
          onClose: () => done(),
        },
        theme,
      );
      const modal = new ZellijModal(
        inspector,
        { borderStyle: "square", padding: 0, titleBar: {}, overlay: overlayOptions },
        theme,
      );
      return {
        render: (width: number) => modal.renderModal(width).lines,
        invalidate: () => modal.invalidate(),
        handleInput(data: string) {
          modal.handleInput(data);
          tui.requestRender();
        },
      };
    },
    { overlay: true, overlayOptions },
  );
}
