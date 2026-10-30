/**
 * Read-only view of the active branch for the history tools. Raw tool output
 * is kept aside and only surfaced on request; tool outcomes come from Pi's
 * structured `isError` / exit codes, never from guessing at the text.
 */

export type ToolStatus = "SUCCESS" | "FAILURE" | "UNKNOWN";
export type HistoryKind = "user" | "assistant" | "tool" | "shell" | "note";

export interface HistoryItem {
  entryId: string;
  /** Position on the branch, used to keep items in order and window reads. */
  index: number;
  timestamp?: string;
  kind: HistoryKind;
  /** Searchable text: message text, or a short tool-call description. */
  text: string;
  /** Raw tool or shell output, excluded unless explicitly requested. */
  output?: string;
  status?: ToolStatus;
  /** True once a compaction has dropped the entry from the model context. */
  compacted: boolean;
}

interface RawEntry {
  type?: string;
  id?: string;
  timestamp?: string;
  firstKeptEntryId?: string;
  summary?: string;
  message?: RawMessage;
  /** custom_message entries keep these on the entry itself. */
  content?: unknown;
  display?: boolean;
}

interface RawMessage {
  role?: string;
  content?: unknown;
  toolCallId?: string;
  isError?: boolean;
  command?: string;
  output?: string;
  exitCode?: number;
  cancelled?: boolean;
}

interface RawBlock {
  type?: string;
  text?: string;
  id?: string;
  name?: string;
  arguments?: Record<string, unknown>;
}

const ARG_VALUE_CHARS = 200;
const ARGS_CHARS = 400;
const COMMAND_CHARS = 500;

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return (content as RawBlock[])
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n");
}

function lineCount(value: unknown): number {
  return typeof value === "string" ? value.split("\n").length : 0;
}

/** One line per tool call: keep paths and commands, drop file bodies. */
export function describeToolCall(name: string, args: Record<string, unknown> = {}): string {
  const path = typeof args.path === "string" ? args.path : typeof args.file_path === "string" ? args.file_path : undefined;
  switch (name) {
    case "bash":
    case "bash_bg":
      return `${name}: ${clip(String(args.command ?? ""), COMMAND_CHARS)}`;
    case "read": {
      const range = [args.offset !== undefined ? `offset ${args.offset}` : "", args.limit !== undefined ? `limit ${args.limit}` : ""]
        .filter(Boolean)
        .join(", ");
      return `read: ${path ?? ""}${range ? ` (${range})` : ""}`;
    }
    case "write":
      return `write: ${path ?? ""} (${lineCount(args.content)} lines)`;
    case "edit": {
      const edits = Array.isArray(args.edits) ? args.edits.length : 1;
      return `edit: ${path ?? ""} (${edits} ${edits === 1 ? "change" : "changes"})`;
    }
  }
  const parts = Object.entries(args).map(([key, value]) => {
    const rendered = typeof value === "string" ? value : JSON.stringify(value);
    return `${key}=${clip(rendered ?? "", ARG_VALUE_CHARS)}`;
  });
  return clip(`${name}: ${parts.join(", ")}`, ARGS_CHARS);
}

function shellStatus(message: RawMessage): ToolStatus {
  if (message.cancelled || typeof message.exitCode !== "number") return "UNKNOWN";
  return message.exitCode === 0 ? "SUCCESS" : "FAILURE";
}

