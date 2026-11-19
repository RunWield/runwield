import { test } from "node:test";
import { ok as assert, strictEqual as equal, deepStrictEqual } from "node:assert/strict";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { defineGitFixture, git } from "../git-test-fixture.ts";
import { readAttachedAction } from "./coordinator.ts";
import { listEntries } from "../worktree-registry.ts";
import { resolveWorkflowPlanLocation } from "../workflow/plan-location.ts";
import { loadPlan } from "../../plan-store.ts";
import {
    activateInput,
    EVIDENCE,
    pendingTriage,
    runOperation,
    triageReportInput,
    reachPlanning,
    readRecordBytes,
    spawnAttachedCli,
    planWrittenInput,
} from "./attached-test-fixture.ts";

const child = { planName: "epic/02-next", planId: "child-two" };
const fixture = defineGitFixture(async (root) => {
    await mkdir(join(root, "docs/plans/epic"), { recursive: true });
    await writeFile(join(root, "README.md"), "clean main\n");
    await writeFile(
        join(root, "docs/plans/epic.md"),
        "---\nplanId: parent\nclassification: PROJECT\nstatus: ready_for_work\ntargetBranch: epic/target\n---\n# Epic\n",
    );
    await git(root, ["add", "."]);
    await git(root, ["commit", "-m", "main"]);
    await git(root, ["switch", "-c", "epic/target"]);
    await writeFile(
        join(root, "docs/plans/epic/02-next.md"),
        "---\nplanId: child-two\nclassification: PLANNED_CHANGE\ncomplexity: HIGH\nstatus: draft\nparentPlan: epic\norder: 2\ntargetBranch: epic/target\n---\n# Target child\n",
    );
    await writeFile(join(root, "target-only.txt"), "published sibling implementation\n");
    await writeFile(
        join(root, "docs/plans/epic/03-later.md"),
        "---\nplanId: child-three\nclassification: PLANNED_CHANGE\nstatus: draft\nparentPlan: epic\norder: 3\ntargetBranch: epic/target\n---\n# Later child\n",
    );
    await git(root, ["add", "."]);
    await git(root, ["commit", "-m", "published Epic family"]);
    await git(root, ["switch", "main"]);
});

test("native existing-child planning hands off an isolated authoritative document", async () => {
    const root = await fixture.checkout();
    await writeFile(join(root, "README.md"), "dirty invoking checkout\n");
    await git(root, ["add", "README.md"]);
    await writeFile(join(root, "untracked.txt"), "preserve this too\n");
    const staged = await git(root, ["diff", "--cached", "--binary"]);
    const input = activateInput();
    input.payload = {
        requestText: `Plan only docs/plans/${child.planName}.md, Plan ID ${child.planId}, target epic/target`,
        hostRequestId: "existing-child",
        existingPlan: { ...child, targetBranch: "epic/target" },
    };
    const triage = pendingTriage(await runOperation("activate", root, input));
    const planned = await runOperation("triage_report", root, triageReportInput(triage));
    assert(planned.ok && planned.workflow.nextAction.kind === "plan");
    const before = await git(root, ["status", "--porcelain"]);
    const passive = await runOperation("status", root, { workflowId: triage.workflowId, inspectOnly: true });
    assert(passive.ok);
    equal((await listEntries(root)).length, 0);
    equal((await resolveWorkflowPlanLocation(root, child.planName, { readOnly: true })).planningNotStarted, true);
    equal(await git(root, ["status", "--porcelain"]), before);
    const prepareInput = {
        workflowId: triage.workflowId,
        evidence: EVIDENCE,
        operationId: "prepare-planning",
        expectedRevision: planned.workflow.revision,
        payload: { actionId: planned.workflow.nextAction.actionId },
    };
    const prepared = await runOperation("start_planning", root, prepareInput);
    assert(prepared.ok && prepared.workflow.nextAction.kind === "plan", JSON.stringify(prepared));
    const handoffInput = {
        projectRoot: root,
        evidence: EVIDENCE,
        workflowId: triage.workflowId,
        actionId: planned.workflow.nextAction.actionId,
        content: "instructions" as const,
    };
    const handoff = await readAttachedAction(handoffInput);
    assert(handoff.ok && "context" in handoff && handoff.context?.kind === "plan");
    assert(planned.workflow.plan, "Existing child must be bound before the Planner is dispatched");
    deepStrictEqual(prepared.workflow.plan, child);
    const action = prepared.workflow.nextAction;
    equal(action.planningRequired, false);
    assert(action.planningCwd && action.planningCwd !== root);
    equal(action.planPath, join(action.planningCwd, "docs/plans/epic/02-next.md"));
    equal(handoff.context.planningCwd, action.planningCwd);
    equal(handoff.context.planPath, action.planPath);
    equal(handoff.context.planId, child.planId);
    equal(handoff.context.planningRequired, false);
    equal(await readFile(join(action.planningCwd, "target-only.txt"), "utf8"), "published sibling implementation\n");
    equal((await loadPlan(action.planningCwd, child.planName))?.attrs.planId, child.planId);
    equal(await git(root, ["branch", "--show-current"]), "main");
    equal(await readFile(join(root, "README.md"), "utf8"), "dirty invoking checkout\n");
    equal(await readFile(join(root, "untracked.txt"), "utf8"), "preserve this too\n");
    equal(await git(root, ["diff", "--cached", "--binary"]), staged);
    const entries = await listEntries(root);
    equal(entries.length, 1);
    equal(entries[0].planName, child.planName);
    equal((await loadPlan(action.planningCwd, "epic/03-later"))?.attrs.status, "draft");
    deepStrictEqual(await runOperation("start_planning", root, prepareInput), prepared);
    deepStrictEqual(await readAttachedAction(handoffInput), handoff);
    const retried = await runOperation("start_planning", root, {
        ...prepareInput,
        operationId: "retry-preparation",
        expectedRevision: prepared.workflow.revision,
    });
    assert(retried.ok && retried.workflow.nextAction.kind === "plan");
    equal(retried.workflow.nextAction.planningCwd, action.planningCwd);
    deepStrictEqual(await listEntries(root), entries);
});

