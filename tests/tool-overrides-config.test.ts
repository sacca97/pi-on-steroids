import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerToolRendering } from "../src/features/tool-rendering/tool-overrides.ts";
import { DEFAULT_STEROIDS_CONFIG, type SteroidsConfig } from "../src/types.ts";

interface RenderThemeLike {
	fg(color: string, value: string): string;
	bold(value: string): string;
}

interface RenderComponentLike {
	render(width: number): string[];
}

interface RenderCallContextLike {
	lastComponent?: unknown;
	state?: Record<string, unknown>;
	invalidate(): void;
	executionStarted: boolean;
	isPartial: boolean;
}

interface RegisteredToolLike {
	name: string;
	description?: string;
	parameters?: unknown;
	promptSnippet?: string;
	promptGuidelines?: string[];
	renderCall?: (args: unknown, theme: RenderThemeLike, context: RenderCallContextLike) => RenderComponentLike;
	renderResult?: (result: unknown, options: unknown, theme: unknown) => RenderComponentLike;
}

interface ToolEventHandlers {
	session_start?: () => Promise<void> | void;
	before_agent_start?: () => Promise<void> | void;
}

function buildConfig(overrides: Partial<SteroidsConfig>): SteroidsConfig {
	return {
		...DEFAULT_STEROIDS_CONFIG,
		...overrides,
	};
}

function withDefaultReadEditOwners(tools: unknown[] = []): unknown[] {
	const names = new Set(
		tools
			.map((tool) => (tool as { name?: unknown }).name)
			.filter((name): name is string => typeof name === "string"),
	);
	const defaults = ["read", "edit"]
		.filter((name) => !names.has(name))
		.map((name) => ({ name, sourceInfo: { source: "builtin", path: `<builtin:${name}>` } }));
	return [...defaults, ...tools];
}

function createExtensionApiStub(allTools: Array<RegisteredToolLike & Record<string, unknown>> = []): {
	api: ExtensionAPI;
	registeredTools: RegisteredToolLike[];
	runtimeTools: Array<RegisteredToolLike & Record<string, unknown>>;
	eventHandlers: ToolEventHandlers;
} {
	const registeredTools: RegisteredToolLike[] = [];
	const eventHandlers: ToolEventHandlers = {};
	const api = {
		registerTool(tool: RegisteredToolLike): void {
			registeredTools.push(tool);
		},
		on(event: keyof ToolEventHandlers, handler: () => Promise<void> | void): void {
			eventHandlers[event] = handler;
		},
		getAllTools(): unknown[] {
			return withDefaultReadEditOwners(allTools);
		},
	} as unknown as ExtensionAPI;

	return { api, registeredTools, runtimeTools: allTools, eventHandlers };
}

async function runLifecycle(eventHandlers: ToolEventHandlers): Promise<void> {
	await eventHandlers.session_start?.();
	await eventHandlers.before_agent_start?.();
}

function createTheme(): RenderThemeLike {
	return {
		fg: (_color: string, value: string): string => value,
		bold: (value: string): string => value,
	};
}

function normalizeRenderedText(component: RenderComponentLike): string {
	return component
		.render(120)
		.map((line) => line.trimEnd())
		.join("\n")
		.trim();
}

function renderToolResult(
	tool: RegisteredToolLike | undefined,
	input:
		| string
		| {
				text: string;
				details?: unknown;
				expanded?: boolean;
				isPartial?: boolean;
				isError?: boolean;
		  },
): string {
	assert.ok(tool?.renderResult, `expected renderResult for tool '${tool?.name ?? "unknown"}'`);
	const payload = typeof input === "string" ? { text: input } : input;
	return normalizeRenderedText(
		tool.renderResult(
			{
				content: [{ type: "text", text: payload.text }],
				details: payload.details ?? {},
				isError: payload.isError ?? false,
			},
			{ isPartial: payload.isPartial ?? false, expanded: payload.expanded ?? false },
			createTheme(),
		),
	);
}

function renderToolCall(
	tool: RegisteredToolLike | undefined,
	args: { command: string; timeout?: number },
	contextOverrides: Partial<RenderCallContextLike> = {},
): { output: string; component: RenderComponentLike; context: RenderCallContextLike } {
	assert.ok(tool?.renderCall, `expected renderCall for tool '${tool?.name ?? "unknown"}'`);
	const context: RenderCallContextLike = {
		lastComponent: contextOverrides.lastComponent,
		state: contextOverrides.state ?? {},
		invalidate: contextOverrides.invalidate ?? (() => {}),
		executionStarted: contextOverrides.executionStarted ?? false,
		isPartial: contextOverrides.isPartial ?? false,
	};
	const component = tool.renderCall(args, createTheme(), context);
	return {
		output: normalizeRenderedText(component),
		component,
		context,
	};
}

test("showTruncationHints=false suppresses backend truncation summaries across read/search modes", async () => {
	const config = buildConfig({
		readOutputMode: "summary",
		searchOutputMode: "count",
		showTruncationHints: false,
	});
	const { api, registeredTools, eventHandlers } = createExtensionApiStub();

	registerToolRendering(api, () => config);
	await runLifecycle(eventHandlers);

	assert.equal(
		renderToolResult(registeredTools.find((tool) => tool.name === "read"), {
			text: "alpha\n",
			details: { truncation: { truncated: true } },
		}),
		"↳ loaded 1 line • Ctrl+O to expand",
	);
	assert.equal(
		renderToolResult(registeredTools.find((tool) => tool.name === "grep"), {
			text: "a.txt:1\n",
			details: { truncation: { truncated: true } },
		}),
		"↳ 1 match returned • Ctrl+O to expand",
	);
});

