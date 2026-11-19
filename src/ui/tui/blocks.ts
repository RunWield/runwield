import {
    Container,
    Image,
    Input,
    Key,
    matchesKey,
    SelectList,
    Spacer,
    Text,
    truncateToWidth,
    visibleWidth,
} from "@earendil-works/pi-tui";
import type { ThemeBg, ThemeColor } from "@earendil-works/pi-coding-agent";
import type { SelectItem, SelectListLayoutOptions, SelectListTheme } from "@earendil-works/pi-tui";
import { getMarkdownTheme, getSelectListTheme, imageTheme, theme } from "../theme/theme.ts";
import { buildActiveConversationStatusMessage } from "../../shared/session/session-user-messages.ts";
import {
    validationProgressCheckSummary,
    validationProgressHeading,
} from "../../shared/workflow/validation-progress-presentation.ts";
import { MermaidMarkdown } from "./mermaid-markdown.ts";
import stripAnsi from "strip-ansi";
import type { SessionHelpItem, SessionHelpPayload } from "../../shared/session/session-help.ts";
import type { RuntimeValidationProgress } from "../../shared/session/session-runtime-events.ts";
import type { DocumentLinkHost } from "../review/document-link-host.ts";
import type { ManagedSyncStatus, RunningTask, UiAPI } from "./api.ts";

export interface ToolDisplayImage {
    base64: string;
    mimeType: string;
}

/** Per-report markdown renderer slot. */
export interface ReportRendererSlot {
    text: string | null;
    renderer: MermaidMarkdown | null;
    width: number;
    lines: string[] | null;
}

export interface EngineerReport {
    agentName: string;
    markdown: string;
    completedOrder: number;
}

export interface ReviewerReport extends EngineerReport {
    approved: boolean;
}

export interface ValidationHandoffState {
    progress: RuntimeValidationProgress;
    engineer?: EngineerReport | null;
    reviewer?: ReviewerReport | null;
}

type ReportRendererSlots = Record<"engineer" | "reviewer", ReportRendererSlot>;

interface StyledBlockContent {
    render(width: number): string[];
    invalidate?(): void;
}

interface ThinkingBlockOptions {
    hidden?: boolean;
}

interface BlockRenderCache {
    width: number;
    lines: string[];
}

type SystemMessageStyle = NonNullable<Parameters<UiAPI["appendSystemMessage"]>[3]>;

const TOOL_OUTPUT_LINE_LIMIT = 500;

// ─── Utilities ───────────────────────────────────────────────────────────────

/**
 * Format a system line from explicit text/header/style parts (no parsing).
 * `header` (when provided) is rendered bold in `style.headingColor` (default
 * `accent` / `error` based on isError). The body text uses normal text color
 * unless `style.bodyColor` overrides it.
 */
function formatSystemLine(text: string, isError: boolean, header = "", style?: SystemMessageStyle) {
    // The existing UI API accepts string tokens, which the upstream theme resolves.
    const baseColor = (style?.bodyColor || (isError ? "error" : "text")) as ThemeColor;

    if (!header) {
        return theme.fg(baseColor, text);
    }

    const headerColor = (style?.headingColor || (isError ? "error" : "accent")) as ThemeColor;

    const renderedHeader = theme.fg(headerColor, theme.bold(header));

    if (!text) return renderedHeader;

    return `${renderedHeader} ${theme.fg(baseColor, text)}`;
}

// ─── Layout Primitives ───────────────────────────────────────────────────────

/**
 * Apply a background color to a line, handling embedded \x1b[0m (full reset)
 * codes that would otherwise kill the background mid-line.
 *
 * Instead of chalk.bgHex()(line) which can't handle raw resets, this manually
 * wraps the line with the bg open/close codes and re-applies the bg after any
 * embedded full reset.
 */
function applyBg(bgCode: string, line: string) {
    if (line.includes("\x1b[0m")) {
        // deno-lint-ignore no-control-regex
        return bgCode + line.replace(/\x1b\[0m/g, "\x1b[0m" + bgCode) + "\x1b[49m";
    }
    return bgCode + line + "\x1b[49m";
}

/**
 * Get the raw ANSI background open code for a ThemeBg token.
 * Uses the upstream theme.bg() to render a single space, then extracts
 * the ANSI background open code from the result.
 *
 * Not cached: theme can swap at runtime, and the regex extraction is cheap
 * (single small string). Caching would require a clear hook on every swap.
 */
function getBgCode(bgTokenName: ThemeBg) {
    const rendered = theme.bg(bgTokenName, " ");
    // deno-lint-ignore no-control-regex
    const match = rendered.match(/^(\x1b\[(?:48;2;\d+;\d+;\d+|48;5;\d+)m)/);
    return match ? match[1] : "";
}

/**
 * Convert tool labels/arguments to one physical terminal line.
 * Raw newlines in a header are especially dangerous: the TUI receives one
 * rendered array entry, but the terminal paints multiple lines and escapes the
 * block background/padding.
 */
function normalizeToolHeaderText(text: string) {
    return (
        stripAnsi(text)
            // deno-lint-ignore no-control-regex
            .replace(/[\x00-\x1f\x7f]+/g, " ")
            .trim()
    );
}

function stripAnsiPreservingOsc8(text: string) {
    const links: string[] = [];
    // deno-lint-ignore no-control-regex
    const protectedText = text.replace(/\x1b\]8;;[^\x07]*(?:\x07|\x1b\\).*?\x1b\]8;;(?:\x07|\x1b\\)/g, (link) => {
        const marker = `\u0000RUNWIELD_OSC8_${links.length}\u0000`;
        links.push(link);
        return marker;
    });
    let stripped = stripAnsi(protectedText);
    links.forEach((link, index) => {
        stripped = stripped.replace(`\u0000RUNWIELD_OSC8_${index}\u0000`, link);
    });
    return stripped;
}

