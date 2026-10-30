import {
  buildSessionContext,
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
  type ExtensionAPI,
  type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import type { SteroidsConfig } from "../../types.js";
import { BtwOverlay } from "./overlay.js";
import { SideThread, type SideSessionLike } from "./thread.js";
import { createRegistrationGuard, onReloadShutdown } from "../../extension-lifecycle.js";
import { resolveOverlayOptions } from "../../steroids-settings.js";

/** Side-chat sessions are read-only: they must never race the main agent on writes. */
export const READ_ONLY_TOOLS = ["read", "grep", "find", "ls"] as const;
const registration = createRegistrationGuard();

export default function registerBtw(pi: ExtensionAPI, getConfig: () => SteroidsConfig): void {
  if (!getConfig().btwSideChat || !registration.claim(pi)) {
    return;
  }

  let currentCtx: ExtensionCommandContext | undefined;
  let closeOverlay: (() => void) | undefined;

  const createSession = async (): Promise<SideSessionLike> => {
    const ctx = currentCtx;
    if (!ctx) throw new Error("No active session context.");

    const cwd = ctx.cwd;
    const sessionManager = SessionManager.inMemory(cwd);
    const context = buildSessionContext(ctx.sessionManager.getEntries(), ctx.sessionManager.getLeafId());
    for (const message of context.messages) {
      sessionManager.appendMessage(message as never);
    }

    // Side sessions load no extensions, so this plugin cannot recurse into itself.
    const resourceLoader = new DefaultResourceLoader({ cwd, agentDir: getAgentDir(), noExtensions: true });
    await resourceLoader.reload();

    const { session } = await createAgentSession({
      cwd,
      sessionManager,
      resourceLoader,
      model: ctx.model,
      thinkingLevel: pi.getThinkingLevel(),
      tools: [...READ_ONLY_TOOLS],
    });
    return session as unknown as SideSessionLike;
  };

  const thread = new SideThread(createSession);

  const askInThread = async (ctx: ExtensionCommandContext, question: string, fresh = false): Promise<void> => {
    currentCtx = ctx;
    const answer = await thread.ask(question, fresh).catch((error: unknown) => {
      ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      return "";
    });
    if (ctx.mode !== "tui") {
      const last = thread.blocks.at(-1);
      if (answer) ctx.ui.notify(answer, "info");
      else if (last?.kind === "error") ctx.ui.notify(last.text, "error");
    }
  };

  const showOverlay = (ctx: ExtensionCommandContext): void => {
    if (closeOverlay || ctx.mode !== "tui") return;
    const overlayOptions = resolveOverlayOptions();
    void ctx.ui
      .custom<void>(
        (tui, theme, _keybindings, done) => {
          closeOverlay = () => {
            void thread.abort().catch(() => {});
            done();
          };
          const unsubscribe = thread.onChange(() => tui.requestRender());
          const component = new BtwOverlay(
            thread,
            theme as never,
            () => Math.floor((process.stdout.rows || 30) * 0.6),
            {
              onSubmit: (text) => void askInThread(ctx, text),
              onClose: () => closeOverlay?.(),
            },
          );
          const dispose = component as unknown as { dispose?: () => void };
          dispose.dispose = unsubscribe;
          return component;
        },
        { overlay: true, overlayOptions },
      )
      .finally(() => {
        closeOverlay = undefined;
      });
  };

  const runAsk = async (ctx: ExtensionCommandContext, args: string, fresh = false): Promise<void> => {
    const text = args.trim();
    currentCtx = ctx;
    showOverlay(ctx);
    if (text) {
      await askInThread(ctx, text, fresh);
    } else if (ctx.mode !== "tui") {
      // In the TUI a bare /btw opens the overlay prompt; elsewhere there is nowhere to type.
      ctx.ui.notify("Usage: /btw <question>", "warning");
    }
  };

  const clear = (): void => {
    thread.reset();
    closeOverlay?.();
  };

  const inject = async (ctx: ExtensionCommandContext, text: string, instructions: string): Promise<void> => {
    if (!text) {
      ctx.ui.notify("The side thread is empty.", "warning");
      return;
    }
    const prefix = instructions ? `${instructions}\n\n` : "";
    await pi.sendUserMessage(`${prefix}From a side conversation:\n\n${text}`, { deliverAs: "followUp" });
    clear();
  };

  const commands: [string, string, (args: string, ctx: ExtensionCommandContext) => Promise<void>][] = [
    ["btw", "Ask a read-only side question without interrupting the main agent", (args, ctx) => runAsk(ctx, args)],
    ["btw:new", "Start a fresh side thread that inherits main-session context", (args, ctx) => runAsk(ctx, args, true)],
    ["btw:clear", "Dismiss the side thread", async () => clear()],
    ["btw:inject", "Send the side thread to the main agent", (args, ctx) => inject(ctx, thread.transcriptText(), args.trim())],
  ];

  for (const [name, description, run] of commands) {
    pi.registerCommand(name, { description, handler: async (args, ctx) => run(args, ctx) });
  }

  pi.on("session_shutdown", async () => clear());
  onReloadShutdown(pi, () => registration.release(pi));
}
