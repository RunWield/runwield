import { test } from "node:test";
import { getCapabilities, setCapabilities } from "@earendil-works/pi-tui";
import { assertEquals, assertStringIncludes, assertThrows } from "../../testing/assertions.ts";
import { emitHostedSessionRuntimeEvent } from "../../shared/session/session-runtime-events.js";
import stripAnsi from "strip-ansi";
import { NO_OPEN_BROWSER_PORT } from "../../shared/browser-port.ts";
import { attachTuiRuntimeAdapter } from "./runtime-adapter.ts";
import { withSessionViewFixture } from "./testing/session-view-fixture.ts";
import { createUiApiFixture } from "./ui-api-test-fixture.ts";

/**
 * @typedef {Parameters<Parameters<typeof withSessionViewFixture>[0]>[0]} SessionFixture
 * @typedef {{type: "image", data: string, mimeType: string}} DisplayImage
 * @typedef {Partial<import('../../shared/session/session-runtime-events.js').SessionRuntimeEvent> & {type: string}} EventDraft
 * @typedef {ReturnType<typeof createUiApiFixture> & Pick<SessionFixture, 'runtime' | 'sessionId' | 'session'> & {adapter: ReturnType<typeof attachTuiRuntimeAdapter>, options: Parameters<typeof attachTuiRuntimeAdapter>[0], notifications: string[], completions: string[], emit: (event: EventDraft) => boolean, panel: () => string}} AdapterFixture
 */
/**
 * @param {(fixture: AdapterFixture) => Promise<void> | void} check
 * @param {Parameters<SessionFixture['session']['replaceWorkflowContext']>[0]} context
 */
async function withAdapter(check, context = { routingIntent: "FEATURE", complexity: "LOW" }) {
    await withSessionViewFixture(async ({ runtime, sessionId, session }) => {
        session.replaceWorkflowContext(context);
        const ui = createUiApiFixture();
        /** @type {string[]} */
        const notifications = [];
        /** @type {string[]} */
        const completions = [];
        /** @type {Parameters<typeof attachTuiRuntimeAdapter>[0]} */
        const options = {
            runtime,
            sessionId,
            uiAPI: ui.uiAPI,
            browser: NO_OPEN_BROWSER_PORT,
            notifyRunWieldEvent: (reason) => notifications.push(reason),
            onSessionComplete: (id) => completions.push(id),
        };
        const adapter = attachTuiRuntimeAdapter(options);
        try {
            await check({
                ...ui,
                runtime,
                sessionId,
                session,
                adapter,
                options,
                notifications,
                completions,
                emit: (event) =>
                    emitHostedSessionRuntimeEvent(session, {
                        ...(event.type.startsWith("tool_")
                            ? {
                                  title: "toolName" in event ? event.toolName : "",
                                  kind: "execute",
                                  content: [],
                                  details: null,
                                  durationMs: 0,
                              }
                            : {}),
                        ...(event.type.startsWith("assistant_") ? { agentName: "Guide" } : {}),
                        ...event,
                    }),
                panel: () => stripAnsi(ui.validation.render(120).join("\n")),
            });
        } finally {
            adapter.dispose();
            ui.close();
        }
    });
}
/** @type {import("../../shared/session/session-runtime-events.js").RuntimeValidationCheckResults} */
const checks = { ci: "passed", semanticReview: "passed", humanReview: "skipped", merge: "passed" };
/** @param {"running" | "verified" | "paused" | "failed"} outcome @returns {import("../../shared/session/session-runtime-events.js").RuntimeValidationProgress} */
const progress = (outcome = "running") => ({
    kind: "workflow",
    cycle: 1,
    maxCycles: 3,
    totalCycle: 1,
    outcome,
    stage: outcome === "running" ? "semantic_review" : "terminal",
    checks: { ...checks, merge: outcome === "failed" ? "failed" : "passed" },
});
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test("real TUI renders semantic messages, tool results and safe failures without duplicate diagnostics", async () => {
    await withAdapter(({ emit, allText, uiAPI }) => {
        emit({ type: "user_message", text: "Inspect this change", images: [] });
        emit({
            type: "assistant_thinking_delta",
            messageId: "thought",
            delta: "Inspecting the implementation",
            agentName: "Guide",
        });
        emit({ type: "assistant_thinking_end", messageId: "thought", agentName: "Guide" });
        emit({ type: "tool_start", toolCallId: "read", toolName: "read", title: "read README.md", kind: "read" });
        emit({
            type: "tool_end",
            toolCallId: "read",
            toolName: "read",
            output: "Important file contents",
            content: [{ type: "text", text: "Important file contents" }],
            isError: false,
            durationMs: 10,
        });
        uiAPI.toggleToolOutputsExpanded?.();
        emit({
            type: "assistant_text_delta",
            messageId: "answer",
            delta: "The change is ready.",
            agentName: "Guide",
            messageKind: "assistant",
        });
        emit({ type: "system_status", level: "error", message: "Blocked: read_file" });
        emit({ type: "terminal_error", message: "Blocked: read_file", messageAlreadyReported: true });
        emit({
            type: "terminal_error",
            message: "The model service stopped responding before the reply was complete.",
            error: "SECRET diagnostic stack",
        });
        for (const expected of [
            "Inspect this change",
            "Inspecting the implementation",
            "Important file contents",
            "The change is ready.",
            "The model service stopped responding",
        ])
            assertStringIncludes(allText(), expected);
        assertEquals(allText().split("Blocked: read_file").length - 1, 1);
        assertEquals(allText().includes("SECRET"), false);
    });
});

