import type { ForegroundController } from "./foreground.js";
import type { JobRegistry } from "./registry.js";

export interface BgRuntime {
  registry: JobRegistry;
  foreground: ForegroundController;
}

let runtime: BgRuntime | undefined;

export function getBgRuntime(): BgRuntime | undefined {
  return runtime;
}

export function setBgRuntime(next: BgRuntime | undefined): void {
  runtime = next;
}
