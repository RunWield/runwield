import { test } from "node:test";
import { deepEqual, equal, ok, rejects } from "node:assert/strict";
import { mkdir, readFile, writeFile, lstat, rm, realpath } from "node:fs/promises";
import { join } from "node:path";
import { defineCommittedGitFixture, git } from "../git-test-fixture.ts";
import { enterProjectRuntime, resolveProjectRuntimeLayout } from "../project-runtime-layout.ts";
import { importPlans, savePlanProse, withLocalPlanWorkflow } from "../../plan-store/index.ts";
import { listPlans, loadPlan } from "../testing/plan-query-fixture.ts";
import { prepareSessionPlanningWorktree } from "./session-planning-worktree.ts";
import {
    reachPlanning,
    planWrittenInput,
    runOperation,
    spawnAttachedCli,
    EVIDENCE,
} from "../attached/attached-test-fixture.ts";
import { executionInput, completionInput } from "../attached/execution-test-fixture.ts";
import { ensureReviewHosted, stopHostedAttachedReviews } from "../attached/review-host.ts";
import { NO_OPEN_BROWSER_PORT } from "../browser-port.ts";
import { getRunWieldRuntimeDir } from "../../constants.ts";

const repository = defineCommittedGitFixture({ "README.md": "Composed migration\n" });

