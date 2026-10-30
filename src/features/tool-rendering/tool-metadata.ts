export interface PromptMetadata {
	promptSnippet?: string;
	promptGuidelines?: string[];
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function toRecord(value: unknown): Record<string, unknown> {
	return isRecord(value) ? value : {};
}

export function isNonBlankString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

export function extractPromptMetadata(tool: unknown): PromptMetadata {
	const source = toRecord(tool);
	const promptSnippet = isNonBlankString(source.promptSnippet) ? source.promptSnippet : undefined;
	const promptGuidelines = Array.isArray(source.promptGuidelines)
		? source.promptGuidelines.filter(isNonBlankString)
		: [];

	return {
		promptSnippet,
		promptGuidelines: promptGuidelines.length > 0 ? promptGuidelines : undefined,
	};
}