test("Plan submission cannot bypass missing target-backed planning preparation", async () => {
    const root = await fixture.checkout();
    const { planning } = await reachPlanning(root);
    const result = await runOperation(
        "plan_written",
        root,
        planWrittenInput({ ...planning, planName: child.planName }),
    );
    assert(!result.ok);
    assert(result.rejection.message.includes("Start planning"));
    equal((await listEntries(root)).length, 0);
    equal((await resolveWorkflowPlanLocation(root, child.planName, { readOnly: true })).planningNotStarted, true);
});

test("an older unbound workflow binds only the selected child and restores preparation in a fresh process", async () => {
    const root = await fixture.checkout();
    const { planning } = await reachPlanning(root);
    const result = await runOperation("start_planning", root, {
        workflowId: planning.workflowId,
        expectedRevision: planning.expectedRevision,
        operationId: "resume-child",
        evidence: EVIDENCE,
        payload: { actionId: planning.actionId, existingPlan: { ...child, targetBranch: "epic/target" } },
    });
    assert(result.ok && result.workflow.nextAction.kind === "plan", JSON.stringify(result));
    deepStrictEqual(result.workflow.plan, child);
    equal(result.workflow.nextAction.actionId, planning.actionId);
    const fresh = await spawnAttachedCli("get_instructions", root, {
        workflowId: planning.workflowId,
        actionId: planning.actionId,
        evidence: EVIDENCE,
    });
    assert(fresh.result.ok && "context" in fresh.result && fresh.result.context?.kind === "plan");
    equal(fresh.result.context.planningCwd, result.workflow.nextAction.planningCwd);
    equal(fresh.result.context.planId, child.planId);
    equal((await listEntries(root)).length, 1);
});

for (const selection of [
    { ...child, planId: "wrong-child" },
    { ...child, targetBranch: "wrong-target" },
    { ...child, planName: "epic/missing" },
]) {
    test(`planning rejects a mismatched or missing selection ${JSON.stringify(selection)} without preparation`, async () => {
        const root = await fixture.checkout();
        const { planning } = await reachPlanning(root);
        const before = await readRecordBytes(root, planning.workflowId);
        const files = await git(root, ["status", "--porcelain"]);
        const result = await runOperation("start_planning", root, {
            workflowId: planning.workflowId,
            expectedRevision: planning.expectedRevision,
            operationId: "wrong-selection",
            evidence: EVIDENCE,
            payload: { actionId: planning.actionId, existingPlan: selection },
        });
        assert(!result.ok);
        equal(result.rejection.code, "invalid_input");
        equal(await readRecordBytes(root, planning.workflowId), before);
        equal(await git(root, ["status", "--porcelain"]), files);
        equal((await listEntries(root)).length, 0);
    });
}

test("a stale planning action cannot prepare a workspace", async () => {
    const root = await fixture.checkout();
    const { planning } = await reachPlanning(root);
    const result = await runOperation("start_planning", root, {
        workflowId: planning.workflowId,
        expectedRevision: planning.expectedRevision,
        operationId: "stale-action",
        evidence: EVIDENCE,
        payload: { actionId: "stale", existingPlan: child },
    });
    assert(!result.ok);
    equal(result.rejection.code, "action_superseded");
    equal((await listEntries(root)).length, 0);
});