/**
 * Wrap plain text to terminal-width lines. Existing newlines are handled by the
 * caller; this preserves words where possible and hard-wraps words longer than
 * the viewport.
 */
function wrapPlainLine(text: string, width: number) {
    if (width <= 0) return [""];
    if (!text) return [""];

    const lines: string[] = [];
    let line = "";

    for (const word of text.split(/\s+/)) {
        if (!word) continue;

        if (!line) {
            line = word;
        } else if (visibleWidth(`${line} ${word}`) <= width) {
            line = `${line} ${word}`;
        } else {
            lines.push(line);
            line = word;
        }

        while (visibleWidth(line) > width) {
            lines.push(truncateToWidth(line, width));
            line = line.slice(stripAnsi(truncateToWidth(line, width)).length);
        }
    }

    if (line || lines.length === 0) lines.push(line);
    return lines;
}

const THINKING_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function getThinkingFrame(frameIndex: number) {
    return THINKING_FRAMES[frameIndex % THINKING_FRAMES.length];
}

/**
 * Normalize presentation-only markdown that some providers include in their
 * thinking deltas. Thinking blocks intentionally render as muted plain text,
 * so CommonMark comments should be invisible and simple emphasis wrappers
 * should not leak as literal punctuation.
 */
function normalizeThinkingText(text: string) {
    return text
        .replace(/<!--[^]*?-->/g, "")
        .split(/\r?\n/)
        .map((line) => line.replace(/^(\s*)(\*\*\*|___|\*\*|__|\*|_)(\S[\s\S]*?\S|\S)\2(\s*)$/u, "$1$3$4"))
        .join("\n")
        .replace(/\n{3,}/g, "\n\n");
}

/**
 * A block that applies a background color, horizontal/vertical padding,
 * and stretches each line to the full available width.
 *
 * Handles embedded ANSI full-reset codes (\x1b[0m) from child components
 * (e.g. pi-tui's truncateToWidth) by re-applying the bg after each reset.
 */
export class StyledBlock {
    declare bgToken: ThemeBg;
    declare paddingX: number;
    declare paddingY: number;
    declare child: StyledBlockContent | null | undefined;

    /**
     * @param bgToken - Theme background token (e.g. "userMessageBg", "selectedBg")
     * @param paddingX - Horizontal padding on each side
     * @param paddingY - Empty lines above and below the content
     */
    constructor(bgToken: ThemeBg, paddingX: number, paddingY: number, child: StyledBlockContent | null | undefined) {
        this.bgToken = bgToken;
        this.paddingX = paddingX;
        this.paddingY = paddingY;
        this.child = child;
    }

    invalidate() {
        if (this.child && typeof this.child.invalidate === "function") {
            this.child.invalidate();
        }
    }

    render(w: number) {
        if (!this.child) return [];

        const innerW = Math.max(0, w - this.paddingX * 2);
        const innerLines = this.child.render(innerW);

        const padX = " ".repeat(this.paddingX);
        const emptyLine = " ".repeat(w);

        const lines = innerLines.map((line) => {
            const vw = visibleWidth(line);
            const clamped = vw > innerW ? truncateToWidth(line, innerW) : line;
            const clampedW = vw > innerW ? visibleWidth(clamped) : vw;
            const rightPad = " ".repeat(Math.max(0, w - this.paddingX - clampedW));
            return padX + clamped + rightPad;
        });

        const padY = Array.from({ length: this.paddingY }, () => emptyLine);

        const bgCode = getBgCode(this.bgToken);
        const allLines = [...padY, ...lines, ...padY];
        return allLines.map((line) => applyBg(bgCode, line));
    }
}

// ─── Message Blocks ──────────────────────────────────────────────────────────

/**
 * The User Prompt Block.
 */
export class UserPromptBlock {
    declare content: Container;
    declare block: StyledBlock;

    constructor(text: string) {
        this.content = new Container();
        this.content.addChild(new Text(theme.fg("text", text), 0, 0));
        this.block = new StyledBlock("userMessageBg", 2, 1, this.content);
    }

    invalidate() {
        this.block.invalidate();
    }

    render(w: number) {
        return this.block.render(w);
    }
}

/**
 * Thinking Block.
 * Muted, streaming display of model reasoning. No background — visually
 * distinct from the vibrant AgentMessageBlock and from styled tool/system
 * blocks, so a thinking pass can sit cleanly between agent text and a tool
 * execution without colliding with their backgrounds.
 */
export class ThinkingBlock {
    declare hidden: boolean;
    declare currentText: string;
    declare frameIndex: number;
    declare ended: boolean;
    declare renderCache: BlockRenderCache | null;

    constructor(options: ThinkingBlockOptions = {}) {
        this.hidden = options.hidden ?? false;
        this.currentText = "";
        this.frameIndex = 0;
        this.ended = false;

        this.renderCache = null;
    }

