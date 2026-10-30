// Vendored from ../zellij-modal/index.ts to keep pi-on-steroids standalone.
// Keep this module in sync when upstream zellij-modal primitives change.
import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const ANSI_RESET = "\x1b[0m";

/**
 * Border character set used to render a modal frame.
 */
export interface BorderCharacters {
	/** Top-left corner. */
	topLeft: string;
	/** Top-right corner. */
	topRight: string;
	/** Bottom-left corner. */
	bottomLeft: string;
	/** Bottom-right corner. */
	bottomRight: string;
	/** Horizontal line character. */
	horizontal: string;
	/** Vertical line character. */
	vertical: string;
	/** Optional left tee junction. */
	verticalLeft?: string;
	/** Optional right tee junction. */
	verticalRight?: string;
}

/**
 * Predefined border character sets aligned with Zellij styles.
 */
export const BORDER_STYLES = {
	rounded: {
		topLeft: "╭",
		topRight: "╮",
		bottomLeft: "╰",
		bottomRight: "╯",
		horizontal: "─",
		vertical: "│",
		verticalLeft: "├",
		verticalRight: "┤",
	},
	square: {
		topLeft: "┌",
		topRight: "┐",
		bottomLeft: "└",
		bottomRight: "┘",
		horizontal: "─",
		vertical: "│",
		verticalLeft: "├",
		verticalRight: "┤",
	},
	double: {
		topLeft: "╔",
		topRight: "╗",
		bottomLeft: "╚",
		bottomRight: "╝",
		horizontal: "═",
		vertical: "║",
	},
	none: {
		topLeft: " ",
		topRight: " ",
		bottomLeft: " ",
		bottomRight: " ",
		horizontal: " ",
		vertical: " ",
	},
} as const satisfies Record<string, BorderCharacters>;

/**
 * Name of a supported border style.
 */
export type BorderStyle = keyof typeof BORDER_STYLES;

/**
 * Supported palette color formats.
 */
export type PaletteColor =
	| { type: "rgb"; r: number; g: number; b: number }
	| { type: "8bit"; code: number }
	| { type: "named"; name: string };

/**
 * Semantic color slots for a Zellij-style modal.
 */
export interface ZellijColorPalette {
	/** Primary foreground text. */
	fg: PaletteColor;
	/** Modal background. */
	bg: PaletteColor;
	/** Accent / selection color. */
	accent: PaletteColor;
	/** Secondary text color. */
	muted: PaletteColor;
	/** Tertiary text color. */
	dim: PaletteColor;
	/** Success state color. */
	success: PaletteColor;
	/** Error state color. */
	error: PaletteColor;
	/** Warning state color. */
	warning: PaletteColor;
	/** Default border color. */
	border: PaletteColor;
	/** Border color when focused. */
	borderFocused: PaletteColor;
	/** Border color when unfocused. */
	borderUnfocused: PaletteColor;
}

/**
 * Default Zellij-inspired palette.
 *
 * The modal background is a dark grey instead of pure black so overlays are
 * visually distinct from the main terminal surface.
 */
export const DEFAULT_ZELLIJ_PALETTE: ZellijColorPalette = {
	fg: { type: "named", name: "white" },
	bg: { type: "8bit", code: 236 },
	accent: { type: "8bit", code: 36 },
	muted: { type: "8bit", code: 245 },
	dim: { type: "8bit", code: 238 },
	success: { type: "8bit", code: 154 },
	error: { type: "8bit", code: 124 },
	warning: { type: "8bit", code: 166 },
	border: { type: "8bit", code: 238 },
	borderFocused: { type: "8bit", code: 154 },
	borderUnfocused: { type: "8bit", code: 238 },
};

/**
 * A title segment in the top border.
 */
export interface TitleSegment {
	/** Segment text. */
	text: string;
	/** Segment foreground color slot or explicit color. */
	color: keyof ZellijColorPalette | PaletteColor;
	/** Enables bold style. */
	bold?: boolean;
	/** Truncation strategy when segment text is too long. */
	truncate?: "end" | "none";
	/** Maximum visible width for text content (0 means unlimited). */
	maxWidth?: number;
}