test("real TUI validation reports survive model changes and clear on settlement or failure", async () => {
    await withAdapter(({ emit, panel, allText }) => {
        emit({ type: "model_changed", model: "test/model" });
        emit({ type: "thinking_level_changed", thinkingLevel: "medium" });
        emit({
            type: "assistant_text_delta",
            messageId: "implementation",
            delta: "Feature implemented",
            agentName: "Engineer",
            messageKind: "workflow",
            workflowMessage: "task_completed",
        });
        emit({ type: "system_status", message: "Checking changes", level: "info", validationProgress: progress() });
        emit({
            type: "assistant_text_delta",
            messageId: "review",
            delta: "Missing guard",
            agentName: "Reviewer",
            messageKind: "workflow",
            workflowMessage: "review_report_update",
            approved: false,
        });
        assertStringIncludes(panel(), "Feature implemented");
        assertStringIncludes(panel(), "Missing guard");
        assertEquals(stripAnsi(allText()).split("Missing guard").length - 1, 1);
        emit({
            type: "system_status",
            message: "Validation complete",
            level: "success",
            validationProgress: progress("verified"),
        });
        assertEquals(panel(), "");
        emit({ type: "system_status", message: "Checking another change", validationProgress: progress() });
        emit({ type: "terminal_error", message: "Runtime crashed" });
        assertEquals(panel(), "");
        assertStringIncludes(allText(), "Runtime crashed");
    });
});

test("ordinary operations do not leak old completion reports into a later validation", async () => {
    await withAdapter(
        ({ emit, panel }) => {
            emit({
                type: "assistant_text_delta",
                messageId: "operation",
                delta: "Ordinary operation done",
                agentName: "Operator",
                messageKind: "workflow",
                workflowMessage: "task_completed",
            });
            emit({ type: "system_status", message: "Checking", validationProgress: progress() });
            assertEquals(panel().includes("Ordinary operation done"), false);
        },
        { routingIntent: "OPERATION", complexity: "LOW" },
    );
    await withAdapter(({ emit, panel }) => {
        emit({
            type: "assistant_text_delta",
            messageId: "old",
            delta: "Old completion",
            agentName: "Engineer",
            messageKind: "workflow",
            workflowMessage: "task_completed",
        });
        emit({ type: "user_message", text: "A new request", images: [] });
        emit({ type: "system_status", message: "Checking", validationProgress: progress() });
        assertEquals(panel().includes("Old completion"), false);
    });
});

test("replayed thinking and hidden workflow plumbing stay out of the transcript", async () => {
    await withAdapter(({ emit, allText, runtime, sessionId }) => {
        emit({
            type: "assistant_thinking_delta",
            messageId: "old",
            delta: "old private thought",
            _meta: { replay: true },
        });
        emit({ type: "assistant_thinking_end", messageId: "old", _meta: { replay: true } });
        emit({ type: "tool_start", toolCallId: "triage", toolName: "triage_report", title: "triage_report" });
        emit({
            type: "tool_end",
            toolCallId: "triage",
            toolName: "triage_report",
            output: "hidden plumbing",
            isError: false,
        });
        emit({ type: "user_message", text: "!printf local-output", images: [] });
        emit({ type: "tool_start", toolCallId: "local", toolName: "bash", title: "! printf local-output" });
        emit({ type: "tool_end", toolCallId: "local", toolName: "bash", output: "local-output", isError: false });
        assertEquals(allText().includes("old private thought"), false);
        assertEquals(allText().includes("hidden plumbing"), false);
        assertEquals(allText().includes("!printf local-output"), false);
        assertStringIncludes(allText(), "! printf local-output");
        runtime.requestSessionHelp(sessionId);
        assertStringIncludes(allText(), "Keyboard shortcuts");
    });
});