    appendText(delta: string) {
        this.currentText += delta;
        this.frameIndex++;
        this.invalidate();
    }

    end() {
        this.ended = true;
        this.invalidate();
    }

    invalidate() {
        this.renderCache = null;
    }

    render(w: number) {
        if (this.renderCache !== null && this.renderCache.width === w) return this.renderCache.lines;
        const lines = this.renderLines(w);
        this.renderCache = { width: w, lines };
        return lines;
    }

    renderLines(w: number) {
        const rawBody = this.hidden ? "hidden" : normalizeThinkingText(this.currentText).trim();
        const bodyLines = rawBody ? rawBody.split(/\r?\n/).flatMap((line) => wrapPlainLine(line, w)) : [];
        const renderedLines = bodyLines.map((line) => theme.fg("thinkingText", line));
        return renderedLines.map((line) => {
            const clamped = visibleWidth(line) > w ? truncateToWidth(line, w) : line;
            return clamped + " ".repeat(Math.max(0, w - visibleWidth(clamped)));
        });
    }
}

/**
 * Agent Message Block (Markdown).
 * Renders without a background, matching the upstream Pi style.
 */
export class AgentMessageBlock {
    declare container: Container;
    declare currentText: string;
    declare markdown: MermaidMarkdown;

    constructor(agentName: string, documentLinks: DocumentLinkHost | null) {
        this.container = new Container();

        if (agentName) {
            this.container.addChild(new Text(theme.fg("success", theme.bold(`${agentName}:`)), 0, 0));
        }

        this.currentText = "";
        this.markdown = new MermaidMarkdown("", 0, 0, getMarkdownTheme());
        this.markdown.setDocumentLinks(documentLinks);
        this.container.addChild(this.markdown);
        this.container.addChild(new Spacer(1));
    }

    appendText(delta: string) {
        this.currentText += delta;
        this.markdown.setText(this.currentText);
        this.invalidate();
    }

    invalidate() {
        this.container.invalidate();
    }

    render(w: number) {
        return this.container.render(w);
    }
}

/**
 * System Message Block.
 */
export class ReviewResultBlock {
    declare container: Container;
    declare agentName: string;
    declare markdownText: string;
    declare approved: boolean;
    declare bgToken: ThemeBg;
    declare markdown: MermaidMarkdown;
    declare block: StyledBlock;

    constructor(agentName: string, markdownText: string, approved: boolean) {
        this.container = new Container();
        this.agentName = agentName || "Reviewer";
        this.markdownText = markdownText || "";
        this.approved = approved;
        this.bgToken = approved ? "toolSuccessBg" : "toolErrorBg";

        this.container.addChild(new Text(theme.fg("success", theme.bold(`${this.agentName}:`)), 0, 0));
        this.markdown = new MermaidMarkdown(this.markdownText, 0, 0, getMarkdownTheme());
        this.container.addChild(this.markdown);
        this.block = new StyledBlock(this.bgToken, 2, 1, this.container);
    }

    invalidate() {
        this.markdown.setText(this.markdownText);
        this.block.invalidate();
    }

    render(w: number) {
        return this.block.render(w);
    }
}

/**
 * Full-width pinned validation handoff panel. It renders a complete structured
 * validation snapshot plus the latest semantic reports mirrored from history.
 */
export class ValidationHandoffBlock {
    declare state: ValidationHandoffState;
    declare block: StyledBlock;
    declare reportRenderers: ReportRendererSlots;

    constructor(state: ValidationHandoffState) {
        this.state = state;
        this.block = new StyledBlock("customMessageBg", 2, 1, {
            render: (w) => this.renderContent(w),
            invalidate: () => {},
        });
        // Keep one renderer per report so the mermaid cache stays warm between renders.

        this.reportRenderers = {
            engineer: { text: null, renderer: null, width: 0, lines: null },
            reviewer: { text: null, renderer: null, width: 0, lines: null },
        };
    }

    setState(state: ValidationHandoffState) {
        this.state = state;
        this.invalidate();
    }

    invalidate() {
        // Wiping the text here forces the next render to redraw with the
        // current theme, so a theme swap can't leave stale colors behind.
        this.reportRenderers.engineer.text = null;
        this.reportRenderers.reviewer.text = null;
        this.block.invalidate();
    }

    formatHeading(progress: RuntimeValidationProgress) {
        const heading = validationProgressHeading(progress);
        const checks = progress.checks
            ? validationProgressCheckSummary(progress)
                  .split(", ")
                  .filter((check) => check !== heading)
                  .join(", ")
            : "";
        return checks ? `${heading} • ${checks}` : heading;
    }

    appendMarkdownSection(
        lines: string[],
        title: string,
        markdownText: string,
        width: number,
        slot: keyof ReportRendererSlots,
    ) {
        lines.push("");
        lines.push(theme.fg("accent", theme.bold(title)));
        const body = markdownText || "(no report text)";
        const cached = this.reportRenderers[slot];
        let renderer = cached.renderer;
        if (renderer === null) {
            renderer = new MermaidMarkdown(body, 0, 0, getMarkdownTheme());
            cached.renderer = renderer;
        } else if (cached.text !== body) {
            renderer.setText(body);
        }
        if (cached.text !== body || cached.width !== width) {
            cached.text = body;
            cached.width = width;
            cached.lines = renderer.render(width);
        }
        lines.push(...(cached.lines ?? []));
    }