/**
 * Three-part title bar configuration.
 */
export interface TitleBarConfig {
	/** Left segment (usually title). */
	left?: TitleSegment | string;
	/** Center segment (usually status). */
	center?: TitleSegment | string;
	/** Right segment (usually counters/actions). */
	right?: TitleSegment | string;
}

/**
 * Help text line rendered in the bottom border.
 */
export interface HelpUndertitleConfig {
	/** Static help text. */
	text?: string;
	/** Progressive truncation variants from longest to shortest. */
	variants?: string[];
	/** Structured key hints for help text generation. */
	keyHints?: Array<{
		key: string;
		description: string;
	}>;
	/** Separator between key hints. */
	keyHintSeparator?: string;
	/** Palette slot for help text color. */
	color?: keyof ZellijColorPalette;
}

/**
 * Full modal configuration.
 */
export interface ZellijModalConfig {
	/** Border style preset. */
	borderStyle: BorderStyle;
	/** Active color palette. */
	palette: ZellijColorPalette;
	/** Focus state for frame highlighting. */
	focused: boolean;
	/** Internal content padding. */
	padding: number;
	/** Top title bar config. */
	titleBar: TitleBarConfig;
	/** Optional bottom help line config. */
	helpUndertitle?: HelpUndertitleConfig;
	/** Minimum preferred modal width. */
	minWidth: number;
	/** Maximum modal width (0 means no explicit max). */
	maxWidth: number;
	/** Overlay options for `ctx.ui.custom()`. */
	overlay: {
		anchor: "center" | "top" | "bottom";
		width: number | string;
		maxHeight: number | string;
		margin: number;
	};
}

/**
 * Partial modal configuration used by consumers.
 */
export type ZellijModalConfigPartial = Partial<ZellijModalConfig> & {
	/** Shorthand for `titleBar.left`. */
	title?: string;
	/** Shorthand for help text. */
	helpText?: string | HelpUndertitleConfig;
};

/**
 * Modal rendering metadata.
 */
export interface ZellijModalRenderOutput {
	/** Fully rendered lines. */
	lines: string[];
	/** Visible frame width. */
	visibleWidth: number;
	/** Width of content area inside borders and padding. */
	contentWidth: number;
	/** Inclusive index of first content line. */
	contentStartLine: number;
	/** Inclusive index of last content line. */
	contentEndLine: number;
}

/**
 * Minimal content renderer contract for modal content.
 */
export interface ZellijModalContentRenderer {
	/** Render content into lines for the given width. */
	render(width: number): string[];
	/** Invalidate internal caches. */
	invalidate(): void;
	/** Optional input handler. */
	handleInput?(data: string): void;
}

/**
 * Theme helper for modal-specific color resolution and ANSI formatting.
 */
export interface ZellijModalTheme {
	/** Active palette used by this theme helper. */
	palette: ZellijColorPalette;
	/** Resolve color slot or explicit color into ANSI foreground/background codes. */
	resolveColor: (color: PaletteColor | keyof ZellijColorPalette) => { fg: string; bg: string };
	/** Apply foreground color to text. */
	colorizeForeground: (color: PaletteColor | keyof ZellijColorPalette, text: string) => string;
	/** Apply background color to text. */
	colorizeBackground: (color: PaletteColor | keyof ZellijColorPalette, text: string) => string;
}

const NAMED_COLOR_CODES: Record<string, number> = {
	black: 16,
	white: 255,
	red: 196,
	green: 46,
	blue: 45,
	yellow: 226,
	cyan: 51,
	magenta: 201,
	gray: 245,
	grey: 245,
	orange: 166,
};

/** Modal surface for light themes, where the default dark grey would make dark text unreadable. */
const LIGHT_THEME_MODAL_BG: PaletteColor = { type: "8bit", code: 254 };

/**
 * Resolve a `PaletteColor` into ANSI foreground/background escape codes.
 */
