import { test } from "node:test";
import { realpath as fsRealpath, rm as fsRm, writeFile as fsWriteFile, mkdir as fsMkdir } from "node:fs/promises";
import { ok as assert } from "node:assert/strict";
import { assertEquals, assertStringIncludes } from "../../testing/assertions.ts";
import { join } from "node:path";
import { loadPlan } from "../../plan-store.js";
import { hasNonGitExecutionConsent } from "../non-git-execution-consent.ts";
import {
    getTransitionJournalDir,
    getTransitionJournalPath,
    listTransitionRecoveryRecords,
} from "../workflow/state-transition.ts";
import { makeValidationProjectRoot } from "../workflow/validation-test-helpers.js";
import { readRecordBytes, runOperation, spawnAttachedCli, withProject } from "./attached-test-fixture.ts";
import { completionInput, executionInput, readyPlan } from "./execution-test-fixture.ts";
import { type AttachedWorkflowRecord, loadAttachedWorkflowRecord, locateAttachedWorkflows } from "./record-store.ts";

for (const consent of ["proceed", "decline"] as const) {
    test(`non-Git consent persists across processes and ${consent} uses the Core decision`, async () => {
        const root = await makeValidationProjectRoot("other");
        try {
            const ready = await readyPlan(root);
            const question = await runOperation("start_execution", root, executionInput(ready, "ask"));
            assert(question.ok && question.workflow.nextAction.kind === "consent", JSON.stringify(question));
            assertEquals(question.workflow.state, "awaiting_consent");
            assertEquals(question.workflow.execution, null);
            assertStringIncludes(question.workflow.nextAction.disclosure, "edits current files directly");
            const fresh = await spawnAttachedCli("status", root, { workflowId: ready.workflowId });
            assert(fresh.result.ok);
            assertEquals(fresh.result.workflow.nextAction, question.workflow.nextAction);
            const wrong = await runOperation(
                "start_execution",
                root,
                executionInput(question.workflow, "wrong", { actionId: "old", consent }),
            );
            assert(!wrong.ok && wrong.rejection.code === "action_superseded");
            const answer = await spawnAttachedCli(
                "start_execution",
                root,
                executionInput(question.workflow, "answer", {
                    actionId: question.workflow.nextAction.actionId,
                    consent,
                }),
            );
            assert(answer.result.ok, JSON.stringify(answer.result));
            assertEquals(hasNonGitExecutionConsent("featurePlan", root), consent === "proceed");
            assertEquals(answer.result.workflow.pendingConsent, null);
            if (consent === "decline") {
                assertEquals(answer.result.workflow.state, "plan_ready");
                assertEquals(answer.result.workflow.execution, null);
                assertEquals((await loadPlan(root, "dark-mode-toggle"))?.attrs.status, "ready_for_work");
            } else {
                assertEquals(answer.result.workflow.state, "implementing");
                assertEquals(answer.result.workflow.execution?.executionMode, "non_git_in_place");
                assertEquals(answer.result.workflow.execution?.executionCwd, await fsRealpath(root));
                const completed = await runOperation("task_completed", root, completionInput(answer.result.workflow));
                assert(completed.ok, JSON.stringify(completed));
                assertEquals((await loadPlan(root, "dark-mode-toggle"))?.attrs.status, "implemented");
            }
        } finally {
            await fsRm(root, { recursive: true });
        }
    });
}

test("old Attached records without execution fields normalize to null on read", async () => {
    await withProject(async (root) => {
        const ready = await readyPlan(root);
        const location = locateAttachedWorkflows(root);
        const record: AttachedWorkflowRecord = JSON.parse(await readRecordBytes(root, ready.workflowId));
        const { execution: _execution, pendingConsent: _pendingConsent, ...old } = record;
        await fsWriteFile(join(location.workflowsDir, `${ready.workflowId}.json`), JSON.stringify(old));
        const loaded = await loadAttachedWorkflowRecord(location, ready.workflowId);
        assert(loaded.status === "found");
        assertEquals(loaded.record.execution, null);
        assertEquals(loaded.record.pendingConsent, null);
        const status = await runOperation("status", root, { workflowId: ready.workflowId });
        assert(status.ok);
        assertEquals(status.workflow.execution, null);
        assertEquals(status.workflow.pendingConsent, null);
    });
});

test("non-Git preparation retries after a lost Attached write without repeating execution_started", async () => {
    const root = await makeValidationProjectRoot("other");
    try {
        const ready = await readyPlan(root);
        const question = await runOperation("start_execution", root, executionInput(ready, "ask"));
        assert(question.ok && question.workflow.nextAction.kind === "consent");
        const before = await readRecordBytes(root, ready.workflowId);
        const input = executionInput(question.workflow, "answer", {
            actionId: question.workflow.nextAction.actionId,
            consent: "proceed",
        });
        const started = await runOperation("start_execution", root, input);
        assert(started.ok && started.workflow.state === "implementing");
        const transitionId = crypto.randomUUID();
        await fsMkdir(getTransitionJournalDir(root), { recursive: true });
        await fsWriteFile(
            getTransitionJournalPath(root, transitionId),
            JSON.stringify({
                version: 1,
                transitionId,
                operation: "execution_preparation",
                planName: "dark-mode-toggle",
                resources: [{ kind: "plan", id: "dark-mode-toggle" }],
                state: "applying",
                intendedPostconditions: { status: "in_progress" },
                completedEffects: [{ effect: "execution_prepared", completedAt: new Date().toISOString() }],
                updatedAt: new Date().toISOString(),
            }),
        );
        assertEquals((await listTransitionRecoveryRecords(root)).length, 1);
        await fsWriteFile(join(locateAttachedWorkflows(root).workflowsDir, `${ready.workflowId}.json`), before);
        const retry = await spawnAttachedCli("start_execution", root, input);
        assert(retry.result.ok, JSON.stringify(retry.result));
        assertEquals(retry.result.workflow.state, "implementing");
        assertEquals(retry.result.workflow.execution?.executionMode, "non_git_in_place");
        assertEquals((await listTransitionRecoveryRecords(root)).length, 0);
        assertEquals((await loadPlan(root, "dark-mode-toggle"))?.attrs.status, "in_progress");
    } finally {
        await fsRm(root, { recursive: true });
    }
});