    renderContent(w: number) {
        const width = Math.max(1, w);
        const progress = this.state.progress;
        const headingColor =
            progress.outcome === "failed" ? "error" : progress.outcome === "verified" ? "success" : "accent";

        const lines = [theme.fg(headingColor, theme.bold(this.formatHeading(progress)))];
        if (progress.message) lines.push(theme.fg("muted", progress.message));
        const engineer = this.state.engineer || null;
        const reviewer = this.state.reviewer || null;
        if (engineer) {
            this.appendMarkdownSection(
                lines,
                `${engineer.agentName || "Engineer"} latest completion report`,
                engineer.markdown,
                width,
                "engineer",
            );
        }
        if (reviewer) {
            const stale =
                engineer && reviewer.completedOrder < engineer.completedOrder && !reviewer.approved
                    ? " (feedback addressed; rechecking)"
                    : "";
            const verdict = reviewer.approved ? "approved" : "rejected";
            this.appendMarkdownSection(
                lines,
                `${reviewer.agentName || "Reviewer"} latest AI review — ${verdict}${stale}`,
                reviewer.markdown || (reviewer.approved ? "Approved." : "Rejected without detailed feedback."),
                width,
                "reviewer",
            );
        }
        return lines;
    }

    render(w: number) {
        return this.block.render(w);
    }
}

export class SystemMessageBlock {
    declare container: Container;
    declare isError: boolean;
    declare style: SystemMessageStyle;
    declare block: StyledBlock;

    constructor(text: string, isError: boolean = false, header: string = "", style: SystemMessageStyle = {}) {
        this.container = new Container();
        this.isError = isError;
        this.style = style;
        this.container.addChild(new Text(formatSystemLine(text, isError, header, style), 0, 0));
        this.block = new StyledBlock("customMessageBg", 2, 1, this.container);
    }

    appendText(text: string, header: string = "", style?: SystemMessageStyle) {
        this.container.addChild(new Text(formatSystemLine(text, this.isError, header, style || this.style), 0, 0));
        this.invalidate();
    }

    invalidate() {
        this.block.invalidate();
    }

    render(w: number) {
        return this.block.render(w);
    }
}

export class ManagedSyncStatusBlock {
    declare state: ManagedSyncStatus;

    constructor(state: ManagedSyncStatus) {
        this.state = { ...state };
    }

    setState(state: ManagedSyncStatus) {
        this.state = { ...state };
    }

    invalidate() {}

    render(w: number) {
        const state = this.state;
        if (state.status === "active_elsewhere") {
            return [truncateToWidth(theme.fg("dim", buildActiveConversationStatusMessage(state.owningSurfaceKind)), w)];
        }
        const surface = state.owningSurfaceKind ? ` (${state.owningSurfaceKind} active)` : "";
        const generations =
            state.latestGeneration === null
                ? "no committed generation"
                : `gen ${state.localGeneration ?? "?"}/${state.latestGeneration}`;
        const label =
            state.status === "current"
                ? "Session current"
                : state.status === "syncing"
                  ? "Syncing committed updates"
                  : state.status === "blocked"
                    ? "Managed submission blocked"
                    : "Sync degraded — refresh required";
        const message = state.message ? ` — ${state.message}` : "";
        return [
            truncateToWidth(
                theme.fg(
                    state.status === "degraded" ? "warning" : "dim",
                    `${label}${surface} · ${generations}${message}`,
                ),
                w,
            ),
        ];
    }
}

export class KeyboardHelpBlock {
    declare help: SessionHelpPayload;
    declare content: Required<StyledBlockContent>;
    declare block: StyledBlock;

    constructor(help: SessionHelpPayload) {
        this.help = {
            title: help.title,
            items: help.items.map((item) => ({ ...item })),
        };
        this.content = {
            render: (w: number) => this.renderContent(w),
            invalidate: () => {},
        };
        this.block = new StyledBlock("customMessageBg", 2, 1, this.content);
    }

    invalidate() {
        this.block.invalidate();
    }

    renderItem(item: SessionHelpItem, keyWidth: number, width: number) {
        const key = theme.fg("accent", item.key.padEnd(keyWidth));
        const prefixWidth = keyWidth + 1;
        const descriptionWidth = Math.max(1, width - prefixWidth);
        const descriptionLines = wrapPlainLine(item.description, descriptionWidth);
        return descriptionLines.map((line, index) => {
            const currentKey = index === 0 ? key : " ".repeat(keyWidth);
            return `${currentKey} ${theme.fg("muted", line)}`;
        });
    }

    renderColumn(items: SessionHelpItem[], keyWidth: number, columnWidth: number) {
        return items.flatMap((item) => this.renderItem(item, keyWidth, columnWidth));
    }