export function resolveColor(color: PaletteColor): { fg: string; bg: string } {
	if (color.type === "rgb") {
		const r = clampInt(color.r, 0, 255);
		const g = clampInt(color.g, 0, 255);
		const b = clampInt(color.b, 0, 255);
		return {
			fg: `\x1b[38;2;${r};${g};${b}m`,
			bg: `\x1b[48;2;${r};${g};${b}m`,
		};
	}

	const code = color.type === "8bit" ? clampInt(color.code, 0, 255) : NAMED_COLOR_CODES[color.name.toLowerCase()] ?? 255;
	return {
		fg: `\x1b[38;5;${code}m`,
		bg: `\x1b[48;5;${code}m`,
	};
}

/**
 * Build a `ZellijModalTheme` helper from a palette.
 */
export function createZellijModalTheme(palette: ZellijColorPalette): ZellijModalTheme {
	const resolve = (color: PaletteColor | keyof ZellijColorPalette) =>
		resolveColor(typeof color === "string" ? palette[color] : color);
	return {
		palette,
		resolveColor: resolve,
		colorizeForeground: (color, text) => `${resolve(color).fg}${text}${ANSI_RESET}`,
		colorizeBackground: (color, text) => `${resolve(color).bg}${text}${ANSI_RESET}`,
	};
}

/**
 * Convert Pi `Theme` values to a Zellij modal palette.
 */
export function themeToZellijPalette(theme: Theme): ZellijColorPalette {
	const extract = (colorName: string, fallback: PaletteColor): PaletteColor => {
		const provider = theme as unknown as {
			getFgAnsi?: (name: string) => string;
		};
		if (!provider.getFgAnsi) {
			return fallback;
		}

		try {
			return parseAnsiForegroundColor(provider.getFgAnsi(colorName)) ?? fallback;
		} catch {
			return fallback;
		}
	};

	const fg = extract("fg", DEFAULT_ZELLIJ_PALETTE.fg);
	return {
		fg,
		// Pi themes do not expose a generic surface background. Use a modal surface
		// so overlays stand out: dark grey for light text, light grey for dark text.
		bg: colorLuminance(fg) >= 0.5 ? DEFAULT_ZELLIJ_PALETTE.bg : LIGHT_THEME_MODAL_BG,
		accent: extract("accent", DEFAULT_ZELLIJ_PALETTE.accent),
		muted: extract("muted", DEFAULT_ZELLIJ_PALETTE.muted),
		dim: extract("dim", DEFAULT_ZELLIJ_PALETTE.dim),
		success: extract("success", DEFAULT_ZELLIJ_PALETTE.success),
		error: extract("error", DEFAULT_ZELLIJ_PALETTE.error),
		warning: extract("warning", DEFAULT_ZELLIJ_PALETTE.warning),
		border: extract("borderMuted", DEFAULT_ZELLIJ_PALETTE.border),
		borderFocused: extract("accent", DEFAULT_ZELLIJ_PALETTE.borderFocused),
		borderUnfocused: extract("borderMuted", DEFAULT_ZELLIJ_PALETTE.borderUnfocused),
	};
}

interface PositionedTitleSegment {
	start: number;
	end: number;
	text: string;
	color: keyof ZellijColorPalette | PaletteColor;
	bold: boolean;
}

/**
 * Core frame renderer for Zellij-style borders, title bar, and undertitle.
 */
export class ZellijModalFrame {
	private config!: ZellijModalConfig;
	private borders!: BorderCharacters;
	private theme!: ZellijModalTheme;

	constructor(config: ZellijModalConfig) {
		this.setConfig(config);
	}

	/**
	 * Update frame configuration (used when modal config changes).
	 */
	setConfig(config: ZellijModalConfig): void {
		this.config = config;
		this.borders = BORDER_STYLES[config.borderStyle] ?? BORDER_STYLES.rounded;
		this.theme = createZellijModalTheme(config.palette);
	}

