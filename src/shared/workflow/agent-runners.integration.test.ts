import { assertEquals } from "../../testing/assertions.ts";
import { test } from "node:test";
import { ok as assert } from "node:assert/strict";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { withRuntimeCommandFixture } from "../../cmd/testing/runtime-command-fixture.ts";
import { loadPlan, savePlan } from "../../plan-store.js";
import { HostedSession } from "../session/hosted-session.js";
import type { RuntimeInteractionRequest, RuntimeInteractionResponse } from "../session/session-runtime-interactions.js";
import { AgyCliBackendError } from "../session/backends/agy-cli/failure.ts";
import { buildEngineerPausedMessage, runEngineerWithPlan } from "./engineer-runner.ts";
import { runPlanningAgent } from "./planning-agent.ts";
import { recordPlanEvent } from "./plan-lifecycle.js";

interface AgentSessionFixture {
    hostedSession: HostedSession;
    sessionManager: SessionManager;
}

function createAgentSession(
    projectRoot: string,
    interactionRequests: RuntimeInteractionRequest[] = [],
    respond: (request: RuntimeInteractionRequest) => RuntimeInteractionResponse | Promise<RuntimeInteractionResponse> =
        () => ({
            outcome: "selected",
            value: "continue",
        }),
): AgentSessionFixture {
    const sessionManager = SessionManager.inMemory(projectRoot);
    const hostedSession = new HostedSession({
        id: `agent-runner-${crypto.randomUUID()}`,
        cwd: projectRoot,
        interactionAdapter: {
            supportsInteraction: (type) => type === "pair_checkpoint" || type === "plan_deviation_confirmation",
            requestInteraction: (request) => {
                interactionRequests.push(request);
                return respond(request);
            },
        },
    });
    // Pi's concrete SessionManager satisfies HostedSession's deliberately small
    // runtime contract, but the legacy JSDoc signature is wider.
    hostedSession.setRootSessionManager(sessionManager);
    return { hostedSession, sessionManager };
}

test("planning runs the real plan_written machinery with the supplied triage context", async () => {
    await withRuntimeCommandFixture("planning-agent-runner-", async ({ projectRoot, setModelMessages }) => {
        await savePlan(projectRoot, "fixture-plan", "# Fixture Plan", { status: "draft" });
        setModelMessages([
            fauxAssistantMessage(fauxToolCall("plan_written", {
                planName: "fixture-plan",
            })),
        ]);
        const fixture = createAgentSession(projectRoot, [], async (request) => {
            if (request.type === "plan_review") {
                const beforeReview = await loadPlan(projectRoot, "fixture-plan");
                if (!beforeReview) throw new Error("Fixture Plan disappeared before review");
                await recordPlanEvent({
                    cwd: projectRoot,
                    planName: "fixture-plan",
                    event: "review_approved",
                    currentStatus: beforeReview.attrs.status,
                    expectedRevision: beforeReview.revision,
                    details: { triageMeta: beforeReview.attrs },
                });
                const approved = await loadPlan(projectRoot, "fixture-plan");
                return {
                    outcome: "accepted",
                    _meta: { approved: true, approvalAction: "run", planAttrs: approved?.attrs },
                };
            }
            return { outcome: "canceled" };
        });

        try {
            const result = await runPlanningAgent({
                agentName: "planner",
                initialRequest: "Plan the isolated fixture change.",
                triageMeta: {
                    classification: "PLANNED_CHANGE",
                    workKind: "REFACTOR",
                    summary: "Remove an obsolete dependency bag",
                    affectedPaths: ["src/fixture.ts"],
                },
                sessionManager: fixture.sessionManager,
                hostedSession: fixture.hostedSession,
                images: undefined,
            });

            assertEquals(result.outcome, "approved_execute");
            assertEquals(result.planName, "fixture-plan");
            assertEquals(result.triageMeta?.workKind, "REFACTOR");
            assertEquals(result.triageMeta?.classification, "PLANNED_CHANGE");
            assertEquals(fixture.hostedSession.getRootAgentName(), "planner");
        } finally {
            fixture.hostedSession.dispose();
        }
    });
});