/** Flatten branch entries (root → leaf) into ordered, searchable items. */
export function buildHistory(entries: readonly unknown[]): HistoryItem[] {
  const branch = entries as RawEntry[];
  const latestCompaction = branch.findLast((entry) => entry?.type === "compaction");
  const keptIndex = latestCompaction ? branch.findIndex((entry) => entry?.id === latestCompaction.firstKeptEntryId) : -1;
  const compactionIndex = latestCompaction ? branch.indexOf(latestCompaction) : -1;
  // A retain-none compaction points at itself, so everything before it is compacted.
  const contextStart = keptIndex >= 0 ? keptIndex : compactionIndex;

  const items: HistoryItem[] = [];
  const pendingCalls = new Map<string, HistoryItem>();

  branch.forEach((entry, position) => {
    if (!entry?.id) return;
    const base = { entryId: entry.id, timestamp: entry.timestamp, compacted: position < contextStart };
    const push = (item: Omit<HistoryItem, "index" | keyof typeof base>): HistoryItem => {
      const full = { ...base, ...item, index: items.length };
      items.push(full);
      return full;
    };

    if (entry.type === "branch_summary" && entry.summary) {
      push({ kind: "note", text: `Branch summary: ${entry.summary}` });
      return;
    }
    // Extension messages (e.g. background-job notifications) are stored as their own entry type.
    if (entry.type === "custom_message") {
      const text = textOf(entry.content);
      if (entry.display && text.trim()) push({ kind: "note", text });
      return;
    }
    if (entry.type !== "message" || !entry.message) return;
    const message = entry.message;

    switch (message.role) {
      case "user": {
        const text = textOf(message.content);
        if (text.trim()) push({ kind: "user", text });
        break;
      }
      case "assistant": {
        const blocks = Array.isArray(message.content) ? (message.content as RawBlock[]) : [];
        const text = textOf(blocks);
        if (text.trim()) push({ kind: "assistant", text });
        for (const block of blocks) {
          if (block?.type !== "toolCall" || !block.name) continue;
          const call = push({ kind: "tool", text: describeToolCall(block.name, block.arguments), status: "UNKNOWN" });
          if (block.id) pendingCalls.set(block.id, call);
        }
        break;
      }
      case "toolResult": {
        const call = message.toolCallId ? pendingCalls.get(message.toolCallId) : undefined;
        if (!call) break;
        call.status = message.isError === true ? "FAILURE" : message.isError === false ? "SUCCESS" : "UNKNOWN";
        call.output = textOf(message.content);
        pendingCalls.delete(message.toolCallId!);
        break;
      }
      case "bashExecution":
        push({ kind: "shell", text: `! ${clip(message.command ?? "", COMMAND_CHARS)}`, output: message.output ?? "", status: shellStatus(message) });
        break;
    }
  });

  return items;
}

export function parseQuery(query: string): string[] {
  const terms: string[] = [];
  for (const match of query.matchAll(/"([^"]+)"|(\S+)/g)) {
    const term = (match[1] ?? match[2]).trim().toLowerCase();
    if (term) terms.push(term);
  }
  return terms;
}

export interface SearchOptions {
  includeOutputs?: boolean;
  limit?: number;
}

export interface SearchHit {
  item: HistoryItem;
  /** Which field matched, so the excerpt can come from it. */
  field: "text" | "output";
}

/** Items containing every term, newest first. */
export function searchHistory(items: readonly HistoryItem[], query: string, options: SearchOptions = {}): SearchHit[] {
  const terms = parseQuery(query);
  if (terms.length === 0) return [];
  const limit = options.limit ?? 10;
  const hits: SearchHit[] = [];
  for (let i = items.length - 1; i >= 0 && hits.length < limit; i--) {
    const item = items[i];
    const text = item.text.toLowerCase();
    const output = options.includeOutputs ? (item.output ?? "").toLowerCase() : "";
    if (!terms.every((term) => text.includes(term) || output.includes(term))) continue;
    const textMatches = terms.some((term) => text.includes(term));
    hits.push({ item, field: textMatches ? "text" : "output" });
  }
  return hits;
}

/** A single-line window of `text` around the first matching term. */
export function excerpt(text: string, terms: readonly string[], width = 240): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= width) return flat;
  const lower = flat.toLowerCase();
  const at = Math.min(...terms.map((term) => lower.indexOf(term)).filter((index) => index >= 0), flat.length);
  const start = at >= flat.length ? 0 : Math.max(0, Math.min(at - Math.floor(width / 3), flat.length - width));
  const end = Math.min(flat.length, start + width);
  return `${start > 0 ? "…" : ""}${flat.slice(start, end)}${end < flat.length ? "…" : ""}`;
}

