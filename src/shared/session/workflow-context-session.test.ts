import { assertEquals } from "../../testing/assertions.ts";
import { test } from "node:test";
import type { SessionManager } from "@earendil-works/pi-coding-agent";
import type { WorkflowContext } from "./workflow-context-session.js";
import type { WorkflowProgressFact } from "../workflow/workflow-presentation.ts";
import {
    deriveWorkflowContextFromExecutionWorkflow,
    normalizeWorkflowContext,
    normalizeWorkflowPlanName,
    readPersistedWorkflowContext,
    recordNormalizedWorkflowContext,
    recordWorkflowPlanName,
    recordWorkflowTriageContext,
    WORKFLOW_CONTEXT_CUSTOM_TYPE,
} from "./workflow-context-session.js";

interface FixtureWorkflowEntry {
    type: "custom";
    customType: string;
    data: WorkflowContext;
}

// Preserve the partial JavaScript fixture, including its numeric append result and entries without SDK metadata.
function makeSessionManager(entries: FixtureWorkflowEntry[] = []) {
    return {
        getBranch: () => entries,
        appendCustomEntry: (customType: string, data: WorkflowContext) =>
            entries.push({ type: "custom", customType, data }),
    } as unknown as SessionManager;
}

test("workflow context records latest triage and suppresses duplicates", () => {
    const entries: FixtureWorkflowEntry[] = [];
    const sessionManager = makeSessionManager(entries);

    recordWorkflowTriageContext(sessionManager, { routingIntent: "PLANNED_CHANGE", complexity: "MEDIUM" });
    recordWorkflowTriageContext(sessionManager, { routingIntent: "PLANNED_CHANGE", complexity: "MEDIUM" });

    assertEquals(entries.length, 1);
    assertEquals(entries[0].customType, WORKFLOW_CONTEXT_CUSTOM_TYPE);
    assertEquals(readPersistedWorkflowContext(sessionManager), {
        routingIntent: "PLANNED_CHANGE",
        complexity: "MEDIUM",
    });
});

test("workflow context merges plan name and later triage clears stale plan", () => {
    const sessionManager = makeSessionManager();

    recordWorkflowTriageContext(sessionManager, { routingIntent: "PROJECT", complexity: "HIGH" });
    recordWorkflowPlanName(sessionManager, "docs/plans/epic/child-plan.md");
    assertEquals(readPersistedWorkflowContext(sessionManager), {
        routingIntent: "PROJECT",
        complexity: "HIGH",
        planName: "epic/child-plan",
    });

    recordWorkflowTriageContext(sessionManager, {
        routingIntent: "QUICK_FIX",
        complexity: "LOW",
        summary: "Show routing details in the sidebar.",
    });
    assertEquals(readPersistedWorkflowContext(sessionManager), {
        routingIntent: "QUICK_FIX",
        complexity: "LOW",
        summary: "Show routing details in the sidebar.",
    });
});

test("workflow context permits plan-only context", () => {
    const sessionManager = makeSessionManager();

    recordWorkflowPlanName(sessionManager, "standalone-plan.md");

    assertEquals(readPersistedWorkflowContext(sessionManager), { planName: "standalone-plan" });
});

test("workflow context skips malformed latest markers and tolerates missing session manager", () => {
    const sessionManager = makeSessionManager([
        {
            type: "custom",
            customType: WORKFLOW_CONTEXT_CUSTOM_TYPE,
            data: { routingIntent: "PLANNED_CHANGE", complexity: "LOW" },
        },
        {
            type: "custom",
            customType: WORKFLOW_CONTEXT_CUSTOM_TYPE,
            data: { routingIntent: "NOPE", complexity: "LOW" },
        },
    ]);

    assertEquals(readPersistedWorkflowContext(sessionManager), { routingIntent: "PLANNED_CHANGE", complexity: "LOW" });
    assertEquals(recordWorkflowPlanName(null, "p"), { planName: "p" });
});

test("workflow context reads are fail-open when session entry access throws", () => {
    const sessionManager = {
        getBranch: () => {
            throw new Error("read failed");
        },
    } as unknown as SessionManager;

    assertEquals(readPersistedWorkflowContext(sessionManager), null);
    assertEquals(recordWorkflowPlanName(sessionManager, "p"), { planName: "p" });
});

