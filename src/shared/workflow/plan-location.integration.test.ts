import { assertEquals } from "../../testing/assertions.ts";
import { runtimeSourceArgs } from "../../testing/runtime-source-args.ts";
import { captureForegroundProcess } from "../captured-process.ts";
import { getCwd } from "../../constants.js";
import { test } from "node:test";
import { tmpdir } from "node:os";
import { realpathSync as fsRealpathSync } from "node:fs";
import {
    lstat as fsLstat,
    mkdtemp as fsMkdtemp,
    readFile as fsReadFile,
    rm as fsRm,
    stat as fsStat,
    writeFile as fsWriteFile,
} from "node:fs/promises";
import process from "node:process";
import { ok as assert } from "node:assert/strict";
import { fileURLToPath as fromFileUrl } from "node:url";
import { join } from "node:path";
import { getRunWieldRuntimeDir, PROJECT_INTERNAL_RUNTIME_DIR_NAME } from "../../constants.js";
import {
    listPlans,
    loadPlan,
    savePlan,
    updatePlanFrontMatter,
    withPlanCatalogLock,
    withPlanLock,
} from "../../plan-store.js";
import { defineCommittedGitFixture, git } from "../git-test-fixture.ts";
import { HostedSession } from "../session/hosted-session.js";
import { readControllerRecord, writeControllerState } from "./controller-registry.ts";
import { findById, getWorktreeRegistryPath, pruneEntry } from "../worktree-registry.js";
import { addEntry } from "../worktree-registry.js";
import { createExecutionStartPorts, startActiveExecutionWorkflow } from "./execution-start.ts";
import { recordPlanEvent } from "./plan-lifecycle.js";
import { recoverMissingExecutionWorktreesForPlanLoading, resolveWorkflowPlanLocation } from "./plan-location.ts";
import { applySharedPlanReviewDecision } from "./plan-review-actions.ts";
import { executePlanAction, loadPlanActionEvidence } from "./plan-actions.ts";

const fixture = defineCommittedGitFixture({ ".gitignore": ".wld/\n", "app.ts": "// application\n" });

async function pathExists(path: string): Promise<boolean> {
    return await fsStat(path).then(() => true).catch(() => false);
}

function selectedInternalLockPath(root: string, name: string): string {
    return join(getRunWieldRuntimeDir(fsRealpathSync(root)), PROJECT_INTERNAL_RUNTIME_DIR_NAME, "plan-locks", name);
}

