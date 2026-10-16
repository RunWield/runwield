import { test } from "node:test";
import { assertEquals, assertStringIncludes } from "../../testing/assertions.ts";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { withRuntimeCommandFixture } from "../../cmd/testing/runtime-command-fixture.ts";
import { createSessionRuntime } from "./session-runtime.ts";
import { createInteractiveCompositionHarness } from "../../ui/tui/testing/interactive-composition-fixture.ts";
import { setCustomSetting } from "../settings.js";
import { openFileSessionStore } from "./file-session-store.ts";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { readRequestAttemptEntries } from "./request-dispatch.ts";
import { captureTranscriptEvidence } from "./session-transcript-projection.js";

test("Operator accepts a follow-up after task_completed settles", async () => {
    await withRuntimeCommandFixture("operator-follow-up-", async ({ projectRoot, setModelResponseFactories }) => {
        await setCustomSetting("workflowMetrics", true, "project", projectRoot);
        let followUpContext = "";
        setModelResponseFactories([
            () =>
                fauxAssistantMessage(fauxToolCall("triage_report", {
                    routingIntent: "OPERATION",
                    complexity: "LOW",
                    summary: "Perform the operation.",
                    sessionName: "Operator continuation",
                })),
            () => fauxAssistantMessage(fauxToolCall("task_completed", { message: "Operation verified." })),
            (context) => {
                followUpContext = JSON.stringify(context.messages);
                return fauxAssistantMessage(fauxText("Follow-up received."));
            },
        ]);
        const store = openFileSessionStore();
        const runtime = createSessionRuntime({ ownerProcessKind: "test", sessionStore: store });
        try {
            const { sessionId } = await runtime.createInteractiveSession({ cwd: projectRoot, mode: "new" });
            const first = await runtime.promptUserTurn(sessionId, { initialRequest: "Perform the operation." });
            assertEquals(first.ok, true);
            const managedId = runtime.getSessionSnapshot(sessionId)?.managed?.runwieldSessionId || "";
            const transcript = store.getCurrentSessionSegment(managedId)?.transcriptPath || "";
            const attempts = readRequestAttemptEntries(SessionManager.open(transcript));
            const started = attempts.filter((attempt) => attempt.phase === "started");
            assertEquals(started.length, 2);
            for (const attempt of started) {
                assertEquals(
                    attempts.filter((entry) => entry.attemptId === attempt.attemptId).at(-1)?.phase,
                    "completed",
                    "Every dispatched turn must finish its transcript writes before the Session checkpoint",
                );
            }
            const generation = store.inspectSessionActivation(managedId).generation;
            const evidence = await captureTranscriptEvidence({
                transcriptPath: transcript,
                transcriptCwd: projectRoot,
            });
            assertEquals(evidence.byteLength, generation?.byteLength);
            assertEquals(evidence.digestHex, generation?.digestHex);
            assertEquals(evidence.terminalEntryId, generation?.terminalEntryId);
            const second = await runtime.promptUserTurn(sessionId, { initialRequest: "Explain the result." });
            assertEquals(second.ok, true);
            assertEquals(second.restoreDraft, false);
            assertStringIncludes(followUpContext, "Operation verified.");
            assertStringIncludes(followUpContext, "Explain the result.");
            assertEquals(runtime.getSessionSnapshot(sessionId)?.activeAgent, "operator");
        } finally {
            await runtime.closeAllSessionsWhenIdle();
            store.close();
        }
    });
});

test("TUI sends the first follow-up after a skill routes to Operator completion", async () => {
    await withRuntimeCommandFixture("operator-tui-follow-up-", async ({ setModelResponseFactories }) => {
        let followUps = 0;
        setModelResponseFactories([
            () =>
                fauxAssistantMessage(fauxToolCall("triage_report", {
                    routingIntent: "OPERATION",
                    complexity: "LOW",
                    summary: "Review the changes.",
                    sessionName: "Operator review",
                })),
            () => fauxAssistantMessage(fauxToolCall("task_completed", { message: "Operation verified." })),
            () => {
                followUps++;
                return fauxAssistantMessage(fauxText("Follow-up received."));
            },
        ]);
        const harness = createInteractiveCompositionHarness();
        try {
            await harness.waitForComposition();
            await harness.type("/skill:review review the changes");
            await harness.pressKey("enter");
            await harness.waitForScreen("Operation verified.");
            await harness.waitForIdle();
            await harness.type("Explain the result.");
            await harness.pressKey("enter");
            await harness.waitForScreen("Follow-up received.");
            await harness.waitForIdle();
            assertEquals(followUps, 1);
            assertEquals(harness.terminal.getScrollbackText().includes("could not send that message"), false);
        } finally {
            await harness.dispose();
        }
    });
});