	/**
	 * Render one content line with left/right borders.
	 */
	renderContentLine(content: string, width: number, palette: ZellijColorPalette): string {
		const { innerWidth, borderPaint } = this.getBorderPaint(width, palette);
		const vertical = borderPaint(this.borders.vertical);
		const paddedContent = truncateToWidth(content, innerWidth, "", true);
		return `${vertical}${paddedContent}${vertical}`;
	}

	/**
	 * Render complete frame around provided content lines.
	 */
	renderFrame(contentLines: string[], width: number, palette: ZellijColorPalette): ZellijModalRenderOutput {
		const frameWidth = Math.max(4, width);
		const safeContent = contentLines.length > 0 ? contentLines : [""];
		const lines: string[] = [];

		lines.push(this.renderTitleBar(frameWidth, palette));

		const contentStartLine = lines.length;
		for (const line of safeContent) {
			lines.push(this.renderContentLine(line, frameWidth, palette));
		}
		const contentEndLine = lines.length - 1;

		lines.push(this.renderBottomLine(frameWidth, palette));

		return {
			lines: lines.map((line) => this.paintBackground(line, palette)),
			visibleWidth: frameWidth,
			contentWidth: Math.max(1, frameWidth - 2 - this.config.padding * 2),
			contentStartLine,
			contentEndLine,
		};
	}

	private getBorderPaint(width: number, palette: ZellijColorPalette): {
		innerWidth: number;
		borderPaint: (text: string) => string;
	} {
		const innerWidth = Math.max(0, width - 2);
		const borderColor = this.config.focused ? palette.borderFocused : palette.borderUnfocused;
		const borderPaint = (text: string) => this.theme.colorizeForeground(borderColor, text);
		return { innerWidth, borderPaint };
	}

	private renderBorderedRow(
		width: number,
		palette: ZellijColorPalette,
		corners: { left: string; right: string },
		renderInner: (innerWidth: number, borderPaint: (text: string) => string) => string,
	): string {
		const { innerWidth, borderPaint } = this.getBorderPaint(width, palette);
		if (innerWidth === 0) {
			return `${borderPaint(corners.left)}${borderPaint(corners.right)}`;
		}
		return `${borderPaint(corners.left)}${renderInner(innerWidth, borderPaint)}${borderPaint(corners.right)}`;
	}

	private renderTitleBar(width: number, palette: ZellijColorPalette): string {
		return this.renderBorderedRow(width, palette, { left: this.borders.topLeft, right: this.borders.topRight }, (innerWidth, borderPaint) => {
			const segments = this.positionTitleSegments(innerWidth);
			let inner = "";
			let cursor = 0;

			for (const segment of segments) {
				if (segment.start > cursor) {
					inner += borderPaint(this.borders.horizontal.repeat(segment.start - cursor));
				}
				const text = segment.bold ? `\x1b[1m${segment.text}${ANSI_RESET}` : segment.text;
				inner += this.theme.colorizeForeground(segment.color, text);
				cursor = segment.end;
			}

			if (cursor < innerWidth) {
				inner += borderPaint(this.borders.horizontal.repeat(innerWidth - cursor));
			}

			return inner;
		});
	}

