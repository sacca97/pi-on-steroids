import assert from "node:assert/strict";
import test from "node:test";
import {
  buildHistory,
  describeToolCall,
  excerpt,
  parseQuery,
  readHistory,
  searchHistory,
  formatSearch,
  stripPointer,
  withPointer,
} from "../src/features/compaction-history/history.ts";
import registerCompactionHistory from "../src/features/compaction-history/index.ts";
import { DEFAULT_STEROIDS_CONFIG } from "../src/types.ts";

let seq = 0;
const msg = (message: object, id = `e${++seq}`) => ({ type: "message", id, timestamp: "2026-10-29T10:00:00.000Z", message });
const user = (text: string, id?: string) => msg({ role: "user", content: text }, id);
const assistant = (content: object[], id?: string) => msg({ role: "assistant", content }, id);
const call = (id: string, name: string, args: object) => ({ type: "toolCall", id, name, arguments: args });
const result = (toolCallId: string, isError: boolean | undefined, text: string, id?: string) =>
  msg({ role: "toolResult", toolCallId, toolName: "x", content: [{ type: "text", text }], isError }, id);

function session() {
  return [
    { type: "message", id: "sys", message: { role: "system", content: "", sections: {} } },
    user("Fix the failing parser tests", "u1"),
    assistant([{ type: "thinking", thinking: "secret plan" }, { type: "text", text: "Investigating the parser." }, call("c1", "bash", { command: "go test ./..." })], "a1"),
    result("c1", true, "FAIL parser_test.go:42 unexpected token", "r1"),
    assistant([call("c2", "edit", { path: "parser.go", edits: [{}, {}] }), call("c3", "write", { path: "notes.md", content: "a\nb\nc" })], "a2"),
    result("c2", false, "Applied", "r2"),
    { type: "compaction", id: "k1", firstKeptEntryId: "a3", summary: "old" },
    assistant([{ type: "text", text: "Fixed the tokenizer bug." }, call("c4", "bash", { command: "go test ./..." })], "a3"),
    msg({ role: "bashExecution", command: "git status", output: "clean", exitCode: 0, cancelled: false, truncated: false }, "b1"),
    { type: "custom_message", id: "h1", customType: "goal-continue", content: "hidden nudge", display: false },
    { type: "custom_message", id: "n1", customType: "bg-task", content: "Background job b1 failed", display: true },
  ];
}

test("tool calls keep paths and commands but drop file bodies", () => {
  assert.equal(describeToolCall("bash", { command: "npm test" }), "bash: npm test");
  assert.equal(describeToolCall("read", { path: "a.ts", offset: 10 }), "read: a.ts (offset 10)");
  assert.equal(describeToolCall("write", { path: "a.ts", content: "x\ny" }), "write: a.ts (2 lines)");
  assert.equal(describeToolCall("edit", { path: "a.ts", edits: [{}] }), "edit: a.ts (1 change)");
  const custom = describeToolCall("mcp_tool", { body: "z".repeat(1000), n: 3 });
  assert.ok(custom.length <= 400);
  assert.match(custom, /^mcp_tool: body=z+…/);
});

test("history keeps conversation and tool outcomes, omits thinking, system and hidden messages", () => {
  const items = buildHistory(session());
  assert.deepEqual(
    items.map((item) => [item.entryId, item.kind, item.status ?? "", item.compacted]),
    [
      ["u1", "user", "", true],
      ["a1", "assistant", "", true],
      ["a1", "tool", "FAILURE", true],
      ["a2", "tool", "SUCCESS", true],
      ["a2", "tool", "UNKNOWN", true],
      ["a3", "assistant", "", false],
      ["a3", "tool", "UNKNOWN", false],
      ["b1", "shell", "SUCCESS", false],
      ["n1", "note", "", false],
    ],
  );
  const all = JSON.stringify(items.map((item) => item.text));
  assert.ok(!all.includes("secret plan"));
  assert.ok(!all.includes("hidden nudge"));
  assert.ok(!all.includes("unexpected token"), "raw output stays out of the searchable text");
  assert.equal(items[2].output, "FAIL parser_test.go:42 unexpected token");
});

test("a missing isError or exit code is UNKNOWN, not success", () => {
  const items = buildHistory([
    assistant([call("x", "bash", { command: "a" })], "a"),
    result("x", undefined, "?", "r"),
    msg({ role: "bashExecution", command: "b", output: "", exitCode: undefined, cancelled: false }, "s1"),
    msg({ role: "bashExecution", command: "c", output: "", exitCode: 0, cancelled: true }, "s2"),
    msg({ role: "bashExecution", command: "d", output: "", exitCode: 2, cancelled: false }, "s3"),
  ]);
  assert.deepEqual(items.map((item) => item.status), ["UNKNOWN", "UNKNOWN", "UNKNOWN", "FAILURE"]);
});

test("without a compaction nothing is marked compacted", () => {
  assert.ok(buildHistory([user("hi", "u")]).every((item) => !item.compacted));
});

test("search matches all terms, newest first, and only searches output on request", () => {
  const items = buildHistory(session());
  assert.deepEqual(searchHistory(items, "go test").map((hit) => hit.item.entryId), ["a3", "a1"]);
  assert.deepEqual(searchHistory(items, "go test", { limit: 1 }).map((hit) => hit.item.entryId), ["a3"]);
  assert.equal(searchHistory(items, "unexpected token").length, 0);
  const hits = searchHistory(items, "unexpected token", { includeOutputs: true });
  assert.deepEqual(hits.map((hit) => [hit.item.entryId, hit.field]), [["a1", "output"]]);
  assert.deepEqual(parseQuery(`"parser tests" Fix`), ["parser tests", "fix"]);
  assert.deepEqual(searchHistory(items, `"parser tests"`).map((hit) => hit.item.entryId), ["u1"]);
  assert.equal(searchHistory(items, "   ").length, 0);
});

