import { assertEquals, assertStringIncludes } from "@std/assert";
import { parsePlanFrontMatter, resolvePlanExecutionPolicy } from "../../plan-store.js";
import { HostedSession } from "../session/hosted-session.js";
import { decidePostExecution } from "./decisions.ts";
import { resolveExecutionOwner, supportsPairExecution } from "./workflow.js";
import { selectRuntimeCollaborationStyle } from "./execution-collaboration.ts";
import { buildPairPausedMessage } from "./engineer-runner.ts";

Deno.test("Plan metadata normalizes explicit pair execution ownership", () => {
    const parsed = parsePlanFrontMatter(`---
classification: FEATURE
executionAgent: frontend-engineer
collaborationRecommendation: pair
---
# UI
`);
    assertEquals(parsed.attrs.executionAgent, "frontend-engineer");
    assertEquals(parsed.attrs.collaborationRecommendation, "pair");
    assertEquals(resolvePlanExecutionPolicy(parsed.attrs), {
        ok: true,
        policy: {
            executionAgent: "frontend-engineer",
            collaborationRecommendation: "pair",
            source: "canonical",
        },
    });
    assertEquals(resolveExecutionOwner(parsed.attrs), "frontend-engineer");
});

Deno.test("legacy frontend true resolves to autonomous Frontend Engineer", () => {
    const parsed = parsePlanFrontMatter(`---
classification: FEATURE
frontend: true
---
# Legacy UI
`);
    assertEquals(resolvePlanExecutionPolicy(parsed.attrs), {
        ok: true,
        policy: {
            executionAgent: "frontend-engineer",
            collaborationRecommendation: "autonomous",
            source: "legacy_frontend",
        },
    });
    assertEquals(resolveExecutionOwner(parsed.attrs), "frontend-engineer");
});

Deno.test("missing and frontend false ownership resolve to Engineer", () => {
    assertEquals(resolveExecutionOwner({}), "engineer");
    assertEquals(resolveExecutionOwner({ frontend: false }), "engineer");
});

Deno.test("Pair capability requires an attached conversational host, not a checkpoint form", () => {
    const unsupported = new HostedSession({
        id: "pair-unsupported",
        cwd: Deno.cwd(),
        interactionAdapter: {
            requestInteraction: () => ({ outcome: "selected", value: "pair" }),
        },
    });
    const genericOnly = new HostedSession({
        id: "pair-generic-only",
        cwd: Deno.cwd(),
        interactionAdapter: {
            supportsInteraction: (type) => type === "select" || type === "text",
            requestInteraction: () => ({ outcome: "selected", value: "pair" }),
        },
    });
    const throwing = new HostedSession({
        id: "pair-throwing",
        cwd: Deno.cwd(),
        interactionAdapter: {
            supportsInteraction: () => {
                throw new Error("capability probe failed");
            },
            requestInteraction: () => ({ outcome: "selected", value: "pair" }),
        },
    });
    const supported = new HostedSession({
        id: "pair-supported",
        cwd: Deno.cwd(),
        interactionAdapter: {
            supportsInteraction: (type) => type === "pair_checkpoint",
            requestInteraction: () => ({ outcome: "selected", value: "pair" }),
        },
    });

    assertEquals(supportsPairExecution(new HostedSession({ id: "pair-none", cwd: Deno.cwd() })), false);
    assertEquals(supportsPairExecution(unsupported), true);
    assertEquals(supportsPairExecution(genericOnly), true);
    assertEquals(supportsPairExecution(throwing), true);
    assertEquals(supportsPairExecution(supported), true);
});

