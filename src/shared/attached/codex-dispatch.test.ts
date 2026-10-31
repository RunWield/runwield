import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setCustomSetting } from "../settings.js";
import { applyAttachedReviewDecision, openAttachedReviewRound } from "./coordinator.ts";
import { ATTACHED_HOST_ROLES, type AttachedHostRole, type AttachedOperationResult } from "./operations.ts";
import {
    EVIDENCE,
    activateInput,
    pendingTriage,
    readRecordBytes,
    runOperation,
    submitReview,
    triageReportInput,
    withProject,
} from "./attached-test-fixture.ts";
import { compactResult, compactStatus } from "./presentation.ts";
import { executionInput } from "./execution-test-fixture.ts";
import { attachedValidationFixture } from "./validation-test-fixture.ts";
import { approveSemantic } from "./delivery-test-fixture.ts";

const evidence = { ...EVIDENCE, host: "codex", hostVersion: "0.164.0-alpha.11.1" };

async function saveRoles(root: string) {
    await setCustomSetting(
        "connect",
        {
            codex: {
                roles: Object.fromEntries(
                    ATTACHED_HOST_ROLES.map((role) => [role, { model: `native-${role}`, thinkingLevel: "high" }]),
                ),
            },
        },
        "project",
        root,
    );
}

async function assertDispatch(root: string, result: AttachedOperationResult, role: AttachedHostRole) {
    assert(result.ok);
    const expected = { host: "codex", role, status: "ready", model: `native-${role}`, thinkingLevel: "high" };
    assert.deepEqual(result.workflow.nextAction.dispatch, expected);
    if (result.instructions) assert.deepEqual(result.instructions.dispatch, expected);
    assert.deepEqual(compactResult(result).workflow?.nextAction.dispatch, expected);
    assert.deepEqual(compactStatus(result, null).workflow?.nextAction.dispatch, expected);
    const action = result.workflow.nextAction;
    assert("actionId" in action);
    const before = await readRecordBytes(root, result.workflow.workflowId);
    const fetched = await runOperation("get_instructions", root, {
        evidence,
        workflowId: result.workflow.workflowId,
        actionId: action.actionId,
    });
    assert(fetched.ok && "instructions" in fetched);
    assert.deepEqual(fetched.instructions.dispatch, expected);
    const status = await runOperation("status", root, {
        evidence,
        workflowId: result.workflow.workflowId,
        inspectOnly: true,
    });
    assert(status.ok);
    assert.deepEqual(status.workflow.nextAction.dispatch, expected);
    assert.equal(status.workflow.revision, result.workflow.revision);
    assert.equal(await readRecordBytes(root, result.workflow.workflowId), before);
    assert.equal(before.includes('"dispatch"'), false);
}

test("Router and Planner dispatch preferences survive action reads, compact status, and operation replay", async () => {
    await withProject(async (root) => {
        await saveRoles(root);
        const activated = await runOperation("activate", root, { ...activateInput(), evidence });
        await assertDispatch(root, activated, "router");
        const input = { ...triageReportInput(pendingTriage(activated)), evidence };
        const planned = await runOperation("triage_report", root, input);
        await assertDispatch(root, planned, "planner");
        await setCustomSetting(
            "connect",
            { codex: { roles: { planner: { model: "inherit", thinkingLevel: "max" } } } },
            "project",
            root,
        );
        const replay = await runOperation("triage_report", root, input);
        assert(replay.ok && planned.ok);
        assert.deepEqual(replay.workflow.nextAction.dispatch, {
            host: "codex",
            role: "planner",
            status: "ready",
            model: "inherit",
            thinkingLevel: "max",
        });
        assert.equal(replay.workflow.revision, planned.workflow.revision);
        assert.equal(
            "actionId" in replay.workflow.nextAction && replay.workflow.nextAction.actionId,
            "actionId" in planned.workflow.nextAction && planned.workflow.nextAction.actionId,
        );
    });
});