	/**
	 * Fill the whole modal row with the modal background color. Theme helpers
	 * reset only foreground/background selectively, but Zellij border/title
	 * helpers use full SGR resets, so re-apply the background after those.
	 */
	private paintBackground(line: string, palette: ZellijColorPalette): string {
		const background = this.theme.resolveColor(palette.bg).bg;
		if (!background) {
			return line;
		}
		const restored = line.replace(/\x1b\[([0-9;]*)m/g, (sequence, params: string) =>
			resetsBackground(params) ? `${sequence}${background}` : sequence,
		);
		return `${background}${restored}\x1b[49m`;
	}

	private renderBottomLine(width: number, palette: ZellijColorPalette): string {
		return this.renderBorderedRow(width, palette, { left: this.borders.bottomLeft, right: this.borders.bottomRight }, (innerWidth, borderPaint) => {
			const helpText = this.resolveHelpText(Math.max(0, innerWidth - 3));
			if (!helpText) {
				return borderPaint(this.borders.horizontal.repeat(innerWidth));
			}

			const helpSlot = this.config.helpUndertitle?.color ?? "dim";
			const safeHelp = truncateToWidth(helpText, Math.max(0, innerWidth - 3), "…");
			const helpWidth = visibleWidth(safeHelp);
			const rightFill = Math.max(0, innerWidth - helpWidth - 3);

			return `${borderPaint(this.borders.horizontal)} ${this.theme.colorizeForeground(helpSlot, safeHelp)} ${borderPaint(this.borders.horizontal.repeat(rightFill))}`;
		});
	}

	private positionTitleSegments(innerWidth: number): PositionedTitleSegment[] {
		if (innerWidth <= 0) {
			return [];
		}

		const left = this.resolveTitleSegment(this.config.titleBar.left, "left");
		const center = this.resolveTitleSegment(this.config.titleBar.center, "center");
		const right = this.resolveTitleSegment(this.config.titleBar.right, "right");

		const placements: PositionedTitleSegment[] = [];

		if (left) {
			const leftText = this.fitTextToWidth(left.text, Math.min(innerWidth, left.maxWidth ?? innerWidth), left.truncate);
			if (leftText) {
				placements.push({
					start: 0,
					end: Math.min(innerWidth, visibleWidth(leftText)),
					text: leftText,
					color: left.color,
					bold: left.bold ?? false,
				});
			}
		}

		if (right) {
			const reservedLeft = placements[0]?.end ?? 0;
			const available = Math.max(0, innerWidth - reservedLeft);
			const rightText = this.fitTextToWidth(right.text, Math.min(available, right.maxWidth ?? available), right.truncate);
			const rightWidth = visibleWidth(rightText);
			if (rightText && rightWidth > 0) {
				placements.push({
					start: innerWidth - rightWidth,
					end: innerWidth,
					text: rightText,
					color: right.color,
					bold: right.bold ?? false,
				});
			}
		}

		if (center) {
			const leftLimit = placements.find((placement) => placement.start === 0)?.end ?? 0;
			const rightStart = placements.find((placement) => placement.end === innerWidth)?.start ?? innerWidth;
			const freeWidth = Math.max(0, rightStart - leftLimit);
			if (freeWidth > 0) {
				const centerText = this.fitTextToWidth(center.text, Math.min(freeWidth, center.maxWidth ?? freeWidth), center.truncate);
				const centerWidth = visibleWidth(centerText);
				if (centerText && centerWidth > 0) {
					const centeredStart = Math.floor((innerWidth - centerWidth) / 2);
					const start = clampInt(centeredStart, leftLimit, Math.max(leftLimit, rightStart - centerWidth));
					placements.push({
						start,
						end: start + centerWidth,
						text: centerText,
						color: center.color,
						bold: center.bold ?? false,
					});
				}
			}
		}

		return placements.sort((a, b) => a.start - b.start);
	}

	private resolveTitleSegment(
		segment: TitleSegment | string | undefined,
		position: "left" | "center" | "right",
	): (TitleSegment & { text: string }) | null {
		if (!segment) {
			return null;
		}

		if (typeof segment === "string") {
			const color: keyof ZellijColorPalette = position === "left" ? "accent" : position === "center" ? "muted" : "dim";
			return {
				text: ` ${segment} `,
				color,
				bold: position === "left",
				truncate: "end",
				maxWidth: 0,
			};
		}

		const clean = segment.text.trim();
		if (!clean) {
			return null;
		}

		return {
			...segment,
			text: ` ${clean} `,
			truncate: segment.truncate ?? "end",
			bold: segment.bold ?? false,
		};
	}

	private fitTextToWidth(text: string, maxWidth: number, mode: TitleSegment["truncate"]): string {
		if (maxWidth <= 0) {
			return "";
		}
		if (visibleWidth(text) <= maxWidth) {
			return text;
		}

		return truncateToWidth(text, maxWidth, mode === "none" ? "" : "…");
	}

	private resolveHelpText(maxWidth: number): string | null {
		const config = this.config.helpUndertitle;
		if (!config || maxWidth <= 0) {
			return null;
		}

		if (config.variants && config.variants.length > 0) {
			for (const variant of config.variants) {
				if (visibleWidth(variant) <= maxWidth) {
					return variant;
				}
			}
			return config.variants[config.variants.length - 1] ?? null;
		}

		if (config.keyHints && config.keyHints.length > 0) {
			const separator = config.keyHintSeparator ?? " • ";
			return config.keyHints
				.map((hint) => `${hint.key} ${hint.description}`)
				.join(separator);
		}

		return config.text?.trim() ? config.text : null;
	}
}

/**
 * Main Zellij-style modal component wrapper.
 */
export class ZellijModal implements ZellijModalContentRenderer {
	config: ZellijModalConfig;
	content: ZellijModalContentRenderer;

