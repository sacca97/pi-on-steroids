export interface TranscriptBlock {
  kind: "user" | "assistant" | "tool" | "error";
  text: string;
}

/** The subset of AgentSession the side thread depends on. */
export interface SideSessionLike {
  subscribe(listener: (event: SideSessionEvent) => void): () => void;
  prompt(text: string): Promise<void>;
  abort(): Promise<void>;
  dispose(): void;
}

export interface SideSessionEvent {
  type: string;
  toolName?: string;
  args?: unknown;
  assistantMessageEvent?: { type: string; delta?: string };
}

export type SideSessionFactory = () => Promise<SideSessionLike>;

function describeToolCall(toolName: string, args: unknown): string {
  const record = (args ?? {}) as Record<string, unknown>;
  const target = [record.path, record.pattern, record.command].find((value) => typeof value === "string");
  return typeof target === "string" ? `${toolName} ${target.split("\n")[0].slice(0, 80)}` : toolName;
}

export class SideThread {
  private session: SideSessionLike | undefined;
  private unsubscribe: (() => void) | undefined;
  private openAssistant: TranscriptBlock | undefined;
  /** Bumped by reset(), so an ask that started before it can tell it no longer owns the thread. */
  private epoch = 0;
  private readonly listeners = new Set<() => void>();

  blocks: TranscriptBlock[] = [];
  streaming = false;

  constructor(private readonly createSession: SideSessionFactory) {}

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  get active(): boolean {
    return this.session !== undefined;
  }

  /** Sends a question, starting a fresh thread first when `fresh` is set. */
  async ask(question: string, fresh = false): Promise<string> {
    if (fresh) {
      this.reset();
    }
    if (this.streaming) {
      throw new Error("The side thread is still answering. Wait for it or run /btw:clear.");
    }

    // Mark the thread busy before creating the session, so an overlapping ask cannot create a second one.
    const epoch = this.epoch;
    const owned = (): boolean => this.epoch === epoch;
    this.blocks.push({ kind: "user", text: question });
    this.openAssistant = undefined;
    this.streaming = true;
    this.emit();

    try {
      if (!this.session) {
        const created = await this.createSession();
        if (!owned()) {
          void created.abort().catch(() => {}).finally(() => created.dispose());
          return "";
        }
        this.session = created;
        this.unsubscribe = created.subscribe((event) => this.handleEvent(event));
      }
      await this.session.prompt(question);
    } catch (error) {
      // A reset replaced this session while it was answering; its outcome no longer belongs to the thread.
      if (owned()) {
        this.blocks.push({ kind: "error", text: error instanceof Error ? error.message : String(error) });
      }
    } finally {
      if (owned()) {
        this.streaming = false;
        this.openAssistant = undefined;
        this.emit();
      }
    }
    return owned() ? this.lastAnswer() : "";
  }

  lastAnswer(): string {
    return this.blocks.findLast((block) => block.kind === "assistant")?.text ?? "";
  }

  /** Plain-text rendering of the user/assistant turns, for injecting into the main agent. */
  transcriptText(): string {
    return this.blocks
      .filter((block) => block.kind === "user" || block.kind === "assistant")
      .map((block) => `${block.kind === "user" ? "Q" : "A"}: ${block.text}`)
      .join("\n\n");
  }

  async abort(): Promise<void> {
    await this.session?.abort();
  }

  reset(): void {
    this.epoch += 1;
    const session = this.session;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.session = undefined;
    this.openAssistant = undefined;
    this.streaming = false;
    this.blocks = [];
    if (session) {
      void session.abort().catch(() => {}).finally(() => session.dispose());
    }
    this.emit();
  }

  private handleEvent(event: SideSessionEvent): void {
    if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
      if (!this.openAssistant) {
        this.openAssistant = { kind: "assistant", text: "" };
        this.blocks.push(this.openAssistant);
      }
      this.openAssistant.text += event.assistantMessageEvent.delta ?? "";
      this.emit();
    } else if (event.type === "tool_execution_start") {
      this.openAssistant = undefined;
      this.blocks.push({ kind: "tool", text: describeToolCall(event.toolName ?? "tool", event.args) });
      this.emit();
    }
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}
