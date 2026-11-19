import { renderMermaidASCII } from "beautiful-mermaid";
import { getCapabilities, hyperlink, Markdown, visibleWidth } from "@earendil-works/pi-tui";

import type { AsciiRenderOptions } from "beautiful-mermaid";
import type { MarkdownTheme, DefaultTextStyle, MarkdownOptions } from "@earendil-works/pi-tui";
import type { Token, Tokens } from "marked";
import type { DocumentLinkHost } from "../review/document-link-host.ts";

interface InlineStyleContext {
    applyText: (text: string) => string;
    stylePrefix: string;
}

interface InlineBoundaries {
    previousText: string;
    nextText: string;
}

export interface MermaidMarkdownOptions {
    renderMermaid?: (source: string) => string;
}

interface CachedMermaidSuccess {
    status: "success";
    lines: string[];
}

interface CachedMermaidFailure {
    status: "failure";
}

type CachedMermaidResult = CachedMermaidSuccess | CachedMermaidFailure;

// pi-tui declares these runtime renderer methods private; keep the existing JS adapter boundary local.
interface RuntimeMarkdownInstance extends Omit<Pick<Markdown, keyof Markdown>, "render"> {
    render(width: Parameters<Markdown["render"]>[0]): ReturnType<Markdown["render"]>;
    renderToken(
        token: Token,
        width: number,
        nextTokenType: string | undefined,
        styleContext?: InlineStyleContext,
    ): string[];
    renderInlineTokens(tokens: Token[], styleContext?: InlineStyleContext): string;
}

interface RuntimeMarkdownConstructor {
    new (...args: ConstructorParameters<typeof Markdown>): RuntimeMarkdownInstance;
}

const MERMAID_RENDER_OPTIONS: Readonly<AsciiRenderOptions> = Object.freeze({
    useAscii: false,
    colorMode: "none",
    paddingX: 1,
    paddingY: 1,
    boxBorderPadding: 0,
});

function normalizeFenceLanguage(lang: string) {
    return lang.trim().toLowerCase();
}

function isCompletedBacktickFence(raw: string) {
    const opening = raw.match(/^(`{3,})[^\n]*(?:\n|$)/);
    if (!opening) return false;

    const markerLength = opening[1].length;
    const lines = raw.split(/\r?\n/);
    for (let i = lines.length - 1; i > 0; i--) {
        const line = lines[i];
        if (line.trim() === "") continue;
        const closing = line.match(/^(`{3,})\s*$/);
        return Boolean(closing && closing[1].length >= markerLength);
    }
    return false;
}

function trimOuterBlankLines(lines: string[]) {
    let start = 0;
    let end = lines.length;
    while (start < end && lines[start].trim() === "") start++;
    while (end > start && lines[end - 1].trim() === "") end--;
    return lines.slice(start, end);
}

function normalizeOsc8Terminators(line: string) {
    // Some terminals do not activate OSC 8 links that use ST (ESC backslash).
    // BEL is the form already used by RunWield's hand-built review links.
    // deno-lint-ignore no-control-regex
    return line.replace(/\x1b\]8;;([^\x07\x1b]*)\x1b\\/g, "\x1b]8;;$1\x07");
}

function inlineBoundaryText(token: Token | undefined): string {
    if (token?.type === "br") return "\n";
    if (token && "tokens" in token && token.tokens?.length) return token.tokens.map(inlineBoundaryText).join("");
    return token && "text" in token ? token.text || token.raw : token?.raw || "";
}

/**
 * Markdown adapter that renders completed top-level Mermaid fences as compact
 * Unicode diagrams when they fit, otherwise preserving upstream Markdown output.
 */
const RuntimeMarkdown = Markdown as unknown as RuntimeMarkdownConstructor;

export class MermaidMarkdown extends RuntimeMarkdown {
    declare markdownTheme: MarkdownTheme;
    declare renderDepth: number;
    declare documentLinks: DocumentLinkHost | null;
    declare insideLink: boolean;
    declare inlineBoundaries: InlineBoundaries;
    declare mermaidCache: Map<string, CachedMermaidResult>;
    declare renderMermaid: NonNullable<MermaidMarkdownOptions["renderMermaid"]>;

    constructor(
        text: string,
        paddingX: number,
        paddingY: number,
        theme: MarkdownTheme,
        defaultTextStyle?: DefaultTextStyle,
        options?: MarkdownOptions,
        mermaidOptions: MermaidMarkdownOptions = {},
    ) {
        super(text, paddingX, paddingY, theme, defaultTextStyle, options);

        this.markdownTheme = theme;
        this.renderDepth = 0;

        this.documentLinks = null;
        this.insideLink = false;

        this.inlineBoundaries = { previousText: "", nextText: "" };

        this.mermaidCache = new Map();
        this.renderMermaid =
            mermaidOptions.renderMermaid || ((source) => renderMermaidASCII(source, MERMAID_RENDER_OPTIONS));
    }

    render(width: number): string[] {
        return super.render(width).map((line) => normalizeOsc8Terminators(line));
    }

    setDocumentLinks(host: DocumentLinkHost | null) {
        this.documentLinks = host;
    }