	private frame: ZellijModalFrame;
	private palette: ZellijColorPalette;

	constructor(content: ZellijModalContentRenderer, config: ZellijModalConfigPartial = {}, theme?: Theme) {
		if (!content || typeof content.render !== "function") {
			throw new Error("ZellijModal requires a valid content renderer.");
		}

		this.config = this.buildConfig(config);
		this.palette = theme ? themeToZellijPalette(theme) : this.config.palette;
		this.content = content;
		this.frame = new ZellijModalFrame({ ...this.config, palette: this.palette });
	}

	/**
	 * Render content only (without frame).
	 */
	render(width: number): string[] {
		const contentWidth = Math.max(1, width - 2 - this.config.padding * 2);
		const paddedWidth = contentWidth + this.config.padding * 2;
		const sidePadding = " ".repeat(this.config.padding);
		const lines: string[] = [];

		try {
			const rawLines = this.content.render(contentWidth);
			const normalized = rawLines.length > 0 ? rawLines : [""];

			pushPaddingLines(lines, this.config.padding, paddedWidth);

			for (const line of normalized) {
				const fitted = truncateToWidth(line, contentWidth, "", true);
				lines.push(`${sidePadding}${fitted}${sidePadding}`);
			}

			pushPaddingLines(lines, this.config.padding, paddedWidth);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const safe = truncateToWidth(` Render error: ${message} `, paddedWidth, "…", true);
			lines.push(safe);
		}

		return lines;
	}

	/**
	 * Render complete frame + content.
	 */
	renderModal(width: number): ZellijModalRenderOutput {
		const frameWidth = this.resolveModalWidth(width);
		const contentLines = this.render(frameWidth);
		return this.frame.renderFrame(contentLines, frameWidth, this.palette);
	}

	/**
	 * Invalidate child renderer state.
	 */
	invalidate(): void {
		this.content.invalidate();
	}

	/**
	 * Delegate input to child renderer.
	 */
	handleInput(data: string): void {
		this.content.handleInput?.(data);
	}

	/**
	 * Get overlay options for `ctx.ui.custom()`.
	 */
	getOverlayOptions(): { overlay: true; overlayOptions: ZellijModalConfig["overlay"] } {
		return {
			overlay: true,
			overlayOptions: this.config.overlay,
		};
	}

	/**
	 * Dispose modal resources.
	 */
	dispose(): void {
		this.content.invalidate();
	}

	private buildConfig(partial: ZellijModalConfigPartial): ZellijModalConfig {
		const borderStyle = partial.borderStyle && BORDER_STYLES[partial.borderStyle] ? partial.borderStyle : "rounded";
		const padding = Math.max(0, partial.padding ?? 1);
		const minWidth = Math.max(4, partial.minWidth ?? 40);
		const maxWidth = Math.max(0, partial.maxWidth ?? 0);
		const helpUndertitle = normalizeHelpUndertitle(partial.helpText, partial.helpUndertitle);

		return {
			borderStyle,
			palette: partial.palette ?? DEFAULT_ZELLIJ_PALETTE,
			focused: partial.focused ?? true,
			padding,
			titleBar: partial.titleBar ?? { left: partial.title ?? "Modal" },
			helpUndertitle,
			minWidth,
			maxWidth,
			overlay: {
				anchor: partial.overlay?.anchor ?? "center",
				width: partial.overlay?.width ?? 70,
				maxHeight: partial.overlay?.maxHeight ?? "80%",
				margin: Math.max(0, partial.overlay?.margin ?? 1),
			},
		};
	}

