import {
  Input,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
  type Focusable,
} from "@earendil-works/pi-tui";
import { ZellijModal, type ZellijModalContentRenderer } from "../../zellij-modal.js";
import type { SideThread } from "./thread.js";

interface ThemeLike {
  fg(color: string, text: string): string;
  bold(text: string): string;
}

export interface BtwOverlayOptions {
  /** Called when the user submits the prompt. */
  onSubmit?: (text: string) => void;
  /** Called when the user presses Esc (or Ctrl+C). */
  onClose?: () => void;
}

const HEADER_TITLE = "pi-on-steroids /btw";
const PLACEHOLDER = "Ask a side question…";
/** Fixed rows: modal top/bottom borders plus header, divider, divider, prompt and footer. */
const CONTENT_CHROME_ROWS = 7;

export class BtwOverlay implements Component, Focusable {
  focused = false;
  private readonly input = new Input();
  private readonly modal: ZellijModal;

  constructor(
    private readonly thread: SideThread,
    private readonly theme: ThemeLike,
    private readonly getMaxLines: () => number,
    options: BtwOverlayOptions = {},
  ) {
    this.input.onEscape = () => options.onClose?.();
    this.input.onSubmit = (value) => {
      const text = value.trim();
      if (!text || this.thread.streaming) return;
      this.input.setValue("");
      options.onSubmit?.(text);
    };

    const content: ZellijModalContentRenderer = {
      render: (width) => this.renderContent(width),
      invalidate: () => this.input.invalidate(),
      handleInput: (data) => this.handleInput(data),
    };
    // Use the same square Zellij frame as the /steroids settings overlay so the
    // side chat is immediately recognizable.
    this.modal = new ZellijModal(
      content,
      { borderStyle: "square", padding: 0, titleBar: {}, minWidth: 40 },
      theme as never,
    );
  }

  invalidate(): void {
    this.modal.invalidate();
  }

  handleInput(data: string): void {
    this.input.focused = true;
    this.input.handleInput(data);
  }

  render(width: number): string[] {
    return this.modal.renderModal(width).lines;
  }

  private renderContent(width: number): string[] {
    this.input.focused = this.focused;
    const safeWidth = Math.max(1, width);
    const divider = this.theme.fg("dim", "─".repeat(safeWidth));
    const body = this.renderBody(safeWidth);
    return [
      this.renderHeader(safeWidth),
      divider,
      ...body,
      divider,
      this.renderPrompt(safeWidth),
      this.renderFooter(safeWidth),
    ];
  }

  private renderHeader(width: number): string {
    const title = this.theme.fg("accent", this.theme.bold(HEADER_TITLE));
    const state = this.thread.streaming ? " · answering…" : "";
    const statusText = `btw${state}`;
    const status = this.theme.fg("muted", statusText);
    const gap = Math.max(1, width - visibleWidth(HEADER_TITLE) - visibleWidth(statusText));
    if (gap <= 1) {
      return truncateToWidth(`${title} ${status}`, width, "", true);
    }
    return `${title}${" ".repeat(gap)}${status}`;
  }

  private renderBody(width: number): string[] {
    const body: string[] = [];
    for (const block of this.thread.blocks) {
      const wrap = (text: string, color: string, prefix = "") =>
        wrapTextWithAnsi(prefix + text, width).map((line) => this.theme.fg(color, line));
      switch (block.kind) {
        case "user":
          body.push(...wrap(block.text, "accent", "› "));
          break;
        case "assistant":
          body.push(...wrapTextWithAnsi(block.text || "…", width));
          break;
        case "tool":
          body.push(...wrap(block.text, "muted", "· "));
          break;
        case "error":
          body.push(...wrap(block.text, "error"));
          break;
      }
    }
    if (body.length === 0) {
      body.push(this.theme.fg("muted", "Ask a side question below. The thread is read-only."));
    }

    const maxBody = Math.max(1, this.getMaxLines() - CONTENT_CHROME_ROWS);
    if (body.length <= maxBody) return body;
    // One row goes to the notice itself.
    const tail = maxBody > 1 ? body.slice(-(maxBody - 1)) : [];
    const hidden = body.length - tail.length;
    return [this.theme.fg("muted", `… ${hidden} earlier lines`), ...tail];
  }

  private renderPrompt(width: number): string {
    // Input always prefixes its own "> " prompt; render two columns wider and
    // swap in the codex/opencode-style "›" prompt so we work across pi-tui versions.
    const rendered = this.input.render(width + 2)[0] ?? "";
    const content = (rendered.startsWith("> ") ? rendered.slice(2) : rendered).trimEnd();
    const value = this.input.getValue();
    const body = value ? content : `${content}${this.theme.fg("muted", PLACEHOLDER)}`;
    const line = `${this.theme.fg("accent", "› ")}${body}`;
    const clipped = truncateToWidth(line, width, "");
    return `${clipped}${" ".repeat(Math.max(0, width - visibleWidth(clipped)))}`;
  }

  private renderFooter(width: number): string {
    const text = this.thread.streaming
      ? "read-only │ answering… │ esc cancel"
      : "read-only │ enter send │ esc close │ /btw:inject │ /btw:clear";
    return this.theme.fg("dim", truncateToWidth(text, width, "…", true));
  }
}
