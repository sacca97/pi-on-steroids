import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  applyProfile,
  deleteProfile,
  describeProfile,
  getProfileSettings,
  isBuiltInProfile,
  listProfileNames,
  nextCustomProfileName,
  saveProfile,
} from "./profiles.js";
import { FEATURE_TOGGLES, openSettingsOverlay, type SteroidsController } from "./steroids-settings.js";

export type { SteroidsController };
import type { SteroidsConfig } from "./types.js";

const USAGE = "Usage: /steroids [show|list|on|off|reset|profile <name>|save [name]|delete <name>]";

const onOff = (value: boolean): string => (value ? "on" : "off");

function summarize(config: SteroidsConfig): string {
  const features = FEATURE_TOGGLES.map(({ key, label }) => `${label}: ${onOff(config[key])}`).join(", ");
  return `display profile: ${describeProfile(config)}; ${features}`;
}

function run(action: () => SteroidsConfig, ctx: ExtensionCommandContext, controller: SteroidsController, message: string): void {
  try {
    controller.setConfig(action(), ctx);
    ctx.ui.notify(message, "info");
  } catch (error) {
    ctx.ui.notify(error instanceof Error ? error.message : String(error), "warning");
  }
}

function handleArgs(args: string, ctx: ExtensionCommandContext, controller: SteroidsController): boolean {
  const [command, ...rest] = args.trim().split(/\s+/);
  const config = controller.getConfig();
  const typed = rest.join(" ").trim();
  const name = listProfileNames(config).find((candidate) => candidate.toLowerCase() === typed.toLowerCase()) ?? typed;

  switch (command?.toLowerCase()) {
    case "":
    case undefined:
      return false;
    case "show":
      ctx.ui.notify(`steroids: ${summarize(config)}`, "info");
      return true;
    case "list":
      ctx.ui.notify(`Profiles: ${listProfileNames(config).join(", ")} (active: ${describeProfile(config)})`, "info");
      return true;
    case "reset":
      run(() => applyProfile(config, "hidden"), ctx, controller, "Display profile reset to hidden.");
      return true;
    case "on":
    case "off": {
      const enabled = command.toLowerCase() === "on";
      run(() => ({ ...config, enabled }), ctx, controller, `pi-on-steroids ${enabled ? "enabled" : "disabled"}; applies after /reload.`);
      return true;
    }
    case "profile":
      if (!getProfileSettings(config, name)) {
        ctx.ui.notify(`Unknown profile "${name}". Available: ${listProfileNames(config).join(", ")}`, "warning");
      } else {
        run(() => applyProfile(config, name), ctx, controller, `Display profile set to ${name}.`);
      }
      return true;
    case "save": {
      const target = name || nextCustomProfileName(config);
      run(() => saveProfile(config, target), ctx, controller, `Saved current display settings as ${target}.`);
      return true;
    }
    case "delete":
      if (!name || isBuiltInProfile(name) || !Object.hasOwn(config.customProfiles, name)) {
        ctx.ui.notify(`"${name}" is not a custom profile. Custom: ${Object.keys(config.customProfiles).join(", ") || "none"}`, "warning");
      } else {
        run(() => deleteProfile(config, name), ctx, controller, `Deleted profile ${name}.`);
      }
      return true;
    default:
      ctx.ui.notify(USAGE, "warning");
      return true;
  }
}

export async function runSteroidsCommand(
  args: string,
  ctx: ExtensionCommandContext,
  controller: SteroidsController,
): Promise<void> {
  if (handleArgs(args, ctx, controller)) return;
  if (!ctx.hasUI || ctx.mode !== "tui") {
    ctx.ui.notify("The /steroids settings window needs the TUI. " + USAGE, "warning");
    return;
  }
  await openSettingsOverlay(ctx, controller);
}

export function registerSteroidsCommand(pi: ExtensionAPI, controller: SteroidsController): void {
  pi.registerCommand("steroids", {
    description: "Switch display profiles and toggle pi-on-steroids features",
    handler: (args, ctx) => runSteroidsCommand(args, ctx, controller),
  });
}