test("Plan locks stay in the linked checkout while primary locks remain independent", async () => {
    const root = await fixture.checkout({ prefix: "rw-selected-lock-primary-" });
    const container = await fsMkdtemp(join(tmpdir(), "rw-selected-lock-tree-"));
    const selected = join(container, "selected");
    try {
        await git(root, ["worktree", "add", "-b", "worktree/selected-locks", selected, "HEAD"]);
        const selectedLock = selectedInternalLockPath(selected, "demo.lock");
        const selectedCatalog = selectedInternalLockPath(selected, "catalog.lock");
        const primaryLock = selectedInternalLockPath(root, "demo.lock");
        const primaryCatalog = selectedInternalLockPath(root, "catalog.lock");
        const legacySelectedLock = join(getRunWieldRuntimeDir(fsRealpathSync(selected)), "plan-locks", "demo.lock");
        const legacySelectedCatalog = join(
            getRunWieldRuntimeDir(fsRealpathSync(selected)),
            "plan-locks",
            "catalog.lock",
        );
        const primaryRegistryPath = getWorktreeRegistryPath(root);
        const selectedRegistryPath = join(
            getRunWieldRuntimeDir(fsRealpathSync(selected)),
            PROJECT_INTERNAL_RUNTIME_DIR_NAME,
            "worktrees.json",
        );
        const baseCommit = await git(root, ["rev-parse", "HEAD"]);
        await addEntry(selected, {
            id: "selected-entry",
            planName: "demo",
            planId: "plan-demo",
            baseBranch: "main",
            baseRef: "main",
            baseCommit,
            branch: "worktree/selected-locks",
            path: selected,
            status: "active",
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
        });
        assertEquals((await findById(root, "selected-entry"))?.path, selected);
        await fsLstat(primaryRegistryPath);
        assertEquals(await pathExists(selectedRegistryPath), false);
        await writeControllerState(selected, { planName: "demo", planId: "plan-demo" }, {
            failureReason: "primary proof",
        });
        assertEquals(
            (await readControllerRecord(root, { planName: "demo", planId: "plan-demo" }))?.state.failureReason,
            "primary proof",
        );
        const planEntries: string[] = [];
        let releaseFirstPlan = () => {};
        let signalFirstPlan = () => {};
        const firstPlanMayFinish = new Promise<void>((resolve) => releaseFirstPlan = resolve);
        const firstPlanEntered = new Promise<void>((resolve) => signalFirstPlan = resolve);
        const firstPlan = withPlanLock(selected, "demo", async () => {
            planEntries.push("selected-first");
            await fsLstat(selectedLock);
            assertEquals(await pathExists(primaryLock), false);
            assertEquals(await pathExists(legacySelectedLock), false);
            signalFirstPlan();
            await firstPlanMayFinish;
        });
        await firstPlanEntered;
        const selectedSecondPlan = withPlanLock(
            selected,
            "demo",
            () => Promise.resolve(planEntries.push("selected-second")),
        );
        await new Promise((resolve) => setTimeout(resolve, 75));
        assertEquals(planEntries, ["selected-first"]);
        await withPlanLock(root, "demo", async () => {
            planEntries.push("primary");
            await fsLstat(primaryLock);
        });
        releaseFirstPlan();
        await Promise.all([firstPlan, selectedSecondPlan]);
        assertEquals(planEntries, ["selected-first", "primary", "selected-second"]);
        assertEquals(await pathExists(selectedLock), false);
        assertEquals(await pathExists(primaryLock), false);

        const catalogEntries: string[] = [];
        let releaseFirstCatalog = () => {};
        let signalFirstCatalog = () => {};
        const firstCatalogMayFinish = new Promise<void>((resolve) => releaseFirstCatalog = resolve);
        const firstCatalogEntered = new Promise<void>((resolve) => signalFirstCatalog = resolve);
        const firstCatalog = withPlanCatalogLock(selected, async () => {
            catalogEntries.push("selected-first");
            await fsLstat(selectedCatalog);
            assertEquals(await pathExists(primaryCatalog), false);
            assertEquals(await pathExists(legacySelectedCatalog), false);
            signalFirstCatalog();
            await firstCatalogMayFinish;
        });
        await firstCatalogEntered;
        const selectedSecondCatalog = withPlanCatalogLock(
            selected,
            () => Promise.resolve(catalogEntries.push("selected-second")),
        );
        await new Promise((resolve) => setTimeout(resolve, 75));
        assertEquals(catalogEntries, ["selected-first"]);
        await withPlanCatalogLock(root, async () => {
            catalogEntries.push("primary");
            await fsLstat(primaryCatalog);
        });
        releaseFirstCatalog();
        await Promise.all([firstCatalog, selectedSecondCatalog]);
        assertEquals(catalogEntries, ["selected-first", "primary", "selected-second"]);
        assertEquals(await pathExists(selectedCatalog), false);
        assertEquals(await pathExists(primaryCatalog), false);
    } finally {
        await git(root, ["worktree", "remove", "--force", selected]).catch(() => {});
        await fsRm(container, { recursive: true }).catch(() => {});
        await fsRm(root, { recursive: true }).catch(() => {});
    }
});