Deno.test("post-execution decisions keep Pair pauses out of validation", () => {
    const options = /** @type {const} */ ({
        planName: "visual-plan",
        triageMeta: { classification: "FEATURE" },
        executionAgentName: "frontend-engineer",
    });

    assertEquals(
        decidePostExecution(
            { repairRequired: false, executionComplete: false, paused: true, pauseReason: "stop" },
            options,
        ),
        {
            kind: "stay_with_agent",
            payload: {
                agentName: "frontend-engineer",
                reason: "execution_paused",
                pauseReason: "stop",
                error: undefined,
            },
        },
    );
    assertEquals(
        decidePostExecution(
            { repairRequired: false, executionComplete: false, canceled: true },
            options,
        ).payload.reason,
        "execution_canceled",
    );
    assertEquals(
        decidePostExecution(
            {
                repairRequired: false,
                executionComplete: false,
                checkpointPending: true,
                checkpointId: "checkpoint-1",
            },
            options,
        ),
        {
            kind: "stay_with_agent",
            payload: {
                agentName: "frontend-engineer",
                reason: "pair_checkpoint_pending",
                checkpointId: "checkpoint-1",
            },
        },
    );
});

Deno.test("deliberate Pair resume preserves execution attempt timestamp", () => {
    const session = new HostedSession({ id: "pair-timestamp-resume", cwd: Deno.cwd() });
    session.setActiveExecutionWorkflow({
        planName: "visual-plan",
        triageMeta: { classification: "FEATURE" },
        executionAgent: "frontend-engineer",
        executionStarted: true,
        executionAttemptStartedAtMs: 12345,
        collaborationStyle: "pair",
        pairCheckpointCount: 1,
        pairPauseReason: "stop",
        pairStopRequested: true,
    });

    const resumed = { ...session.getActiveExecutionWorkflow() };
    delete resumed.pairPauseReason;
    delete resumed.pairStopRequested;
    session.setActiveExecutionWorkflow(
        /** @type {import('../session/hosted-session.js').ActiveExecutionWorkflow} */ (resumed),
    );

    assertEquals(session.getActiveExecutionWorkflow()?.executionAttemptStartedAtMs, 12345);
    assertEquals(session.getActiveExecutionWorkflow()?.pairPauseReason, undefined);
    assertEquals(session.getActiveExecutionWorkflow()?.pairCheckpointCount, 1);
});

Deno.test("an engineer-owned Plan can select Pair, and an incapable host falls back without owner-specific copy", () => {
    /** @type {string[]} */
    const statusMessages = [];
    const capable = new HostedSession({
        id: "pair-engineer-capable",
        cwd: Deno.cwd(),
        interactionAdapter: {
            supportsInteraction: (/** @type {string} */ type) => type === "pair_checkpoint",
            requestInteraction: () => ({ outcome: "selected", value: "continue" }),
        },
    });
    const incapable = new HostedSession({ id: "pair-engineer-incapable", cwd: Deno.cwd() });
    incapable.setEventSink({
        emit: (/** @type {{ text?: string, message?: string }} */ event) =>
            statusMessages.push(event.text || event.message || ""),
    });
    const policy = /** @type {const} */ ({
        executionAgent: "engineer",
        collaborationRecommendation: "pair",
        source: "canonical",
    });

    const selected = selectRuntimeCollaborationStyle(capable, policy);
    const fellBack = selectRuntimeCollaborationStyle(incapable, policy);

    assertEquals(selected.style, "pair");
    assertEquals(fellBack.style, "autonomous");
    // The stored recommendation survives the fallback; only this run is autonomous.
    assertEquals(fellBack.recommendation, "pair");
    assertEquals(fellBack.resolutionReason, "canonical_pair_unavailable");
    assertEquals(statusMessages.join("\n").includes("Frontend Engineer"), false);
    assertStringIncludes(statusMessages.join("\n"), "continuing with autonomous Plan execution");
});

Deno.test("Pair pause copy names the runtime Agent behind each Plan owner", () => {
    assertStringIncludes(
        buildPairPausedMessage("stop", Deno.cwd(), "engineer"),
        "Plan Engineer stopped Pair Execution",
    );
    assertStringIncludes(
        buildPairPausedMessage("stop", Deno.cwd(), "frontend-engineer"),
        "Frontend Engineer stopped Pair Execution",
    );
    // A pre-split caller can still pass the runtime name straight through.
    assertStringIncludes(
        buildPairPausedMessage("canceled", Deno.cwd(), "plan-engineer"),
        "Plan Engineer paused Pair Execution",
    );
});
