export const READ_OUTPUT_MODES = ["hidden", "summary", "preview"] as const;
export const SEARCH_OUTPUT_MODES = ["hidden", "count", "preview"] as const;
export const BASH_OUTPUT_MODES = ["opencode", "summary", "preview"] as const;
export const DIFF_VIEW_MODES = ["auto", "split", "unified"] as const;
export const DIFF_INDICATOR_MODES = ["bars", "classic", "none"] as const;

export type ReadOutputMode = (typeof READ_OUTPUT_MODES)[number];
export type SearchOutputMode = (typeof SEARCH_OUTPUT_MODES)[number];
export type BashOutputMode = (typeof BASH_OUTPUT_MODES)[number];
export type DiffViewMode = (typeof DIFF_VIEW_MODES)[number];
export type DiffIndicatorMode = (typeof DIFF_INDICATOR_MODES)[number];

/** Settings that control how output looks. A profile is a named snapshot of exactly these. */
export const DISPLAY_SETTING_KEYS = [
	"enableNativeUserMessageBox",
	"groupToolCalls",
	"hideAssistantCommentary",
	"readOutputMode",
	"searchOutputMode",
	"previewLines",
	"expandedPreviewMaxLines",
	"bashOutputMode",
	"bashCollapsedLines",
	"diffViewMode",
	"diffIndicatorMode",
	"diffSplitMinWidth",
	"diffCollapsedLines",
	"diffWordWrap",
	"showTruncationHints",
] as const;

export const BUILT_IN_PROFILE_NAMES = ["hidden", "balanced", "verbose"] as const;
export type BuiltInProfileName = (typeof BUILT_IN_PROFILE_NAMES)[number];

export type DisplaySettings = Pick<SteroidsConfig, (typeof DISPLAY_SETTING_KEYS)[number]>;

export interface SteroidsConfig {
	enabled: boolean;
	/** Name of the active display profile (built-in or a key of `customProfiles`). */
	profile: string;
	customProfiles: Record<string, DisplaySettings>;
	enableNativeUserMessageBox: boolean;
	groupToolCalls: boolean;
	hideAssistantCommentary: boolean;
	backgroundTasks: boolean;
	btwSideChat: boolean;
	goalMode: boolean;
	compactionHistory: boolean;
	backgroundAutoSeconds: number;
	readOutputMode: ReadOutputMode;
	searchOutputMode: SearchOutputMode;
	previewLines: number;
	expandedPreviewMaxLines: number;
	bashOutputMode: BashOutputMode;
	bashCollapsedLines: number;
	diffViewMode: DiffViewMode;
	diffIndicatorMode: DiffIndicatorMode;
	diffSplitMinWidth: number;
	diffCollapsedLines: number;
	diffWordWrap: boolean;
	showTruncationHints: boolean;
}

export const DEFAULT_STEROIDS_CONFIG: SteroidsConfig = {
	enabled: true,
	profile: "hidden",
	customProfiles: {},
	enableNativeUserMessageBox: true,
	groupToolCalls: true,
	hideAssistantCommentary: true,
	backgroundTasks: false,
	btwSideChat: false,
	goalMode: false,
	compactionHistory: false,
	backgroundAutoSeconds: 120,
	readOutputMode: "hidden",
	searchOutputMode: "hidden",
	previewLines: 8,
	expandedPreviewMaxLines: 4000,
	bashOutputMode: "opencode",
	bashCollapsedLines: 10,
	diffViewMode: "auto",
	diffIndicatorMode: "bars",
	diffSplitMinWidth: 120,
	diffCollapsedLines: 24,
	diffWordWrap: true,
	showTruncationHints: false,
};

export interface ConfigLoadResult {
	config: SteroidsConfig;
	error?: string;
}

export interface ConfigSaveResult {
	success: boolean;
	error?: string;
}
