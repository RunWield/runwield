import { assertEquals, assertStringIncludes } from "@std/assert";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { TuiAltScreen } from "@earendil-works/pi-tui";
import { NO_OPEN_BROWSER_PORT } from "../../shared/browser-port.ts";
import { emitSystemStatus } from "../../shared/session/session-runtime-events.js";
import { HostedSession } from "../../shared/session/hosted-session.js";
import {
    createValidationProgress,
    emitRunWieldSystemStatus,
    getCurrentValidationProgress,
} from "../../shared/workflow/validation-progress.ts";
import { createChatView } from "./chat-view.ts";
import { attachTuiRuntimeAdapter } from "./runtime-adapter.js";
import { VirtualTerminal } from "./testing/virtual-terminal.js";
import { withSessionViewFixture } from "./testing/session-view-fixture.ts";
import { tuiSessionSidebarProjection } from "./session-sidebar.ts";

type HostedManager = NonNullable<ConstructorParameters<typeof HostedSession>[0]["sessionManager"]>;

Deno.test("accepted validation progress survives a cold Session and clears for a new workflow", () => {
    const root = Deno.makeTempDirSync({ prefix: "sidebar-cold-" });
    try {
        const manager = SessionManager.create(root);
        manager.appendMessage(fauxAssistantMessage(fauxText("Started sample.")));
        const session = new HostedSession({ id: "before", cwd: root, sessionManager: manager as HostedManager });
        session.setWorkflowExecutionContext({ planName: "delivered", triageMeta: { status: "reviewed" } });
        const progress = createValidationProgress({
            kind: "workflow",
            stage: "terminal",
            outcome: "verified",
            cycle: 1,
            maxCycles: 3,
            checks: { ci: "passed", semanticReview: "passed", humanReview: "passed", merge: "passed" },
            message: "Delivered to plan/sample. Owner may open a PR to main.",
        });
        emitRunWieldSystemStatus(session, progress.message || "Delivered", "success", progress);
        const resumed = new HostedSession({
            id: "after",
            cwd: root,
            sessionManager: SessionManager.open(manager.getSessionFile()!) as HostedManager,
        });
        assertEquals(resumed.getWorkflowContext()?.validationProgress?.outcome, "verified");
        const sidebar = tuiSessionSidebarProjection({ workflowContext: resumed.getWorkflowContext() }).workflow;
        assertEquals(
            sidebar.stages.filter((stage) => stage.id !== "repair").every((stage) => stage.state === "completed"),
            true,
        );
        assertEquals(sidebar.action, null);
        resumed.setWorkflowExecutionContext({ planName: "next", triageMeta: { status: "in_progress" } });
        assertEquals(resumed.getWorkflowContext()?.validationProgress, undefined);
        emitRunWieldSystemStatus(resumed, "Starting next Plan.");
        assertEquals(getCurrentValidationProgress(resumed), undefined);
        assertEquals(
            tuiSessionSidebarProjection({ workflowContext: resumed.getWorkflowContext() }).workflow.currentStage?.id,
            "execution",
        );
    } finally {
        Deno.removeSync(root, { recursive: true });
    }
});

for (const legacy of [false, true]) {
    Deno.test(`runtime completion survives panel clearing (legacy event: ${legacy})`, async () => {
        await withSessionViewFixture(async ({ runtime, sessionId, session }) => {
            session.setWorkflowExecutionContext({ planName: "sample", triageMeta: { status: "implemented" } });
            const terminal = new VirtualTerminal({ columns: 150, rows: 45 });
            const tui = new TuiAltScreen(terminal);
            const view = await createChatView({
                documentLinks: null,
                tui,
                suppressStartupHeader: true,
                getSessionId: () => sessionId,
                sessionRuntime: runtime,
                setActiveModel: () => Promise.resolve({ status: "active" }),
            });
            const detach = attachTuiRuntimeAdapter({
                runtime,
                sessionId,
                uiAPI: view.uiAPI,
                browser: NO_OPEN_BROWSER_PORT,
                notifyRunWieldEvent: () => {},
            });
            try {
                tui.start();
                const progress = createValidationProgress({
                    kind: "workflow",
                    stage: "terminal",
                    outcome: "verified",
                    cycle: 1,
                    maxCycles: 3,
                    checks: { ci: "passed", semanticReview: "passed", humanReview: "passed", merge: "passed" },
                });
                if (legacy) {
                    emitSystemStatus(session, "Delivered to the Plan branch.", {
                        level: "success",
                        validationProgress: progress,
                    });
                } else emitRunWieldSystemStatus(session, "Delivered to the Plan branch.", "success", progress);
                session.clearActiveExecutionWorkflow();
                tui.renderNow(true);
                await terminal.flush();
                const screen = terminal.getScreenText();
                assertStringIncludes(screen, "✓ Planning");
                assertStringIncludes(screen, "✓ Publication");
                assertEquals(screen.includes("ctrl+enter"), false);
                const capture = Deno.env.get("WLD_SIDEBAR_CAPTURE");
                if (capture) {
                    await Deno.writeTextFile(
                        capture,
                        JSON.stringify({
                            columns: 150,
                            rows: 45,
                            lines: terminal.getViewportLines(),
                            output: terminal.writes,
                        }),
                    );
                }
            } finally {
                detach.dispose();
                view.dispose();
                tui.stop();
            }
        });
    });
}

Deno.test("runtime resumes saved Code Review from its name without stale Plan content", async () => {
    await withSessionViewFixture(async ({ runtime, sessionId, session, projectRoot }) => {
        const { savePlan } = await import("../../plan-store.js");
        await savePlan(projectRoot, "resume-review", "# Saved Code Review", {
            classification: "PLANNED_CHANGE",
            status: "reviewed",
            humanReviewMode: "always",
            humanReviewDecision: null,
            executionMode: "non_git_in_place",
            affectedPaths: [],
        });
        session.setWorkflowExecutionContext({ planName: "resume-review", triageMeta: { status: "reviewed" } });
        let reviews = 0;
        runtime.setInteractionAdapter(sessionId, {
            requestInteraction(request) {
                if (request.type === "code_review") {
                    reviews++;
                    return { outcome: "canceled" };
                }
                return { outcome: "selected", value: "stop" };
            },
        });
        const result = await runtime.runValidation(sessionId, {
            planName: "resume-review",
            planContent: "",
            triageMeta: { status: "implemented" },
            trigger: "session_resume",
        });
        assertEquals(result?.kind, "paused");
        assertEquals(reviews, 1);
        assertEquals(
            tuiSessionSidebarProjection(runtime.getSessionSnapshot(sessionId) || {}).workflow.action?.label,
            "Reopen Code Review",
        );
    });
});