    renderContent(w: number) {
        const width = Math.max(1, w);
        const lines = [theme.fg("accent", theme.bold(this.help.title))];
        const maxKeyWidth = Math.max(...this.help.items.map((item) => visibleWidth(item.key)), 1);
        if (width >= 86 && this.help.items.length >= 6) {
            const gap = 4;
            const columnWidth = Math.floor((width - gap) / 2);
            const split = Math.ceil(this.help.items.length / 2);
            const left = this.renderColumn(this.help.items.slice(0, split), maxKeyWidth, columnWidth);
            const right = this.renderColumn(this.help.items.slice(split), maxKeyWidth, columnWidth);
            const rows = Math.max(left.length, right.length);
            for (let index = 0; index < rows; index++) {
                const leftLine = left[index] || "";
                const rightLine = right[index] || "";
                const pad = " ".repeat(Math.max(gap, columnWidth - visibleWidth(leftLine) + gap));
                lines.push(rightLine ? `${leftLine}${pad}${rightLine}` : leftLine);
            }
            return lines;
        }
        lines.push(...this.renderColumn(this.help.items, maxKeyWidth, width));
        return lines;
    }

    render(w: number) {
        return this.block.render(w);
    }
}

// ─── Tool Execution Block ────────────────────────────────────────────────────

/**
 * The Tool Execution Block.
 * Contains a header (tool name + args), a body for streaming output, and a footer (duration + expand hint).
 */
export class ToolExecutionBlock {
    declare previewLineLimit: number;
    declare expanded: boolean;
    declare durationStr: string;
    declare bodyText: string;
    declare displayImages: ToolDisplayImage[];
    declare isError: boolean;
    declare ended: boolean;
    declare showElapsedTime: boolean;
    declare startTime: number;
    declare bgToken: ThemeBg;
    declare toolName: string;
    declare headerText: string;
    declare bodyTextComponent: MermaidMarkdown | Text;
    declare outputLineCount: number;
    declare renderCache: BlockRenderCache | null;

    constructor(toolName: string, title: string) {
        this.previewLineLimit = 6;
        this.expanded = toolName === "pair_checkpoint";
        this.durationStr = "";
        this.bodyText = "";

        this.displayImages = [];
        this.isError = false;
        this.ended = false;
        this.showElapsedTime = false;
        this.startTime = Date.now();
        this.bgToken = "toolPendingBg";

        this.toolName = normalizeToolHeaderText(toolName);
        this.headerText = normalizeToolHeaderText(title);

        // Body text component (rendered inside the block)
        this.bodyTextComponent =
            this.toolName === "pair_checkpoint"
                ? new MermaidMarkdown("", 0, 0, getMarkdownTheme())
                : new Text("", 0, 0);

        this.outputLineCount = 0;

        this.renderCache = null;
    }

    getOutputLines() {
        if (!this.bodyText) return [];
        return this.bodyText.replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n");
    }

    private updateBodyText() {
        // Every way of changing the output funnels through here, so this one
        // clear keeps the cache honest.
        this.renderCache = null;
        const lines = this.getOutputLines();
        this.outputLineCount = lines.length;
        let shown = lines;
        if (!this.expanded && lines.length > this.previewLineLimit) {
            shown = lines.slice(0, this.previewLineLimit);
        } else if (this.expanded && lines.length > TOOL_OUTPUT_LINE_LIMIT) {
            const headLineCount = Math.ceil((TOOL_OUTPUT_LINE_LIMIT - 1) / 2);
            const tailLineCount = TOOL_OUTPUT_LINE_LIMIT - headLineCount - 1;
            const omittedLineCount = lines.length - headLineCount - tailLineCount;
            shown = [
                ...lines.slice(0, headLineCount),
                `… ${omittedLineCount} lines omitted …`,
                ...lines.slice(-tailLineCount),
            ];
        }
        if (this.bodyTextComponent instanceof MermaidMarkdown) {
            this.bodyTextComponent.setText(shown.join("\n"));
            return;
        }
        const renderedText = shown
            .map((line) => {
                if (!this.isError && (line.startsWith("Review Plan:") || line.startsWith("Review Code:"))) {
                    return theme.fg("success", theme.bold(line));
                }
                return this.isError ? theme.fg("text", line) : theme.fg("toolOutput", line);
            })
            .join("\n");
        this.bodyTextComponent.setText(renderedText);
    }

    setExpanded(expanded: boolean) {
        this.expanded = expanded;
        this.updateBodyText();
    }

    setOutput(text: string) {
        // Strip ANSI codes from tool output to prevent embedded resets (\x1b[0m)
        // from breaking the block's background coloring. Preserve OSC 8 links so
        // live review URLs stay clickable.
        this.bodyText = stripAnsiPreservingOsc8(text);
        this.updateBodyText();
    }

    appendOutput(text: string) {
        // Strip ANSI codes from tool output to prevent embedded resets (\x1b[0m)
        // from breaking the block's background coloring. Preserve OSC 8 links so
        // live review URLs stay clickable.
        this.bodyText += stripAnsiPreservingOsc8(text);
        this.updateBodyText();
    }

    appendDisplayImage(base64: string, mimeType: string) {
        this.displayImages.push({ base64, mimeType });
        this.renderCache = null;
    }

    enableElapsedTime() {
        if (!this.ended) {
            this.showElapsedTime = true;
        }
    }

    formatElapsedTime() {
        return `Elapsed time: ${((Date.now() - this.startTime) / 1000).toFixed(1)}s`;
    }

    endExecution(isError: boolean, durationMs: number | null) {
        this.isError = isError;
        this.ended = true;
        this.showElapsedTime = false;
        if (isError) {
            this.bgToken = "toolErrorBg";
        } else {
            this.bgToken = "toolSuccessBg";
        }
        this.durationStr = durationMs === null ? "" : `Took ${(durationMs / 1000).toFixed(1)}s`;
        this.updateBodyText();
    }