function header(item: HistoryItem): string {
  const status = item.status ? ` → ${item.status}` : "";
  const when = item.timestamp ? ` ${item.timestamp.slice(0, 16).replace("T", " ")}` : "";
  const where = item.compacted ? "" : " (in context)";
  return `#${item.entryId} [${item.kind}]${when}${where}${status}`;
}

export function formatSearch(hits: readonly SearchHit[], query: string, maxChars = 6000): string {
  if (hits.length === 0) return `No history entries match "${query}".`;
  const terms = parseQuery(query);
  const lines: string[] = [];
  let used = 0;
  for (const { item, field } of hits) {
    const body = field === "output" ? `output: ${excerpt(item.output ?? "", terms)}` : excerpt(item.text, terms);
    const block = `${header(item)}\n  ${field === "output" ? `${item.text}\n  ${body}` : body}`;
    if (used + block.length > maxChars) {
      lines.push(`… more matches omitted; narrow the query.`);
      break;
    }
    lines.push(block);
    used += block.length;
  }
  lines.push("", "Use history_read with an entry id to see the surrounding conversation.");
  return lines.join("\n");
}

export interface ReadOptions {
  before?: number;
  after?: number;
  includeOutputs?: boolean;
  itemChars?: number;
  outputChars?: number;
  maxChars?: number;
}

export function readHistory(items: readonly HistoryItem[], entryId: string, options: ReadOptions = {}): string {
  const id = entryId.replace(/^#/, "").trim();
  const first = items.findIndex((item) => item.entryId === id);
  if (first < 0) return `No history entry with id ${id} on the current branch.`;
  const last = items.findLastIndex((item) => item.entryId === id);
  const from = Math.max(0, first - (options.before ?? 2));
  const to = Math.min(items.length - 1, last + (options.after ?? 8));
  const itemChars = options.itemChars ?? 2000;
  const outputChars = options.outputChars ?? 1500;
  const maxChars = options.maxChars ?? 12000;

  const blocks: string[] = [];
  let used = 0;
  for (let i = from; i <= to; i++) {
    const item = items[i];
    let block = `${header(item)}\n${clip(item.text, itemChars)}`;
    if (options.includeOutputs && item.output) block += `\n--- output ---\n${clip(item.output, outputChars)}`;
    if (used + block.length > maxChars) {
      blocks.push(`… stopped at the size limit; continue with history_read #${item.entryId}.`);
      break;
    }
    blocks.push(block);
    used += block.length;
  }
  if (to < items.length - 1 && !blocks.at(-1)?.startsWith("…")) blocks.push(`… later entries continue from #${items[to + 1].entryId}.`);
  return blocks.join("\n\n");
}

const POINTER_MARKER = "<!-- compaction-history -->";

export const BRIEF_SUMMARY_INSTRUCTIONS =
  "Keep the summary brief: only what is needed to continue the work. The full earlier conversation stays retrievable with the history_search and history_read tools, so do not reproduce file contents, command output or long details.";

function historyPointer(firstKeptEntryId: string): string {
  return [
    POINTER_MARKER,
    "Earlier conversation was compacted, but its full history is preserved in this session",
    `(entries before #${firstKeptEntryId}). Use history_search to find earlier decisions, commands,`,
    "file paths or errors, and history_read to see the conversation around a match.",
    "This summary is incomplete: something missing here may still be in the history.",
  ].join("\n");
}

export function withPointer(summary: string, firstKeptEntryId: string): string {
  return `${stripPointer(summary)}\n\n${historyPointer(firstKeptEntryId)}`;
}

/** Remove a previous pointer so iterative summaries do not accumulate copies. */
export function stripPointer(summary: string | undefined): string | undefined {
  if (summary === undefined) return undefined;
  const at = summary.indexOf(POINTER_MARKER);
  return at < 0 ? summary : summary.slice(0, at).trimEnd();
}
