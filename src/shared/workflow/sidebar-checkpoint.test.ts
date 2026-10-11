import { assertEquals, assertExists } from "@std/assert";
import { createGitPort } from "../git-port.ts";
import { createWorkRecordMnemotecaFixture } from "../work-records/test-fixtures/mnemoteca-port.ts";
import { loadPlan } from "../../plan-store.js";
import { HostedSession } from "../session/hosted-session.js";
import { continueWorkflowValidation } from "./validation-supervisor.ts";
import { makeValidationProjectRoot, NO_ISOLATED_AGENT_PORT } from "./validation-test-helpers.js";
import { tuiSessionSidebarProjection } from "../../ui/tui/session-sidebar.ts";

Deno.test("canceling Code Review settles a paused checkpoint and reopening skips finished checks", async () => {
    const root = await makeValidationProjectRoot("sample", {
        classification: "PLANNED_CHANGE",
        status: "reviewed",
        humanReviewMode: "always",
        humanReviewDecision: null,
        executionMode: "non_git_in_place",
    });
    const session = new HostedSession({ id: crypto.randomUUID(), cwd: root });
    let reviews = 0;
    let checks = 0;
    session.setInteractionAdapter({
        requestInteraction(request) {
            if (request.type === "code_review") {
                reviews++;
                return { outcome: "canceled" };
            }
            return { outcome: "selected", value: "stop" };
        },
    });
    try {
        for (let round = 1; round <= 2; round++) {
            const plan = await loadPlan(root, "sample");
            assertExists(plan);
            session.setWorkflowExecutionContext({ planName: "sample", triageMeta: plan.attrs });
            const result = await continueWorkflowValidation({
                hostedSession: session,
                planName: "sample",
                planContent: plan.body,
                triageMeta: plan.attrs,
                git: createGitPort(),
                workRecordMnemotecaPort: createWorkRecordMnemotecaFixture(),
                trigger: "session_resume",
                semanticReviewPort: NO_ISOLATED_AGENT_PORT,
                localCI: {
                    run: () => {
                        checks++;
                        return Promise.reject(new Error("Completed checks must not rerun"));
                    },
                },
            });
            assertEquals(result.kind, "paused");
            const saved = await loadPlan(root, "sample");
            assertEquals(saved?.attrs.status, "reviewed");
            assertEquals(saved?.attrs.humanReviewDecision, null);
            assertEquals(session.getActiveExecutionWorkflow()?.triageMeta?.validationCheckpoint?.state, "paused");
            const sidebar = tuiSessionSidebarProjection({ workflowContext: session.getWorkflowContext() }).workflow;
            assertEquals(sidebar.currentStage?.id, "code_review");
            assertEquals(sidebar.currentStage?.state, "paused");
            assertEquals(reviews, round);
            assertEquals(checks, 0);
        }
    } finally {
        session.dispose();
        await Deno.remove(root, { recursive: true });
    }
});