    invalidate() {
        this.renderCache = null;
    }

    render(w: number) {
        // While a tool is running, its elapsed clock ticks in real time, so
        // those lines can never come from the cache.
        const live = this.showElapsedTime && !this.ended;
        if (!live && this.renderCache !== null && this.renderCache.width === w) return this.renderCache.lines;
        const lines = this.renderLines(w);
        if (!live) this.renderCache = { width: w, lines };
        return lines;
    }

    renderLines(w: number) {
        const bg = this.bgToken;
        const paddingX = 2;
        const innerW = Math.max(0, w - paddingX * 2);

        const allLines = [];

        // ── Header: bold tool name, with vertical padding ──
        const rawHeaderLine = theme.fg("text", theme.bold(this.headerText));
        const headerLine =
            visibleWidth(rawHeaderLine) > innerW ? truncateToWidth(rawHeaderLine, innerW) : rawHeaderLine;
        const headerBlock = new StyledBlock(bg, paddingX, 1, { render: () => [headerLine], invalidate: () => {} });
        allLines.push(...headerBlock.render(w));

        // ── Body: tool output (no vertical padding) ──
        if (this.bodyText) {
            const bgCode = getBgCode(bg);
            const bodyLines = this.bodyTextComponent.render(innerW);
            const padX = " ".repeat(paddingX);
            for (const line of bodyLines) {
                const vw = visibleWidth(line);
                const clamped = vw > innerW ? truncateToWidth(line, innerW) : line;
                const clampedW = vw > innerW ? visibleWidth(clamped) : vw;
                const rightPad = " ".repeat(Math.max(0, w - paddingX - clampedW));
                allLines.push(applyBg(bgCode, padX + clamped + rightPad));
            }
        }

        if (this.expanded) {
            for (const image of this.displayImages) {
                const imageBlock = new Image(image.base64, image.mimeType, imageTheme, {
                    maxWidthCells: 60,
                    maxHeightCells: 20,
                });
                allLines.push(...imageBlock.render(innerW));
            }
        }

        // ── Footer: duration + expand/collapse hint, with vertical padding ──
        const footerContent = this.renderFooterContent(innerW);
        if (footerContent.length > 0) {
            const footerBlock = new StyledBlock(bg, paddingX, 1, {
                render: () => footerContent,
                invalidate: () => {},
            });
            allLines.push(...footerBlock.render(w));
        }

        return allLines;
    }

    /**
     * Render the footer content lines (duration left, expand hint right).
     */
    private renderFooterContent(innerW: number) {
        // The count is cached because splitting the whole output on every
        // keystroke was the slow part.
        const canExpand = this.outputLineCount > this.previewLineLimit;
        const leftText = this.durationStr || (this.showElapsedTime && !this.ended ? this.formatElapsedTime() : "");
        const left = leftText ? theme.fg("dim", leftText) : "";
        const right = canExpand
            ? theme.fg("dim", this.expanded ? "press ctrl+o to collapse" : "press ctrl+o to expand")
            : "";

        if (!left && !right) return [];

        if (!left) {
            const rightPad = " ".repeat(Math.max(0, innerW - visibleWidth(right)));
            return [`${rightPad}${right}`];
        }

        if (!right) return [left];

        const leftLen = visibleWidth(left);
        const rightLen = visibleWidth(right);

        if (leftLen + 1 + rightLen <= innerW) {
            const spacing = " ".repeat(Math.max(1, innerW - leftLen - rightLen));
            return [`${left}${spacing}${right}`];
        }

        const rightPad = " ".repeat(Math.max(0, innerW - rightLen));
        return [left, `${rightPad}${right}`];
    }
}

export class ToolExecutionGroupBlock {
    declare children: ToolExecutionBlock[];
    declare expanded: boolean;

    constructor() {
        this.children = [];
        this.expanded = false;
    }

    addBlock(block: ToolExecutionBlock) {
        this.children.push(block);
        block.setExpanded(this.expanded);
    }

    trimCompletedChildren(activeBlocks: Set<ToolExecutionBlock>, maxChildren: number) {
        while (this.children.length > maxChildren) {
            const removableIndex = this.children.findIndex((child) => !activeBlocks.has(child));
            if (removableIndex === -1) return;
            this.children.splice(removableIndex, 1);
        }
    }

    setExpanded(expanded: boolean) {
        this.expanded = expanded;
        for (const child of this.children) child.setExpanded(expanded);
    }

    contains(block: ToolExecutionBlock) {
        return this.children.includes(block);
    }

    getPaddingBgToken(): ThemeBg {
        if (this.children.some((child) => child.ended && !child.isError)) return "toolSuccessBg";
        if (this.children.length > 0 && this.children.every((child) => child.ended && child.isError)) {
            return "toolErrorBg";
        }
        return "toolPendingBg";
    }