	private resolveModalWidth(availableWidth: number): number {
		const boundedMax = this.config.maxWidth > 0 ? Math.min(availableWidth, this.config.maxWidth) : availableWidth;
		return Math.max(4, boundedMax);
	}
}

function pushPaddingLines(lines: string[], count: number, paddedWidth: number): void {
	for (let i = 0; i < count; i++) {
		lines.push(" ".repeat(paddedWidth));
	}
}

function normalizeHelpUndertitle(
	helpText: ZellijModalConfigPartial["helpText"],
	helpUndertitle: HelpUndertitleConfig | undefined,
): HelpUndertitleConfig | undefined {
	if (helpUndertitle) {
		return helpUndertitle;
	}
	if (typeof helpText === "string") {
		return helpText ? { text: helpText } : undefined;
	}
	return helpText;
}

/** True when an SGR parameter list clears the background (a full reset or 49), skipping extended colour arguments. */
export function resetsBackground(params: string): boolean {
	if (params === "") return true;
	const codes = params.split(";").map((part) => (part === "" ? 0 : Number.parseInt(part, 10)));
	for (let i = 0; i < codes.length; i += 1) {
		const code = codes[i];
		if (code === 38 || code === 48 || code === 58) {
			i += codes[i + 1] === 5 ? 2 : codes[i + 1] === 2 ? 4 : 1;
			continue;
		}
		if (code === 0 || code === 49) return true;
	}
	return false;
}

/** Approximate perceived brightness (0–1) of a palette colour. */
function colorLuminance(color: PaletteColor): number {
	let rgb: [number, number, number];
	if (color.type === "rgb") {
		rgb = [color.r, color.g, color.b];
	} else {
		const code = color.type === "8bit" ? color.code : NAMED_COLOR_CODES[color.name.toLowerCase()] ?? 255;
		rgb = xterm256ToRgb(code);
	}
	const [r, g, b] = rgb;
	return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

function xterm256ToRgb(code: number): [number, number, number] {
	const basic: [number, number, number][] = [
		[0, 0, 0], [128, 0, 0], [0, 128, 0], [128, 128, 0], [0, 0, 128], [128, 0, 128], [0, 128, 128], [192, 192, 192],
		[128, 128, 128], [255, 0, 0], [0, 255, 0], [255, 255, 0], [0, 0, 255], [255, 0, 255], [0, 255, 255], [255, 255, 255],
	];
	if (code < 16) return basic[clampInt(code, 0, 15)];
	if (code >= 232) {
		const level = 8 + (code - 232) * 10;
		return [level, level, level];
	}
	const index = code - 16;
	const step = (value: number) => (value === 0 ? 0 : 55 + value * 40);
	return [step(Math.floor(index / 36)), step(Math.floor(index / 6) % 6), step(index % 6)];
}

function parseAnsiForegroundColor(ansi: string): PaletteColor | null {
	const rgbMatch = /\x1b\[38;2;(\d+);(\d+);(\d+)m/.exec(ansi);
	if (rgbMatch) {
		const [, r, g, b] = rgbMatch;
		return {
			type: "rgb",
			r: clampInt(Number.parseInt(r ?? "0", 10), 0, 255),
			g: clampInt(Number.parseInt(g ?? "0", 10), 0, 255),
			b: clampInt(Number.parseInt(b ?? "0", 10), 0, 255),
		};
	}

	const bit8Match = /\x1b\[38;5;(\d+)m/.exec(ansi);
	if (bit8Match) {
		const [, code] = bit8Match;
		return {
			type: "8bit",
			code: clampInt(Number.parseInt(code ?? "255", 10), 0, 255),
		};
	}

	return null;
}

function clampInt(value: number, min: number, max: number): number {
	if (!Number.isFinite(value)) {
		return min;
	}
	return Math.min(max, Math.max(min, Math.round(value)));
}