test("Plan pause does not repeat an Antigravity denial already shown by the backend", () => {
    const denial = new AgyCliBackendError("permission_denied", {
        message: "Blocked: view_file: [redacted-home]/.gemini/antigravity-cli/settings.json",
    });
    const paused = buildEngineerPausedMessage(denial, undefined);
    assertEquals(paused.includes("Reason:"), false);
    assertEquals(paused.includes('Say "continue"'), true);
    assertEquals(
        buildEngineerPausedMessage(new Error("other failure"), undefined).includes("Reason: other failure"),
        true,
    );
});

test("Engineer completion is derived from the real task_completed tool result", async () => {
    await withRuntimeCommandFixture("engineer-runner-", async ({ projectRoot, setModelMessages }) => {
        setModelMessages([
            fauxAssistantMessage(fauxToolCall("task_completed", { message: "- Implemented.\n- Verified." })),
        ]);
        const fixture = createAgentSession(projectRoot);
        fixture.hostedSession.setActiveExecutionWorkflow({
            planName: "fixture-plan",
            triageMeta: { classification: "PLANNED_CHANGE", workKind: "REFACTOR" },
            executionAgent: "engineer",
            executionStarted: true,
            executionCwd: projectRoot,
            projectRoot,
        });

        try {
            const result = await runEngineerWithPlan(
                "fixture-plan",
                "# Fixture Plan",
                fixture.sessionManager,
                projectRoot,
                fixture.hostedSession,
                projectRoot,
                "Remove the dependency bag.",
                undefined,
                undefined,
            );

            assertEquals(result.completed, true);
            assert("completionReport" in result);
            assertEquals(result.completionReport, "- Implemented.\n- Verified.");
            // The Plan says `engineer`; the Agent that ran it is Plan Engineer.
            assertEquals(fixture.hostedSession.getRootAgentName(), "plan-engineer");
        } finally {
            fixture.hostedSession.dispose();
        }
    });
});

test("Pair execution reports a durable checkpoint and settles without a form", async () => {
    await withRuntimeCommandFixture("pair-engineer-runner-", async ({ projectRoot, setModelMessages }) => {
        setModelMessages([
            fauxAssistantMessage(fauxToolCall("pair_checkpoint", {
                action: "report",
                summary: "The fixture screen is ready.",
                evidence: ["fixture screenshot"],
            })),
        ]);
        const interactionRequests: RuntimeInteractionRequest[] = [];
        const fixture = createAgentSession(projectRoot, interactionRequests);
        fixture.hostedSession.setActiveExecutionWorkflow({
            planName: "pair-plan",
            triageMeta: { classification: "PLANNED_CHANGE", workKind: "FEATURE" },
            executionAgent: "frontend-engineer",
            executionStarted: true,
            executionCwd: projectRoot,
            projectRoot,
            collaborationStyle: "pair",
            collaborationRecommendation: "pair",
        });

        try {
            fixture.hostedSession.beginTurn("pair-report-turn");
            const result = await runEngineerWithPlan(
                "pair-plan",
                "# Pair Plan",
                fixture.sessionManager,
                projectRoot,
                fixture.hostedSession,
                projectRoot,
                "Build the visual fixture.",
                undefined,
                undefined,
                "frontend-engineer",
            );

            assertEquals(result.completed, false);
            assertEquals("checkpointPending" in result && result.checkpointPending, true);
            assertEquals(interactionRequests, []);
            assertEquals(fixture.hostedSession.getActiveExecutionWorkflow()?.pairCheckpointCount, 1);
            assert(fixture.hostedSession.getActiveExecutionWorkflow()?.pairPauseReason === undefined);
        } finally {
            fixture.hostedSession.dispose();
        }
    });
});