    renderCompactRow(child: ToolExecutionBlock, width: number) {
        const bgCode = getBgCode(child.bgToken);
        const leftPadding = Math.min(2, Math.max(0, width));
        const rightPadding = Math.min(2, Math.max(0, width - leftPadding));
        const innerWidth = Math.max(0, width - leftPadding - rightPadding);
        const titlePrefix =
            child.headerText === child.toolName || child.headerText.startsWith(`${child.toolName} `)
                ? child.toolName
                : child.headerText.split(" ")[0] || child.headerText;
        const titleSuffix = child.headerText.slice(titlePrefix.length);
        const title = theme.fg("text", `\x1b[1m${titlePrefix}\x1b[22m${titleSuffix}`);
        const durationText =
            child.durationStr || (child.showElapsedTime && !child.ended ? child.formatElapsedTime() : "");
        const duration = durationText ? theme.fg("dim", durationText) : "";
        const durationWidth = visibleWidth(duration);
        let content = title;
        if (duration && durationWidth + 1 < innerWidth) {
            const titleWidth = innerWidth - durationWidth - 1;
            const visibleTitle = visibleWidth(title) > titleWidth ? truncateToWidth(title, titleWidth) : title;
            content = `${visibleTitle}${" ".repeat(
                Math.max(1, innerWidth - visibleWidth(visibleTitle) - durationWidth),
            )}${duration}`;
        }
        const clamped = visibleWidth(content) > innerWidth ? truncateToWidth(content, innerWidth) : content;
        const row = `${" ".repeat(leftPadding)}${clamped}${" ".repeat(
            Math.max(0, innerWidth - visibleWidth(clamped) + rightPadding),
        )}`;
        return applyBg(bgCode, row);
    }

    render(w: number) {
        if (!this.expanded) {
            const paddingLine = applyBg(getBgCode(this.getPaddingBgToken()), " ".repeat(Math.max(0, w)));
            return [paddingLine, ...this.children.map((child) => this.renderCompactRow(child, w)), paddingLine];
        }

        const lines: string[] = [];
        this.children.forEach((child, index) => {
            lines.push(...child.render(w));
            if (index < this.children.length - 1) lines.push("");
        });
        return lines;
    }

    invalidate() {
        // This isn't a pi-tui Container, so invalidation has to be forwarded
        // to the blocks it holds.
        for (const child of this.children) child.invalidate();
    }
}

// ─── Prompt Blocks ───────────────────────────────────────────────────────────

/**
 * SelectList subclass that filters by substring across value and label.
 */
class SearchableSelectList extends SelectList {
    constructor(
        items: SelectItem[],
        maxVisible: number,
        slTheme: SelectListTheme,
        layout: SelectListLayoutOptions = {},
    ) {
        super(items, maxVisible, slTheme, layout);
    }

    override setFilter(filter: string) {
        const lower = filter.toLowerCase();

        // Pi keeps these JavaScript fields private in its TypeScript declarations.
        this["filteredItems"] = this["items"].filter(
            (item: SelectItem) =>
                item.value.toLowerCase().includes(lower) || (item.label && item.label.toLowerCase().includes(lower)),
        );

        this["selectedIndex"] = 0;
    }
}

/**
 * Prompt Select Block
 * Embeds a searchable SelectList vertically in the chat stream.
 */
export class PromptSelectBlock {
    declare container: Container;
    declare promptTitle: string;
    declare hintText: string;
    declare _headerText: Text;
    declare header: StyledBlock;
    declare input: Input;
    declare searchBlock: StyledBlock;
    declare list: SearchableSelectList;
    declare bodyBlock: StyledBlock;
    declare _footerText: Text;
    declare footer: StyledBlock;
    declare settled: boolean;
    declare chosenValue: string | null;

    constructor(promptTitle: string, items: SelectItem[], hint: string = "", layout: SelectListLayoutOptions = {}) {
        this.container = new Container();

        // Raw prompt + hint, re-baked into Text on invalidate so theme swaps recolor live.
        this.promptTitle = promptTitle;
        this.hintText = hint || "Type to search, arrows to navigate, Enter to select, Esc to cancel";

        // Header
        this._headerText = new Text(theme.fg("text", this.promptTitle), 0, 0);
        this.header = new StyledBlock("selectedBg", 2, 1, this._headerText);
        this.container.addChild(this.header);

        // Search input
        this.input = new Input();
        this.searchBlock = new StyledBlock("selectedBg", 2, 0, this.input);
        this.container.addChild(this.searchBlock);

        // Body with SelectList
        this.list = new SearchableSelectList(items, Math.min(items.length, 10), getSelectListTheme(), layout);
        this.bodyBlock = new StyledBlock("selectedBg", 2, 0, this.list);
        this.container.addChild(this.bodyBlock);

        // Footer with hint
        this._footerText = new Text(theme.fg("dim", this.hintText), 0, 0);
        this.footer = new StyledBlock("selectedBg", 2, 1, this._footerText);
        this.container.addChild(this.footer);

        this.settled = false;
        this.chosenValue = null;

        // Wire input callbacks to delegate to list selection
        this.input.onSubmit = () => {
            if (this.settled) return;
            const selected = this.list.getSelectedItem();
            if (selected && this.list.onSelect) {
                this.list.onSelect(selected);
            }
        };
        this.input.onEscape = () => {
            if (this.settled) return;
            if (this.list.onCancel) {
                this.list.onCancel();
            }
        };
    }

    /**
     * Called when selection completes
     */
    settle(value: string | null) {
        this.settled = true;
        this.chosenValue = value;
        this.container.children = [];
        if (value !== null) {
            const summaryText = theme.fg("text", value);
            this.container.addChild(new StyledBlock("selectedBg", 2, 1, new Text(summaryText, 0, 0)));
        }
        this.invalidate();
    }