test("imported Epic sibling edits survive execution and another host resumes the exact saved workflow", async () => {
    const root = await realpath(await repository.checkout());
    const sources = new Map<string, string>();
    try {
        for (const [name, id, extra] of [
            ["family", "family-id", "classification: PROJECT\ntype: sequence"],
            ["family/first", "first-id", "classification: PLANNED_CHANGE\nparentPlan: family\norder: 1"],
            ["family/second", "second-id", "classification: PLANNED_CHANGE\nparentPlan: family\norder: 2"],
        ]) {
            const path = join(root, "docs/plans", `${name}.md`);
            await mkdir(join(path, ".."), { recursive: true });
            const text = `---\nplanId: ${id}\nstatus: draft\ntargetBranch: main\n${extra}\n---\n# ${name}\n\nOriginal scope.\n`;
            sources.set(path, text);
            await writeFile(path, text);
        }
        await mkdir(join(getRunWieldRuntimeDir(root), "internal/debug"), { recursive: true });
        await mkdir(join(root, ".wld/agents"), { recursive: true });
        const settings = '{"custom":{"plans":{"deliveryCopies":false},"workRecords":{"deliveryCopies":false}}}\n';
        await writeFile(join(root, ".wld/settings.json"), settings);
        await writeFile(join(root, ".wld/agents/personal.md"), "Personal override\n");
        await writeFile(join(getRunWieldRuntimeDir(root), "internal/debug/repair"), "unfinished repair\0bytes");
        await git(root, ["add", "README.md", "docs", ".wld/settings.json", ".wld/agents"]);
        await git(root, ["commit", "-m", "Legacy Epic and local preferences"]);
        deepEqual(await listPlans(root), []);
        await enterProjectRuntime(root);
        equal(
            await readFile(join(resolveProjectRuntimeLayout(root).primary.debugRoot, "repair"), "utf8"),
            "unfinished repair\0bytes",
        );
        equal((await importPlans(root, join(root, "docs/plans"))).kind, "committed");
        await importPlans(root, join(root, "docs/plans"));
        equal((await listPlans(root)).length, 3);
        equal((await loadPlan(root, "family/second"))?.attrs.parentPlan, "family");

        const { planning } = await reachPlanning(root);
        const prepared = await runOperation("start_planning", root, {
            ...planWrittenInput(planning),
            operationId: "prepare-imported-child",
            payload: { actionId: planning.actionId, existingPlan: { planName: "family/first", planId: "first-id" } },
        });
        ok(prepared.ok && prepared.workflow.nextAction.kind === "plan", JSON.stringify(prepared));
        const submitted = await runOperation(
            "plan_written",
            root,
            planWrittenInput({ ...planning, expectedRevision: prepared.workflow.revision, planName: "family/first" }),
        );
        ok(submitted.ok, JSON.stringify(submitted));
        const hosted = await ensureReviewHosted(root, submitted.workflow, NO_OPEN_BROWSER_PORT);
        ok(hosted);
        const url = new URL(hosted.url);
        const first = await loadPlan(root, "family/first");
        ok(first);
        const stale = await fetch(new URL(`/api/review/decision${url.search}`, url), {
            method: "POST",
            body: JSON.stringify({ documentRevision: "stale", reviewRevision: 0, approvalAction: "run" }),
        });
        equal(stale.status, 409, await stale.text());
        const approved = await fetch(new URL(`/api/review/decision${url.search}`, url), {
            method: "POST",
            body: JSON.stringify({
                documentRevision: first.revision,
                reviewRevision: 0,
                approvalAction: "run",
                executionAgent: "engineer",
                collaborationRecommendation: "autonomous",
            }),
        });
        equal(approved.status, 200, await approved.text());
        const ready = await runOperation("status", root, { workflowId: submitted.workflow.workflowId });
        ok(ready.ok);
        const started = await runOperation("start_execution", root, executionInput(ready.workflow, "composed-start"));
        ok(started.ok && started.workflow.nextAction.kind === "implementation", JSON.stringify(started));
        const active = started.workflow;
        ok(active.nextAction.kind === "implementation");
        const sibling = await loadPlan(root, "family/second");
        ok(sibling);
        await savePlanProse(root, "family/second", "# Sibling\n\nUnpublished sentinel scope.\n", sibling.revision);
        const later = await withLocalPlanWorkflow(root, "family/second", () =>
            prepareSessionPlanningWorktree(root, "family/second"),
        );
        ok(later.plan?.markdown.includes("Unpublished sentinel scope."));
        equal(later.plan?.attrs.planId, "second-id");
        equal((await loadPlan(root, "family/second"))?.attrs.status, "draft");

        // The second host discovers the saved workflow without receiving its ID.
        const evidence = { ...EVIDENCE, host: "codex", hostVersion: "0.164.0-alpha.11.1" };
        const resumed = await spawnAttachedCli("status", root, { inspectOnly: true, evidence });
        ok(resumed.result.ok, JSON.stringify(resumed.result));
        equal(resumed.result.workflow.workflowId, active.workflowId);
        equal(resumed.result.workflow.revision, active.revision);
        ok(resumed.result.workflow.nextAction.kind === "implementation");
        equal(resumed.result.workflow.nextAction.actionId, active.nextAction.actionId);
        equal(resumed.result.workflow.nextAction.planRevision, active.nextAction.planRevision);
        equal(resumed.result.workflow.nextAction.executionCwd, active.nextAction.executionCwd);
        equal(resumed.result.workflow.nextAction.worktreeBranch, active.nextAction.worktreeBranch);
        const instructions = await spawnAttachedCli("get_instructions", root, {
            workflowId: active.workflowId,
            actionId: active.nextAction.actionId,
            evidence,
        });
        ok(instructions.result.ok, JSON.stringify(instructions.result));
        const execution = active.nextAction.executionCwd;
        await writeFile(join(execution, "sentinel.ts"), 'export const sentinel = "composed";\n');
        const completed = await spawnAttachedCli("task_completed", root, {
            ...completionInput(resumed.result.workflow),
            evidence,
        });
        ok(completed.result.ok, JSON.stringify(completed.result));
        equal(completed.result.workflow.state, "implemented");
        equal(
            (await loadPlan(root, "family/first"))?.attrs.worktreeId,
            (await loadPlan(execution, "family/first"))?.attrs.worktreeId,
        );
        for (const [path, text] of sources) equal(await readFile(path, "utf8"), text);
        equal(await readFile(join(root, ".wld/settings.json"), "utf8"), settings);
        equal(await readFile(join(root, ".wld/agents/personal.md"), "utf8"), "Personal override\n");
        for (const cwd of [root, execution])
            for (const path of [".wld/internal", ".wld/plans"])
                await rejects(lstat(join(cwd, path)), { code: "ENOENT" });
    } finally {
        await stopHostedAttachedReviews();
        await rm(root, { recursive: true, force: true });
    }
});
