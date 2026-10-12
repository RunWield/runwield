import { DEV_DELIVERY_REPORT } from "../workspace/server/dev-delivery-fixture.ts";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { TuiAltScreen } from "@earendil-works/pi-tui";
import { withSessionViewFixture } from "./testing/session-view-fixture.ts";
import { createChatView } from "./chat-view.ts";
import { createChatInputController } from "./chat-input-controller.ts";
import { attachTuiRuntimeAdapter } from "./runtime-adapter.js";
import { NO_OPEN_BROWSER_PORT } from "../../shared/browser-port.ts";
import { emitHostedSessionRuntimeEvent, RuntimeEventTypes } from "../../shared/session/session-runtime-events.js";
import { VirtualTerminal } from "./testing/virtual-terminal.js";

async function waitFor(predicate: () => boolean): Promise<void> {
    const deadline = performance.now() + 5000;
    while (!predicate()) {
        if (performance.now() > deadline) throw new Error("Timed out waiting for completion UI");
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
}

for (const columns of [60, 140]) {
    for (const choice of ["new", "load-plan", "escape", "record-failed", "record-retry"]) {
        Deno.test(`completion choices stay visible at ${columns} columns and ${choice} works`, async () => {
            await withSessionViewFixture(async ({ runtime, sessionId, session, projectRoot }) => {
                await Deno.mkdir(`${projectRoot}/docs/plans`, { recursive: true });
                await Deno.writeTextFile(
                    `${projectRoot}/docs/plans/next-change.md`,
                    "---\nstatus: draft\nclassification: PLANNED_CHANGE\nplanId: next-change\n---\n# Next change\n",
                );
                if (choice === "record-retry") {
                    const { savePlan } = await import("../../plan-store.js");
                    await savePlan(projectRoot, "record-retry", "# Delivered", {
                        planId: "record-retry",
                        classification: "PLANNED_CHANGE",
                        status: "verified",
                        workRecord: {
                            status: "generated",
                            recordId: "existing",
                            path: "docs/work-records/existing.md",
                        },
                    });
                }
                const capture = Deno.env.get("RUNWIELD_DELIVERY_SCREENSHOT") && columns === 140 && choice === "new";
                const terminal = new VirtualTerminal({ columns, rows: capture ? 54 : 30 });
                let activeId = sessionId;
                const tui = new TuiAltScreen(terminal);
                const view = await createChatView({
                    documentLinks: null,
                    tui,
                    sessionRuntime: runtime,
                    getSessionId: () => activeId,
                    suppressStartupHeader: true,
                    setActiveModel: () => Promise.resolve({ status: "active" }),
                });
                const attach = () =>
                    attachTuiRuntimeAdapter({
                        runtime,
                        sessionId: activeId,
                        uiAPI: view.uiAPI,
                        browser: NO_OPEN_BROWSER_PORT,
                        notifyRunWieldEvent: () => {},
                        onSessionComplete: (id, failed, name) => controller.offerSessionCompletion(id, failed, name),
                    });
                const controller = createChatInputController({
                    view,
                    uiAPI: view.uiAPI,
                    runtime,
                    getSessionId: () => activeId,
                    getProjectRoot: () => projectRoot,
                    sessionStartedAt: new Date().toISOString(),
                    isModelSetupRecoveryCommand: () => false,
                    shouldBlockForModelSetup: () => false,
                    isInitCommandAvailable: () => false,
                    getPromptTemplateByName: () => new Map(),
                    getSkills: () => [],
                    chatPromptAgentName: "router",
                    managedSyncController: { pause: () => Promise.resolve(), resume() {} },
                    replaceRuntimeSession: (id) => {
                        adapter.dispose();
                        runtime.closeSession(activeId);
                        activeId = id;
                        adapter = attach();
                        view.resetForSessionReplacement();
                    },
                    markCtrlCPendingExit() {},
                    isCtrlCPendingExit: () => false,
                });
                let adapter = attach();
                tui.start();
                try {
                    const originalId = activeId;
                    for (let i = 0; i < 40; i++) {
                        view.uiAPI.appendSystemMessage(`Earlier workflow activity ${i}`);
                    }
                    emitHostedSessionRuntimeEvent(session, {
                        type: RuntimeEventTypes.SYSTEM_STATUS,
                        message: "Publishing the Plan",
                        validationProgress: {
                            kind: "workflow",
                            cycle: 1,
                            maxCycles: 3,
                            totalCycle: 1,
                            stage: "merge",
                            outcome: "running",
                            checks: {
                                ci: "passed",
                                semanticReview: "passed",
                                humanReview: "skipped",
                                merge: "running",
                            },
                        },
                    });
                    tui.renderNow(true);
                    await terminal.flush();
                    assertStringIncludes(terminal.getScreenText(), "Publishing");
                    emitHostedSessionRuntimeEvent(session, {
                        type: RuntimeEventTypes.SYSTEM_STATUS,
                        message: "Plan published successfully",
                        validationProgress: {
                            kind: "workflow",
                            cycle: 1,
                            maxCycles: 3,
                            totalCycle: 1,
                            stage: "terminal",
                            outcome: "verified",
                            workRecordFailed: choice.startsWith("record-"),
                            workRecordPlanName: "record-retry",
                            deliveryReport: DEV_DELIVERY_REPORT,
                            checks: { ci: "passed", semanticReview: "passed", humanReview: "skipped", merge: "passed" },
                        },
                    });
                    emitHostedSessionRuntimeEvent(session, {
                        type: RuntimeEventTypes.BUSY_CHANGED,
                        busy: false,
                    });
                    await waitFor(() => terminal.getScreenText().includes("What would you like to do next?"));
                    const screen = terminal.getScreenText();
                    if (capture) {
                        await Deno.writeTextFile(
                            Deno.env.get("RUNWIELD_DELIVERY_SCREENSHOT") || "",
                            JSON.stringify({
                                columns,
                                lines: terminal.getViewportLines(),
                                ansi: terminal.writes,
                            }),
                        );
                    }
                    if (choice.startsWith("record-")) {
                        assertStringIncludes(screen, "Code delivered; Work Record failed.");
                        assertStringIncludes(screen, "wld wr backfill");
                        assertStringIncludes(screen, "Retry Work Record");
                        assert(!screen.includes("Session complete"));
                    } else {
                        assertStringIncludes(screen, "Session complete");
                    }
                    assertStringIncludes(screen, "Start a new session");
                    assertStringIncludes(screen, "Load a Plan");
                    assertStringIncludes(screen, "Quit");
                    assert(!screen.includes("Publishing running"));
                    assert(!screen.includes("Validation passed"));
                    if (choice === "record-retry") {
                        terminal.pressEnter();
                        await waitFor(() => terminal.getScreenText().includes("Session complete"));
                        assertEquals(activeId, originalId);
                        terminal.pressEscape();
                        await waitFor(() => !controller.isProcessingSubmission());
                        tui.renderNow(true);
                        await terminal.flush();
                    } else if (choice === "escape" || choice === "record-failed") {
                        terminal.pressEscape();
                        await terminal.flush();
                        await waitFor(() => !controller.isProcessingSubmission());
                        tui.renderNow(true);
                        await terminal.flush();
                        assertEquals(activeId, originalId);
                    } else {
                        if (choice === "load-plan") terminal.input("\x1b[B");
                        terminal.pressEnter();
                        await waitFor(() => activeId !== originalId);
                        assertEquals(
                            runtime.getSessionSnapshot(activeId)?.activeAgent,
                            "router",
                        );
                        if (choice === "load-plan") {
                            await waitFor(() => terminal.getScreenText().includes("Load plan:")).catch((error) => {
                                throw new Error(`${error}\n${terminal.getScreenText()}`);
                            });
                            assertStringIncludes(terminal.getScreenText(), "next-change");
                            terminal.pressEscape();
                        }
                        await terminal.flush();
                        await waitFor(() => !controller.isProcessingSubmission());
                        tui.renderNow(true);
                        await terminal.flush();
                    }
                    assert(!terminal.getScreenText().includes("What would you like to do next?"));
                } finally {
                    terminal.pressEscape();
                    await controller.dispose();
                    adapter.dispose();
                    view.dispose();
                    tui.stop();
                }
            });
        });
    }
}

for (const choice of ["skip", "open", "dismiss"]) {
    Deno.test(`Code Review offer ${choice} removes selection controls without inventing an outcome`, async () => {
        await withSessionViewFixture(async ({ runtime, sessionId }) => {
            const terminal = new VirtualTerminal({ columns: 100, rows: 22 });
            const tui = new TuiAltScreen(terminal);
            const view = await createChatView({
                documentLinks: null,
                tui,
                sessionRuntime: runtime,
                getSessionId: () => sessionId,
                suppressStartupHeader: true,
                setActiveModel: () => Promise.resolve({ status: "active" }),
            });
            const { createTuiInteractionAdapter } = await import("./runtime-interaction-adapter.js");
            const adapter = createTuiInteractionAdapter(view.uiAPI, { browser: NO_OPEN_BROWSER_PORT });
            tui.start();
            try {
                const response = adapter.requestInteraction({
                    type: "select",
                    prompt: "Would you like to review the code?",
                    options: [{ value: "open", label: "Open code review" }, {
                        value: "skip",
                        label: "Skip code review",
                    }],
                    _meta: { presentation: "code_review_offer" },
                });
                await waitFor(() => terminal.getScreenText().includes("Skip code review"));
                if (choice === "dismiss") terminal.pressEscape();
                else {
                    if (choice === "skip") terminal.input("\x1b[B");
                    terminal.pressEnter();
                }
                const selected = await response;
                if (choice === "skip") view.uiAPI.appendSystemMessage("Code Review skipped", false, "RunWield");
                tui.renderNow(true);
                await terminal.flush();
                const text = terminal.getScreenText();
                assertEquals(text.includes("Would you like to review the code?"), false);
                assertEquals(text.includes("Skip code review"), false);
                assertEquals(text.includes("Open code review"), false);
                assertEquals(text.includes("Code Review skipped"), choice === "skip");
                assertEquals(text.includes("approved"), false);
                assertEquals(selected.outcome, choice === "dismiss" ? "canceled" : "selected");
                if (choice === "skip") {
                    assertEquals(text.split("Code Review skipped").length - 1, 1);
                    if (Deno.env.get("RUNWIELD_SKIP_SCREENSHOT")) {
                        await Deno.writeTextFile(
                            Deno.env.get("RUNWIELD_SKIP_SCREENSHOT") || "",
                            JSON.stringify({ columns: 100, lines: terminal.getViewportLines(), ansi: terminal.writes }),
                        );
                    }
                }
            } finally {
                view.dispose();
                tui.stop();
            }
        });
    });
}
