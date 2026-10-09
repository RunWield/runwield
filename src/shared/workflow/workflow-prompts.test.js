import { assertEquals, assertStringIncludes } from "@std/assert";
import {
    buildAgentHandoffRequest,
    buildEngineerRequest,
    buildReAnchorMessage,
    buildSlicerRequest,
    buildTriageReport,
} from "./workflow-prompts.ts";

Deno.test("buildAgentHandoffRequest explicitly re-anchors the active specialist", () => {
    const request = buildAgentHandoffRequest("Planner", "Continue the requested refactor.", {
        routingIntent: "PLANNED_CHANGE",
        classification: "PLANNED_CHANGE",
        complexity: "MEDIUM",
        summary: "Plan the refactor.",
    });

    assertStringIncludes(request, "## Active RunWield Agent");
    assertStringIncludes(request, "You are now Planner.");
    assertStringIncludes(request, "previous RunWield Agent");
    assertStringIncludes(request, "## User Request\nContinue the requested refactor.");
    assertStringIncludes(request, "## Triage Report");
});

Deno.test("buildSlicerRequest includes existing child order and dependencies", () => {
    const request = buildSlicerRequest({
        planName: "epic-a",
        epicBody: "# Epic",
        epicAttrs: {
            classification: "PROJECT",
            status: "ready_for_work",
            targetBranch: "feature-base",
        },
        children: [
            {
                name: "epic-a/02-second",
                order: 2,
                status: "draft",
                summary: "Second slice",
                workKind: "DOCUMENTATION",
                dependencies: ["01-first"],
                affectedPaths: ["src/second.js"],
            },
        ],
    });

    assertStringIncludes(request, "- epic-a/02-second");
    assertStringIncludes(request, "  - Order: 2");
    assertStringIncludes(request, "  - Status: draft");
    assertStringIncludes(request, "  - Work Kind: DOCUMENTATION");
    assertStringIncludes(request, "  - Dependencies: 01-first");
    assertStringIncludes(request, "- Target branch: feature-base");
});

Deno.test("approval annotations are included in Engineer and Slicer handoffs", () => {
    const feedback = "Keep the selected command and highlighted boundary.";
    const engineerRequest = buildEngineerRequest("feature-plan", "Plan body", feedback);
    const slicerRequest = buildSlicerRequest({
        planName: "epic-plan",
        epicBody: "Epic body",
        reviewFeedback: feedback,
    });

    assertStringIncludes(engineerRequest, "Annotations Submitted With Approval");
    assertStringIncludes(engineerRequest, feedback);
    assertStringIncludes(slicerRequest, "Annotations Submitted With Approval");
    assertStringIncludes(slicerRequest, feedback);
});

Deno.test("buildEngineerRequest emits only the approved Plan envelope when optional context is missing", () => {
    const request = buildEngineerRequest("feature-plan", "Plan body");

    assertEquals(request, "## Approved Plan: feature-plan\n\n## Approved Plan Body\n\nPlan body");
    assertEquals(request.includes("Router Handoff Message"), false);
    assertEquals(request.includes("Runtime Collaboration Style"), false);
    assertEquals(request.includes("Annotations Submitted With Approval"), false);
});

Deno.test("buildEngineerRequest removes protected Plan Front Matter and preserves the projected body exactly", () => {
    const projectedBody =
        "# Approved body\n\nUNIQUE BODY SENTINEL\n\n## Router Handoff Message\nThis is ordinary Plan Markdown.";
    const request = buildEngineerRequest(
        "feature-plan",
        `---\nsummary: SECRET FRONT MATTER\nworktreeId: secret-worktree\n---\n${projectedBody}\n`,
    );

    assertEquals(request, `## Approved Plan: feature-plan\n\n## Approved Plan Body\n\n${projectedBody}`);
    assertEquals(request.includes("SECRET FRONT MATTER"), false);
    assertEquals(request.includes("worktreeId"), false);
});

Deno.test("buildEngineerRequest includes confirmed Plan Deviations after the body", () => {
    const request = buildEngineerRequest(
        "feature-plan",
        `---
planDeviations:
  - id: call-1
    supersededRequirement: "Replace nav."
    replacementRequirement: "Keep nav."
    approvedAt: "2026-09-10T00:00:00.000Z"
---
# Approved body
`,
    );

    assertStringIncludes(request, "## Approved Plan Body\n\n# Approved body");
    assertStringIncludes(request, "## Approved Plan Deviations");
    assertStringIncludes(request, "Superseded requirement: Replace nav.");
    assertStringIncludes(request, "Replacement requirement: Keep nav.");
});

Deno.test("buildTriageReport preserves the Router's structured context", () => {
    const report = buildTriageReport({
        routingIntent: "PLANNED_CHANGE",
        classification: "PLANNED_CHANGE",
        workKind: "DOCUMENTATION",
        sessionName: "documentation work kind",
        complexity: "MEDIUM",
        summary: "Add a documentation Work Kind.",
        affectedPaths: ["src/constants.js", "docs/prd/runwield-core-prd.md"],
    });

    assertStringIncludes(report, "- Routing Intent: PLANNED_CHANGE");
    assertStringIncludes(report, "- Plan Classification: PLANNED_CHANGE");
    assertStringIncludes(report, "- Work Kind: DOCUMENTATION");
    assertStringIncludes(report, "- Session Name: documentation work kind");
    assertStringIncludes(report, "- Complexity: MEDIUM");
    assertStringIncludes(report, "- Summary: Add a documentation Work Kind.");
    assertStringIncludes(report, "- Affected paths: src/constants.js, docs/prd/runwield-core-prd.md");
});

