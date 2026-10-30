import { resolvePiAgentDir } from "./agent-dir.js";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
	BASH_OUTPUT_MODES,
	DEFAULT_STEROIDS_CONFIG,
	type ConfigLoadResult,
	type ConfigSaveResult,
	DIFF_INDICATOR_MODES,
	DIFF_VIEW_MODES,
	READ_OUTPUT_MODES,
	SEARCH_OUTPUT_MODES,
	type DisplaySettings,
	type SteroidsConfig,
} from "./types.js";
import { isValidCustomProfileName, pickDisplaySettings } from "./profiles.js";
import { toRecord } from "./features/tool-rendering/tool-metadata.js";

const CONFIG_DIR = join(resolvePiAgentDir(), "extensions", "pi-on-steroids");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
	if (typeof value !== "number" || Number.isNaN(value)) {
		return fallback;
	}
	const rounded = Math.floor(value);
	if (rounded < min) return min;
	if (rounded > max) return max;
	return rounded;
}

function toBoolean(value: unknown, fallback: boolean): boolean {
	return typeof value === "boolean" ? value : fallback;
}

function toEnum<T extends string>(values: readonly T[], value: unknown, fallback: T): T {
	return values.includes(value as T) ? (value as T) : fallback;
}

function toDiffViewMode(value: unknown): SteroidsConfig["diffViewMode"] {
	if (value === "stacked") {
		// Backward compatibility with older config naming.
		return "unified";
	}

	return toEnum(DIFF_VIEW_MODES, value, DEFAULT_STEROIDS_CONFIG.diffViewMode);
}

function cloneDefaultConfig(): SteroidsConfig {
	return {
		...DEFAULT_STEROIDS_CONFIG,
		customProfiles: {},
	};
}

let cachedConfigFile: string | undefined;
let cachedConfigFingerprint: string | undefined;
let cachedConfigResult: ConfigLoadResult | undefined;

function cloneLoadResult(result: ConfigLoadResult): ConfigLoadResult {
	return {
		...result,
		config: normalizeSteroidsConfig(result.config),
	};
}

function getConfigFingerprint(configFile: string): string {
	try {
		const stats = statSync(configFile);
		return `${stats.mtimeMs}:${stats.size}`;
	} catch {
		return "missing";
	}
}

function toProfileName(value: unknown): string {
	return typeof value === "string" && value.trim() ? value.trim() : DEFAULT_STEROIDS_CONFIG.profile;
}

function normalizeCustomProfiles(raw: unknown): Record<string, DisplaySettings> {
	const profiles: Record<string, DisplaySettings> = {};
	for (const [name, entry] of Object.entries(toRecord(raw))) {
		if (isValidCustomProfileName(name)) {
			// Reuse the full normalizer so each snapshot is clamped and defaulted like the live settings.
			profiles[name] = pickDisplaySettings(normalizeSteroidsConfig(entry));
		}
	}
	return profiles;
}

