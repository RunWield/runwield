import { assert, assertEquals, assertNotEquals } from "@std/assert";
import chalk from "chalk";

// Force chalk to produce ANSI codes in non-TTY test environment
chalk.level = 3;

// Initialize the runwield theme before importing blocks (theme must be ready)
import { initRunWieldTheme, theme } from "../theme/theme.js";
initRunWieldTheme();

import {
    AgentMessageBlock,
    KeyboardHelpBlock,
    PromptSelectBlock,
    PromptTextBlock,
    ReviewResultBlock,
    SpinnerBlock,
    StyledBlock,
    SystemMessageBlock,
    ThinkingBlock,
    ToolExecutionBlock,
    ToolExecutionGroupBlock,
    UserPromptBlock,
    ValidationHandoffBlock,
} from "./blocks.js";
import { getCapabilities, setCapabilities, Text } from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Compute visible length by stripping all ANSI/APC/OSC sequences.
 * @param {string} str
 */
function visibleLength(str) {
    // deno-lint-ignore no-control-regex
    return str.replace(/\x1b\[[0-9;]*m|\x1b[_\]].*?\x07/g, "").length;
}

/**
 * Assert every line has correct visible width and consistent background.
 * Checks that:
 * 1. Every line is exactly `w` visible chars wide
 * 2. Every line starts with a bg ANSI code
 * 3. After any \x1b[0m (full reset), the bg is re-applied
 *
 * @param {string[]} lines
 * @param {number} w
 * @param {string} blockName - for error messages
 */
