import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isRecord } from "../tool-rendering/tool-metadata.js";
import { createRegistrationGuard, onReloadShutdown } from "../../extension-lifecycle.js";

interface ThemeLike {
  fg(color: string, text: string): string;
}

interface AssistantMessageLike {
  role?: unknown;
  api?: unknown;
  content?: unknown;
}

const THINKING_CHAT_PREFIX = "Thinking: ";
const THINKING_LABEL_PREFIX_PATTERN = /^(?:thinking:\s*)+/i;
const LEADING_ANSI_FRAGMENT_PATTERN = /^(?:\s*;?\d{1,3}(?:;\d{1,3})*m)+\s*/;
const MAX_THINKING_CONTENT_DEPTH = 16;

const registration = createRegistrationGuard();

const OPENAI_REASONING_APIS = new Set([
  "openai-completions",
  "openai-responses",
  "openai-codex-responses",
]);

function shouldPrefixThinkingForApi(api: unknown): boolean {
  const normalizedApi = typeof api === "string" ? api.trim().toLowerCase() : "";

  // Keep OpenAI handling explicit to avoid applying this formatter to
  // unrelated OpenAI transport APIs that may not emit thinking blocks.
  if (normalizedApi.startsWith("openai-")) {
    return OPENAI_REASONING_APIS.has(normalizedApi);
  }

  // For non-OpenAI providers, apply the prefix when thinking blocks exist.
  return true;
}

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

function stripLeadingAnsiFragments(text: string): string {
  let current = text;
  while (true) {
    const next = current.replace(LEADING_ANSI_FRAGMENT_PATTERN, "");
    if (next === current) {
      return current;
    }
    current = next;
  }
}

function stripThinkingPresentationArtifacts(text: string): string {
  let current = stripAnsi(text);
  let removedThinkingLabel = false;

  while (true) {
    const withoutLabel = current
      .replace(THINKING_LABEL_PREFIX_PATTERN, "")
      .trimStart();
    if (withoutLabel !== current) {
      current = withoutLabel;
      removedThinkingLabel = true;
      continue;
    }

    const withoutAnsiFragments = stripLeadingAnsiFragments(current).trimStart();
    if (withoutAnsiFragments !== current) {
      const fragmentExposedAnotherLabel =
        withoutAnsiFragments.replace(THINKING_LABEL_PREFIX_PATTERN, "").trimStart() !==
        withoutAnsiFragments;

      if (removedThinkingLabel || fragmentExposedAnotherLabel) {
        current = withoutAnsiFragments;
        continue;
      }
    }

    return current;
  }
}

function formatThinkingLabel(theme: ThemeLike | undefined, thinkingText: string): string {
  if (!theme) {
    return `${THINKING_CHAT_PREFIX}${thinkingText}`;
  }

  const label = theme.fg("accent", THINKING_CHAT_PREFIX.trimEnd());
  const body = theme.fg("thinkingText", thinkingText);
  return `${label} ${body}`;
}

function prefixThinkingLine(text: string, theme: ThemeLike | undefined): string {
  const normalizedThinking = stripThinkingPresentationArtifacts(text).trim();
  if (!normalizedThinking) {
    return text;
  }

  return formatThinkingLabel(theme, normalizedThinking);
}

function isThinkingBlock(value: unknown): value is Record<string, unknown> & {
  type: "thinking";
  thinking: string;
} {
  return isRecord(value) && value.type === "thinking" && typeof value.thinking === "string";
}

function mapThinkingContentArray(
  content: unknown[],
  mapThinkingText: (text: string) => string,
  depth = 0,
  seen: WeakSet<object> = new WeakSet<object>(),
): { content: unknown[]; changed: boolean } {
  if (depth > MAX_THINKING_CONTENT_DEPTH || seen.has(content)) {
    return { content, changed: false };
  }

  seen.add(content);
  let changed = false;
  const nextContent = content.map((block) => {
    if (Array.isArray(block)) {
      const nested = mapThinkingContentArray(
        block,
        mapThinkingText,
        depth + 1,
        seen,
      );
      changed ||= nested.changed;
      return nested.content;
    }

    if (!isThinkingBlock(block)) {
      return block;
    }

    const nextThinking = mapThinkingText(block.thinking);
    if (nextThinking === block.thinking) {
      return block;
    }

    changed = true;
    return { ...block, thinking: nextThinking };
  });

  return { content: changed ? nextContent : content, changed };
}