    handleInput(data: string) {
        if (this.settled) return;

        // Navigation keys go to the list
        if (matchesKey(data, Key.up) || matchesKey(data, Key.down)) {
            this.list.handleInput(data);
            return;
        }

        // Enter and Escape are handled by the input's onSubmit / onEscape callbacks
        if (matchesKey(data, Key.enter) || matchesKey(data, Key.escape)) {
            this.input.handleInput(data);
            return;
        }

        // Everything else (typing, backspace, etc.) goes to the input, then filter the list
        this.input.handleInput(data);
        this.list.setFilter(this.input.getValue());
    }

    focus() {
        this.input.focused = true;
    }

    blur() {
        this.input.focused = false;
    }

    invalidate() {
        // Re-bake header/hint with current theme so theme swaps recolor live.
        if (!this.settled) {
            this._headerText.setText(theme.fg("text", this.promptTitle));
            this._footerText.setText(theme.fg("dim", this.hintText));
        }
        this.container.invalidate();
    }

    render(w: number) {
        return this.container.render(w);
    }
}

/**
 * Prompt Text Block
 * Embeds an Input vertically in the chat stream.
 */
export class PromptTextBlock {
    declare container: Container;
    declare promptTitle: string;
    declare hintText: string;
    declare _headerText: Text;
    declare header: StyledBlock;
    declare input: Input;
    declare bodyBlock: StyledBlock;
    declare _footerText: Text;
    declare footer: StyledBlock;
    declare settled: boolean;
    declare chosenValue: string | null;

    constructor(promptTitle: string, hint: string = "") {
        this.container = new Container();

        this.promptTitle = promptTitle;
        this.hintText = hint || "Enter text and press Enter, Esc to cancel";

        // Header
        this._headerText = new Text(theme.fg("text", this.promptTitle), 0, 0);
        this.header = new StyledBlock("selectedBg", 2, 1, this._headerText);
        this.container.addChild(this.header);

        // Body with Input
        this.input = new Input();
        this.bodyBlock = new StyledBlock("selectedBg", 2, 0, this.input);
        this.container.addChild(this.bodyBlock);

        // Footer with hint
        this._footerText = new Text(theme.fg("dim", this.hintText), 0, 0);
        this.footer = new StyledBlock("selectedBg", 2, 1, this._footerText);
        this.container.addChild(this.footer);

        this.settled = false;
        this.chosenValue = null;
    }

    /**
     * Called when input completes
     */
    settle(value: string | null) {
        this.settled = true;
        this.chosenValue = value;
        this.container.children = [];
        if (value !== null) {
            const summaryText = theme.fg("text", value);
            this.container.addChild(new StyledBlock("selectedBg", 2, 1, new Text(summaryText, 0, 0)));
        }
        this.invalidate();
    }

    handleInput(data: string) {
        if (this.settled) return;
        this.input.handleInput(data);
    }

    focus() {
        this.input.focused = true;
    }

    blur() {
        this.input.focused = false;
    }

    invalidate() {
        if (!this.settled) {
            this._headerText.setText(theme.fg("text", this.promptTitle));
            this._footerText.setText(theme.fg("dim", this.hintText));
        }
        this.container.invalidate();
    }

    render(w: number) {
        return this.container.render(w);
    }
}

// ─── Spinner Block ───────────────────────────────────────────────────────────

export class SpinnerBlock {
    declare frame: number;
    declare isBusy: boolean;
    declare tasks: RunningTask[];
    declare busyLines: readonly string[] | undefined;
    declare busyLabel: string | undefined;

    constructor() {
        this.frame = 0;
        this.isBusy = false;

        this.tasks = [];

        this.busyLines = undefined;

        this.busyLabel = undefined;
    }

    setBusy(busy: boolean, tasks: RunningTask[] = []) {
        this.isBusy = busy;
        if (!busy) this.busyLabel = undefined;
        this.tasks = tasks;
        this.invalidate();
    }

    setBusyLines(lines: readonly string[] | undefined) {
        this.busyLines = lines;
        this.busyLabel = undefined;
        this.invalidate();
    }

    advance() {
        if (this.isBusy || this.tasks.length > 0) {
            this.frame++;
            this.invalidate();
        }
    }

    invalidate() {}

    render(w: number) {
        if (!this.isBusy && this.tasks.length === 0) return [];

        const f = getThinkingFrame(this.frame);
        if (this.tasks.length > 0) {
            return this.tasks.map((t) => {
                const line =
                    theme.fg("accent", f) +
                    " " +
                    theme.fg("success", t.assignee) +
                    " " +
                    theme.fg("dim", `(Task ${t.task})`);
                return line + " ".repeat(Math.max(0, w - visibleWidth(line)));
            });
        }

        // Keep the selected label until the agent stops or switches; only the spinner frame advances.
        this.busyLabel ??=
            this.busyLines && this.busyLines.length > 0
                ? this.busyLines[Math.floor(Math.random() * this.busyLines.length)]
                : "Working...";
        const line = theme.fg("accent", `${f} ${this.busyLabel}`);
        return [line + " ".repeat(Math.max(0, w - visibleWidth(line)))];
    }
}