function assertBlockBackground(lines, w, blockName) {
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const vl = visibleLength(line);

        assertEquals(vl, w, `${blockName} line ${i}: visible length should be ${w}, got ${vl}`);

        // Every line should start with a bg code (truecolor or 256-color)
        assertEquals(
            // deno-lint-ignore no-control-regex
            /^\x1b\[(?:48;2;\d+;\d+;\d+|48;5;\d+)m/.test(line),
            true,
            `${blockName} line ${i}: should start with bg ANSI code`,
        );

        // After any \x1b[0m, the bg must be re-applied immediately
        const parts = line.split("\x1b[0m");
        if (parts.length > 1) {
            for (let p = 1; p < parts.length; p++) {
                assertEquals(
                    // deno-lint-ignore no-control-regex
                    /^\x1b\[(?:48;2;\d+;\d+;\d+|48;5;\d+)m/.test(parts[p]),
                    true,
                    `${blockName} line ${i}: bg must be re-applied after \\x1b[0m (part ${p})`,
                );
            }
        }
    }
}

// ─── StyledBlock ─────────────────────────────────────────────────────────────

Deno.test("StyledBlock renders full-width bg lines", () => {
    const w = 80;
    const block = new StyledBlock("userMessageBg", 2, 1, new Text("hello", 0, 0));
    const lines = block.render(w);
    assertBlockBackground(lines, w, "StyledBlock");
});

Deno.test("StyledBlock handles embedded \\x1b[0m in child content", () => {
    const w = 80;
    // Simulate a child that produces content with \x1b[0m (like truncateToWidth)
    const child = {
        render: () => ["before \x1b[0m after"],
        invalidate: () => {},
    };
    const block = new StyledBlock("userMessageBg", 2, 1, child);
    const lines = block.render(w);
    assertBlockBackground(lines, w, "StyledBlock(with reset)");
});

// ─── UserPromptBlock ─────────────────────────────────────────────────────────

Deno.test("UserPromptBlock renders with consistent background", () => {
    const w = 100;
    const block = new UserPromptBlock("Hello world");
    const lines = block.render(w);
    assertBlockBackground(lines, w, "UserPromptBlock");
});

// ─── AgentMessageBlock ───────────────────────────────────────────────────────

Deno.test("AgentMessageBlock renders without background (like Pi)", () => {
    const w = 100;
    const block = new AgentMessageBlock("TestAgent", null);
    block.appendText("Some markdown **content** here.");
    const lines = block.render(w);

    // Agent messages no longer have a bg — just verify they render without error
    assertEquals(lines.length > 0, true, "AgentMessageBlock should produce output");

    // Verify agent name is in the output
    const plain = lines.map((l) => stripAnsi(l)).join("\n");
    assertEquals(plain.includes("TestAgent:"), true, "Should contain agent name");
});

Deno.test("AgentMessageBlock renders Markdown URLs with BEL-delimited terminal hyperlinks", () => {
    const capabilities = getCapabilities();
    setCapabilities({ ...capabilities, hyperlinks: true });
    try {
        const url = "https://github.com/gandazgul/runwield/pull/80";
        const block = new AgentMessageBlock("Operator", null);
        block.appendText(`Opened draft PR #80: ${url}.`);

        const rendered = block.render(140).join("\n");

        assertEquals(stripAnsi(rendered).includes(`Opened draft PR #80: ${url}.`), true);
        assertEquals(rendered.includes(`\x1b]8;;${url}\x07`), true);
        assertEquals(rendered.includes("\x1b]8;;\x07."), true);
    } finally {
        setCapabilities(capabilities);
    }
});

Deno.test("AgentMessageBlock renders completed Mermaid fences as Unicode diagrams", () => {
    const block = new AgentMessageBlock("Planner", null);
    block.appendText("```mermaid\ngraph TD\n  A --> B\n```");

    const plain = block.render(120).map((line) => stripAnsi(line)).join("\n");

    assertEquals(plain.includes("Planner:"), true, "Should contain agent name");
    assertEquals(plain.includes("┌"), true, "Should render a Unicode diagram");
    assertEquals(plain.includes("```mermaid"), false, "Should not show source for fitting completed diagram");
});

// ─── ThinkingBlock ───────────────────────────────────────────────────────────

Deno.test("ThinkingBlock renders reasoning with muted styling", () => {
    const block = new ThinkingBlock();
    block.appendText("\nThe user is greeting me.\nI should respond naturally.");

    const lines = block.render(80);
    const plain = lines.map((line) => stripAnsi(line)).join("\n");

    assertEquals(plain.includes("Thinking"), false);
    assertEquals(plain.includes("The user is greeting me."), true);
    assertNotEquals(lines.join("\n"), plain, "ThinkingBlock should include ANSI styling");
});

Deno.test("ThinkingBlock removes the thinking label after completion", () => {
    const block = new ThinkingBlock();
    block.appendText("Finished reasoning.");
    block.end();

    const plain = block.render(80).map((line) => stripAnsi(line)).join("\n");

    assertEquals(plain.includes("Thinking"), false);
    assertEquals(plain.includes("✓"), false);
    assertEquals(plain.includes("Finished reasoning."), true);
});

Deno.test("ThinkingBlock wraps long reasoning lines to the viewport width", () => {
    const block = new ThinkingBlock();
    block.appendText("This is a long reasoning line that should wrap instead of truncating at the viewport edge.");

    const lines = block.render(32).map((line) => stripAnsi(line));

    assertEquals(lines.some((line) => line.includes("truncating")), true);
    assertEquals(lines.some((line) => line.includes("viewport edge")), true);
    assert(lines.every((line) => visibleLength(line) <= 32));
});

Deno.test("ThinkingBlock can hide reasoning text", () => {
    const block = new ThinkingBlock({ hidden: true });
    block.appendText("private reasoning");

    const plain = block.render(80).map((line) => stripAnsi(line)).join("\n");

    assertEquals(plain.includes("Thinking"), false);
    assertEquals(plain.includes("hidden"), true);
    assertEquals(plain.includes("private reasoning"), false);
});

// ─── SystemMessageBlock ──────────────────────────────────────────────────────

Deno.test("SystemMessageBlock renders with consistent background", () => {
    const w = 100;
    const block = new SystemMessageBlock("[RunWield] System message");
    const lines = block.render(w);
    assertBlockBackground(lines, w, "SystemMessageBlock");
});

Deno.test("SystemMessageBlock error renders with consistent background", () => {
    const w = 100;
    const block = new SystemMessageBlock("[Error] Something failed", true);
    const lines = block.render(w);
    assertBlockBackground(lines, w, "SystemMessageBlock(error)");
});

Deno.test("SystemMessageBlock renders with mdHeading heading style", () => {
    const w = 100;
    const text = "skill1, skill2";
    const header = "Loaded skills (2):";
    const style = { headingColor: "mdHeading" };
    const block = new SystemMessageBlock(text, false, header, style);
    const lines = block.render(w);

    assertBlockBackground(lines, w, "SystemMessageBlock(mdHeading)");

    // StyledBlock adds padY top/bottom; content lives on the middle line(s).
    const contentLine = lines.find((l) => stripAnsi(l).trim().length > 0) || "";
    const plain = stripAnsi(contentLine).trim();
    assertEquals(plain, `${header} ${text}`, "Stripped content should be 'header text'");

    // The mdHeading color is peach (#fab387) → 250;179;135 (truecolor) or 216 (256-color).
    // Body text should remain normal text by default, not muted/dim, so the heading
    // may be the only explicit foreground color on this line.
    // deno-lint-ignore no-control-regex
    const fgMatches = contentLine.match(/\x1b\[(?:38;2;\d+;\d+;\d+|38;5;\d+)m/g) || [];
    const hasPeach = fgMatches.some((m) => m === "\x1b[38;2;250;179;135m" || m === "\x1b[38;5;216m");
    assertEquals(hasPeach, true, "Should contain the peach/mdHeading ANSI code");

    const mutedBlock = new SystemMessageBlock(text, false, header, { ...style, bodyColor: "dim" });
    const mutedContentLine = mutedBlock.render(w).find((l) => stripAnsi(l).trim().length > 0) || "";
    assertNotEquals(
        contentLine,
        mutedContentLine,
        "Default system body text should not render with the explicit dim/muted body style",
    );
});

Deno.test("SystemMessageBlock appendText uses header and style", () => {
    const w = 100;
    const block = new SystemMessageBlock("First line");
    block.appendText("s1", "Loaded skills (1):", { headingColor: "mdHeading" });
    const lines = block.render(w);

    assertBlockBackground(lines, w, "SystemMessageBlock(append)");

    const plain = lines.map((l) => stripAnsi(l)).join("\n");
    assertEquals(plain.includes("First line"), true);
    assertEquals(plain.includes("Loaded skills (1): s1"), true);
});

Deno.test("SystemMessageBlock preserves OSC 8 hyperlinks on wrapped URL lines", () => {
    const w = 50;
    const url =
        "https://auth.example/oauth/authorize?client_id=runwield&redirect_uri=http%3A%2F%2Flocalhost%3A12345%2Fcallback&scope=openid%20profile%20email&state=long-state-token";
    const block = new SystemMessageBlock(`\x1b]8;;${url}\x07${url}\x1b]8;;\x07`);
    const lines = block.render(w);
    const urlLines = lines.filter((line) => line.includes("auth.example") || line.includes("redirect_uri"));

    assertEquals(urlLines.length > 1, true);
    for (const line of urlLines) {
        assertEquals(line.includes(`\x1b]8;;${url}\x07`), true);
        assertEquals(line.includes("\x1b]8;;\x07"), true);
    }
});

// ─── ReviewResultBlock ───────────────────────────────────────────────────────

Deno.test("ReviewResultBlock renders approved markdown with success background", () => {
    const w = 100;
    const block = new ReviewResultBlock("Reviewer", "Semantic review **approved**.", true);
    const lines = block.render(w);
    const plain = lines.map((line) => stripAnsi(line)).join("\n");

    assertBlockBackground(lines, w, "ReviewResultBlock(approved)");
    assertEquals(plain.includes("Reviewer:"), true);
    assertEquals(plain.includes("Semantic review approved."), true);
});

Deno.test("ReviewResultBlock renders feedback markdown with error background", () => {
    const w = 100;
    const block = new ReviewResultBlock("Reviewer", "Semantic review rejected:\n- Missing `thing`", false);
    const lines = block.render(w);
    const plain = lines.map((line) => stripAnsi(line)).join("\n");

    assertBlockBackground(lines, w, "ReviewResultBlock(feedback)");
    assertEquals(plain.includes("Reviewer:"), true);
    assertEquals(plain.includes("Semantic review rejected:"), true);
    assertEquals(plain.includes("Missing thing"), true);
});

Deno.test("ValidationHandoffBlock renders owner validation labels and latest handoff reports", () => {
    const w = 180;
    const block = new ValidationHandoffBlock({
        progress: {
            kind: "workflow",
            outcome: "paused",
            stage: "engineer_repair",
            cycle: 2,
            maxCycles: 3,
            totalCycle: 5,
            repairAttempt: 1,
            maxRepairAttempts: 3,
            checks: { ci: "failed", semanticReview: "pending", humanReview: "pending", merge: "pending" },
            message: "Engineer continuation required.",
        },
        engineer: { agentName: "Engineer", markdown: "- Fixed CI", completedOrder: 2 },
        reviewer: { agentName: "Reviewer", markdown: "- Earlier feedback", approved: false, completedOrder: 1 },
    });
    const lines = block.render(w);
    const plain = lines.map((line) => stripAnsi(line)).join("\n");

    assertBlockBackground(lines, w, "ValidationHandoffBlock");
    assertEquals(plain.includes("Repair paused"), true);
    assertEquals(
        plain.includes("Verification Command failed, AI review pending, Code review pending, Merge worktree pending"),
        true,
    );
    assertEquals(plain.includes("Round 2/3"), false);
    assertEquals(plain.includes("Stage: engineer repair"), false);
    assertEquals(plain.includes("Attempt 1/3"), false);
    assertEquals(plain.includes("Mechanical Validation"), false);
    assertEquals(plain.includes("Semantic review"), false);
    assertEquals(plain.includes("Engineer latest completion report"), true);
    assertEquals(plain.includes("Reviewer latest AI review — rejected (feedback addressed; rechecking)"), true);
});

Deno.test("ValidationHandoffBlock shows each workflow check once as verification advances", () => {
    const states = /** @type {const} */ (["running", "failed", "passed"]);
    for (const state of states) {
        const block = new ValidationHandoffBlock({
            progress: {
                kind: "workflow",
                outcome: state === "passed" ? "verified" : state,
                stage: state === "running" ? "ci" : "terminal",
                checks: { ci: state, semanticReview: "pending", humanReview: "pending", merge: "pending" },
            },
        });
        const plain = stripAnsi(block.render(200).join("\n"));
        assertEquals(plain.split("Verification Command").length - 1, 1);
        assertEquals(plain.includes(`Verification Command ${state === "passed" ? "done" : state}`), true);
        assertEquals(plain.includes("Merge worktree pending"), true);
        assertEquals(plain.includes("Tests and CI"), false);
        assertEquals(plain.includes("Combining commits"), false);
    }
});

Deno.test("ValidationHandoffBlock renders verification command wording for QUICK_FIX progress", () => {
    const runningBlock = new ValidationHandoffBlock({
        progress: {
            kind: "mechanical",
            outcome: "running",
            stage: "ci",
            checks: { ci: "running", semanticReview: "skipped", humanReview: "skipped", merge: "skipped" },
        },
        engineer: { agentName: "Engineer", markdown: "- Repairing CI", completedOrder: 1 },
    });
    const runningPlain = stripAnsi(runningBlock.render(120).join("\n"));

    assertEquals(runningPlain.split("Verification Command").length - 1, 1);
    assertEquals(runningPlain.includes("Stage: CI"), false);
    assertEquals(runningPlain.includes("Mechanical Validation"), false);
    assertEquals(runningPlain.includes("Verification Command running"), true);
    assertEquals(runningPlain.includes("Review skipped"), false);
    assertEquals(runningPlain.includes("Human skipped"), false);
    assertEquals(runningPlain.includes("Merge skipped"), false);
    assertEquals(runningPlain.includes("Engineer latest completion report"), true);
    assertEquals(runningPlain.includes("Reviewer latest AI review"), false);

    const verifiedBlock = new ValidationHandoffBlock({
        progress: {
            kind: "mechanical",
            outcome: "verified",
            stage: "terminal",
            checks: { ci: "passed", semanticReview: "skipped", humanReview: "skipped", merge: "skipped" },
        },
    });
    const verifiedPlain = stripAnsi(verifiedBlock.render(120).join("\n"));

    assertEquals(verifiedPlain.includes("Verification Command done"), true);
    assertEquals(verifiedPlain.split("Verification Command").length - 1, 1);
    assertEquals(verifiedPlain.includes("Validation passed"), false);
    assertEquals(verifiedPlain.includes("Mechanical Validation"), false);
});

Deno.test("KeyboardHelpBlock renders ordered shortcuts with responsive wrapping", () => {
    const block = new KeyboardHelpBlock({
        title: "Keyboard shortcuts",
        items: [
            { key: "esc", description: "to interrupt" },
            { key: "ctrl+c", description: "to clear input" },
            { key: "shift+enter", description: "to insert newline" },
            { key: "?", description: "to show this keyboard help block" },
            { key: "/", description: "for commands" },
            { key: "!!", description: "to run bash (no context)" },
        ],
    });

    const wide = block.render(100);
    const widePlain = stripAnsi(wide.join("\n"));
    assertBlockBackground(wide, 100, "KeyboardHelpBlock wide");
    assertEquals(widePlain.includes("Keyboard shortcuts"), true);
    assertEquals(widePlain.includes("esc"), true);
    assertEquals(widePlain.includes("!!"), true);

    const narrow = block.render(24);
    assertBlockBackground(narrow, 24, "KeyboardHelpBlock narrow");
    for (const line of narrow) {
        assert(visibleLength(line) <= 24);
    }
    assertEquals(stripAnsi(narrow.join("\n")).includes("keyboard"), true);
});

// ─── ToolExecutionBlock ──────────────────────────────────────────────────────

Deno.test("ToolExecutionBlock renders with consistent background (no output)", () => {
    const w = 100;
    const block = new ToolExecutionBlock("bash", "$ ls -la");
    block.endExecution(false, 150);
    const lines = block.render(w);
    assertBlockBackground(lines, w, "ToolExecutionBlock(empty)");
});

Deno.test("ToolExecutionBlock renders with consistent background (with output)", () => {
    const w = 100;
    const block = new ToolExecutionBlock("bash", "$ ls -la");
    block.appendOutput("file1.txt\nfile2.txt\nfolder/\n");
    block.endExecution(false, 250);
    const lines = block.render(w);
    assertBlockBackground(lines, w, "ToolExecutionBlock(output)");
});

Deno.test("ToolExecutionBlock shows live elapsed time from execution start after it is enabled", () => {
    const originalNow = Date.now;
    let now = 1000;
    Date.now = () => now;
    try {
        const w = 100;
        const block = new ToolExecutionBlock("bash", "$ sleep 1");

        let plain = block.render(w).map((line) => stripAnsi(line)).join("\n");
        assertEquals(plain.includes("Elapsed time:"), false);

        block.enableElapsedTime();
        plain = block.render(w).map((line) => stripAnsi(line)).join("\n");
        assertEquals(plain.includes("Elapsed time: 0.0s"), true);

        now = 1500;
        plain = block.render(w).map((line) => stripAnsi(line)).join("\n");
        assertEquals(plain.includes("Elapsed time: 0.5s"), true);

        block.endExecution(false, 700);
        plain = block.render(w).map((line) => stripAnsi(line)).join("\n");
        assertEquals(plain.includes("Elapsed time:"), false);
        assertEquals(plain.includes("Took 0.7s"), true);
    } finally {
        Date.now = originalNow;
    }
});

Deno.test("ToolExecutionBlock keeps elapsed footer with expand hint inside the block", () => {
    const originalNow = Date.now;
    let now = 2000;
    Date.now = () => now;
    try {
        const w = 100;
        const block = new ToolExecutionBlock("bash", "$ echo lines");
        for (let i = 0; i < 10; i++) {
            block.appendOutput(`line ${i}\n`);
        }

        now = 2600;
        block.enableElapsedTime();
        const lines = block.render(w);
        const plain = lines.map((line) => stripAnsi(line)).join("\n");

        assertBlockBackground(lines, w, "ToolExecutionBlock(elapsed expand hint)");
        assertEquals(plain.includes("Elapsed time: 0.6s"), true);
        assertEquals(plain.includes("press ctrl+o to expand"), true);
    } finally {
        Date.now = originalNow;
    }
});

Deno.test("ToolExecutionBlock keeps multi-line command headers inside the block", () => {
    const w = 120;
    const block = new ToolExecutionBlock(
        "bash",
        '$ cd /Users/gandazgul/Documents/web/runwield && git commit -m "Consolidate formats\n- Move plan formats"',
    );
    block.appendOutput("[main abc123] Consolidate formats\n");
    block.endExecution(false, 100);

    const lines = block.render(w);
    assertBlockBackground(lines, w, "ToolExecutionBlock(multiline header)");

    for (let i = 0; i < lines.length; i++) {
        assertEquals(lines[i].includes("\n"), false, `rendered line ${i} should not contain embedded newlines`);
        assertEquals(lines[i].includes("\r"), false, `rendered line ${i} should not contain embedded carriage returns`);
    }

    const plain = lines.map((line) => stripAnsi(line)).join("\n");
    assertEquals(plain.includes("Consolidate formats - Move plan formats"), true);
});

Deno.test("ToolExecutionBlock error renders with consistent background", () => {
    const w = 100;
    const block = new ToolExecutionBlock("bash", "$ bad-command");
    block.appendOutput("command not found: bad-command\n");
    block.endExecution(true, 100);
    const lines = block.render(w);
    assertBlockBackground(lines, w, "ToolExecutionBlock(error)");
});

Deno.test("ToolExecutionBlock strips ANSI from tool output", () => {
    const w = 100;
    const block = new ToolExecutionBlock("bash", "$ ls --color");
    // Simulate colored ls output with full resets
    block.appendOutput("\x1b[35mfile.txt\x1b[0m\n\x1b[34mfolder\x1b[0m\n");
    block.endExecution(false, 50);
    // Body text should have ANSI stripped
    assertEquals(block.bodyText, "file.txt\nfolder\n");
    const lines = block.render(w);
    assertBlockBackground(lines, w, "ToolExecutionBlock(colored output)");
});

Deno.test("ToolExecutionBlock highlights the clickable plan review URL instruction", () => {
    const w = 120;
    const url = "http://127.0.0.1:4567/review/plan?token=test";
    const block = new ToolExecutionBlock("plan_written", "plan_written runtime-boundary");
    block.setOutput(
        "Plan name: docs/plans/runtime-boundary.md\n" +
            `Review Plan: \x1b]8;;${url}\x07${url}\x1b]8;;\x07\n` +
            "Status: Waiting for plan review decision.\n",
    );

    const rendered = block.render(w).join("\n");
    const plain = stripAnsi(rendered);

    assertEquals(plain.includes(`Review Plan: ${url}`), true);
    assertEquals(rendered.includes(`\x1b]8;;${url}\x07${url}\x1b]8;;\x07`), true);
    assertEquals(rendered.includes("\x1b[2mReview Plan:"), false);
});

Deno.test("ToolExecutionBlock expansion and truncation logic", () => {
    const w = 100;
    const block = new ToolExecutionBlock("bash", "$ echo lines");

    // Add more lines than previewLineLimit (6)
    for (let i = 0; i < 10; i++) {
        block.appendOutput(`line ${i}\n`);
    }

    // While collapsed (default), it should only show a subset of lines
    assertEquals(block.expanded, false);
    const collapsedLines = block.render(w);

    // Expand it
    block.setExpanded(true);
    const expandedLines = block.render(w);

    // The expanded render should be taller than the collapsed render
    assertEquals(expandedLines.length > collapsedLines.length, true);
});

Deno.test("ToolExecutionBlock limits expanded output while preserving its start and end", () => {
    const block = new ToolExecutionBlock("bash", "$ print many lines");
    block.setOutput(Array.from({ length: 1_000 }, (_, index) => `line ${index}`).join("\n"));
    block.setExpanded(true);

    const plain = block.render(100).map((line) => stripAnsi(line)).join("\n");

    assertEquals(plain.includes("line 0"), true);
    assertEquals(plain.includes("line 999"), true);
    assertEquals(plain.includes("line 500"), false);
    assertEquals(plain.includes("501 lines omitted"), true);
});

Deno.test("ToolExecutionGroupBlock bolds only the tool name in compact rows", () => {
    const block = new ToolExecutionBlock("set_session_name", "set_session_name Name Here");
    block.endExecution(false, 10);
    const group = new ToolExecutionGroupBlock();
    group.addBlock(block);

    const rendered = group.render(80).join("\n");
    const plain = stripAnsi(rendered);

    assertEquals(plain.includes("set_session_name Name Here"), true);
    assertEquals(rendered.includes(`${chalk.bold("set_session_name")} Name Here`), true);
    assertEquals(rendered.includes(chalk.bold("set_session_name Name Here")), false);
});

Deno.test("ToolExecutionGroupBlock renders compact rows inside padded block lines", () => {
    const w = 80;
    const group = new ToolExecutionGroupBlock();
    const pending = new ToolExecutionBlock("bash", "$ sleep 1");
    const success = new ToolExecutionBlock("read", "read docs/domain-language.md");
    const error = new ToolExecutionBlock("code_search", "code_search ToolExecution");

    success.endExecution(false, 120);
    error.endExecution(true, 80);
    group.addBlock(pending);
    group.addBlock(success);
    group.addBlock(error);

    const lines = group.render(w);
    assertEquals(lines.length, 5);
    assertBlockBackground(lines, w, "ToolExecutionGroupBlock(compact)");
    assertEquals(stripAnsi(lines[0]), " ".repeat(w));
    assertEquals(stripAnsi(lines.at(-1) || ""), " ".repeat(w));
    assertEquals(stripAnsi(lines[1]).startsWith("  $ sleep 1"), true);
    assertEquals(stripAnsi(lines[1]).endsWith("  "), true);
    assertEquals(stripAnsi(lines.join("\n")).includes("Elapsed time:"), false);
    assertEquals(stripAnsi(lines.join("\n")).includes("Took 0.1s"), true);

    const bgCodes = lines.map((line) => line.slice(0, line.indexOf("m") + 1));
    assertEquals(bgCodes[0], bgCodes.at(-1));
    assertEquals(bgCodes[0], bgCodes[2]);
    // Terminal palettes can map two semantic backgrounds to the same color.
    const pendingBg = theme.bg("toolPendingBg", " ");
    assertEquals(bgCodes[1], pendingBg.slice(0, pendingBg.indexOf("m") + 1));
    const errorBg = theme.bg("toolErrorBg", " ");
    assertEquals(bgCodes[3], errorBg.slice(0, errorBg.indexOf("m") + 1));
});

Deno.test("ToolExecutionGroupBlock uses error padding only when all compact children fail", () => {
    const w = 80;
    const successGroup = new ToolExecutionGroupBlock();
    const success = new ToolExecutionBlock("read", "read README.md");
    const failed = new ToolExecutionBlock("bash", "$ false");
    success.endExecution(false, 20);
    failed.endExecution(true, 30);
    successGroup.addBlock(failed);
    successGroup.addBlock(success);

    const errorGroup = new ToolExecutionGroupBlock();
    const firstError = new ToolExecutionBlock("bash", "$ false");
    const secondError = new ToolExecutionBlock("grep", "grep missing");
    firstError.endExecution(true, 20);
    secondError.endExecution(true, 30);
    errorGroup.addBlock(firstError);
    errorGroup.addBlock(secondError);

    assertEquals(
        successGroup.render(w)[0].slice(0, successGroup.render(w)[0].indexOf("m") + 1),
        success.render(w)[0].slice(0, success.render(w)[0].indexOf("m") + 1),
    );
    assertEquals(
        errorGroup.render(w)[0].slice(0, errorGroup.render(w)[0].indexOf("m") + 1),
        firstError.render(w)[0].slice(0, firstError.render(w)[0].indexOf("m") + 1),
    );
});

Deno.test("ToolExecutionGroupBlock keeps long multiline compact titles on one physical row", () => {
    const w = 30;
    const group = new ToolExecutionGroupBlock();
    const block = new ToolExecutionBlock("bash", "first line\nsecond line with enough text to overflow");
    group.addBlock(block);

    const lines = group.render(w);

    assertEquals(lines.length, 3);
    assertBlockBackground(lines, w, "ToolExecutionGroupBlock(narrow title)");
    assertEquals(lines[1].includes("\n"), false);
    assertEquals(stripAnsi(lines[1]).includes("second"), true);
});

Deno.test("ToolExecutionGroupBlock keeps duration visible when a long title can be truncated", () => {
    const w = 40;
    const group = new ToolExecutionGroupBlock();
    const block = new ToolExecutionBlock(
        "bash",
        "$ run a very long command name that needs truncation before the duration",
    );
    block.endExecution(false, 12300);
    group.addBlock(block);

    const lines = group.render(w);
    const row = stripAnsi(lines[1]);

    assertEquals(visibleLength(lines[1]), w);
    assertEquals(row.includes("Took 12.3s"), true);
});

Deno.test("ToolExecutionGroupBlock keeps compact rows within tiny widths", () => {
    const group = new ToolExecutionGroupBlock();
    group.addBlock(new ToolExecutionBlock("bash", "$ echo hi"));

    for (const w of [0, 1, 2]) {
        const lines = group.render(w);
        assertEquals(lines.every((line) => visibleLength(line) === w), true);
    }
});

Deno.test("ToolExecutionGroupBlock expands complete output and images, then collapses them", () => {
    const capabilities = getCapabilities();
    setCapabilities({ ...capabilities, images: "kitty" });
    try {
        const w = 100;
        const group = new ToolExecutionGroupBlock();
        const block = new ToolExecutionBlock("read", "read image.md");
        for (let i = 0; i < 10; i++) block.appendOutput(`line ${i}\n`);
        block.appendDisplayImage(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
            "image/png",
        );
        block.endExecution(false, 20);
        group.addBlock(block);

        const compact = stripAnsi(group.render(w).join("\n"));
        assertEquals(compact.includes("line 0"), false);
        assertEquals(compact.includes("image/png"), false);

        group.setExpanded(true);
        const expanded = stripAnsi(group.render(w).join("\n"));
        assertEquals(expanded.includes("line 0"), true);
        assertEquals(expanded.includes("line 9"), true);
        assertEquals(expanded.includes("iVBORw0KGgo"), true);

        group.setExpanded(false);
        const collapsed = stripAnsi(group.render(w).join("\n"));
        assertEquals(collapsed.includes("line 0"), false);
        assertEquals(collapsed.includes("image/png"), false);
    } finally {
        setCapabilities(capabilities);
    }
});

// ─── PromptSelectBlock ───────────────────────────────────────────────────────

Deno.test("PromptSelectBlock renders with uniform background", () => {
    const w = 100;
    const items = [
        { value: "option1", label: "Option 1", description: "First option" },
        { value: "option2", label: "Option 2", description: "Second option" },
    ];
    const block = new PromptSelectBlock("Choose:", items);
    block.focus();
    const lines = block.render(w);
    assertBlockBackground(lines, w, "PromptSelectBlock");

    // All lines should use the same bg color (selectedBg = surface0 = #313244)
    const bgCodes = lines.map((line) => {
        // deno-lint-ignore no-control-regex
        const m = line.match(/^\x1b\[(?:48;2;(\d+;\d+;\d+)|48;5;(\d+))m/);
        return m ? (m[1] || m[2]) : null;
    });
    const uniqueBgs = [...new Set(bgCodes)];
    assertEquals(uniqueBgs.length, 1, `PromptSelectBlock should have uniform bg, got: ${uniqueBgs.join(", ")}`);
});

Deno.test("PromptSelectBlock keeps a compact active layout", () => {
    const block = new PromptSelectBlock("Choose:", [
        { value: "option1", label: "Option 1" },
        { value: "option2", label: "Option 2" },
    ]);
    block.focus();
    const lines = block.render(100);
    assertEquals(lines.length, 9);
});

Deno.test("PromptSelectBlock handles long items that trigger truncation", () => {
    const w = 80;
    const items = [
        {
            value: "very-long-plan-name-that-will-be-truncated-by-the-select-list",
            label: "very-long-plan-name-that-will-be-truncated-by-the-select-list",
            description: "This description is also quite long and should trigger truncation in the list",
        },
        { value: "short", label: "Short", description: "A short one" },
    ];
    const block = new PromptSelectBlock("Resume plan:", items);
    block.focus();
    const lines = block.render(w);
    assertBlockBackground(lines, w, "PromptSelectBlock(truncated)");
});

Deno.test("PromptSelectBlock handles filtering and settling", () => {
    const items = [
        { value: "apple", label: "Apple", description: "Red fruit" },
        { value: "banana", label: "Banana", description: "Yellow fruit" },
    ];
    const block = new PromptSelectBlock("Choose fruit:", items);

    // Test Filtering: simulate typing "ban"
    block.handleInput("b");
    block.handleInput("a");
    block.handleInput("n");

    // The list should now only contain "banana"
    // @ts-ignore: Accessing private field for test verification
    assertEquals(block.list.filteredItems.length, 1);
    // @ts-ignore: Accessing private field for test verification
    assertEquals(block.list.filteredItems[0].value, "banana");

    // Test Navigation: clear filter
    block.input.setValue("");
    block.list.setFilter("");

    block.handleInput("\x1b[B");
    // @ts-ignore: Accessing private field for test verification
    assertEquals(block.list.selectedIndex > 0, true);

    // Test Settling
    block.settle("banana");
    assertEquals(block.settled, true);
    assertEquals(block.chosenValue, "banana");
});

// ─── PromptTextBlock ─────────────────────────────────────────────────────────

Deno.test("PromptTextBlock renders with uniform background", () => {
    const w = 100;
    const block = new PromptTextBlock("Enter value:");
    block.focus();
    const lines = block.render(w);
    assertBlockBackground(lines, w, "PromptTextBlock");

    // All lines should use the same bg color
    const bgCodes = lines.map((line) => {
        // deno-lint-ignore no-control-regex
        const m = line.match(/^\x1b\[(?:48;2;(\d+;\d+;\d+)|48;5;(\d+))m/);
        return m ? (m[1] || m[2]) : null;
    });
    const uniqueBgs = [...new Set(bgCodes)];
    assertEquals(uniqueBgs.length, 1, `PromptTextBlock should have uniform bg, got: ${uniqueBgs.join(", ")}`);
});

Deno.test("PromptTextBlock handles input and settling", () => {
    const block = new PromptTextBlock("Enter value:");
    block.focus();

    // Simulate typing
    block.handleInput("h");
    block.handleInput("i");

    assertEquals(block.input.getValue(), "hi");

    block.settle(block.input.getValue());

    assertEquals(block.settled, true);
    assertEquals(block.chosenValue, "hi");

    // Verify visual output changes to a finalized line (contains "hi")
    const lines = block.render(80);
    const plainTextLines = lines.map((line) => stripAnsi(line));
    assertEquals(plainTextLines.some((line) => line.includes("hi")), true);
});

// ─── SpinnerBlock ────────────────────────────────────────────────────────────

Deno.test("SpinnerBlock renders full-width lines when busy", () => {
    const w = 80;
    const spinner = new SpinnerBlock();
    spinner.setBusy(true);
    const lines = spinner.render(w);
    for (let i = 0; i < lines.length; i++) {
        const vl = visibleLength(lines[i]);
        assertEquals(vl, w, `SpinnerBlock line ${i}: visible length should be ${w}, got ${vl}`);
    }
});

Deno.test("Spinner cycles animation frames", () => {
    const spinner = new SpinnerBlock();
    spinner.setBusy(true);

    const frame1 = spinner.render(80)[0];
    spinner.advance();
    const frame2 = spinner.render(80)[0];

    assertNotEquals(frame1, frame2);
});

Deno.test("SpinnerBlock renders tasks when provided", () => {
    const spinner = new SpinnerBlock();
    spinner.setBusy(true, [{ task: 1, assignee: "agent", description: "doing work" }]);

    const lines = spinner.render(80);
    const plainText = stripAnsi(lines[0]);
    assertEquals(plainText.includes("agent"), true);
    assertEquals(plainText.includes("Task 1"), true);
});

Deno.test("SpinnerBlock shows Working... fallback when no busyLines set", () => {
    const spinner = new SpinnerBlock();
    spinner.setBusy(true);
    const plainText = stripAnsi(spinner.render(80)[0]);
    assertEquals(plainText.includes("Working..."), true);
});

Deno.test("SpinnerBlock shows agent busy line when busyLines are set", () => {
    const spinner = new SpinnerBlock();
    spinner.setBusy(true);
    spinner.setBusyLines(["Planning...", "Drafting the plan...", "Thinking through the steps..."]);
    const plainText = stripAnsi(spinner.render(80)[0]);
    assertEquals(
        plainText.includes("Planning...") || plainText.includes("Drafting the plan...") ||
            plainText.includes("Thinking through the steps..."),
        true,
    );
});

Deno.test("SpinnerBlock keeps the busy line stable throughout a turn", () => {
    const spinner = new SpinnerBlock();
    const labels = ["Line A", "Line B", "Line C"];
    spinner.setBusy(true);
    spinner.setBusyLines(labels);
    const label = labels.find((line) => stripAnsi(spinner.render(80)[0]).includes(line));
    assert(label);
    for (let i = 0; i < 10; i++) {
        spinner.advance();
        spinner.setBusy(true);
        assertEquals(stripAnsi(spinner.render(80)[0]).includes(label), true);
    }
});

Deno.test("SpinnerBlock selects a new busy line when the Agent switches", () => {
    const spinner = new SpinnerBlock();
    spinner.setBusy(true);
    spinner.setBusyLines(["Ideating..."]);
    assertEquals(stripAnsi(spinner.render(80)[0]).includes("Ideating..."), true);
    spinner.setBusyLines(["Coding..."]);
    assertEquals(stripAnsi(spinner.render(80)[0]).includes("Coding..."), true);
    spinner.advance();
    assertEquals(stripAnsi(spinner.render(80)[0]).includes("Coding..."), true);
    spinner.setBusy(false);
    assertEquals(spinner.render(80), []);
    spinner.setBusy(true);
    assertEquals(stripAnsi(spinner.render(80)[0]).includes("Coding..."), true);
});

Deno.test("SpinnerBlock uses Working... when switching to an Agent without busy lines", () => {
    const spinner = new SpinnerBlock();
    spinner.setBusy(true);
    spinner.setBusyLines(["Ideating..."]);
    spinner.render(80);
    spinner.setBusyLines(undefined);
    assertEquals(stripAnsi(spinner.render(80)[0]).includes("Working..."), true);
    spinner.setBusy(false);
    spinner.setBusy(true);
    assertEquals(stripAnsi(spinner.render(80)[0]).includes("Working..."), true);
});

/** @type {import('../../shared/session/session-runtime-events.js').RuntimeValidationProgress} */
const verifiedReportProgress = {
    kind: "mechanical",
    outcome: "verified",
    stage: "terminal",
    checks: { ci: "passed", semanticReview: "skipped", humanReview: "skipped", merge: "skipped" },
    message: "done",
};

Deno.test("ValidationHandoffBlock caches panel lines until state changes", () => {
    const state = {
        progress: verifiedReportProgress,
        engineer: { agentName: "Engineer", markdown: "# report one", completedOrder: 1 },
        reviewer: null,
    };
    const block = new ValidationHandoffBlock(state);

    const first = block.render(80);
    const second = block.render(80);
    assertEquals(second, first, "idle frames should reuse the cached panel lines");

    block.setState({
        progress: verifiedReportProgress,
        engineer: { agentName: "Engineer", markdown: "# report two", completedOrder: 2 },
        reviewer: null,
    });
    const third = block.render(80);
    assert(third !== first, "new report markdown must rebuild the panel");
    assertEquals(stripAnsi(third.join("\n")).includes("report two"), true);
});

Deno.test("ValidationHandoffBlock rebuilds report lines after invalidate", () => {
    const block = new ValidationHandoffBlock({
        progress: verifiedReportProgress,
        engineer: { agentName: "Engineer", markdown: "# keep me", completedOrder: 1 },
        reviewer: null,
    });
    const before = block.render(80);

    block.invalidate();
    const after = block.render(80);
    assertEquals(after, before);
    assertEquals(stripAnsi(after.join("\n")).includes("keep me"), true);
});

// ─── Settled-block line caches (typing must not re-render history) ───────────

Deno.test("ToolExecutionBlock reuses cached lines across idle frames", () => {
    const block = new ToolExecutionBlock("bash", "run tests");
    block.setOutput("ok line one\nok line two");
    block.endExecution(false, 120);

    const first = block.render(80);
    assert(first === block.render(80), "idle frames should reuse the cached lines array");

    block.setOutput("ok line one\nok line two\nok line three");
    assert(block.render(80) !== first, "new output must rebuild lines");
});

Deno.test("ToolExecutionBlock rebuilds lines after invalidate", () => {
    const block = new ToolExecutionBlock("bash", "run tests");
    block.setOutput("ok");
    block.endExecution(false, 10);

    const before = block.render(80);
    block.invalidate();
    const after = block.render(80);
    assert(after !== before, "invalidate must drop the cache for the next frame");
    assertEquals(after, before);
});

Deno.test("ToolExecutionBlock clock keeps rebuilding while running", () => {
    const originalNow = Date.now;
    let now = 1000;
    Date.now = () => now;
    try {
        const block = new ToolExecutionBlock("bash", "$ sleep 1");
        block.enableElapsedTime();
        const first = block.render(100);
        now = 1500;
        block.enableElapsedTime();
        const second = block.render(100);
        assert(first !== second, "the elapsed footer must move with the 100ms timer");
        assert(stripAnsi(second.join("\n")).includes("Elapsed time: 0.5s"));
    } finally {
        Date.now = originalNow;
    }
});

Deno.test("ThinkingBlock caches idle frames and clears on new deltas", () => {
    const block = new ThinkingBlock({});
    block.appendText("considering the plan");
    block.end();

    const first = block.render(80);
    assert(first === block.render(80), "settled thinking should reuse lines");

    block.appendText(" more");
    const second = block.render(80);
    assert(second !== first, "new deltas must rebuild lines");

    block.invalidate();
    const third = block.render(80);
    assert(third !== second, "invalidate must drop the thinking cache");
    assertEquals(third, second);
});

Deno.test("ToolExecutionGroupBlock forwards invalidate to child tool blocks", () => {
    const group = new ToolExecutionGroupBlock();
    const child = new ToolExecutionBlock("bash", "run tests");
    child.setOutput("ok");
    child.endExecution(false, 10);
    group.addBlock(child);

    const before = child.render(80);
    group.invalidate();
    const after = child.render(80);
    assert(after !== before, "theme swaps must reach tool caches inside groups");
    assertEquals(after, before);
});
