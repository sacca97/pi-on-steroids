import assert from "node:assert/strict";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	createBashTool,
	createEditTool,
	createFindTool,
	createGrepTool,
	createLsTool,
	createReadTool,
	createWriteTool,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { loadBashToolOverrideOptions, registerToolRendering } from "../src/features/tool-rendering/tool-overrides.ts";
import { DEFAULT_STEROIDS_CONFIG } from "../src/types.ts";


interface RegisteredToolLike {
	name: string;
	description: string;
	parameters: unknown;
	renderShell?: "default" | "self";
	promptSnippet?: string;
	promptGuidelines?: string[];
	renderCall?: (...args: unknown[]) => unknown;
	renderResult?: (...args: unknown[]) => unknown;
}

interface ToolEventHandlers {
	session_start?: () => Promise<void> | void;
	before_agent_start?: () => Promise<void> | void;
}

interface ExecutableToolLike extends RegisteredToolLike {
	execute: (...args: unknown[]) => Promise<{ content?: Array<{ type: string; text?: string }> }>;
}

async function withTempDir(name: string, run: (dir: string) => Promise<void> | void): Promise<void> {
	const dir = mkdtempSync(join(tmpdir(), name));
	try {
		await run(dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

function getTextOutput(result: { content?: Array<{ type: string; text?: string }> }): string {
	return (result.content ?? [])
		.filter((entry) => entry.type === "text")
		.map((entry) => entry.text ?? "")
		.join("");
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

function createExtensionApiStub(allTools: unknown[] = []): {
	api: ExtensionAPI;
	registeredTools: RegisteredToolLike[];
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

	return { api, registeredTools, eventHandlers };
}

test("registerToolRendering copies built-in prompt metadata onto overridden tools", async () => {
	const { api, registeredTools, eventHandlers } = createExtensionApiStub();

	registerToolRendering(api, () => DEFAULT_STEROIDS_CONFIG);
	assert.deepEqual(
		registeredTools.map((tool) => tool.name).sort(),
		["bash", "edit", "find", "grep", "ls", "read", "write"],
	);
	await eventHandlers.before_agent_start?.();

	assert.equal(registeredTools.length, 7);

	const byName = new Map(registeredTools.map((tool) => [tool.name, tool]));
	const cwd = process.cwd();
	const builtInTools = {
		read: createReadTool(cwd),
		grep: createGrepTool(cwd),
		find: createFindTool(cwd),
		ls: createLsTool(cwd),
		bash: createBashTool(cwd),
		edit: createEditTool(cwd),
		write: createWriteTool(cwd),
	};

	for (const [name, builtInTool] of Object.entries(builtInTools)) {
		const registeredTool = byName.get(name);
		const builtInMetadata = builtInTool as unknown as RegisteredToolLike;
		assert.ok(registeredTool, `expected '${name}' to be registered`);
		assert.equal(registeredTool.promptSnippet, builtInMetadata.promptSnippet);
	}

	assert.deepEqual(byName.get("read")?.promptGuidelines, (builtInTools.read as unknown as RegisteredToolLike).promptGuidelines);
	assert.deepEqual(byName.get("edit")?.promptGuidelines, (builtInTools.edit as unknown as RegisteredToolLike).promptGuidelines);
	assert.deepEqual(byName.get("write")?.promptGuidelines, (builtInTools.write as unknown as RegisteredToolLike).promptGuidelines);
	assert.equal(byName.get("grep")?.promptGuidelines, undefined);
	assert.equal(byName.get("find")?.promptGuidelines, undefined);
	assert.equal(byName.get("ls")?.promptGuidelines, undefined);
	assert.equal(byName.get("bash")?.promptGuidelines, undefined);
});

test("registerToolRendering registers built-in display renderers during extension load for pre-bind history rendering", () => {
	const { api, registeredTools } = createExtensionApiStub();

	registerToolRendering(api, () => DEFAULT_STEROIDS_CONFIG);

	const byName = new Map(registeredTools.map((tool) => [tool.name, tool]));
	for (const name of ["read", "grep", "find", "ls", "bash", "edit", "write"] as const) {
		const registeredTool = byName.get(name);
		assert.ok(registeredTool, `expected '${name}' to be available before session_start`);
		assert.equal(typeof registeredTool.renderCall, "function", `${name} has renderCall before session_start`);
		assert.equal(typeof registeredTool.renderResult, "function", `${name} has renderResult before session_start`);
	}
});

test("registerToolRendering clones built-in parameter schemas so Pi TUI keeps extension renderers active", async () => {
	const { api, registeredTools, eventHandlers } = createExtensionApiStub();

	registerToolRendering(api, () => DEFAULT_STEROIDS_CONFIG);
	await eventHandlers.before_agent_start?.();

	const byName = new Map(registeredTools.map((tool) => [tool.name, tool]));
	const cwd = process.cwd();
	const builtInTools = {
		read: createReadTool(cwd),
		grep: createGrepTool(cwd),
		find: createFindTool(cwd),
		ls: createLsTool(cwd),
		bash: createBashTool(cwd),
		edit: createEditTool(cwd),
		write: createWriteTool(cwd),
	};

	for (const [name, builtInTool] of Object.entries(builtInTools)) {
		const registeredTool = byName.get(name);
		assert.ok(registeredTool, `expected '${name}' to be registered`);
		assert.notEqual(
			registeredTool.parameters,
			builtInTool.parameters,
			`expected '${name}' to use a cloned parameter object`,
		);
		assert.deepEqual(registeredTool.parameters, builtInTool.parameters);
	}
});

test("registerToolRendering forces edit into the default render shell so tool backgrounds fill the full row", async () => {
	const { api, registeredTools, eventHandlers } = createExtensionApiStub();

	registerToolRendering(api, () => DEFAULT_STEROIDS_CONFIG);
	await eventHandlers.before_agent_start?.();

	const byName = new Map(registeredTools.map((tool) => [tool.name, tool]));
	assert.equal(byName.get("edit")?.renderShell, "default");
});

test("bash override uses shellPath from Pi settings", async () => {
	await withTempDir("pi-on-steroids-shellpath-", async (dir) => {
		const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = dir;
		writeFileSync(
			join(dir, "settings.json"),
			JSON.stringify({ shellPath: "/definitely/missing/bash" }),
			"utf8",
		);

		try {
			const { api, registeredTools, eventHandlers } = createExtensionApiStub();
			registerToolRendering(api, () => DEFAULT_STEROIDS_CONFIG);
			await eventHandlers.before_agent_start?.();

			const bashTool = registeredTools.find((tool) => tool.name === "bash") as ExecutableToolLike | undefined;
			assert.ok(bashTool, "expected bash override to be registered");
			await assert.rejects(
				bashTool.execute("tool-call-1", { command: "printf test" }, undefined, undefined, { cwd: process.cwd() }),
				/custom shell path not found/i,
			);
			assert.equal(bashTool.description.length > 0, true);
		} finally {
			if (previousAgentDir === undefined) {
				delete process.env.PI_CODING_AGENT_DIR;
			} else {
				process.env.PI_CODING_AGENT_DIR = previousAgentDir;
			}
		}
	});
});

test("bash override uses shellCommandPrefix from Pi settings", async () => {
	await withTempDir("pi-on-steroids-shellprefix-", async (dir) => {
		const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = dir;
		writeFileSync(
			join(dir, "settings.json"),
			JSON.stringify({ shellCommandPrefix: "printf 'prefix-output\\n'" }),
			"utf8",
		);

		try {
			const { api, registeredTools, eventHandlers } = createExtensionApiStub();
			registerToolRendering(api, () => DEFAULT_STEROIDS_CONFIG);
			await eventHandlers.before_agent_start?.();

			const bashTool = registeredTools.find((tool) => tool.name === "bash") as ExecutableToolLike | undefined;
			assert.ok(bashTool, "expected bash override to be registered");
			const result = await bashTool.execute(
				"tool-call-2",
				{ command: "printf 'command-output\\n'" },
				undefined,
				undefined,
				{ cwd: process.cwd() },
			);
			assert.equal(getTextOutput(result).trim(), "prefix-output\ncommand-output");
		} finally {
			if (previousAgentDir === undefined) {
				delete process.env.PI_CODING_AGENT_DIR;
			} else {
				process.env.PI_CODING_AGENT_DIR = previousAgentDir;
			}
		}
	});
});


test("shell settings are cached until settings.json changes", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-settings-cache-"));
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = dir;
	try {
		const path = join(dir, "settings.json");
		writeFileSync(path, JSON.stringify({ shellCommandPrefix: "export A=1" }));
		const first = loadBashToolOverrideOptions();
		assert.equal(first.commandPrefix, "export A=1");
		assert.equal(loadBashToolOverrideOptions(), first, "unchanged file is not re-parsed");
		writeFileSync(path, JSON.stringify({ shellCommandPrefix: "export A=2" }));
		utimesSync(path, new Date(), new Date(Date.now() + 5000));
		assert.equal(loadBashToolOverrideOptions().commandPrefix, "export A=2");
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		rmSync(dir, { recursive: true, force: true });
	}
});
