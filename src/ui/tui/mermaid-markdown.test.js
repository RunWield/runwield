import { test } from "node:test";
import { ok as assert } from "node:assert/strict";
import { assertEquals, assertStringIncludes } from "../../testing/assertions.ts";
import { getCapabilities, Markdown, setCapabilities, visibleWidth } from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";

import { initRunWieldTheme } from "../theme/theme.js";
initRunWieldTheme();

import { getMarkdownTheme } from "../theme/theme.js";
import { MermaidMarkdown } from "./mermaid-markdown.js";

/** @param {string[]} lines */
function plain(lines) {
    return lines.map((line) => stripAnsi(line)).join("\n");
}

/**
 * @param {string} text
 * @param {number} [width]
 * @param {(source: string) => string} [renderMermaid]
 */
function renderMermaidMarkdown(text, width = 100, renderMermaid) {
    const md = new MermaidMarkdown(text, 0, 0, getMarkdownTheme(), undefined, undefined, { renderMermaid });
    return md.render(width);
}

/** @param {string} body */
function fence(body) {
    return `before\n\n\`\`\`mermaid\n${body}\n\`\`\`\n\nafter`;
}

test("MermaidMarkdown matches upstream Markdown for non-Mermaid content", () => {
    const text = "# Heading\n\nA paragraph with **strong** text and `code`.\n\n- one\n- two";
    const upstream = new Markdown(text, 0, 0, getMarkdownTheme());
    const mermaid = new MermaidMarkdown(text, 0, 0, getMarkdownTheme());

    assertEquals(mermaid.render(80), upstream.render(80));
});

test("MermaidMarkdown renders URLs with BEL-delimited terminal hyperlinks", () => {
    const capabilities = getCapabilities();
    setCapabilities({ ...capabilities, hyperlinks: true });
    try {
        const url = "https://github.com/gandazgul/runwield/pull/80";
        const rendered = renderMermaidMarkdown(`Opened draft PR #80: ${url}.`, 120).join("\n");

        assertStringIncludes(stripAnsi(rendered), `Opened draft PR #80: ${url}.`);
        assertStringIncludes(rendered, `\x1b]8;;${url}\x07`);
        assertStringIncludes(rendered, "\x1b]8;;\x07.");
    } finally {
        setCapabilities(capabilities);
    }
});

test("MermaidMarkdown renders a completed top-level flowchart as Unicode", () => {
    const rendered = plain(renderMermaidMarkdown(fence("graph TD\n  A --> B"), 120));

    assertStringIncludes(rendered, "before");
    assertStringIncludes(rendered, "after");
    assertStringIncludes(rendered, "┌");
    assert(!rendered.includes("```mermaid"));
});

test("MermaidMarkdown keeps source until a closing fence is complete", () => {
    const partial = plain(renderMermaidMarkdown("```mermaid\ngraph TD\n  A --> B\n``", 120));
    assertStringIncludes(partial, "```mermaid");
    assert(!partial.includes("┌"));

    const complete = plain(renderMermaidMarkdown("```mermaid\ngraph TD\n  A --> B\n```", 120));
    assertStringIncludes(complete, "┌");
    assert(!complete.includes("```mermaid"));
});

test("MermaidMarkdown falls back for malformed, empty, unsupported, tilde, extra-info, and nested fences", () => {
    const examples = [
        "```mermaid\nthis is not mermaid\n```",
        "```mermaid\n\n```",
        "```mermaid\npie\n  title Unsupported here\n```",
        "~~~mermaid\ngraph TD\n  A --> B\n~~~",
        "```mermaid title=extra\ngraph TD\n  A --> B\n```",
        "> ```mermaid\n> graph TD\n>   A --> B\n> ```",
    ];

    for (const example of examples) {
        const rendered = plain(renderMermaidMarkdown(example, 120));
        assertStringIncludes(rendered, "mermaid");
    }
});

test("MermaidMarkdown renders supported Mermaid families", () => {
    const examples = [
        "sequenceDiagram\n  participant A\n  participant B\n  A->>B: Hi",
        "stateDiagram-v2\n  [*] --> Idle\n  Idle --> [*]",
        "classDiagram\n  class Animal\n  Animal <|-- Cat",
        "erDiagram\n  USER ||--o{ ORDER : places",
    ];

    for (const source of examples) {
        const rendered = plain(renderMermaidMarkdown(`\`\`\`mermaid\n${source}\n\`\`\``, 160));
        assert(!rendered.includes("```mermaid"), `expected rendered diagram for ${source}`);
        assert(rendered.includes("┌") || rendered.includes("╭") || rendered.includes("●"), rendered);
    }
});

test("MermaidMarkdown falls back instead of wrapping diagrams that do not fit", () => {
    const source = "graph LR\n  AlphaLabel --> BetaLabel --> GammaLabel --> DeltaLabel";
    const narrow = renderMermaidMarkdown(`\`\`\`mermaid\n${source}\n\`\`\``, 20);
    const narrowPlain = plain(narrow);

    assertStringIncludes(narrowPlain, "```mermaid");
    assert(narrow.every((/** @type {string} */ line) => visibleWidth(line) <= 20));
});

test("MermaidMarkdown reevaluates cached diagrams when width changes", () => {
    let calls = 0;
    const md = new MermaidMarkdown(
        "```mermaid\ngraph TD\n  A --> B\n```",
        0,
        0,
        getMarkdownTheme(),
        undefined,
        undefined,
        {
            renderMermaid: () => {
                calls++;
                return "┌───┐\n│ A │\n└───┘";
            },
        },
    );

    const wide = plain(md.render(20));
    const narrow = plain(md.render(4));
    const wideAgain = plain(md.render(20));

    assertStringIncludes(wide, "┌───┐");
    assertStringIncludes(narrow, "```");
    assert(!narrow.includes("┌───┐"));
    assertStringIncludes(wideAgain, "┌───┐");
    assertEquals(calls, 1);
});

test("MermaidMarkdown renders multiple fences independently", () => {
    const text = "```mermaid\ngraph TD\n  A --> B\n```\n\n```mermaid\ngraph TD\n  C --> D\n```";
    const rendered = plain(renderMermaidMarkdown(text, 120));

    assertStringIncludes(rendered, "A");
    assertStringIncludes(rendered, "C");
    assert(!rendered.includes("```mermaid"));
});

test("MermaidMarkdown caches renderer failures by source", () => {
    let calls = 0;
    const md = new MermaidMarkdown(
        "```mermaid\ngraph TD\n  A --> B\n```",
        0,
        0,
        getMarkdownTheme(),
        undefined,
        undefined,
        {
            renderMermaid: () => {
                calls++;
                throw new Error("boom");
            },
        },
    );

    assertStringIncludes(plain(md.render(120)), "```mermaid");
    md.invalidate();
    assertStringIncludes(plain(md.render(120)), "```mermaid");
    assertEquals(calls, 1);
});
