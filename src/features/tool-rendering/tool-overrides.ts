import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type {
  BashToolDetails,
  EditToolDetails,
  ExtensionAPI,
  FindToolDetails,
  GrepToolDetails,
  LsToolDetails,
  ReadToolDetails,
  ToolDefinition,
  ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import {
  createBashTool,
  createLocalBashOperations,
  type BashOperations,
  createEditTool,
  createFindTool,
  createGrepTool,
  createLsTool,
  createReadTool,
  createWriteTool,
  formatSize,
} from "@earendil-works/pi-coding-agent";
import { Container, Spacer, Text } from "@earendil-works/pi-tui";
import { resolvePiAgentDir } from "../../agent-dir.js";
import { renderBashCall } from "./bash-display.js";
import {
  compactOutputLines,
  countNonEmptyLines,
  extractTextOutput,
  isLikelyQuietCommand,
  pluralize,
  previewLines,
  sanitizeAnsiForThemedOutput,
  shortenPath,
  splitLines,
} from "./render-utils.js";
import { renderEditDiffResult, renderWriteDiffResult } from "./diff-renderer.js";
import {
  buildPendingEditPreviewData,
  buildPendingWritePreviewData,
  readWorkspaceUtf8File,
  type PendingDiffPreviewData,
} from "./pending-diff-preview.js";
import { extractPromptMetadata, isNonBlankString, isRecord, toRecord } from "./tool-metadata.js";
import type { SteroidsConfig } from "../../types.js";
import { Type } from "typebox";
import { getBgRuntime } from "../bg-tasks/runtime.js";
import { runBashBg } from "../bg-tasks/tools.js";
import {
  countWriteContentLines,
  getWriteContentSizeBytes,
  shouldRenderWriteCallSummary,
} from "./write-display-utils.js";

interface BuiltInTools {
  read: ReturnType<typeof createReadTool>;
  grep: ReturnType<typeof createGrepTool>;
  find: ReturnType<typeof createFindTool>;
  ls: ReturnType<typeof createLsTool>;
  bash: ReturnType<typeof createBashTool>;
  edit: ReturnType<typeof createEditTool>;
  write: ReturnType<typeof createWriteTool>;
}

type ConfigGetter = () => SteroidsConfig;

interface RuntimeToolDefinition {
  name?: string;
  label?: string;
  description?: string;
  parameters?: unknown;
  prepareArguments?: unknown;
  renderCall?: (args: Record<string, unknown>, theme: RenderTheme, context?: ToolRenderContextLike) => unknown;
  renderResult?: (result: Record<string, unknown>, options: ToolRenderResultOptions, theme: RenderTheme, context?: ToolRenderContextLike) => unknown;
  execute?: (toolCallId: string, params: Record<string, unknown>, signal: AbortSignal | undefined, onUpdate: unknown, ctx: { cwd: string }) => Promise<unknown>;
  renderShell?: unknown;
  [key: string]: unknown;
}

interface RenderTheme {
  fg(color: string, text: string): string;
  bg?(color: string, text: string): string;
  bold(text: string): string;
  getBgAnsi?(color: string): string;
}

interface ToolRenderContextLike {
  args?: unknown;
  toolCallId?: string;
  state?: unknown;
  cwd?: string;
  argsComplete?: boolean;
  isError?: boolean;
  isPartial?: boolean;
  expanded?: boolean;
}

export interface WriteExecutionMeta {
  previousContent?: string;
  fileExistedBeforeWrite: boolean;
}

interface PendingDiffPreviewState {
  key?: string;
  data?: PendingDiffPreviewData;
}

interface PiSettingsShellConfig {
  shellPath?: unknown;
  shellCommandPrefix?: unknown;
}

interface BashToolOverrideOptions {
  shellPath?: string;
  commandPrefix?: string;
}

const builtInToolCache = new Map<string, BuiltInTools>();
export const WRITE_EXECUTION_META_LIMIT = 100;
const WRITE_EXECUTION_META_STATE_KEY = "__piSteroidsWriteExecutionMeta";
const EDIT_PENDING_PREVIEW_STATE_KEY = "__piSteroidsEditPendingPreview";
const WRITE_PENDING_PREVIEW_STATE_KEY = "__piSteroidsWritePendingPreview";

function registerRuntimeTool(pi: ExtensionAPI, tool: RuntimeToolDefinition): void {
  pi.registerTool(tool as unknown as ToolDefinition);
}

function getToolPrepareArguments(tool: unknown): unknown {
  const prepareArguments = toRecord(tool).prepareArguments;
  return typeof prepareArguments === "function" ? prepareArguments : undefined;
}

function cloneToolParameters(parameters: unknown, seen = new WeakMap<object, unknown>()): unknown {
  if (parameters === null || typeof parameters !== "object") {
    return parameters;
  }

  if (seen.has(parameters)) {
    return seen.get(parameters);
  }

  const clone: object = Array.isArray(parameters)
    ? []
    : Object.create(Object.getPrototypeOf(parameters) as object | null) as object;
  seen.set(parameters, clone);

  for (const key of Reflect.ownKeys(parameters)) {
    const descriptor = Object.getOwnPropertyDescriptor(parameters, key);
    if (!descriptor) {
      continue;
    }

    if ("value" in descriptor) {
      descriptor.value = cloneToolParameters(descriptor.value as unknown, seen);
    }

    Object.defineProperty(clone, key, descriptor);
  }

  return clone;
}

/** Resolves the runtime per call so a cached bash tool never holds a stale or missing runtime. */
function bgAwareBashOperations(): BashOperations | undefined {
  if (!getBgRuntime()) {
    return undefined;
  }
  return {
    exec: (command, cwd, options) => {
      const runtime = getBgRuntime();
      const operations = runtime?.foreground.operations ?? createLocalBashOperations({ shellPath: loadBashToolOverrideOptions().shellPath });
      return operations.exec(command, cwd, options);
    },
  };
}

function withBackgroundParameter(parameters: unknown): unknown {
  const schema = parameters as { properties?: Record<string, unknown> };
  return {
    ...schema,
    properties: {
      ...schema.properties,
      run_in_background: Type.Optional(Type.Boolean({ description: "Run the command in the background and return immediately with a job id" })),
    },
  };
}

function clearBuiltInToolCache(): void {
  builtInToolCache.clear();
}

function getStringSetting(value: unknown): string | undefined {
  return isNonBlankString(value) ? value : undefined;
}

let shellOptionsCache: { path: string; mtimeMs: number; options: BashToolOverrideOptions } | undefined;

/** Shell settings from Pi's settings.json, re-parsed only when the file changes (this runs on every bash call). */
export function loadBashToolOverrideOptions(): BashToolOverrideOptions {
  const settingsPath = join(resolvePiAgentDir(), "settings.json");
  let mtimeMs: number;
  try {
    mtimeMs = statSync(settingsPath).mtimeMs;
  } catch {
    return {};
  }
  if (shellOptionsCache?.path === settingsPath && shellOptionsCache.mtimeMs === mtimeMs) {
    return shellOptionsCache.options;
  }

  let options: BashToolOverrideOptions = {};
  try {
    const rawSettings = JSON.parse(readFileSync(settingsPath, "utf-8")) as PiSettingsShellConfig;
    options = {
      shellPath: getStringSetting(rawSettings.shellPath),
      commandPrefix: getStringSetting(rawSettings.shellCommandPrefix),
    };
  } catch {
    // unreadable or invalid settings: no overrides
  }
  shellOptionsCache = { path: settingsPath, mtimeMs, options };
  return options;
}

function getBuiltInTools(cwd: string): BuiltInTools {
  let tools = builtInToolCache.get(cwd);
  if (!tools) {
    tools = createLazyBuiltInTools(cwd);
    builtInToolCache.set(cwd, tools);
  }
  return tools;
}

function createLazyBuiltInTools(cwd: string): BuiltInTools {
  const cache = new Map<string, unknown>();
  const get = <K extends keyof BuiltInTools>(name: K, factory: () => BuiltInTools[K]): BuiltInTools[K] => {
    if (!cache.has(name)) {
      cache.set(name, factory());
    }
    return cache.get(name) as BuiltInTools[K];
  };
  return {
    get read() { return get("read", () => createReadTool(cwd)); },
    get grep() { return get("grep", () => createGrepTool(cwd)); },
    get find() { return get("find", () => createFindTool(cwd)); },
    get ls() { return get("ls", () => createLsTool(cwd)); },
    get bash() { return get("bash", () => createBashTool(cwd, { ...loadBashToolOverrideOptions(), operations: bgAwareBashOperations() })); },
    get edit() { return get("edit", () => createEditTool(cwd)); },
    get write() { return get("write", () => createWriteTool(cwd)); },
  } as BuiltInTools;
}

function createLazyToolRecord<T>(
  bootstrapTools: BuiltInTools,
  factory: (tool: BuiltInTools[keyof BuiltInTools]) => T,
): Record<keyof BuiltInTools, T> {
  const cache = new Map<string, unknown>();
  const get = (name: keyof BuiltInTools): T => {
    if (!cache.has(name)) {
      cache.set(name, factory(bootstrapTools[name]));
    }
    return cache.get(name) as T;
  };
  return {
    get read() { return get("read"); },
    get grep() { return get("grep"); },
    get find() { return get("find"); },
    get ls() { return get("ls"); },
    get bash() { return get("bash"); },
    get edit() { return get("edit"); },
    get write() { return get("write"); },
  } as Record<keyof BuiltInTools, T>;
}

function captureExistingWriteContent(
  cwd: string,
  rawPath: unknown,
): { existed: boolean; content?: string } {
  if (!isNonBlankString(rawPath)) {
    return { existed: false };
  }

  const existing = readWorkspaceUtf8File(cwd, rawPath);
  return {
    existed: existing.exists,
    content: existing.content,
  };
}

function formatExpandHint(theme: RenderTheme): string {
  return theme.fg("muted", " • Ctrl+O to expand");
}

function formatTruncationHint(remaining: number, expanded: boolean, theme: RenderTheme): string {
  if (remaining <= 0) {
    return "";
  }
  const hint = expanded ? "" : " • Ctrl+O to expand";
  return `\n${theme.fg("muted", `... (${remaining} more ${pluralize(remaining, "line")}${hint})`)}`;
}

function buildPreviewText(
  lines: string[],
  maxLines: number,
  theme: RenderTheme,
  expanded: boolean,
): string {
  if (lines.length === 0) {
    return theme.fg("muted", "↳ (no output)");
  }

  const { shown, remaining } = previewLines(lines, maxLines);
  let text = shown
    .map((line) => theme.fg("toolOutput", sanitizeAnsiForThemedOutput(line)))
    .join("\n");
  text += formatTruncationHint(remaining, expanded, theme);
  return text;
}

function prepareOutputLines(
  rawText: string,
  options: ToolRenderResultOptions,
): string[] {
  return compactOutputLines(splitLines(rawText), {
    expanded: options.expanded,
    maxCollapsedConsecutiveEmptyLines: 1,
  });
}

function formatBashNoOutputLine(
  command: string | undefined,
  theme: RenderTheme,
): string {
  if (isLikelyQuietCommand(command)) {
    return theme.fg("muted", "↳ command completed (no output)");
  }
  return theme.fg("muted", "↳ (no output)");
}

function truncationHint(
  details: { truncation?: { truncated?: boolean } } | undefined,
): string {
  return details?.truncation?.truncated ? " • truncated" : "";
}

function countTextLines(value: unknown): number {
  if (typeof value !== "string") {
    return 0;
  }
  return splitLines(value).length;
}

function getStringField(value: unknown, field: string): string | undefined {
  const raw = toRecord(value)[field];
  return typeof raw === "string" ? raw : undefined;
}

function getNumericField(value: unknown, field: string): number | undefined {
  const raw = toRecord(value)[field];
  return typeof raw === "number" && Number.isFinite(raw) ? raw : undefined;
}

function getToolPathArg(value: unknown): string | undefined {
  return getStringField(value, "file_path") ?? getStringField(value, "path");
}

function getEditPayloadLineCount(value: unknown): number {
  const record = toRecord(value);
  const lines = record.lines;
  if (Array.isArray(lines)) {
    return lines.filter((line): line is string => typeof line === "string").length;
  }
  if (typeof lines === "string") {
    return countTextLines(lines);
  }

  return countTextLines(record.newText);
}

function getEditLineCount(value: unknown): number {
  const record = toRecord(value);
  const edits = Array.isArray(record.edits) ? record.edits as unknown[] : [];
  if (edits.length > 0) {
    return edits.reduce<number>((total, edit) => total + getEditPayloadLineCount(edit), 0);
  }

  return getEditPayloadLineCount(record);
}

function isToolError(
  result: unknown,
  context?: ToolRenderContextLike,
): boolean {
  return context?.isError === true || toRecord(result).isError === true;
}

function toStateRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

export function recordWriteExecutionMeta(
  pendingMetaByToolCallId: Map<string, WriteExecutionMeta>,
  toolCallId: string,
  meta: WriteExecutionMeta,
): void {
  pendingMetaByToolCallId.delete(toolCallId);
  pendingMetaByToolCallId.set(toolCallId, meta);

  while (pendingMetaByToolCallId.size > WRITE_EXECUTION_META_LIMIT) {
    const oldestToolCallId: string | undefined = pendingMetaByToolCallId.keys().next().value as string | undefined;
    if (oldestToolCallId === undefined) {
      return;
    }
    pendingMetaByToolCallId.delete(oldestToolCallId);
  }
}

export function clearWriteExecutionMeta(
  pendingMetaByToolCallId: Map<string, WriteExecutionMeta>,
): void {
  pendingMetaByToolCallId.clear();
}

export function getWriteExecutionMeta(
  context: ToolRenderContextLike | undefined,
  pendingMetaByToolCallId: Map<string, WriteExecutionMeta>,
): WriteExecutionMeta | undefined {
  if (!context) {
    return undefined;
  }

  const carrier = toStateRecord(context.state);
  const existing = carrier
    ? toRecord(carrier[WRITE_EXECUTION_META_STATE_KEY])
    : undefined;
  if (existing && Object.keys(existing).length > 0) {
    return existing as unknown as WriteExecutionMeta;
  }

  if (!context.toolCallId) {
    return undefined;
  }

  const pending = pendingMetaByToolCallId.get(context.toolCallId);
  if (!pending) {
    return undefined;
  }

  if (carrier) {
    const storedMeta: WriteExecutionMeta = { ...pending };
    carrier[WRITE_EXECUTION_META_STATE_KEY] = storedMeta;
    pendingMetaByToolCallId.delete(context.toolCallId);
    return storedMeta;
  }

  return pending;
}

function getPendingDiffPreviewState(
  context: ToolRenderContextLike | undefined,
  stateKey: string,
): PendingDiffPreviewState | undefined {
  const carrier = toStateRecord(context?.state);
  if (!carrier) {
    return undefined;
  }

  const current = carrier[stateKey];
  if (isRecord(current)) {
    return current as PendingDiffPreviewState;
  }

  const next: PendingDiffPreviewState = {};
  carrier[stateKey] = next;
  return next;
}

function resolvePendingDiffPreview(
  context: ToolRenderContextLike | undefined,
  stateKey: string,
  previewKey: string | undefined,
  compute: () => PendingDiffPreviewData | undefined,
): PendingDiffPreviewData | undefined {
  const previewState = getPendingDiffPreviewState(context, stateKey);
  if (!previewState) {
    return compute();
  }

  if (previewState.key !== previewKey) {
    previewState.key = previewKey;
    previewState.data = previewKey ? compute() : undefined;
  }

  return previewState.data;
}

function buildPendingDiffCallComponent(
  summaryText: string,
  previewData: PendingDiffPreviewData | undefined,
  context: ToolRenderContextLike | undefined,
  config: SteroidsConfig,
  theme: RenderTheme,
): Text | Container {
  if (!context?.isPartial || !previewData) {
    return textResult(summaryText);
  }

  const container = new Container();
  container.addChild(textResult(summaryText));
  container.addChild(new Spacer(1));

  if (previewData.notice || typeof previewData.nextContent !== "string") {
    container.addChild(textResult(theme.fg("warning", previewData.notice || "Preview unavailable.")));
    return container;
  }

  container.addChild(
    renderWriteDiffResult(
      previewData.nextContent,
      {
        expanded: context.expanded === true,
        filePath: previewData.filePath,
        previousContent: previewData.previousContent,
        fileExistedBeforeWrite: previewData.fileExistedBeforeWrite,
        headerLabel: previewData.headerLabel,
      },
      config,
      theme,
      "",
    ),
  );
  return container;
}

function formatLineCountSuffix(
  lineCount: number,
  theme: RenderTheme,
): string {
  return theme.fg("muted", ` (${lineCount} ${pluralize(lineCount, "line")})`);
}

function formatWriteCallSuffix(
  lineCount: number,
  sizeBytes: number,
  theme: RenderTheme,
): string {
  return theme.fg(
    "muted",
    ` (${lineCount} ${pluralize(lineCount, "line")} • ${formatSize(sizeBytes)})`,
  );
}

function formatInProgressLineCount(
  action: string,
  lineCount: number,
  theme: RenderTheme,
): string {
  return theme.fg("warning", `${action}...`) + formatLineCountSuffix(lineCount, theme);
}

interface PreviewHintContext {
  lines: string[];
  config: SteroidsConfig;
  theme: RenderTheme;
  options: ToolRenderResultOptions;
  details: unknown;
}

function getExpandedPreviewLineLimit(
  lines: string[],
  config: SteroidsConfig,
): number {
  const limit = Math.max(0, config.expandedPreviewMaxLines);
  if (limit === 0) {
    return lines.length;
  }
  return Math.min(lines.length, limit);
}

function formatExpandedPreviewCapHint(
  lines: string[],
  config: SteroidsConfig,
  theme: RenderTheme,
): string {
  const cap = Math.max(0, config.expandedPreviewMaxLines);
  if (cap === 0 || lines.length <= cap) {
    return "";
  }

  return `\n${theme.fg("warning", `(display capped at ${cap} lines by the expandedPreviewMaxLines setting)`)}`;
}

function appendPreviewHints(preview: string, ctx: PreviewHintContext): string {
  const { config, theme, details } = ctx;
  if (config.showTruncationHints && toRecord(toRecord(details).truncation).truncated) {
    preview += `\n${theme.fg("warning", "(truncated by backend limits)")}`;
  }
  if (ctx.options.expanded) {
    preview += formatExpandedPreviewCapHint(ctx.lines, config, theme);
  }
  return preview;
}

function renderSearchPreview(ctx: PreviewHintContext, expandedOnly = false): Text {
  const useExpanded = expandedOnly || ctx.options.expanded;
  const maxLines = useExpanded
    ? getExpandedPreviewLineLimit(ctx.lines, ctx.config)
    : ctx.config.previewLines;
  const preview = buildPreviewText(ctx.lines, maxLines, ctx.theme, useExpanded);
  return textResult(appendPreviewHints(preview, ctx));
}

function formatReadSummary(
  lines: string[],
  details: ReadToolDetails | undefined,
  theme: RenderTheme,
  showTruncationHints: boolean,
): string {
  const lineCount = lines.length;
  let summary = theme.fg(
    "muted",
    `↳ loaded ${lineCount} ${pluralize(lineCount, "line")}`,
  );
  summary += theme.fg(
    "warning",
    showTruncationHints ? truncationHint(details) : "",
  );
  return summary;
}

function formatSearchSummary(
  lines: string[],
  unitLabel: string,
  details: { truncation?: { truncated?: boolean } } | undefined,
  theme: RenderTheme,
  showTruncationHints: boolean,
  pluralLabel?: string,
): string {
  const count = countNonEmptyLines(lines);
  let summary = theme.fg(
    "muted",
    `↳ ${count} ${pluralize(count, unitLabel, pluralLabel)} returned`,
  );
  summary += theme.fg(
    "warning",
    showTruncationHints ? truncationHint(details) : "",
  );
  return summary;
}

function formatBashSummary(
  lines: string[],
  theme: RenderTheme,
): string {
  const lineCount = lines.length;
  return theme.fg(
    "muted",
    `↳ ${lineCount} ${pluralize(lineCount, "line")} returned`,
  );
}

function formatBashTruncationHints(
  details: BashToolDetails | undefined,
  config: SteroidsConfig,
  theme: RenderTheme,
): string {
  if (!config.showTruncationHints || !details) {
    return "";
  }

  const hints: string[] = [];
  if (details.truncation?.truncated) {
    hints.push("output truncated");
  }
  if (details.fullOutputPath) {
    hints.push(`full output: ${details.fullOutputPath}`);
  }
  if (hints.length === 0) {
    return "";
  }
  return `\n${theme.fg("warning", `(${hints.join(" • ")})`)}`;
}

function getBashPreviewLineLimit(
  lines: string[],
  options: ToolRenderResultOptions,
  config: SteroidsConfig,
): number {
  if (options.expanded) {
    return getExpandedPreviewLineLimit(lines, config);
  }

  return config.bashOutputMode === "opencode"
    ? config.bashCollapsedLines
    : config.previewLines;
}

type ToolRenderInput = {
  content?: Array<{ type: string; text?: string }>;
  details?: unknown;
};

function textResult(text: string): Text {
  return new Text(text, 0, 0);
}

function partialResultText(theme: RenderTheme, label: string): Text {
  return textResult(theme.fg("warning", label));
}

function renderBashPreviewWithHints(
  lines: string[],
  maxLines: number,
  config: SteroidsConfig,
  theme: RenderTheme,
  options: ToolRenderResultOptions,
  details: BashToolDetails | undefined,
): Text {
  let preview = buildPreviewText(lines, maxLines, theme, options.expanded);
  preview += formatBashTruncationHints(details, config, theme);
  if (options.expanded) {
    preview += formatExpandedPreviewCapHint(lines, config, theme);
  }
  return textResult(preview);
}

function renderBashLivePreview(
  rawOutput: string,
  options: ToolRenderResultOptions,
  config: SteroidsConfig,
  theme: RenderTheme,
  details: BashToolDetails | undefined,
): Text {
  const lines = prepareOutputLines(rawOutput, options);
  if (lines.length === 0) {
    return textResult("");
  }
  const maxLines = getBashPreviewLineLimit(lines, options, config);
  if (!options.expanded && maxLines === 0) {
    return textResult("");
  }
  return renderBashPreviewWithHints(lines, maxLines, config, theme, options, details);
}

function renderBashErrorResult(
  rawOutput: string,
  options: ToolRenderResultOptions,
  config: SteroidsConfig,
  theme: RenderTheme,
  details: BashToolDetails | undefined,
): Text {
  const lines = prepareOutputLines(rawOutput, options);
  let text = theme.fg("error", "↳ command failed");

  if (lines.length > 0) {
    const maxLines = getBashPreviewLineLimit(lines, options, config);
    if (options.expanded || maxLines > 0) {
      const { shown, remaining } = previewLines(lines, maxLines);
      text += `\n${shown
        .map((line) => theme.fg("error", sanitizeAnsiForThemedOutput(line)))
        .join("\n")}`;
      text += formatTruncationHint(remaining, options.expanded, theme);
    }
  }

  text += formatBashTruncationHints(details, config, theme);
  if (options.expanded && lines.length > 0) {
    text += formatExpandedPreviewCapHint(lines, config, theme);
  }

  return textResult(text);
}

function renderSearchResult(
  result: ToolRenderInput,
  options: ToolRenderResultOptions,
  config: SteroidsConfig,
  theme: RenderTheme,
  unitLabel: string,
  details: GrepToolDetails | FindToolDetails | LsToolDetails | undefined,
  pluralLabel?: string,
): Text {
  if (options.isPartial) {
    return partialResultText(theme, "running...");
  }

  const lines = prepareOutputLines(extractTextOutput(result), options);

  if (config.searchOutputMode === "hidden") {
    return textResult("");
  }

  const hintCtx: PreviewHintContext = { lines, config, theme, options, details };

  if (config.searchOutputMode === "count") {
    if (options.expanded) {
      return renderSearchPreview(hintCtx, true);
    }

    let summary = formatSearchSummary(
      lines,
      unitLabel,
      details,
      theme,
      config.showTruncationHints,
      pluralLabel,
    );
    summary += formatExpandHint(theme);
    return textResult(summary);
  }

  return renderSearchPreview(hintCtx);
}

function getSearchScope(args: Record<string, unknown>): string {
  return shortenPath((args.path as string) || ".");
}

function formatSearchCallLine(
  toolName: string,
  accent: string,
  mutedSuffix: string,
  theme: RenderTheme,
): Text {
  return textResult(
    `${theme.fg("toolTitle", theme.bold(toolName))} ${theme.fg("accent", accent)}${theme.fg("muted", mutedSuffix)}`,
  );
}

function getPathArg(args: unknown): string | undefined {
  return getStringField(args, "file_path") || getStringField(args, "path");
}

function renderReadDisplayCall(
  args: unknown,
  theme: RenderTheme,
): Text {
  const path = shortenPath(getPathArg(args));
  const offset = getNumericField(args, "offset");
  const limit = getNumericField(args, "limit");
  let suffix = "";
  if (offset !== undefined || limit !== undefined) {
    const from = offset ?? 1;
    const to = limit !== undefined ? from + limit - 1 : undefined;
    suffix = to ? `:${from}-${to}` : `:${from}`;
  }
  const line = `${theme.fg("toolTitle", theme.bold("read"))} ${theme.fg("accent", path || "...")}${theme.fg("warning", suffix)}`;
  return textResult(line);
}

function renderReadDisplayResult(
  result: ToolRenderInput,
  options: ToolRenderResultOptions,
  config: SteroidsConfig,
  theme: RenderTheme,
 ): Text {
  if (options.isPartial) {
    return partialResultText(theme, "reading...");
  }

  if (config.readOutputMode === "hidden") {
    return textResult("");
  }

  const details = result.details as ReadToolDetails | undefined;
  const rawOutput = extractTextOutput(result);
  const lines = prepareOutputLines(rawOutput, options);
  const hintCtx: PreviewHintContext = { lines, config, theme, options, details };

  if (config.readOutputMode === "summary") {
    if (options.expanded) {
      return renderSearchPreview(hintCtx, true);
    }

    const summaryLines = compactOutputLines(splitLines(rawOutput), {
      expanded: true,
    });
    let summary = formatReadSummary(
      summaryLines,
      details,
      theme,
      config.showTruncationHints,
    );
    summary += formatExpandHint(theme);
    return textResult(summary);
  }

  return renderSearchPreview(hintCtx);
}

function renderEditDisplayCall(
  args: unknown,
  theme: RenderTheme,
  context: ToolRenderContextLike | undefined,
  getConfig: ConfigGetter,
): Text | Container {
  const path = shortenPath(getPathArg(args));
  const lineCount = getEditLineCount(args);
  const summaryText = `${theme.fg("toolTitle", theme.bold("edit"))} ${theme.fg("accent", path || "...")}${formatLineCountSuffix(lineCount, theme)}`;
  if (!context?.argsComplete || !context.isPartial) {
    return textResult(summaryText);
  }

  const previewKey = JSON.stringify({
    path: getPathArg(args) ?? null,
    edits: toRecord(args).edits ?? null,
    oldText: getStringField(args, "oldText") ?? null,
    newText: getStringField(args, "newText") ?? null,
  });
  const previewData = resolvePendingDiffPreview(
    context,
    EDIT_PENDING_PREVIEW_STATE_KEY,
    previewKey,
    () => buildPendingEditPreviewData(args, context.cwd),
  );
  return buildPendingDiffCallComponent(summaryText, previewData, context, getConfig(), theme);
}

function renderEditDisplayResult(
  result: ToolRenderInput & { isError?: boolean },
  options: ToolRenderResultOptions,
  theme: RenderTheme,
  context: ToolRenderContextLike | undefined,
  getConfig: ConfigGetter,
): unknown {
  const lineCount = getEditLineCount(context?.args);
  const { fallbackText, earlyResult } = handleEditOrWriteResult(result, options, context, theme, lineCount, "editing", "Edit failed.");
  if (earlyResult) {
    return earlyResult;
  }

  return renderEditDiffResult(
    result.details as EditToolDetails | undefined,
    { expanded: options.expanded, filePath: getPathArg(context?.args) },
    getConfig(),
    theme,
    fallbackText,
  );
}

function handleEditOrWriteResult(
  result: ToolRenderInput,
  options: ToolRenderResultOptions,
  context: ToolRenderContextLike | undefined,
  theme: RenderTheme,
  lineCount: number,
  progressLabel: string,
  errorMessage: string,
): { fallbackText: string; earlyResult: Text | undefined } {
  if (options.isPartial) {
    return { fallbackText: "", earlyResult: textResult(formatInProgressLineCount(progressLabel, lineCount, theme)) };
  }
  const fallbackText = extractTextOutput(result);
  if (isToolError(result, context)) {
    return { fallbackText, earlyResult: textResult(theme.fg("error", fallbackText || errorMessage)) };
  }
  return { fallbackText, earlyResult: undefined };
}

export function registerToolRendering(
  pi: ExtensionAPI,
  getConfig: ConfigGetter,
): void {
  clearBuiltInToolCache();
  const bootstrapTools = getBuiltInTools(process.cwd());
  const builtInPromptMetadata = createLazyToolRecord(bootstrapTools, extractPromptMetadata);
  const clonedParameters = createLazyToolRecord(bootstrapTools, (tool) => cloneToolParameters(tool.parameters));
  const writeExecutionMetaByToolCallId = new Map<string, WriteExecutionMeta>();
  function createBuiltinToolBase(toolName: keyof BuiltInTools) {
    return {
      description: bootstrapTools[toolName].description,
      ...builtInPromptMetadata[toolName],
      parameters: clonedParameters[toolName],
      prepareArguments: getToolPrepareArguments(bootstrapTools[toolName]),
      async execute(toolCallId: string, params: Record<string, unknown>, signal: unknown, onUpdate: unknown, ctx: { cwd: string }) {
        return getBuiltInTools(ctx.cwd)[toolName].execute(
          toolCallId,
          params as never,
          signal as never,
          onUpdate as never,
        );
      },
    };
  }

  const renderSearchToolResult = (
    result: ToolRenderInput,
    options: ToolRenderResultOptions,
    theme: RenderTheme,
    unitLabel: string,
    pluralLabel?: string,
  ): Text => {
    const config = getConfig();
    return renderSearchResult(result as never, options, config, theme, unitLabel, result.details, pluralLabel);
  };

  const buildSearchCallSuffix = (args: Record<string, unknown>): { scope: string; limitSuffix: string } => {
    return { scope: getSearchScope(args), limitSuffix: args.limit !== undefined ? ` (limit ${args.limit})` : "" };
  };

  registerRuntimeTool(pi, {
    name: "read",
    label: "read",
    ...createBuiltinToolBase("read"),
    renderCall(args, theme) {
      return renderReadDisplayCall(args, theme);
    },
    renderResult(result, options, theme) {
      return renderReadDisplayResult(result, options, getConfig(), theme);
    },
  });

  registerRuntimeTool(pi, {
    name: "grep",
    label: "grep",
    ...createBuiltinToolBase("grep"),
    renderCall(args, theme) {
      const scope = getSearchScope(args);
      const globSuffix = args.glob ? ` (${args.glob})` : "";
      const limitSuffix =
        args.limit !== undefined ? ` limit ${args.limit}` : "";
      return formatSearchCallLine("grep", `/${args.pattern}/`, ` in ${scope}${globSuffix}${limitSuffix}`, theme);
    },
    renderResult(result, options, theme) {
      return renderSearchToolResult(result, options, theme, "match", "matches");
    },
  });

  registerRuntimeTool(pi, {
    name: "find",
    label: "find",
    ...createBuiltinToolBase("find"),
    renderCall(args, theme) {
      const { scope, limitSuffix } = buildSearchCallSuffix(args);
      return formatSearchCallLine("find", args.pattern as string, ` in ${scope}${limitSuffix}`, theme);
    },
    renderResult(result, options, theme) {
      return renderSearchToolResult(result, options, theme, "result");
    },
  });

  registerRuntimeTool(pi, {
    name: "ls",
    label: "ls",
    ...createBuiltinToolBase("ls"),
    renderCall(args, theme) {
      const { scope, limitSuffix } = buildSearchCallSuffix(args);
      return formatSearchCallLine("ls", scope, limitSuffix, theme);
    },
    renderResult(result, options, theme) {
      return renderSearchToolResult(result, options, theme, "entry", "entries");
    },
  });

  registerRuntimeTool(pi, {
    name: "edit",
    label: "edit",
    ...createBuiltinToolBase("edit"),
    renderShell: "default",
    renderCall(args, theme, context) {
      return renderEditDisplayCall(args, theme, context, getConfig);
    },
    renderResult(result, options, theme, context) {
      return renderEditDisplayResult(result as never, options, theme, context, getConfig);
    },
  });

  const writeBase = createBuiltinToolBase("write");
  registerRuntimeTool(pi, {
    name: "write",
    label: "write",
    ...writeBase,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const previous = captureExistingWriteContent(ctx.cwd, params.path);
      recordWriteExecutionMeta(writeExecutionMetaByToolCallId, toolCallId, {
        fileExistedBeforeWrite: previous.existed,
        previousContent: previous.content,
      });

      return writeBase.execute(toolCallId, params, signal, onUpdate, ctx);
    },
    renderCall(args, theme, context) {
      const content = getStringField(args, "content");
      const lineCount = countWriteContentLines(content);
      const sizeBytes = getWriteContentSizeBytes(content);
      const path = shortenPath(getToolPathArg(args));
      const suffix = shouldRenderWriteCallSummary({
        hasContent: content !== undefined,
        hasDetailedResultHeader: false,
      })
        ? formatWriteCallSuffix(lineCount, sizeBytes, theme)
        : "";
      const summaryText = `${theme.fg("toolTitle", theme.bold("write"))} ${theme.fg("accent", path || "...")}${suffix}`;
      if (!context.argsComplete || !context.isPartial) {
        return textResult(summaryText);
      }

      const previewKey = JSON.stringify({ path: getToolPathArg(args) ?? null, content: content ?? null });
      const previewData = resolvePendingDiffPreview(
        context,
        WRITE_PENDING_PREVIEW_STATE_KEY,
        previewKey,
        () => buildPendingWritePreviewData(args, context.cwd),
      );
      return buildPendingDiffCallComponent(summaryText, previewData, context, getConfig(), theme);
    },
    renderResult(result, options, theme, context) {
      const content = getStringField(context?.args, "content");
      const lineCount = countWriteContentLines(content);
      const { fallbackText, earlyResult } = handleEditOrWriteResult(result, options, context, theme, lineCount, "writing", "Write failed.");
      if (earlyResult) {
        return earlyResult;
      }

      const executionMeta = getWriteExecutionMeta(
        context,
        writeExecutionMetaByToolCallId,
      );
      return renderWriteDiffResult(
        content,
        {
          expanded: options.expanded,
          filePath: getToolPathArg(context?.args),
          previousContent: executionMeta?.previousContent,
          fileExistedBeforeWrite: executionMeta?.fileExistedBeforeWrite ?? false,
        },
        getConfig(),
        theme,
        fallbackText,
      );
    },
  });

  const bashBase = createBuiltinToolBase("bash");
  registerRuntimeTool(pi, {
    name: "bash",
    label: "bash",
    ...bashBase,
    ...(getBgRuntime()
      ? {
          parameters: withBackgroundParameter(bashBase.parameters),
          description: `${bashBase.description} Commands running longer than the auto-background delay move to the background automatically; set run_in_background to start one there immediately, then use the jobs tool.`,
          async execute(toolCallId: string, params: Record<string, unknown>, signal: unknown, onUpdate: unknown, ctx: { cwd: string }) {
            const runtime = getBgRuntime();
            if (params.run_in_background === true && runtime) {
              if (typeof params.command !== "string" || params.command.trim() === "") {
                throw new Error("bash requires a non-empty command");
              }
              const timeout = typeof params.timeout === "number" && params.timeout > 0 ? params.timeout : undefined;
              return runBashBg(runtime.registry, { command: params.command, timeout }, ctx.cwd, loadBashToolOverrideOptions()) as never;
            }
            return bashBase.execute(toolCallId, params, signal, onUpdate, ctx);
          },
        }
      : {}),
    renderCall(args, theme, context) {
      return renderBashCall(args, theme, context as never);
    },
    renderResult(result, options, theme, context) {
      const config = getConfig();
      const details = result.details as BashToolDetails | undefined;
      const rawOutput = extractTextOutput(result);

      if (options.isPartial) {
        return renderBashLivePreview(rawOutput, options, config, theme, details);
      }

      if (isToolError(result, context)) {
        return renderBashErrorResult(rawOutput, options, config, theme, details);
      }

      const lines = prepareOutputLines(rawOutput, options);

      if (lines.length === 0) {
        return textResult(
          formatBashNoOutputLine(getStringField(context?.args, "command"), theme) +
          formatBashTruncationHints(details, config, theme),
        );
      }

      if (config.bashOutputMode === "summary") {
        if (options.expanded) {
          return renderBashPreviewWithHints(lines, getExpandedPreviewLineLimit(lines, config), config, theme, options, details);
        }

        return textResult(
          formatBashSummary(lines, theme) +
          formatExpandHint(theme) +
          formatBashTruncationHints(details, config, theme),
        );
      }

      if (config.bashOutputMode === "preview") {
        return renderBashPreviewWithHints(lines, getBashPreviewLineLimit(lines, options, config), config, theme, options, details);
      }

      if (!options.expanded && config.bashCollapsedLines === 0) {
        return textResult(theme.fg("muted", "↳ output hidden") + formatBashTruncationHints(details, config, theme));
      }

      const maxLines = options.expanded
        ? lines.length
        : config.bashCollapsedLines;
      return textResult(
        buildPreviewText(lines, maxLines, theme, options.expanded) +
        formatBashTruncationHints(details, config, theme),
      );
    },
  });

  pi.on("session_start", async () => {
    clearWriteExecutionMeta(writeExecutionMetaByToolCallId);
  });
  pi.on("before_agent_start", async () => {
    clearWriteExecutionMeta(writeExecutionMetaByToolCallId);
  });
}