test("workflow context normalization accepts canonical intents and sanitized plan names", () => {
    assertEquals(normalizeWorkflowPlanName(" docs/plans/example.md "), "example");
    assertEquals(normalizeWorkflowContext({ routingIntent: "operation", complexity: "low" }), {
        routingIntent: "OPERATION",
        complexity: "LOW",
    });
    assertEquals(normalizeWorkflowContext({ routingIntent: "PLANNED_CHANGE", complexity: "bad", planName: "p.md" }), {
        planName: "p",
    });
});

test("workflow context derives execution metadata with legacy feature normalization", () => {
    assertEquals(
        deriveWorkflowContextFromExecutionWorkflow({
            planName: "docs/plans/epic-name/footer-plan.md",
            triageMeta: { classification: "FEATURE", complexity: "medium", parentPlan: "epic-name" },
        }),
        {
            routingIntent: "PLANNED_CHANGE",
            complexity: "MEDIUM",
            planName: "epic-name/footer-plan",
            parentPlan: "epic-name",
        },
    );
    assertEquals(
        deriveWorkflowContextFromExecutionWorkflow({
            planName: "docs/plans/fallback-plan.md",
            triageMeta: { routingIntent: "NOPE", classification: "FEATURE", complexity: "medium" },
        }),
        { routingIntent: "PLANNED_CHANGE", complexity: "MEDIUM", planName: "fallback-plan" },
    );
    assertEquals(
        deriveWorkflowContextFromExecutionWorkflow(
            {
                triageMeta: { routingIntent: "NOPE", classification: "bad", complexity: "medium" },
            },
            "docs/plans/name-only.md",
        ),
        { planName: "name-only" },
    );
    assertEquals(
        deriveWorkflowContextFromExecutionWorkflow({
            planName: "",
            triageMeta: { routingIntent: "PLANNED_CHANGE", complexity: "bad" },
        }),
        null,
    );
});

test("workflow context retains validation and publication progress facts across Session projection", () => {
    const sessionManager = makeSessionManager();
    const progressFacts: WorkflowProgressFact[] = [
        {
            kind: "validation_checkpoint",
            phase: "semantic",
            state: "awaiting_repair",
            repairKind: "semantic",
            updatedAt: "2026-01-01T00:00:00.000Z",
        },
        {
            kind: "publication",
            phase: "target_published",
            failure: false,
            updatedAt: "2026-01-01T00:01:00.000Z",
        },
    ];

    recordNormalizedWorkflowContext(sessionManager, {
        planName: "release-plan",
        status: "validated_ci",
        progressFacts,
        canResume: true,
        canRecover: true,
    });

    assertEquals(readPersistedWorkflowContext(sessionManager), {
        planName: "release-plan",
        status: "validated_ci",
        progressFacts,
        canResume: true,
        canRecover: true,
    });
});

test("workflow context derives current checkpoint facts from execution metadata", () => {
    assertEquals(
        deriveWorkflowContextFromExecutionWorkflow({
            planName: "recover-plan",
            triageMeta: {
                classification: "FEATURE",
                complexity: "MEDIUM",
                status: "implemented",
                validationCheckpoint: {
                    nextPhase: "mechanical",
                    state: "awaiting_repair",
                    repairKind: "ci",
                    updatedAt: "2026-01-01T00:00:00.000Z",
                },
            },
        })?.progressFacts,
        [
            {
                kind: "validation_checkpoint",
                phase: "mechanical",
                state: "awaiting_repair",
                repairKind: "ci",
                updatedAt: "2026-01-01T00:00:00.000Z",
            },
        ],
    );
});

test("workflow context records normalized execution context without duplicate markers", () => {
    const sessionManager = makeSessionManager();
    const context = { routingIntent: "FEATURE", complexity: "medium", planName: "docs/plans/footer-plan.md" };

    recordNormalizedWorkflowContext(sessionManager, context);
    recordNormalizedWorkflowContext(sessionManager, context);

    assertEquals(sessionManager.getBranch().length, 1);
    assertEquals(readPersistedWorkflowContext(sessionManager), {
        routingIntent: "PLANNED_CHANGE",
        complexity: "MEDIUM",
        planName: "footer-plan",
    });
});
