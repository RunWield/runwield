import { mkdtemp, rm } from "node:fs/promises";
import { test } from "node:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { assertEquals, assertRejects, assertStringIncludes } from "../../testing/assertions.ts";
import { NO_OPEN_BROWSER_PORT } from "../../shared/browser-port.ts";
import { createTuiInteractionAdapter } from "./runtime-interaction-adapter.ts";
import { getStoredPlanPath, savePlan } from "../../plan-store.ts";
import { createScriptedReviewBrowser } from "../review/review-test-fixture.ts";
import { createUiApiFixture } from "./ui-api-test-fixture.ts";

// Real prompt components receive terminal input; only the browser is controlled.
test("TUI approval requires an affirmative selection, including a sole deny option", async () => {
    const view = createUiApiFixture();
    try {
        const adapter = createTuiInteractionAdapter(view.uiAPI, { browser: NO_OPEN_BROWSER_PORT });
        for (const value of ["deny", "approve"]) {
            const pending = adapter.requestInteraction({
                type: "approval",
                prompt: "Approve the change?",
                options: [{ value, label: value }],
            });
            assertStringIncludes(view.allText(), "Approve the change?");
            view.terminal.pressEnter();
            const response = await pending;
            assertEquals(response.outcome, value === "approve" ? "accepted" : "canceled");
            assertEquals(response.value, value === "approve");
        }
    } finally {
        view.close();
    }
});

test("TUI dismisses a question answered elsewhere and permits the next question", async () => {
    const view = createUiApiFixture();
    try {
        const adapter = createTuiInteractionAdapter(view.uiAPI, { browser: NO_OPEN_BROWSER_PORT });
        const controller = new AbortController();
        const pending = adapter.requestInteraction(
            { type: "select", prompt: "Choose first", options: [{ value: "first", label: "First" }] },
            controller.signal,
        );
        assertStringIncludes(view.allText(), "Choose first");
        controller.abort();
        assertEquals((await pending).outcome, "canceled");
        assertEquals(view.uiAPI.focusActivePrompt?.(), false);
        const next = adapter.requestInteraction({ type: "text", prompt: "Next question" });
        view.terminal.typeText("still usable");
        view.terminal.pressEnter();
        assertEquals(await next, { outcome: "text", value: "still usable" });
    } finally {
        view.close();
    }
});

test("TUI presents the full Plan Deviation before accepting or canceling it", async () => {
    const view = createUiApiFixture();
    try {
        const adapter = createTuiInteractionAdapter(view.uiAPI, { browser: NO_OPEN_BROWSER_PORT });
        const tail = "This persistence warning must stay visible.";
        const pending = adapter.requestInteraction({
            type: "plan_deviation_confirmation",
            prompt: `Superseded: replace nav. Replacement: keep nav.\n${"x".repeat(650)}\n${tail}`,
        });
        assertStringIncludes(view.allText(), "Superseded: replace nav. Replacement: keep nav.");
        assertStringIncludes(view.allText(), tail);
        view.terminal.pressEnter();
        assertEquals(await pending, { outcome: "accepted", value: true });
        const canceled = adapter.requestInteraction({
            type: "plan_deviation_confirmation",
            prompt: "Another deviation",
        });
        view.terminal.input("\x1b[B");
        view.terminal.pressEnter();
        assertEquals(await canceled, { outcome: "canceled" });
    } finally {
        view.close();
    }
});

test("TUI Plan review returns feedback and remains usable after a missing Plan", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "runwield-review-progress-"));
    const view = createUiApiFixture();
    const scripted = createScriptedReviewBrowser("deny", { feedback: "Add a test" });
    const adapter = createTuiInteractionAdapter(view.uiAPI, { browser: scripted.browser });
    try {
        await savePlan(cwd, "plan", "# Plan\n\nDo the work.\n", {
            planId: "tui-review-plan",
            classification: "PLANNED_CHANGE",
            status: "draft",
        });
        const request = {
            type: "plan_review" as const,
            prompt: "Review the Plan",
            _meta: { cwd, planName: "plan", planPath: getStoredPlanPath(cwd, "plan") },
        };
        const response = await adapter.requestInteraction(request);
        assertEquals(response.outcome, "selected");
        assertEquals(response._meta?.feedback, "Add a test");
        await rm(request._meta.planPath);
        await assertRejects(() => adapter.requestInteraction(request));
        const next = adapter.requestInteraction({ type: "text", prompt: "Continue after failed review" });
        view.terminal.typeText("retry");
        view.terminal.pressEnter();
        assertEquals(await next, { outcome: "text", value: "retry" });
    } finally {
        view.close();
        await rm(cwd, { recursive: true });
    }
});

test("TUI Code Review exposes its live URL until cancellation, then keeps approval pending", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "runwield-tui-code-wait-"));
    const view = createUiApiFixture();
    const controller = new AbortController();
    const adapter = createTuiInteractionAdapter(view.uiAPI, { browser: NO_OPEN_BROWSER_PORT });
    let surfaceUrl = "";
    try {
        const response = await adapter.requestInteraction(
            {
                type: "code_review",
                prompt: "Review",
                _meta: {
                    planName: "feature",
                    diffText: "diff --git a/a b/a\n",
                    executionCwd: cwd,
                    onSurfaceReady: (surface: { url: string }) => {
                        surfaceUrl = surface.url;
                        for (const width of [60, 120]) {
                            const rendered = view.tui.render(width).join("\n");
                            assertStringIncludes(rendered, "Waiting for Code Review");
                            assertStringIncludes(rendered, `\x1b]8;;${surface.url}\x07`);
                        }
                        controller.abort();
                    },
                },
            },
            controller.signal,
        );
        assertEquals(response.outcome, "canceled");
        assertEquals(surfaceUrl.length > 0, true);
        assertEquals(view.allText().includes(surfaceUrl), false);
        assertStringIncludes(view.allText(), "approval is still pending");
        assertStringIncludes(view.allText(), "/load-plan feature");
    } finally {
        controller.abort();
        view.close();
        await rm(cwd, { recursive: true });
    }
});

test("TUI Code Review renders approval and clears a failed review without a live link", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "runwield-tui-code-result-"));
    const view = createUiApiFixture();
    const scripted = createScriptedReviewBrowser("decision", { approved: true, reviewRevision: 0 });
    const adapter = createTuiInteractionAdapter(view.uiAPI, { browser: scripted.browser });
    try {
        const response = await adapter.requestInteraction({
            type: "code_review",
            prompt: "Review",
            _meta: { planName: "feature", diffText: "diff --git a/a b/a\n", executionCwd: cwd },
        });
        assertEquals(response.outcome, "accepted");
        assertStringIncludes(view.allText(), "Code Review approved.");
        assertEquals(view.allText().includes(scripted.urls[0]), false);
        await assertRejects(() =>
            adapter.requestInteraction({
                type: "code_review",
                prompt: "Review",
                _meta: { planName: "broken", diffText: "", executionCwd: "" },
            }),
        );
        assertStringIncludes(view.allText(), "Code Review could not be opened.");
        assertEquals(view.tui.render(120).join("\n").includes("\x1b]8;;http"), false);
    } finally {
        view.close();
        await rm(cwd, { recursive: true });
    }
});
