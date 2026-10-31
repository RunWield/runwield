import { test } from "node:test";
import { writeFile as fsWriteFile } from "node:fs/promises";
import { ok as assert } from "node:assert/strict";
import { assertEquals } from "../../testing/assertions.ts";
import { join } from "node:path";
import { attachedValidationFixture } from "./validation-test-fixture.ts";
import { loadAttachedWorkflowRecord, locateAttachedWorkflows, writeAttachedWorkflowRecord } from "./record-store.ts";

test("a lost validation request write is recovered from Core without rerunning CI", async () => {
    const fixture = await attachedValidationFixture();
    try {
        await fsWriteFile(join(fixture.cwd, "marker"), "pass");
        const result = await fixture.call("start_validation", await fixture.status());
        assert(result.ok && result.workflow.nextAction.kind === "validation");
        const expected = result.workflow.nextAction;
        const restored = await fixture.call("start_validation", result.workflow);
        assert(restored.ok);
        assertEquals(restored.workflow.nextAction, expected);
        assertEquals(await fixture.ciCount(), 1);
        const location = locateAttachedWorkflows(fixture.root);
        const loaded = await loadAttachedWorkflowRecord(location, fixture.workflowId);
        assert(loaded.status === "found");
        assert(
            (
                await writeAttachedWorkflowRecord(
                    location,
                    {
                        ...loaded.record,
                        revision: loaded.record.revision + 1,
                        validation: null,
                    },
                    loaded.record.revision,
                )
            ).status === "written",
        );
        const recovered = await fixture.call("start_validation", await fixture.status());
        assert(recovered.ok);
        assertEquals(recovered.workflow.nextAction, expected);
        assertEquals(await fixture.ciCount(), 1);
    } finally {
        await fixture.close();
    }
});

test("a rejected validation decision remains recoverable and a later text answer runs Core CI", async () => {
    const fixture = await attachedValidationFixture({ command: null });
    try {
        await fsWriteFile(join(fixture.cwd, "marker"), "pass");
        const result = await fixture.call("start_validation", await fixture.status());
        assert(
            result.ok &&
                result.workflow.nextAction.kind === "validation" &&
                result.workflow.nextAction.request.kind === "decision",
        );
        const canceled = await fixture.call("validation_decision", result.workflow, {
            actionId: result.workflow.nextAction.actionId,
            answer: { outcome: "canceled" },
        });
        assert(!canceled.ok && canceled.workflow);
        assertEquals(canceled.workflow.state, "validating");
        assertEquals(canceled.workflow.nextAction.kind, "validation_recovery");
        assertEquals(await fixture.ciCount(), 0);
        const resumed = await fixture.call("start_validation", await fixture.status());
        assert(
            resumed.ok &&
                resumed.workflow.nextAction.kind === "validation" &&
                resumed.workflow.nextAction.request.kind === "decision",
        );
        const answered = await fixture.call("validation_decision", resumed.workflow, {
            actionId: resumed.workflow.nextAction.actionId,
            answer: { outcome: "text", value: "sh verify.sh" },
        });
        assert(
            answered.ok &&
                answered.workflow.nextAction.kind === "validation" &&
                answered.workflow.nextAction.request.kind === "reviewer",
        );
        assertEquals(await fixture.ciCount(), 1);
    } finally {
        await fixture.close();
    }
});

test("a Core round-limit pause keeps findings and resumes the same user decision", async () => {
    const fixture = await attachedValidationFixture();
    try {
        const { updatePlanFrontMatter } = await import("../../plan-store.js");
        const { makeValidationCheckpoint } = await import("../workflow/validation-checkpoint.ts");
        const { createLedger, applyRoundFindings } = await import("../workflow/review-ledger.ts");
        const { SEMANTIC_REVIEW_CYCLES } = await import("../workflow/validation-types.ts");
        const { captureWorktreeTree } = await import("../workflow/git-snapshot.ts");
        const plan = await fixture.plan();
        const ledger = applyRoundFindings(
            createLedger(),
            [
                {
                    title: "Value",
                    resolved: false,
                    requirement: "Value",
                    evidence: "Missing",
                },
            ],
            1,
        ).ledger;
        await updatePlanFrontMatter(
            fixture.cwd,
            "p",
            {
                validationPhase: "semantic",
                validationSemanticRounds: SEMANTIC_REVIEW_CYCLES,
                validationCheckpoint: makeValidationCheckpoint({
                    attemptId: fixture.id,
                    generation: "paused-validation",
                    status: "implemented",
                    phase: "semantic",
                    state: "ready",
                    reviewState: {
                        semanticRound: SEMANTIC_REVIEW_CYCLES,
                        reviewLedger: ledger,
                        repairBaselineTree: await captureWorktreeTree(fixture.cwd),
                        lastRepairReport: "Fixed the value.",
                    },
                }),
            },
            plan.attrs,
            { expectedRevision: plan.revision, expectedControllerRevision: plan.controllerRevision },
        );
        const result = await fixture.call("start_validation", await fixture.status());
        assert(
            result.ok &&
                result.workflow.nextAction.kind === "validation" &&
                result.workflow.nextAction.request.kind === "decision",
        );
        const stopped = await fixture.call("validation_decision", result.workflow, {
            actionId: result.workflow.nextAction.actionId,
            answer: { outcome: "selected", value: "stop" },
        });
        assert(stopped.ok && stopped.workflow.nextAction.kind === "validation_recovery");
        assertEquals(stopped.workflow.nextAction.resultKind, "paused");
        assertEquals(stopped.workflow.state, "validating");
        assertEquals((await fixture.plan()).attrs.validationCheckpoint?.reviewState?.reviewLedger, ledger);
        const resumed = await fixture.call("start_validation", await fixture.status());
        assert(
            resumed.ok &&
                resumed.workflow.nextAction.kind === "validation" &&
                resumed.workflow.nextAction.request.kind === "decision",
        );
        assertEquals(resumed.workflow.nextAction.request.interaction, result.workflow.nextAction.request.interaction);
    } finally {
        await fixture.close();
    }
});