Deno.test("buildEngineerRequest orders Router handoff, pair runtime value, projected Plan, and annotations", () => {
    const feedback = "Approval note: keep the highlighted boundary.";
    const request = buildEngineerRequest(
        "documentation-work-kind",
        "## Implementation Steps\n\nUNIQUE PAIR BODY SENTINEL\n\n1. Update the taxonomy.",
        feedback,
        {
            collaborationStyle: "pair",
            routerMessage: "Add documentation as a first-class Work Kind.",
        },
    );

    assertEquals(
        request,
        "## Approved Plan: documentation-work-kind\n\n" +
            "## Router Handoff Message\n" +
            "Add documentation as a first-class Work Kind.\n\n" +
            "## Runtime Collaboration Style\n" +
            "Pair Execution is active. Report checkpoints, then resolve them only from later user turns as described in your Runtime Collaboration Style.\n\n" +
            "## Approved Plan Body\n\n" +
            "## Implementation Steps\n\n" +
            "UNIQUE PAIR BODY SENTINEL\n\n" +
            "1. Update the taxonomy.\n\n" +
            "## Annotations Submitted With Approval\n" +
            "These notes are implementation context carried forward from Plan Review; the Plan remains approved.\n\n" +
            feedback,
    );
});

Deno.test("buildEngineerRequest names autonomous runtime value without duplicated execution rules", () => {
    const request = buildEngineerRequest("autonomous-plan", "Plan body", undefined, {
        collaborationStyle: "autonomous",
    });

    assertStringIncludes(request, "## Runtime Collaboration Style\nAutonomous execution is active.");
    assertEquals(request.includes("Execute the following plan step by step"), false);
    assertEquals(request.includes("call task_completed"), false);
    assertEquals(request.includes("Complete all Implementation Steps"), false);
    assertEquals(request.includes("Do not use Pair checkpoint ceremony"), false);
    assertEquals(request.includes("Follow the Runtime Collaboration Style section"), false);
    assertEquals(request.includes("## Triage Report"), false);
    assertEquals(request.includes("Routing Intent"), false);
    assertEquals(request.includes("Plan Classification"), false);
});

Deno.test("buildReAnchorMessage names the draft Plan and its sections for Planner", () => {
    const message = buildReAnchorMessage({ agentName: "planner", planName: "some-plan" });

    assertStringIncludes(String(message), "Context was compacted.");
    assertStringIncludes(String(message), "draft Plan is `docs/plans/some-plan.md`");
    assertStringIncludes(String(message), "Implementation Steps");
});

Deno.test("buildReAnchorMessage names the Epic for Architect", () => {
    const message = buildReAnchorMessage({ agentName: "architect", planName: "some-epic" });

    assertStringIncludes(String(message), "Epic is `docs/plans/some-epic.md`");
    assertStringIncludes(String(message), "Vertical Slice Findings");
});

Deno.test("buildReAnchorMessage gives both Plan executors only the parsed Plan body", () => {
    for (const agentName of ["plan-engineer", "frontend-engineer"]) {
        const message = String(buildReAnchorMessage({
            agentName,
            planName: "some-plan",
            planBody: "---\nsummary: SECRET\n---\n# Body\n\nVerification Plan",
        }));

        assertStringIncludes(message, "## Approved Plan Body");
        assertStringIncludes(message, "# Body");
        assertStringIncludes(message, "Verification Plan");
        assertEquals(message.includes("SECRET"), false);
        assertEquals(message.includes("docs/plans/some-plan.md"), false);
    }
});

Deno.test("buildReAnchorMessage re-anchors no Plan for the Quick Fix Engineer", () => {
    // Engineer executes no Plan, so a Plan body is not the artifact its
    // discarded context was about.
    assertEquals(
        buildReAnchorMessage({
            agentName: "engineer",
            planName: "some-plan",
            planBody: "---\nsummary: SECRET\n---\n# Body\n\nVerification Plan",
        }),
        null,
    );
});

Deno.test("buildReAnchorMessage carries open review issues for a repair turn", () => {
    const message = String(buildReAnchorMessage({
        agentName: "reviewer-feedback-engineer",
        planName: "some-plan",
        planBody: "# Repair body",
        openReviewItems: "R1-1 — Seam check never runs\n  Plan requirement: Verification Plan step 3",
    }));

    assertStringIncludes(message, "# Repair body");
    assertStringIncludes(message, "## Open Review Issue Ledger");
    assertStringIncludes(message, "R1-1 — Seam check never runs");
});

Deno.test("buildReAnchorMessage omits an empty Review Issue Ledger", () => {
    const message = String(buildReAnchorMessage({
        agentName: "reviewer-feedback-engineer",
        planName: "some-plan",
        planBody: "# Repair body",
        openReviewItems: "(none)",
    }));

    assertStringIncludes(message, "# Repair body");
    if (message.includes("Open Review Issue Ledger")) {
        throw new Error("An empty ledger must not add a ledger section");
    }
});

Deno.test("buildReAnchorMessage returns null for agents with no durable artifact", () => {
    for (const agentName of ["delegated", "reviewer", "slicer", "router", "recorder", ""]) {
        assertEquals(buildReAnchorMessage({ agentName, planName: "some-plan" }), null);
    }
});

Deno.test("buildReAnchorMessage returns null when no Plan pointer survived", () => {
    assertEquals(buildReAnchorMessage({ agentName: "engineer" }), null);
    assertEquals(buildReAnchorMessage({ agentName: "engineer", planName: "   " }), null);
    assertEquals(buildReAnchorMessage(), null);
});

Deno.test("buildReAnchorMessage refuses an execution re-anchor without a projected body", () => {
    assertEquals(buildReAnchorMessage({ agentName: "engineer", planName: "some-plan" }), null);
});