test("bash output modes stay distinct across opencode, summary, and preview", async () => {
	const output = "alpha\nbeta\ngamma\n";

	const opencodeConfig = buildConfig({
		bashOutputMode: "opencode",
		bashCollapsedLines: 1,
	});
	const opencodeStub = createExtensionApiStub();
	registerToolRendering(opencodeStub.api, () => opencodeConfig);
	await opencodeStub.eventHandlers.before_agent_start?.();
	assert.equal(
		renderToolResult(opencodeStub.registeredTools.find((tool) => tool.name === "bash"), output),
		"alpha\n... (2 more lines • Ctrl+O to expand)",
	);

	const summaryConfig = buildConfig({
		bashOutputMode: "summary",
		bashCollapsedLines: 1,
	});
	const summaryStub = createExtensionApiStub();
	registerToolRendering(summaryStub.api, () => summaryConfig);
	await summaryStub.eventHandlers.before_agent_start?.();
	assert.equal(
		renderToolResult(summaryStub.registeredTools.find((tool) => tool.name === "bash"), output),
		"↳ 3 lines returned • Ctrl+O to expand",
	);
	assert.equal(
		renderToolResult(summaryStub.registeredTools.find((tool) => tool.name === "bash"), {
			text: output,
			expanded: true,
		}),
		"alpha\nbeta\ngamma",
	);

	const previewConfig = buildConfig({
		bashOutputMode: "preview",
		previewLines: 2,
		bashCollapsedLines: 1,
	});
	const previewStub = createExtensionApiStub();
	registerToolRendering(previewStub.api, () => previewConfig);
	await previewStub.eventHandlers.before_agent_start?.();
	assert.equal(
		renderToolResult(previewStub.registeredTools.find((tool) => tool.name === "bash"), output),
		"alpha\nbeta\n... (1 more line • Ctrl+O to expand)",
	);
});

test("bash call spinner appears only while execution is active", async () => {
	const config = buildConfig({
		bashOutputMode: "summary",
	});
	const { api, registeredTools, eventHandlers } = createExtensionApiStub();
	registerToolRendering(api, () => config);
	await eventHandlers.before_agent_start?.();

	const bashTool = registeredTools.find((tool) => tool.name === "bash");
	const idle = renderToolCall(bashTool, { command: "npm test" });
	assert.equal(idle.output, "$ npm test");

	let invalidateCount = 0;
	const running = renderToolCall(
		bashTool,
		{ command: "npm test" },
		{
			state: {},
			executionStarted: true,
			isPartial: true,
			invalidate: () => {
				invalidateCount++;
			},
		},
	);
	assert.match(running.output, /^⠋ \$ npm test · 0s$/);

	await new Promise((resolve) => setTimeout(resolve, 220));
	const animatedFrame = normalizeRenderedText(running.component);
	assert.notEqual(animatedFrame, running.output);
	assert.match(animatedFrame, /^⠙ \$ npm test · 0s$/);
	assert.ok(invalidateCount > 0);

	const complete = renderToolCall(
		bashTool,
		{ command: "npm test" },
		{
			state: running.context.state,
			lastComponent: running.component,
			executionStarted: true,
			isPartial: false,
		},
	);
	assert.equal(complete.output, "$ npm test");
});

test("bash render keeps the running result area empty until output exists", async () => {
	const config = buildConfig({
		bashOutputMode: "summary",
	});
	const { api, registeredTools, eventHandlers } = createExtensionApiStub();
	registerToolRendering(api, () => config);
	await eventHandlers.before_agent_start?.();

	const bashTool = registeredTools.find((tool) => tool.name === "bash");
	assert.equal(
		renderToolResult(bashTool, { text: "", isPartial: true }),
		"",
	);
});

test("bash render shows live partial output once streaming begins", async () => {
	const config = buildConfig({
		bashOutputMode: "summary",
		previewLines: 2,
	});
	const { api, registeredTools, eventHandlers } = createExtensionApiStub();
	registerToolRendering(api, () => config);
	await eventHandlers.before_agent_start?.();

	const bashTool = registeredTools.find((tool) => tool.name === "bash");
	assert.equal(
		renderToolResult(bashTool, {
			text: "alpha\nbeta\ngamma\n",
			isPartial: true,
		}),
		"alpha\nbeta\n... (1 more line • Ctrl+O to expand)",
	);
});

test("bash live partial output respects opencode collapse settings", async () => {
	const config = buildConfig({
		bashOutputMode: "opencode",
		bashCollapsedLines: 1,
		previewLines: 4,
	});
	const { api, registeredTools, eventHandlers } = createExtensionApiStub();
	registerToolRendering(api, () => config);
	await eventHandlers.before_agent_start?.();

	const bashTool = registeredTools.find((tool) => tool.name === "bash");
	assert.equal(
		renderToolResult(bashTool, {
			text: "alpha\nbeta\ngamma\n",
			isPartial: true,
		}),
		"alpha\n... (2 more lines • Ctrl+O to expand)",
	);
});

test("bash errors render with an explicit failure header and preview", async () => {
	const config = buildConfig({
		bashOutputMode: "summary",
		previewLines: 2,
	});
	const { api, registeredTools, eventHandlers } = createExtensionApiStub();
	registerToolRendering(api, () => config);
	await eventHandlers.before_agent_start?.();

	const bashTool = registeredTools.find((tool) => tool.name === "bash");
	assert.equal(
		renderToolResult(bashTool, {
			text: "npm ERR! missing script: test\nSee npm help run-script\n",
			isError: true,
		}),
		"↳ command failed\nnpm ERR! missing script: test\nSee npm help run-script",
	);
});