export function normalizeSteroidsConfig(raw: unknown): SteroidsConfig {
	const source =
		typeof raw === "object" && raw !== null ? (raw as Partial<SteroidsConfig>) : ({} as Partial<SteroidsConfig>);

	return {
		enabled: toBoolean(source.enabled, DEFAULT_STEROIDS_CONFIG.enabled),
		profile: toProfileName(source.profile),
		customProfiles: normalizeCustomProfiles(source.customProfiles),
		enableNativeUserMessageBox: toBoolean(
			source.enableNativeUserMessageBox,
			DEFAULT_STEROIDS_CONFIG.enableNativeUserMessageBox,
		),
		groupToolCalls: toBoolean(source.groupToolCalls, DEFAULT_STEROIDS_CONFIG.groupToolCalls),
		hideAssistantCommentary: toBoolean(
			source.hideAssistantCommentary,
			DEFAULT_STEROIDS_CONFIG.hideAssistantCommentary,
		),
		btwSideChat: toBoolean(source.btwSideChat, DEFAULT_STEROIDS_CONFIG.btwSideChat),
		goalMode: toBoolean(source.goalMode, DEFAULT_STEROIDS_CONFIG.goalMode),
		compactionHistory: toBoolean(source.compactionHistory, DEFAULT_STEROIDS_CONFIG.compactionHistory),
		backgroundTasks: toBoolean(source.backgroundTasks, DEFAULT_STEROIDS_CONFIG.backgroundTasks),
		backgroundAutoSeconds: clampNumber(
			source.backgroundAutoSeconds,
			0,
			3600,
			DEFAULT_STEROIDS_CONFIG.backgroundAutoSeconds,
		),
		readOutputMode: toEnum(READ_OUTPUT_MODES, source.readOutputMode, DEFAULT_STEROIDS_CONFIG.readOutputMode),
		searchOutputMode: toEnum(SEARCH_OUTPUT_MODES, source.searchOutputMode, DEFAULT_STEROIDS_CONFIG.searchOutputMode),
		previewLines: clampNumber(source.previewLines, 1, 80, DEFAULT_STEROIDS_CONFIG.previewLines),
		expandedPreviewMaxLines: clampNumber(
			source.expandedPreviewMaxLines,
			0,
			20_000,
			DEFAULT_STEROIDS_CONFIG.expandedPreviewMaxLines,
		),
		bashOutputMode: toEnum(BASH_OUTPUT_MODES, source.bashOutputMode, DEFAULT_STEROIDS_CONFIG.bashOutputMode),
		bashCollapsedLines: clampNumber(source.bashCollapsedLines, 0, 80, DEFAULT_STEROIDS_CONFIG.bashCollapsedLines),
		diffViewMode: toDiffViewMode(source.diffViewMode),
		diffIndicatorMode: toEnum(
			DIFF_INDICATOR_MODES,
			source.diffIndicatorMode,
			DEFAULT_STEROIDS_CONFIG.diffIndicatorMode,
		),
		diffSplitMinWidth: clampNumber(source.diffSplitMinWidth, 70, 240, DEFAULT_STEROIDS_CONFIG.diffSplitMinWidth),
		diffCollapsedLines: clampNumber(source.diffCollapsedLines, 4, 240, DEFAULT_STEROIDS_CONFIG.diffCollapsedLines),
		diffWordWrap: toBoolean(source.diffWordWrap, DEFAULT_STEROIDS_CONFIG.diffWordWrap),
		showTruncationHints: toBoolean(source.showTruncationHints, DEFAULT_STEROIDS_CONFIG.showTruncationHints),
	};
}

export function loadSteroidsConfig(configFile = CONFIG_FILE): ConfigLoadResult {
	const fingerprint = getConfigFingerprint(configFile);
	if (cachedConfigResult && cachedConfigFile === configFile && cachedConfigFingerprint === fingerprint) {
		return cloneLoadResult(cachedConfigResult);
	}

	let result: ConfigLoadResult;
	if (!existsSync(configFile)) {
		result = { config: cloneDefaultConfig() };
	} else {
		try {
			const rawText = readFileSync(configFile, "utf-8");
			const rawConfig = JSON.parse(rawText) as unknown;
			result = { config: normalizeSteroidsConfig(rawConfig) };
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			result = {
				config: cloneDefaultConfig(),
				error: `Failed to parse ${configFile}: ${message}`,
			};
		}
	}

	cachedConfigFile = configFile;
	cachedConfigFingerprint = fingerprint;
	cachedConfigResult = cloneLoadResult(result);
	return result;
}

export function saveSteroidsConfig(config: SteroidsConfig, configFile = CONFIG_FILE): ConfigSaveResult {
	const normalized = normalizeSteroidsConfig(config);
	const tmpFile = `${configFile}.tmp`;

	try {
		mkdirSync(dirname(configFile), { recursive: true });
		writeFileSync(tmpFile, `${JSON.stringify(normalized, null, 2)}\n`, "utf-8");
		renameSync(tmpFile, configFile);
		cachedConfigFile = undefined;
		cachedConfigFingerprint = undefined;
		cachedConfigResult = undefined;
		return { success: true };
	} catch (error) {
		try {
			if (existsSync(tmpFile)) {
				unlinkSync(tmpFile);
			}
		} catch {
			// Ignore cleanup errors.
		}
		const message = error instanceof Error ? error.message : String(error);
		return {
			success: false,
			error: `Failed to save ${configFile}: ${message}`,
		};
	}
}

export function getSteroidsConfigPath(): string {
	return CONFIG_FILE;
}
