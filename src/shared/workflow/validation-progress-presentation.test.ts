import { assertEquals } from "@std/assert";
import {
    validationCheckLabel,
    validationProgressCheckSummary,
    validationProgressHeading,
    validationStageLabel,
} from "./validation-progress-presentation.ts";
import type { RuntimeValidationProgress } from "../session/session-runtime-events.js";

const BASE_CHECKS: RuntimeValidationProgress["checks"] = {
    ci: "pending",
    semanticReview: "pending",
    humanReview: "pending",
    merge: "pending",
};

function progress(
    patch:
        & Pick<RuntimeValidationProgress, "kind" | "outcome" | "stage">
        & Partial<Omit<RuntimeValidationProgress, "kind" | "outcome" | "stage">>,
): RuntimeValidationProgress {
    return {
        checks: BASE_CHECKS,
        cycle: 1,
        maxCycles: 3,
        totalCycle: 4,
        ...patch,
    };
}

Deno.test("validation progress labels use owner terms", () => {
    assertEquals(validationStageLabel("ci"), "Verification Command");
    assertEquals(validationStageLabel("semantic_review"), "AI review");
    assertEquals(validationStageLabel("human_review"), "Code review");
    assertEquals(validationStageLabel("engineer_repair"), "Repair");
    assertEquals(validationStageLabel("merge"), "Merge worktree");
    assertEquals(validationStageLabel("terminal"), "Validation result");
    assertEquals(validationCheckLabel("ci"), "Verification Command");
    assertEquals(validationCheckLabel("semanticReview"), "AI review");
    assertEquals(validationCheckLabel("humanReview"), "Code review");
    assertEquals(validationCheckLabel("merge"), "Merge worktree");
});

Deno.test("validation progress headings hide raw stages and counters", () => {
    const cases: RuntimeValidationProgress[] = [
        progress({ kind: "mechanical", outcome: "running", stage: "ci" }),
        progress({ kind: "workflow", outcome: "running", stage: "semantic_review" }),
        progress({ kind: "workflow", outcome: "paused", stage: "human_review" }),
        progress({ kind: "workflow", outcome: "failed", stage: "terminal" }),
        progress({ kind: "workflow", outcome: "verified", stage: "terminal" }),
        progress({
            kind: "mechanical",
            outcome: "failed",
            stage: "terminal",
            checks: { ...BASE_CHECKS, ci: "failed" },
        }),
        progress({
            kind: "mechanical",
            outcome: "verified",
            stage: "terminal",
            checks: { ...BASE_CHECKS, ci: "passed" },
        }),
    ];
    const headings = cases.map(validationProgressHeading);

    assertEquals(headings, [
        "Verification Command running",
        "AI review running",
        "Code review paused",
        "Validation failed",
        "Validation passed",
        "Verification Command failed",
        "Verification Command done",
    ]);
    for (const heading of headings) {
        assertEquals(heading.includes("semantic_review"), false, heading);
        assertEquals(heading.includes("Mechanical"), false, heading);
        assertEquals(heading.includes("Semantic Code Review"), false, heading);
        assertEquals(heading.includes("4"), false, heading);
    }
});

Deno.test("validation check summary uses shared labels without raw check names", () => {
    const summary = validationProgressCheckSummary(progress({
        kind: "workflow",
        outcome: "running",
        stage: "merge",
        checks: {
            ci: "passed",
            semanticReview: "passed",
            humanReview: "skipped",
            merge: "running",
        },
    }));

    assertEquals(
        summary,
        "Verification Command done, AI review passed, Code review skipped, Merge worktree running",
    );
    assertEquals(summary.includes("semanticReview"), false);
});