test("a duplicate TUI attachment cannot duplicate output and disposal settles an active real prompt", async () => {
    await withAdapter(async ({ options, adapter, runtime, sessionId, terminal, allText, uiAPI, emit }) => {
        assertThrows(() => attachTuiRuntimeAdapter(options), Error, "already attached");
        emit({
            type: "assistant_text_delta",
            messageId: "answer",
            delta: "Only once",
            agentName: "Guide",
            messageKind: "assistant",
        });
        assertEquals(allText().split("Only once").length - 1, 1);
        const pending = uiAPI.promptText("Pending question");
        assertStringIncludes(allText(), "Pending question");
        adapter.dispose();
        assertEquals(await pending, null);
        const next = attachTuiRuntimeAdapter(options);
        try {
            const question = runtime.requestInteraction(sessionId, { type: "text", prompt: "Next question" });
            for (let attempt = 0; attempt < 200 && !allText().includes("Next question"); attempt++)
                await new Promise((resolve) => setTimeout(resolve, 10));
            assertStringIncludes(allText(), "Next question");
            terminal.typeText("Answer after replacement");
            terminal.pressEnter();
            assertEquals((await question).value, "Answer after replacement");
        } finally {
            next.dispose();
        }
    });
});

test("TUI attention belongs to its surface and completion requires current settled publication", async () => {
    for (const outcome of /** @type {const} */ (["verified", "failed", "paused"]))
        for (const replay of [false, true]) {
            await withAdapter(async ({ emit, completions, notifications, sessionId, session }) => {
                for (const notificationSurface of /** @type {const} */ (["workspace", "acp", "tui"])) {
                    session.notificationSurface = notificationSurface;
                    emit({ type: "attention_requested", reason: "agentStopped" });
                }
                assertEquals(notifications, ["agentStopped"]);
                emit({ type: "busy_changed", busy: false });
                emit({
                    type: "system_status",
                    message: "Workflow settled",
                    validationProgress: progress(outcome),
                    _meta: { replay },
                });
                await tick();
                assertEquals(completions, []);
                emit({ type: "busy_changed", busy: false });
                emit({ type: "busy_changed", busy: false });
                await tick();
                assertEquals(completions, outcome === "verified" && !replay ? [sessionId] : []);
            });
        }
    for (const replace of [false, true])
        await withAdapter(async ({ emit, completions, adapter }) => {
            emit({ type: "system_status", message: "Published", validationProgress: progress("verified") });
            if (replace) adapter.dispose();
            else emit({ type: "user_message", text: "Follow up", images: [] });
            emit({ type: "busy_changed", busy: false });
            await tick();
            assertEquals(completions, []);
        });
});

test("TUI retains repeated message IDs from different segments and removes only consumed queue entries", async () => {
    await withAdapter(async ({ emit, allText, runtime, sessionId, adapter, options }) => {
        for (const [segment, text] of [
            ["planning", "Planning request"],
            ["execution", "Execution request"],
            ["execution", "Execution request"],
        ]) {
            emit({
                type: "user_message",
                eventId: `${segment}:duplicate:user_message:0`,
                messageId: "duplicate",
                text,
                images: [],
            });
        }
        assertEquals(allText().split("Planning request").length - 1, 1);
        assertEquals(allText().split("Execution request").length - 1, 1);
        runtime.queueNextTurnMessage(sessionId, "First queued request", []);
        runtime.queueNextTurnMessage(sessionId, "Second queued request", []);
        assertStringIncludes(allText(), "First queued request");
        assertStringIncludes(allText(), "Second queued request");
        adapter.dispose();
        const next = attachTuiRuntimeAdapter(options);
        try {
            assertEquals(allText().split("First queued request").length - 1, 1);
            await runtime.dequeueLastQueuedMessage(sessionId);
            assertStringIncludes(allText(), "First queued request");
            assertEquals(allText().includes("Second queued request"), false);
        } finally {
            next.dispose();
        }
    });
});

test("TUI preserves read-tool images and hidden-tool image fallback without repeating root handoffs", async () => {
    await withAdapter(({ emit, allText, uiAPI }) => {
        const previousCapabilities = getCapabilities();
        setCapabilities({ ...previousCapabilities, images: null });
        try {
            /** @type {DisplayImage} */
            const image = {
                type: "image",
                data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
                mimeType: "image/png",
            };
            emit({
                type: "tool_start",
                toolCallId: "image-read",
                toolName: "read",
                title: "Read diagram.png",
                kind: "read",
            });
            emit({
                type: "tool_end",
                toolCallId: "image-read",
                toolName: "read",
                output: "Read image",
                content: [image],
                isError: false,
            });
            uiAPI.toggleToolOutputsExpanded?.();
            assertStringIncludes(allText(), "[image/png");
            const before = allText().split("[image/png").length;
            emit({
                type: "tool_end",
                toolCallId: "hidden-image",
                toolName: "task_completed",
                output: "",
                content: [image],
                isError: false,
            });
            assertEquals(allText().split("[image/png").length, before + 1);
            emit({ type: "agent_changed", agentName: "guide", displayName: "Guide", rootHandoff: true });
            emit({ type: "agent_changed", agentName: "guide", displayName: "Guide", rootHandoff: true });
            assertEquals(allText().split("Agent switched to Guide").length - 1, 1);
        } finally {
            setCapabilities(previousCapabilities);
        }
    });
});
