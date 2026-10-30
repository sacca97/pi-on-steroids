import {
  type ExtensionAPI,
  UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import {
  patchNativeUserMessagePrototype,
  type PatchableUserMessagePrototype,
  type UserMessageTheme,
} from "./user-message-box-renderer.js";
import { unregisterUserMessageRenderPrototypePatch } from "./user-message-box-patch.js";
import type { SteroidsConfig } from "../../types.js";
import { createRegistrationGuard, onReloadShutdown } from "../../extension-lifecycle.js";

const registration = createRegistrationGuard();

function getUserMessagePrototype(): PatchableUserMessagePrototype {
  return UserMessageComponent.prototype as unknown as PatchableUserMessagePrototype;
}

function patchUserMessageRender(
  getTheme: () => UserMessageTheme | undefined,
  isEnabled: () => boolean,
): void {
  patchNativeUserMessagePrototype(
    getUserMessagePrototype(),
    getTheme,
    isEnabled,
  );
}

function restoreUserMessageRender(): void {
  unregisterUserMessageRenderPrototypePatch(getUserMessagePrototype());
}

export default function registerNativeUserMessageBox(
  pi: ExtensionAPI,
  getConfig: () => SteroidsConfig,
): void {
  if (!registration.claim(pi)) {
    return;
  }

  let activeTheme: UserMessageTheme | undefined;

  const getTheme = (): UserMessageTheme | undefined => activeTheme;
  const isEnabled = (): boolean => getConfig().enableNativeUserMessageBox;

  patchUserMessageRender(getTheme, isEnabled);

  onReloadShutdown(pi, () => {
    restoreUserMessageRender();
    activeTheme = undefined;
    registration.release(pi);
  });

  pi.on("before_agent_start", async () => {
    patchUserMessageRender(getTheme, isEnabled);
  });

  pi.on("session_start", async (_event, ctx) => {
    activeTheme = ctx?.ui?.theme as unknown as UserMessageTheme;
    patchUserMessageRender(getTheme, isEnabled);
  });

}