function withThinkingLabelsForDisplay(
  content: unknown,
  theme: ThemeLike | undefined,
): unknown {
  if (!Array.isArray(content)) {
    return content;
  }

  return mapThinkingContentArray(content, (thinking) =>
    prefixThinkingLine(thinking, theme),
  ).content;
}

function sanitizeThinkingBlocksForContext(message: AssistantMessageLike): AssistantMessageLike {
  if (!Array.isArray(message.content)) {
    return message;
  }

  const mapped = mapThinkingContentArray(
    message.content,
    stripThinkingPresentationArtifacts,
  );

  return mapped.changed ? { ...message, content: mapped.content } : message;
}

function sanitizeContextMessages(messages: unknown[]): unknown[] {
  let changed = false;
  const nextMessages = messages.map((message) => {
    if (!isRecord(message) || message.role !== "assistant") {
      return message;
    }

    const sanitized = sanitizeThinkingBlocksForContext(message as AssistantMessageLike);
    changed ||= sanitized !== message;
    return sanitized;
  });

  return changed ? nextMessages : messages;
}

function prefixThinkingBlocksForDisplay(
  message: AssistantMessageLike,
  theme: ThemeLike | undefined,
): void {
  if (!shouldPrefixThinkingForApi(message.api)) {
    return;
  }

  const displayContent = withThinkingLabelsForDisplay(message.content, theme);
  if (displayContent !== message.content) {
    message.content = displayContent;
  }
}

function extractAssistantMessage(event: unknown): AssistantMessageLike | undefined {
  const maybeMessage = isRecord(event) ? event.message : undefined;
  return isRecord(maybeMessage) && maybeMessage.role === "assistant" ? (maybeMessage as AssistantMessageLike) : undefined;
}

function processThinkingEvent(
  event: unknown,
  ctx: ExtensionContext | undefined,
  notifyPrefix: string,
): void {
  try {
    const message = extractAssistantMessage(event);
    if (!message) {
      return;
    }
    prefixThinkingBlocksForDisplay(message, ctx?.ui?.theme);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    ctx?.ui?.notify(`${notifyPrefix}: ${errorMessage}`, "warning");
  }
}

function handleThinkingContextEvent(event: unknown, ctx: ExtensionContext | undefined): void {
  try {
    if (!isRecord(event) || !Array.isArray(event.messages)) {
      return;
    }

    const sanitizedMessages = sanitizeContextMessages(event.messages);
    if (sanitizedMessages !== event.messages) {
      event.messages.splice(0, event.messages.length, ...sanitizedMessages);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    ctx?.ui?.notify(`Thinking context sanitization failed: ${message}`, "warning");
  }
}

export function registerThinkingLabeling(pi: ExtensionAPI): void {
  if (!registration.claim(pi)) {
    return;
  }

  onReloadShutdown(pi, () => {
    registration.release(pi);
  });

  pi.on("message_update", async (event, ctx) => {
    // Render-only labeling: update the transient message_update payload while
    // leaving canonical session/LLM context content untouched.
    processThinkingEvent(event, ctx, "Thinking label formatting failed");
  });

  pi.on("message_end", async (event, ctx) => {
    // Persist themed labels on final assistant messages so the label remains
    // visible after streaming ends and across session reloads.
    // Context sanitization strips these presentation artifacts before each LLM call.
    processThinkingEvent(event, ctx, "Thinking label finalization failed");
  });

  pi.on("context", async (event, ctx) => {
    handleThinkingContextEvent(event, ctx);
  });
}