test("load-plan rebuilds a missing execution worktree from one rescued branch", async () => {
    const root = await fixture.checkout({ prefix: "rw-rescued-execution-" });
    const container = await fsMkdtemp(join(tmpdir(), "rw-rescued-execution-tree-"));
    const executionPath = `${container}/execution`;
    try {
        await savePlan(root, "demo", "# Demo\n\n## Context\n\nImplement demo.\n", {
            planId: "rescued-plan-id",
            classification: "PLANNED_CHANGE",
            status: "ready_for_work",
            targetBranch: "main",
        });
        await git(root, ["add", "docs"]);
        await git(root, ["commit", "-m", "add Plan"]);
        const baseCommit = await git(root, ["rev-parse", "HEAD"]);
        const baseTree = await git(root, ["rev-parse", "HEAD^{tree}"]);
        await git(root, ["switch", "-c", "rescued/demo"]);
        await fsWriteFile(`${root}/app.ts`, "// rescued implementation\n");
        const plan = await loadPlan(root, "demo");
        assert(plan);
        await updatePlanFrontMatter(root, "demo", { status: "implemented" }, plan.attrs, {
            expectedRevision: plan.revision,
        });
        await git(root, ["add", "app.ts", "docs/plans/demo.md"]);
        await git(root, ["commit", "-m", "rescue completed implementation"]);
        await git(root, ["switch", "main"]);
        await fsWriteFile(`${root}/target.ts`, "// newer target work\n");
        await git(root, ["add", "target.ts"]);
        await git(root, ["commit", "-m", "new target work"]);
        await git(root, ["switch", "-c", "rescued/publication"]);
        await git(root, ["merge", "--no-ff", "rescued/demo", "-m", "manually rescue execution commits"]);
        const rescuedCommit = await git(root, ["rev-parse", "HEAD"]);
        await git(root, ["branch", "-D", "rescued/demo"]);
        await git(root, ["switch", "main"]);
        await addEntry(root, {
            id: "missing-attempt",
            planName: "demo",
            planId: "rescued-plan-id",
            baseBranch: "main",
            baseRef: "refs/heads/main",
            baseCommit,
            baseTree,
            executionBaselineTree: baseTree,
            branch: "worktree/demo-missing",
            path: executionPath,
            status: "completed",
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
        });

        assertEquals(await recoverMissingExecutionWorktreesForPlanLoading(root), [{
            planName: "demo",
            branch: "worktree/demo-missing",
        }]);
        const listed = await listPlans(root);

        assertEquals(listed.find((item) => item.name === "demo")?.attrs.status, "implemented");
        assertEquals((await resolveWorkflowPlanLocation(root, "demo")).documentRoot, executionPath);
        assertEquals(await git(root, ["rev-parse", "worktree/demo-missing"]), rescuedCommit);
        assertEquals((await loadPlan(root, "demo"))?.attrs.status, "ready_for_work");
    } finally {
        await git(root, ["worktree", "remove", "--force", executionPath]).catch(() => {});
        await fsRm(container, { recursive: true }).catch(() => {});
        await fsRm(root, { recursive: true });
    }
});

