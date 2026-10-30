import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Register a session_shutdown handler that runs cleanup only when the
 * session is shutting down for a reload. Centralizes the reload-detection
 * check shared by extension registration modules.
 */
export function onReloadShutdown(pi: ExtensionAPI, cleanup: () => void): void {
  pi.on("session_shutdown", async (event: { reason?: string }) => {
    if (event?.reason === "reload") {
      cleanup();
    }
  });
}

/**
 * Per-feature guard so a feature registers at most once per ExtensionAPI until
 * it releases the claim (normally from its reload cleanup).
 */
export function createRegistrationGuard(): {
  claim(pi: ExtensionAPI): boolean;
  release(pi: ExtensionAPI): void;
} {
  const claimed = new WeakSet<ExtensionAPI>();
  return {
    claim(pi) {
      if (claimed.has(pi)) return false;
      claimed.add(pi);
      return true;
    },
    release(pi) {
      claimed.delete(pi);
    },
  };
}
