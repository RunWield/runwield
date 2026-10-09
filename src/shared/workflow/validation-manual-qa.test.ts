import { assert, assertEquals, assertMatch, assertObjectMatch, assertStringIncludes } from "@std/assert";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { withRuntimeCommandFixture } from "../../cmd/testing/runtime-command-fixture.ts";
import { loadPlan, savePlan } from "../../plan-store.js";
import { HostedSession } from "../session/hosted-session.js";
import { runManualQaChecklistPrompt } from "./validation.ts";

Deno.test("Manual QA runs the bundled isolated Operator and persists its visible checklist", async () => {
    await withRuntimeCommandFixture(
        "validation-manual-qa-",
        async ({ projectRoot, setModelResponseFactory }) => {
            let modelContext = "";
            setModelResponseFactory((context) => {
                modelContext = JSON.stringify(context);
                return fauxAssistantMessage(fauxToolCall("manual_qa_completed", {
                    checklistMarkdown: "Manual verification steps for settings-panel\n- [ ] Save settings and reload.",
                }));
            });
            const sessionManager = SessionManager.inMemory(projectRoot);
            const hostedSession = new HostedSession({ id: "manual-qa-persist", cwd: projectRoot });
            // HostedSession's legacy minimal-manager JSDoc widens appendMessage beyond
            // Pi's real SessionManager signature; the concrete manager is the runtime object.
            hostedSession.setRootSessionManager(sessionManager);

            const messages = await runManualQaChecklistPrompt({
                hostedSession,
                name: "settings-panel",
                classification: "FEATURE",
                context: "## Verification Plan\n- Manual: save settings and reload",
                cwd: projectRoot,
            });

            assertEquals(messages, []);
            assertStringIncludes(modelContext, "Name: settings-panel");
            assertStringIncludes(modelContext, "Classification: PLANNED_CHANGE");
            assertStringIncludes(modelContext, "save settings and reload");
            assertStringIncludes(modelContext, "Manual verification steps for <plan name>");
            const checklist = sessionManager.getBranch().find((entry) =>
                entry.type === "custom" && entry.customType === "runwield.manual_qa_checklist"
            );
            assert(checklist && checklist.type === "custom");
            assertEquals(checklist.customType, "runwield.manual_qa_checklist");
            const data = checklist.data;
            assert(data && typeof data === "object" && "toolCallId" in data && typeof data.toolCallId === "string");
            assertMatch(data.toolCallId, /^tool:/);
            assertObjectMatch(data, {
                agentName: "Operator",
                text: "Manual verification steps for settings-panel\n- [ ] Save settings and reload.",
                name: "settings-panel",
                classification: "PLANNED_CHANGE",
            });
            hostedSession.dispose();
        },
    );
});
import {
    makeRecordedSession,
    makeUi,
    makeValidationProjectRoot,
    runValidationLoop,
} from "./validation-test-helpers.js";

Deno.test("Epic child Manual QA failure does not block verified delivery or continuation", async () => {
    const projectRoot = await makeValidationProjectRoot("epic/01-one", {
        classification: "PLANNED_CHANGE",
        status: "reviewed",
        parentPlan: "epic",
        humanReviewMode: "none",
        humanReviewDecision: "not_required",
    });
    await savePlan(projectRoot, "epic", "# Epic", {
        classification: "PROJECT",
        status: "ready_for_work",
        summary: "Epic",
    });
    const uiAPI = makeUi();
    const hostedSession = makeRecordedSession("manual-qa-failure", uiAPI);
    hostedSession.setActiveExecutionWorkflow({
        planName: "epic/01-one",
        triageMeta: {
            classification: "PLANNED_CHANGE",
            status: "reviewed",
            parentPlan: "epic",
            humanReviewMode: "none",
            humanReviewDecision: "not_required",
        },
        executionAgent: "engineer",
        projectRoot,
        executionCwd: projectRoot,
        nonGitInPlace: true,
    });

    const result = await runValidationLoop({
        hostedSession,
        planName: "epic/01-one",
        planContent: "# One\n\nimplemented child",
        triageMeta: {
            classification: "PLANNED_CHANGE",
            status: "reviewed",
            parentPlan: "epic",
            humanReviewMode: "none",
            humanReviewDecision: "not_required",
        },
        semanticReviewPort: { runIsolatedAgentSession: () => Promise.resolve([]) },
    });

    assertEquals(result.kind, "verified");
    assertEquals((await loadPlan(projectRoot, "epic/01-one"))?.attrs.status, "verified");
    assert(
        uiAPI.systemCalls.some((call: { level: string; message: string }) =>
            call.level === "warning" && call.message.includes("RunWield could not save the test note")
        ),
    );
});
