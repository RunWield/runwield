import { assertEquals } from "../../testing/assertions.ts";
import { test } from "node:test";
import {
    candidateIdentity,
    extractDiffPaths,
    hasImplementationDiff,
    requiresImplementationDiff,
    shouldContinueParentEpicAfterValidation,
    shouldRunWorkflowValidation,
} from "./validation-scope.ts";
import type { TriageMeta } from "../../tools/plan-written.ts";

const meta = (classification: TriageMeta["classification"], extra: Partial<TriageMeta> = {}): TriageMeta => ({
    classification,
    ...extra,
});

// One rule, two names. Asserting through both names is what keeps the alias honest:
// if someone gives `requiresImplementationDiff` its own body, this is where the two
// have to be pulled apart deliberately.
test("routing and evidence read through one rule", () => {
    // FEATURE is a legacy alias for PLANNED_CHANGE, not a third behavior. Pinned here
    // because "FEATURE is excluded" is the natural wrong guess from the name alone.
    for (const classification of ["PLANNED_CHANGE", "PROJECT", "FEATURE"] as const) {
        assertEquals(shouldRunWorkflowValidation(meta(classification)), true);
        assertEquals(requiresImplementationDiff(meta(classification)), true);
    }
    assertEquals(shouldRunWorkflowValidation(meta("QUICK_FIX")), false);
    assertEquals(requiresImplementationDiff(meta("QUICK_FIX")), false);
    assertEquals(shouldRunWorkflowValidation(undefined), false);
    assertEquals(requiresImplementationDiff(undefined), false);
});

test("only a child Plan with a parent hands back to its Epic", () => {
    assertEquals(shouldContinueParentEpicAfterValidation(meta("PLANNED_CHANGE", { parentPlan: "epic" })), true);
    assertEquals(shouldContinueParentEpicAfterValidation(meta("PLANNED_CHANGE")), false);
    assertEquals(shouldContinueParentEpicAfterValidation(meta("PLANNED_CHANGE", { parentPlan: "   " })), false);
    // A PROJECT Plan runs validation but is not a child, so it never continues a parent.
    assertEquals(shouldContinueParentEpicAfterValidation(meta("PROJECT", { parentPlan: "epic" })), false);
});

test("implementation diffs are distinguished from Plan-only edits", () => {
    const planOnly = "diff --git a/docs/plans/demo.md b/docs/plans/demo.md\n";
    const withCode = `${planOnly}diff --git a/src/thing.ts b/src/thing.ts\n`;

    assertEquals(extractDiffPaths(withCode).length, 4);
    assertEquals(hasImplementationDiff(planOnly, "demo"), false);
    assertEquals(hasImplementationDiff(withCode, "demo"), true);
    assertEquals(hasImplementationDiff("   \n", "demo"), false);

    // Sibling and nested child Plan documents are still Plan documents: editing another
    // Plan is not implementing this one.
    assertEquals(hasImplementationDiff("diff --git a/docs/plans/other.md b/docs/plans/other.md\n", "demo"), false);
    assertEquals(
        hasImplementationDiff("diff --git a/docs/plans/epic/child.md b/docs/plans/epic/child.md\n", "demo"),
        false,
    );

    // The legacy store is no longer canonical Plan metadata after the clean break.
    assertEquals(hasImplementationDiff("diff --git a/plans/demo.md b/plans/demo.md\n", "demo"), true);

    // Non-empty but unparseable counts as implementation on purpose. Treating a diff
    // RunWield cannot read as "no work" would let a Plan claim completion over
    // changes nobody accounted for.
    assertEquals(hasImplementationDiff("something we cannot parse", "demo"), true);
});

const codeDiff = "diff --git a/src/value.ts b/src/value.ts\n@@ -1 +1 @@\n-old\n+new\n";

test("candidate identity ignores all Plan sections but binds implementation content", () => {
    const plan = "diff --git a/docs/plans/demo.md b/docs/plans/demo.md\n+status: reviewed\n";
    const sibling = "diff --git a/docs/plans/epic/other.md b/docs/plans/epic/other.md\n+changed prose\n";
    assertEquals(candidateIdentity(plan + codeDiff + sibling, "demo"), candidateIdentity(codeDiff, "demo"));
    assertEquals(candidateIdentity(plan + sibling, "demo"), candidateIdentity("", "demo"));
    const quotedPlan = 'diff --git "a/docs/plans/with\\tquote.md" "b/docs/plans/with\\tquote.md"\n+updated\n';
    assertEquals(candidateIdentity(quotedPlan + codeDiff, "demo"), candidateIdentity(codeDiff, "demo"));
    assertEquals(candidateIdentity(codeDiff, "demo").length, 64);
    assertEquals(
        candidateIdentity(codeDiff, "demo") === candidateIdentity(codeDiff.replace("+new", "+edited"), "demo"),
        false,
    );
});

test("candidate identity ignores transient RunWield runtime files but binds project settings", () => {
    const lock = "diff --git a/.wld/internal/plan-locks/demo.lock b/.wld/internal/plan-locks/demo.lock\n+locked\n";
    const settings = "diff --git a/.wld/settings.json b/.wld/settings.json\n+changed\n";
    assertEquals(candidateIdentity(codeDiff + lock, "demo"), candidateIdentity(codeDiff, "demo"));
    assertEquals(candidateIdentity(codeDiff + settings, "demo") === candidateIdentity(codeDiff, "demo"), false);
});

test("candidate identity retains unreadable diffs and renames outside Plan documents", () => {
    const rename =
        "diff --git a/docs/plans/demo.md b/src/demo.md\nrename from docs/plans/demo.md\nrename to src/demo.md\n";
    assertEquals(candidateIdentity(rename, "demo") === candidateIdentity("", "demo"), false);
    assertEquals(candidateIdentity("unreadable diff", "demo") === candidateIdentity("", "demo"), false);
});