    /**
     * Adapt inline tokens only. Never rewrite the source or mutate parsed tokens.
     */
    renderInlineTokens(tokens: Token[], styleContext?: InlineStyleContext): string {
        const upstream = (values: Token[]) => super.renderInlineTokens(values, styleContext);
        const host = this.documentLinks;
        if (!host || this.insideLink || !getCapabilities().hyperlinks) return upstream(tokens);
        const outerBoundaries = this.inlineBoundaries;
        return tokens
            .map((token, tokenIndex) => {
                const previousText =
                    outerBoundaries.previousText + tokens.slice(0, tokenIndex).map(inlineBoundaryText).join("");
                const nextText =
                    tokens
                        .slice(tokenIndex + 1)
                        .map(inlineBoundaryText)
                        .join("") + outerBoundaries.nextText;
                if (token.type === "link" || token.type === "image") {
                    const url = token.type === "link" ? host.resolve(token.href) : null;
                    this.insideLink = true;
                    try {
                        return upstream([url ? { ...token, href: url } : token]);
                    } finally {
                        this.insideLink = false;
                    }
                }
                if (token.type === "codespan") {
                    const url = host.resolve(token.text, "literal");
                    const label = upstream([token]);
                    return url ? hyperlink(label, url) : label;
                }
                if (token.type !== "text" || token.tokens?.length) {
                    // Upstream recurses through this adapter for formatted child tokens.
                    this.inlineBoundaries = { previousText, nextText };
                    try {
                        return upstream([token]);
                    } finally {
                        this.inlineBoundaries = outerBoundaries;
                    }
                }
                // Unquoted paths cannot contain whitespace, URL schemes, or delimiters.
                // Require a complete token: file.md.txt and file.md:12 are not mentions.
                const pattern =
                    /(^|[\s([{"'“‘])([^\s()[\]{}<>"'“”‘’:,;!?`#]+\.md(?:#[^\s()[\]{}<>"'“”‘’:,;.!?`]+)?)(?=$|[\s)\]}"'”’,;!]|[.?](?![\p{L}\p{N}_./%=-]))/gu;
                let result = "";
                let start = 0;
                for (const match of token.text.matchAll(pattern)) {
                    const index = match.index + match[1].length;
                    const path = match[2];
                    const followingText = (token.text.slice(index + path.length) + nextText).slice(0, 2);
                    // Escapes and formatting can split one visible word across tokens.
                    if (index === 0 && previousText && !/[\s([{"'“‘]$/u.test(previousText)) continue;
                    if (followingText && !/^(?:[\s)\]}"'”’,;!]|[.?](?![\p{L}\p{N}_./%=-]))/u.test(followingText))
                        continue;
                    const url = host.resolve(path);
                    if (!url) continue;
                    result += upstream([{ ...token, text: token.text.slice(start, index) }]);
                    result += hyperlink(upstream([{ ...token, text: path }]), url);
                    start = index + path.length;
                }
                return result + upstream([{ ...token, text: token.text.slice(start) }]);
            })
            .join("");
    }

    /**
     * Override pi-tui's private runtime seam. Keep this localized so a future
     * upstream signature change fails in this adapter's tests instead of
     * spreading Markdown renderer knowledge through the TUI.
     *
     */
    renderToken(
        token: Token,
        width: number,
        nextTokenType: string | undefined,
        styleContext?: InlineStyleContext,
    ): string[] {
        if (this.renderDepth === 0) {
            const mermaidLines = this.renderMermaidToken(token, width, nextTokenType);
            if (mermaidLines) return mermaidLines;
        }

        this.renderDepth++;
        try {
            return (Markdown.prototype as unknown as RuntimeMarkdownInstance).renderToken.call(
                this,
                token,
                width,
                nextTokenType,
                styleContext,
            );
        } finally {
            this.renderDepth--;
        }
    }

    renderMermaidToken(token: Token, width: number, nextTokenType: string | undefined): string[] | null {
        if (!this.isEligibleMermaidToken(token)) return null;

        const source = token.text;
        const cached = this.getCachedMermaidResult(source);
        if (cached.status === "failure") return null;

        const indent = this.markdownTheme.codeBlockIndent ?? "  ";
        const linesFit = cached.lines.every((line) => line.trim() === "" || visibleWidth(`${indent}${line}`) <= width);
        if (!linesFit) return null;

        const rendered = cached.lines.map((line) => `${indent}${this.markdownTheme.codeBlock(line)}`);
        if (nextTokenType && nextTokenType !== "space") rendered.push("");
        return rendered;
    }

    isEligibleMermaidToken(token: Token): token is Tokens.Code {
        return (
            token?.type === "code" &&
            typeof token.text === "string" &&
            token.text.trim() !== "" &&
            typeof token.raw === "string" &&
            typeof token.lang === "string" &&
            normalizeFenceLanguage(token.lang) === "mermaid" &&
            isCompletedBacktickFence(token.raw)
        );
    }

    getCachedMermaidResult(source: string): CachedMermaidResult {
        const cached = this.mermaidCache.get(source);
        if (cached) return cached;

        try {
            const rendered = this.renderMermaid(source);
            if (typeof rendered !== "string") {
                const failure: CachedMermaidFailure = { status: "failure" };
                this.mermaidCache.set(source, failure);
                return failure;
            }

            const lines = trimOuterBlankLines(rendered.replace(/\r\n/g, "\n").split("\n"));
            if (lines.length === 0 || lines.every((line) => line.trim() === "")) {
                const failure: CachedMermaidFailure = { status: "failure" };
                this.mermaidCache.set(source, failure);
                return failure;
            }

            const success: CachedMermaidSuccess = { status: "success", lines };
            this.mermaidCache.set(source, success);
            return success;
        } catch (_error) {
            const failure: CachedMermaidFailure = { status: "failure" };
            this.mermaidCache.set(source, failure);
            return failure;
        }
    }
}
