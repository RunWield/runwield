import { test } from "node:test";
import { ok as assert } from "node:assert/strict";
import { assertStringIncludes } from "../../testing/assertions.ts";
import stripAnsi from "strip-ansi";
import { getMarkdownTheme, initRunWieldTheme } from "../theme/theme.js";
import { MermaidMarkdown } from "./mermaid-markdown.js";

initRunWieldTheme();

function renderPlain(text: string, width = 120): string {
    return stripAnsi(new MermaidMarkdown(text, 0, 0, getMarkdownTheme()).render(width).join("\n"));
}

test("MermaidMarkdown renders completed inline dollar LaTeX as Unicode", () => {
    const rendered = renderPlain("Inline $x^2$ and $\\alpha + \\beta$.");

    assertStringIncludes(rendered, "Inline x² and α + β.");
    assert(!rendered.includes("\\alpha"));
});

test("MermaidMarkdown renders completed inline paren LaTeX as Unicode", () => {
    const rendered = renderPlain("Inline \\(x^2\\) and \\(\\alpha + \\beta\\).");

    assertStringIncludes(rendered, "Inline x² and α + β.");
    assert(!rendered.includes("\\beta"));
});

test("MermaidMarkdown renders completed display LaTeX delimiters as Unicode text", () => {
    const dollarDisplay = renderPlain("Display $$\\sum_{i=1}^n i$$ done");
    const bracketDisplay = renderPlain("Display \\[\\frac{1}{2}\\] done");

    assertStringIncludes(dollarDisplay, "∑ᵢ₌₁ⁿ i");
    assertStringIncludes(bracketDisplay, "1/2");
});

test("MermaidMarkdown preserves incomplete streamed LaTeX source", () => {
    const rendered = renderPlain("Inline $\\alpha");

    assertStringIncludes(rendered, "$\\alpha");
});

test("MermaidMarkdown preserves unsupported LaTeX source", () => {
    const rendered = renderPlain("Inline $\\notacommand{x}$ done");

    assertStringIncludes(rendered, "$\\notacommand{x}$");
});

test("MermaidMarkdown renders Unicode math adjacent to completed Mermaid", () => {
    const rendered = renderPlain("Math $x^2$ near Mermaid.\n\n```mermaid\ngraph TD\n A --> B\n```");

    assertStringIncludes(rendered, "Math x² near Mermaid.");
    assertStringIncludes(rendered, "┌");
    assert(!rendered.includes("```mermaid"));
});
