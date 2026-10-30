import { compact, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createRegistrationGuard, onReloadShutdown } from "../../extension-lifecycle.js";
import type { SteroidsConfig } from "../../types.js";
import {
  BRIEF_SUMMARY_INSTRUCTIONS,
  buildHistory,
  formatSearch,
  readHistory,
  searchHistory,
  stripPointer,
  withPointer,
} from "./history.js";

const registration = createRegistrationGuard();
const MAX_SEARCH_RESULTS = 30;

export default function registerCompactionHistory(pi: ExtensionAPI, getConfig: () => SteroidsConfig): void {
  if (!getConfig().compactionHistory || !registration.claim(pi)) {
    return;
  }

  pi.registerTool({
    name: "history_search",
    label: "history_search",
    description:
      "Search this session's full conversation history, including parts removed from context by compaction. Matches user and assistant messages and tool calls (commands, file paths); tool outcomes appear as SUCCESS, FAILURE or UNKNOWN. Returns short excerpts with entry ids.",
    promptSnippet: "Search earlier conversation history, including compacted parts",
    promptGuidelines: [
      "After a compaction, use history_search when you need an earlier decision, command, file path or error that the summary does not cover, instead of guessing or redoing the work.",
    ],
    parameters: Type.Object({
      query: Type.String({ description: "Keywords; all must match. Quote a phrase to match it exactly." }),
      include_outputs: Type.Optional(Type.Boolean({ description: "Also search raw tool and shell output (noisier). Default false." })),
      limit: Type.Optional(Type.Number({ description: `Maximum matches, newest first. Default 10, max ${MAX_SEARCH_RESULTS}.` })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const items = buildHistory(ctx.sessionManager.getBranch());
      const limit = Math.max(1, Math.min(MAX_SEARCH_RESULTS, Math.floor(params.limit ?? 10)));
      const hits = searchHistory(items, params.query, { includeOutputs: params.include_outputs, limit });
      return { content: [{ type: "text", text: formatSearch(hits, params.query) }], details: undefined };
    },
  });

  pi.registerTool({
    name: "history_read",
    label: "history_read",
    description:
      "Read the conversation around a history entry id returned by history_search. Tool output is omitted unless include_outputs is set, and is truncated.",
    parameters: Type.Object({
      entry_id: Type.String({ description: "Entry id from history_search, e.g. a1b2c3d4" }),
      before: Type.Optional(Type.Number({ description: "Items to show before the entry. Default 2, max 20." })),
      after: Type.Optional(Type.Number({ description: "Items to show after the entry. Default 8, max 40." })),
      include_outputs: Type.Optional(Type.Boolean({ description: "Include truncated raw tool output. Default false." })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const items = buildHistory(ctx.sessionManager.getBranch());
      const clamp = (value: number | undefined, fallback: number, max: number) =>
        Math.max(0, Math.min(max, Math.floor(value ?? fallback)));
      const text = readHistory(items, params.entry_id, {
        before: clamp(params.before, 2, 20),
        after: clamp(params.after, 8, 40),
        includeOutputs: params.include_outputs,
      });
      return { content: [{ type: "text", text }], details: undefined };
    },
  });

  // Same summarizer as Pi's default compaction, asked to stay brief, with a
  // pointer to the history tools appended. Returning nothing on any failure
  // lets Pi fall back to its own compaction.
  pi.on("session_before_compact", async (event, ctx) => {
    const model = ctx.model;
    if (!model) return;
    try {
      const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
      if (!auth.ok) return;
      const { preparation } = event;
      const instructions = [event.customInstructions?.trim(), BRIEF_SUMMARY_INSTRUCTIONS].filter(Boolean).join("\n\n");
      const result = await compact(
        { ...preparation, previousSummary: stripPointer(preparation.previousSummary) },
        model,
        auth.apiKey,
        auth.headers,
        instructions,
        event.signal,
        pi.getThinkingLevel(),
        undefined,
        auth.env,
      );
      return { compaction: { ...result, summary: withPointer(result.summary, result.firstKeptEntryId) } };
    } catch {
      // Cancelled by the user: stay cancelled rather than letting Pi run its own compaction.
      return event.signal.aborted ? { cancel: true } : undefined;
    }
  });

  onReloadShutdown(pi, () => registration.release(pi));
}