for (const surface of ["primary", "execution"]) {
    test(`review from ${surface}, restart, approve and execute keeps the document and attempt`, async () => {
        const root = await fixture.checkout();
        const first = new HostedSession({ id: "first", cwd: root, eventSink: () => {} });
        const second = new HostedSession({ id: "second", cwd: root, eventSink: () => {} });
        const trees: string[] = [];
        try {
            await savePlan(root, "demo", "# Demo\n\n## Context\n\nImplement demo.\n", {
                planId: "demo-id",
                classification: "PLANNED_CHANGE",
                status: "ready_for_work",
                executionAgent: "engineer",
                collaborationRecommendation: "autonomous",
                targetBranch: "main",
            });
            const initial = await loadPlan(root, "demo");
            assert(initial);
            await startActiveExecutionWorkflow({
                planName: "demo",
                triageMeta: initial.attrs,
                currentStatus: initial.attrs.status,
                hostedSession: first,
                ports: createExecutionStartPorts(),
            });
            const started = first.getActiveExecutionWorkflow();
            assert(started?.executionCwd && started.worktreeId);
            trees.push(started.executionCwd);
            const primaryBytes = await fsReadFile(initial.path, "utf8");
            const execution = await loadPlan(started.executionCwd, "demo");
            assert(execution);
            const reviewedMarkdown = execution.markdown.replace("Implement demo.", "The revised approved definition.");
            const review = await applySharedPlanReviewDecision({
                cwd: surface === "primary" ? root : started.executionCwd,
                planName: "demo",
                planPath: execution.path,
                planWithFrontMatter: reviewedMarkdown,
                planRevision: execution.revision,
                originalAttrs: execution.attrs,
                trustedClassification: "PLANNED_CHANGE",
                decision: {
                    approved: true,
                    approvalAction: "run",
                    executionAgent: "engineer",
                    collaborationRecommendation: "autonomous",
                },
            });
            assertEquals(review.approved, true, review.feedback);
            assertEquals((await findById(root, started.worktreeId))?.status, "active");
            const reopened = await resolveWorkflowPlanLocation(root, "demo");
            assert(reopened.plan);
            assertEquals(reopened.plan.attrs.status, "approved");
            assertEquals(reopened.plan.attrs.worktreeId, started.worktreeId);
            assertEquals(reopened.plan.attrs.worktreeBranch, started.worktreeBranch);
            const evidence = await loadPlanActionEvidence(root, "demo-id");
            assertEquals(evidence.kind, "success");
            if (evidence.kind === "success") {
                assertEquals(evidence.evidence.status, "approved");
                assertEquals(evidence.evidence.revision, reopened.plan.revision);
            }
            for (const action of ["put_on_hold", "resume_from_hold"] as const) {
                const fresh = await loadPlanActionEvidence(root, "demo-id");
                assert(fresh.kind === "success");
                const changed = await executePlanAction(root, {
                    planId: "demo-id",
                    action,
                    expectedRevision: fresh.evidence.revision,
                    expectedStatus: fresh.evidence.status,
                    expectedWorktree: fresh.evidence.worktree,
                });
                assertEquals(changed.kind, "success", changed.message);
                assertEquals((await resolveWorkflowPlanLocation(root, "demo")).documentRoot, started.executionCwd);
            }
            await recordPlanEvent({
                cwd: root,
                planName: "demo",
                event: "readiness_passed",
                currentStatus: "approved",
            });
            const next = await resolveWorkflowPlanLocation(root, "demo");
            assert(next.plan);
            first.dispose();
            const reader = await captureForegroundProcess(process.execPath, {
                args: runtimeSourceArgs([
                    "run",
                    "-A",
                    fromFileUrl(new URL("./testing/controller-process-reader.ts", import.meta.url)),
                    root,
                    "demo",
                ]),
                cwd: getCwd(),
            });
            assert(reader.success, new TextDecoder().decode(reader.stderr));
            const restarted = JSON.parse(new TextDecoder().decode(reader.stdout));
            assertEquals(restarted.path, execution.path);
            assertEquals(restarted.status, "ready_for_work");
            assertEquals(restarted.primaryStatus, "ready_for_work");
            assertEquals(restarted.worktreeId, started.worktreeId);
            await startActiveExecutionWorkflow({
                planName: "demo",
                triageMeta: next.plan.attrs,
                currentStatus: next.plan.attrs.status,
                hostedSession: second,
                ports: createExecutionStartPorts(),
            });
            const result = second.getActiveExecutionWorkflow();
            assert(result?.executionCwd && result.worktreeId);
            assertEquals(result.worktreeId, started.worktreeId);
            assertEquals(result.worktreeBranch, started.worktreeBranch);
            assertEquals((await loadPlan(result.executionCwd, "demo"))?.attrs.status, "in_progress");
            assert((await loadPlan(result.executionCwd, "demo"))?.body.includes("The revised approved definition."));
            assertEquals(await fsReadFile(initial.path, "utf8"), primaryBytes);
            assertEquals(
                await git(root, ["show-ref", "--verify", "--hash", `refs/heads/${started.worktreeBranch}`]) !== "",
                true,
            );
            await pruneEntry(root, result.worktreeId);
            assertEquals((await resolveWorkflowPlanLocation(root, "demo")).documentRoot, root);
        } finally {
            first.dispose();
            second.dispose();
            for (const tree of trees) await git(root, ["worktree", "remove", "--force", tree]);
            await fsRm(root, { recursive: true });
        }
    });
}