for (const role of ["engineer", "frontend-engineer"] as const) {
    test(`${role} implementation dispatch uses its own preferences and the saved execution directory`, async () => {
        await withProject(async (root) => {
            await saveRoles(root);
            const submitted = await submitReview(root);
            const round = await openAttachedReviewRound(root, submitted.workflowId);
            assert(round.kind === "opened");
            await applyAttachedReviewDecision(root, submitted.workflowId, round.basis, {
                approved: true,
                approvalAction: "run",
                executionAgent: role,
                collaborationRecommendation: "autonomous",
            });
            const status = await runOperation("status", root, { evidence, workflowId: submitted.workflowId });
            assert(status.ok);
            const started = await runOperation("start_execution", root, {
                ...executionInput(status.workflow, "start"),
                evidence,
            });
            await assertDispatch(root, started, role);
            assert(started.ok && started.workflow.nextAction.kind === "implementation");
            assert.notEqual(started.workflow.nextAction.executionCwd, root);
        });
    });
}

test("reviewer, repair, and Recorder preferences remain outside independent review content and durable records", async () => {
    const fixture = await attachedValidationFixture();
    try {
        await saveRoles(fixture.root);
        const failed = await fixture.call("start_validation", await fixture.status());
        assert(
            failed.ok &&
                failed.workflow.nextAction.kind === "validation" &&
                failed.workflow.nextAction.request.kind === "repair",
        );
        const repair = await runOperation("status", fixture.root, { evidence, workflowId: fixture.workflowId });
        await assertDispatch(fixture.root, repair, "reviewer-feedback-engineer");
        await writeFile(join(fixture.cwd, "marker"), "pass");
        const reviewed = await fixture.call("task_completed", failed.workflow, {
            actionId: failed.workflow.nextAction.actionId,
            message: "- Fixed CI by adding the required marker.",
        });
        assert(reviewed.ok);
        const reviewer = await runOperation("status", fixture.root, { evidence, workflowId: fixture.workflowId });
        await assertDispatch(fixture.root, reviewer, "reviewer");
        const compact = JSON.stringify(compactStatus(reviewer, null));
        assert.equal(compact.includes("instructions" + '"' + ":"), false);
        assert.equal(compact.includes("fullDiff"), false);
        assert.equal(compact.includes("systemPrompt"), false);
        const approved = await approveSemantic(fixture, reviewed.workflow);
        assert(approved.workflow.nextAction.kind === "code_review");
        const recording = await fixture.call("validation_decision", approved.workflow, {
            actionId: approved.workflow.nextAction.actionId,
            answer: { outcome: "approved" },
        });
        assert(recording.ok && recording.workflow.nextAction.kind === "recorder", JSON.stringify(recording));
        const recorder = await runOperation("status", fixture.root, { evidence, workflowId: fixture.workflowId });
        await assertDispatch(fixture.root, recorder, "recorder");
    } finally {
        await fixture.close();
    }
});

test("invalid preferences keep the action resumable and recover on the next read without a workflow transition", async () => {
    await withProject(async (root) => {
        const activated = await runOperation("activate", root, { ...activateInput(), evidence });
        assert(activated.ok);
        await setCustomSetting("connect", { codex: { roles: { planer: { model: "typo" } } } }, "project", root);
        const invalid = await runOperation("status", root, { evidence, workflowId: activated.workflow.workflowId });
        assert(invalid.ok);
        assert.equal(invalid.workflow.nextAction.dispatch?.status, "invalid");
        assert.deepEqual(
            compactStatus(invalid, null).workflow?.nextAction.dispatch,
            invalid.workflow.nextAction.dispatch,
        );
        await setCustomSetting("connect", {}, "project", root);
        const recovered = await runOperation("status", root, { evidence, workflowId: activated.workflow.workflowId });
        assert(recovered.ok);
        assert.equal(recovered.workflow.revision, activated.workflow.revision);
        assert.deepEqual(recovered.workflow.nextAction, activated.workflow.nextAction);
    });
});