test("search results show ids, status and context markers within a size cap", () => {
  const items = buildHistory(session());
  const text = formatSearch(searchHistory(items, "go test"), "go test");
  assert.match(text, /#a3 \[tool\] 2026-10-29 10:00 \(in context\) → UNKNOWN/);
  assert.match(text, /#a1 \[tool\] 2026-10-29 10:00 → FAILURE/);
  assert.match(formatSearch([], "nothing"), /No history entries match/);
  const many = buildHistory(Array.from({ length: 50 }, (_, i) => user(`needle ${"x".repeat(400)} ${i}`, `n${i}`)));
  const capped = formatSearch(searchHistory(many, "needle", { limit: 30 }), "needle", 2000);
  assert.ok(capped.length < 2600);
  assert.match(capped, /more matches omitted/);
});

test("excerpt centres on the first match in long text", () => {
  const text = `${"a ".repeat(300)}needle ${"b ".repeat(300)}`;
  const out = excerpt(text, ["needle"], 60);
  assert.ok(out.startsWith("…") && out.endsWith("…"));
  assert.ok(out.includes("needle"));
});

test("read returns a window around an entry, with output only on request", () => {
  const items = buildHistory(session());
  const plain = readHistory(items, "#a2", { before: 1, after: 1 });
  assert.match(plain, /#a1 \[tool\]/);
  assert.match(plain, /edit: parser.go \(2 changes\)/);
  assert.match(plain, /later entries continue from #a3/);
  assert.ok(!plain.includes("Applied"));
  assert.match(readHistory(items, "a2", { before: 0, after: 0, includeOutputs: true }), /--- output ---\nApplied/);
  assert.match(readHistory(items, "missing"), /No history entry with id missing/);
});

test("read stops at the size limit and says where to continue", () => {
  const items = buildHistory(Array.from({ length: 10 }, (_, i) => user("y".repeat(500), `m${i}`)));
  const text = readHistory(items, "m0", { after: 9, maxChars: 1200 });
  assert.match(text, /stopped at the size limit; continue with history_read #m2/);
});

test("the pointer is appended once and stripped before the next summary update", () => {
  const once = withPointer("## Goal\nship", "abc");
  assert.match(once, /entries before #abc/);
  const twice = withPointer(once, "def");
  assert.equal(twice.match(/compaction-history/g)?.length, 1);
  assert.match(twice, /#def/);
  assert.equal(stripPointer(once), "## Goal\nship");
  assert.equal(stripPointer(undefined), undefined);
});

function harness() {
  const handlers = new Map<string, (event: any, ctx: any) => unknown>();
  const tools = new Map<string, any>();
  const pi = {
    on: (name: string, handler: any) => handlers.set(name, handler),
    registerTool: (tool: any) => tools.set(tool.name, tool),
    getThinkingLevel: () => "off",
  };
  registerCompactionHistory(pi as never, () => ({ ...DEFAULT_STEROIDS_CONFIG, compactionHistory: true }));
  return { handlers, tools };
}

test("compaction history is off by default", () => {
  const registered: string[] = [];
  registerCompactionHistory({ registerTool: (t: any) => registered.push(t.name), on: () => {} } as never, () => DEFAULT_STEROIDS_CONFIG);
  assert.deepEqual(registered, []);
});

test("tools read the current branch and clamp their limits", async () => {
  const { tools } = harness();
  const ctx = { sessionManager: { getBranch: () => session() } };
  const search = await tools.get("history_search").execute("id", { query: "go test", limit: 999 }, undefined, undefined, ctx);
  assert.match(search.content[0].text, /#a3/);
  const read = await tools.get("history_read").execute("id", { entry_id: "u1", before: -5, after: 0 }, undefined, undefined, ctx);
  assert.match(read.content[0].text, /^#u1 \[user\]/);
});

test("compaction falls back to Pi's default when no model or auth is available", async () => {
  const { handlers } = harness();
  const compactHook = handlers.get("session_before_compact")!;
  const event = { preparation: { firstKeptEntryId: "a3", messagesToSummarize: [], turnPrefixMessages: [] }, signal: new AbortController().signal };
  assert.equal(await compactHook(event, { model: undefined }), undefined);
  const noAuth = { model: { id: "m" }, modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: false, error: "no key" }) } };
  assert.equal(await compactHook(event, noAuth), undefined);
  const throws = { model: { id: "m" }, modelRegistry: { getApiKeyAndHeaders: async () => { throw new Error("boom"); } } };
  assert.equal(await compactHook(event, throws), undefined);
});

test("a cancelled compaction stays cancelled instead of falling back to Pi's", async () => {
  const { handlers } = harness();
  const abort = new AbortController();
  abort.abort();
  const event = { preparation: { firstKeptEntryId: "a3", messagesToSummarize: [], turnPrefixMessages: [] }, signal: abort.signal };
  const ctx = { model: { id: "m" }, modelRegistry: { getApiKeyAndHeaders: async () => { throw new Error("aborted"); } } };
  assert.deepEqual(await handlers.get("session_before_compact")!(event, ctx), { cancel: true });
});
