import { makeReadOnlyDirectoryFixture } from "../../testing/read-only-directory-fixture.ts";
import { test } from "node:test";
import {
    mkdtemp as fsMkdtemp,
    readdir as fsReaddir,
    readFile as fsReadFile,
    realpath as fsRealpath,
    rm as fsRm,
    writeFile as fsWriteFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { ok as assert } from "node:assert/strict";
import { assertEquals, assertRejects } from "../../testing/assertions.ts";
import { join } from "node:path";
import {
    archivePlan,
    listPlans,
    loadPlan,
    loadPlanBodyById,
    restoreArchivedPlan,
    savePlan,
    savePlanBodyById,
    updatePlanFrontMatter,
} from "../../plan-store.js";
import { defineCommittedGitFixture, git } from "../git-test-fixture.ts";
import { addEntry, findById, updateEntry } from "../worktree-registry.js";
import { resolvePlanWithPrimaryRecovery } from "../../cmd/load-plan/primary-plan-recovery.ts";
import { recordPlanEvent } from "./plan-lifecycle.js";
import { HostedSession } from "../session/hosted-session.js";
import { createExecutionStartPorts, startActiveExecutionWorkflow } from "./execution-start.ts";
import { resolveWorkflowPlanLocation } from "./plan-location.ts";
import { prepareSessionPlanningWorktree } from "./session-planning-worktree.ts";
import { createPublicationAttempt } from "./publication-attempt.ts";
import { findCompletionSiblings } from "./plan-family.ts";

const fixture = defineCommittedGitFixture({ ".gitignore": ".wld/\n", "app.ts": "// app\n" });

async function withProject(run: (root: string, directory: string) => Promise<void>) {
    const root = await fixture.checkout();
    const directory = await fsMkdtemp(join(tmpdir(), "rw-authority-continuation-"));
    try {
        await run(root, directory);
    } finally {
        for await (const entry of await fsReaddir(directory, { withFileTypes: true })) {
            await git(root, ["worktree", "remove", "--force", join(directory, entry.name)]).catch(() => {});
        }
        await fsRm(directory, { recursive: true });
        await fsRm(root, { recursive: true });
    }
}

async function addTree(root: string, directory: string, id: string, name = "demo", retired = false) {
    const path = join(directory, id);
    await git(root, ["worktree", "add", "-b", `worktree/${id}`, path]);
    await addEntry(root, {
        id,
        planId: name,
        planName: name,
        path,
        branch: `worktree/${id}`,
        baseBranch: "main",
        baseRef: "refs/heads/main",
        baseCommit: await git(path, ["rev-parse", "HEAD"]),
        baseTree: await git(path, ["rev-parse", "HEAD^{tree}"]),
        status: retired ? "abandoned" : "completed",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
    });
    return path;
}

async function createPlan(root: string) {
    await savePlan(root, "demo", "# Demo\n\n## Context\n\nImplement demo.\n", {
        planId: "demo",
        classification: "PLANNED_CHANGE",
        status: "ready_for_work",
        targetBranch: "main",
        executionAgent: "engineer",
        collaborationRecommendation: "autonomous",
    });
    await git(root, ["add", "docs"]);
    await git(root, ["commit", "-m", "Plan"]);
}

async function setStatus(root: string, status: "implemented" | "verified" | "in_progress" | "feedback") {
    const plan = await loadPlan(root, "demo");
    assert(plan);
    await updatePlanFrontMatter(root, "demo", { status }, {}, { expectedRevision: plan.revision });
}

test("missing execution document cannot redirect a lifecycle write into primary", async () => {
    await withProject(async (root, directory) => {
        await createPlan(root);
        const tree = await addTree(root, directory, "current");
        const primary = await loadPlan(root, "demo");
        assert(primary);
        const body = await loadPlanBodyById(root, "demo");
        await fsRm(join(tree, "docs/plans/demo.md"));
        await assertRejects(() => loadPlanBodyById(root, "demo"));
        await assertRejects(() =>
            savePlanBodyById(root, "demo", "# Must not overwrite primary\n", body.bodyHash, {
                expectedRevision: body.revision,
            }),
        );
        await assertRejects(() =>
            recordPlanEvent({
                cwd: root,
                planName: "demo",
                event: "plan_held",
                currentStatus: "ready_for_work",
            }),
        );
        await assertRejects(() => resolvePlanWithPrimaryRecovery(root, "demo"));
        assertEquals(await fsReadFile(primary.path, "utf8"), primary.markdown);
    });
});

test("missing execution worktree is rebuilt before lifecycle writes continue", async () => {
    await withProject(async (root, directory) => {
        await createPlan(root);
        const tree = await addTree(root, directory, "current");
        const primary = await loadPlan(root, "demo");
        assert(primary);
        const body = await loadPlanBodyById(root, "demo");
        await fsRm(tree, { recursive: true });

        const snapshot = await resolvePlanWithPrimaryRecovery(root, "demo");
        assertEquals(snapshot.plan.markdown, primary.markdown);
        assertEquals(await fsReaddir(directory), []);
        await prepareSessionPlanningWorktree(root, "demo");
        assertEquals((await resolvePlanWithPrimaryRecovery(root, "demo")).plan.path, join(tree, "docs/plans/demo.md"));
        assertEquals((await loadPlanBodyById(root, "demo")).body, body.body);
        await savePlanBodyById(root, "demo", "# Recovered execution copy\n", body.bodyHash, {
            expectedRevision: body.revision,
        });
        await recordPlanEvent({
            cwd: root,
            planName: "demo",
            event: "plan_held",
            currentStatus: "ready_for_work",
        });

        assertEquals((await resolvePlanWithPrimaryRecovery(root, "demo")).plan.attrs.status, "on_hold");
        assertEquals((await loadPlan(tree, "demo"))?.body, "# Recovered execution copy\n");
        assertEquals(await fsReadFile(primary.path, "utf8"), primary.markdown);
    });
});

test("explicit loading cannot revive the stale primary copy of an archived execution Plan", async () => {
    await withProject(async (root, directory) => {
        await createPlan(root);
        const tree = await addTree(root, directory, "current");
        await setStatus(tree, "verified");
        await archivePlan(root, "demo");
        assertEquals((await listPlans(root)).length, 0);
        await assertRejects(() => resolvePlanWithPrimaryRecovery(root, "demo"), Error, "archived");
    });
});

for (const primaryState of ["missing", "malformed"] as const) {
    test(`stored Plan path arguments select execution when primary is ${primaryState}`, async () => {
        await withProject(async (root, directory) => {
            await createPlan(root);
            const tree = await addTree(root, directory, "current");
            await setStatus(tree, "in_progress");
            const primaryPath = join(root, "docs/plans/demo.md");
            if (primaryState === "missing") await fsRm(primaryPath);
            else await fsWriteFile(primaryPath, "---\nstatus: [broken\n---\n# User edits\n");
            for (const cwd of [root, tree]) {
                for (const argument of ["demo", "docs/plans/demo.md", "./docs/plans/demo.md", primaryPath]) {
                    const loaded = await resolvePlanWithPrimaryRecovery(cwd, argument);
                    assertEquals(loaded.plan.path, join(tree, "docs/plans/demo.md"));
                    assertEquals(loaded.plan.attrs.status, "in_progress");
                }
            }
            if (primaryState === "missing") {
                await assertRejects(() => fsReadFile(primaryPath, "utf8"), Error, "ENOENT");
            } else assertEquals(await fsReadFile(primaryPath, "utf8"), "---\nstatus: [broken\n---\n# User edits\n");
        });
    });
}

for (const retired of [false, true]) {
    test(`restoring a ${retired ? "retired" : "live"} execution Plan with a new name keeps its identity and discovery`, async () => {
        await withProject(async (root, directory) => {
            await createPlan(root);
            const tree = await addTree(root, directory, "current");
            if (retired) {
                await updateEntry(root, "current", { status: "abandoned" });
                const plan = await loadPlan(tree, "demo");
                assert(plan);
                await updatePlanFrontMatter(
                    tree,
                    "demo",
                    { documentWorktreeId: "current" },
                    {},
                    {
                        expectedRevision: plan.revision,
                    },
                );
            }
            const primary = await loadPlan(root, "demo");
            assert(primary);
            await setStatus(tree, "verified");
            await archivePlan(root, "demo");
            await restoreArchivedPlan(root, "demo", { to: "renamed" });
            assertEquals(
                (await listPlans(root)).map((plan) => plan.name),
                ["renamed"],
            );
            const selected = await resolveWorkflowPlanLocation(root, "renamed");
            assertEquals(selected.plan?.attrs.planId, "demo");
            assertEquals(selected.documentRoot, tree);
            assertEquals((await resolvePlanWithPrimaryRecovery(root, "renamed")).plan.attrs.status, "verified");
            await assertRejects(() => resolvePlanWithPrimaryRecovery(root, "demo"), Error, "now named renamed");
            await archivePlan(root, "renamed");
            assertEquals((await listPlans(root)).length, 0);
            await restoreArchivedPlan(root, "demo");
            assertEquals(
                (await listPlans(root)).map((plan) => plan.name),
                ["renamed"],
            );
            assertEquals(await fsReadFile(primary.path, "utf8"), primary.markdown);
        });
    });
}

for (const failure of ["name_collision", "archive_unlink", "publication_started"] as const) {
    test(`restore rename preserves the archived Plan when ${failure}`, async () => {
        await withProject(async (root, directory) => {
            await createPlan(root);
            const tree = await addTree(root, directory, "current");
            await setStatus(tree, "verified");
            await archivePlan(root, "demo");
            const archivedPath = join(tree, "docs/plans/archived/demo.md");
            const before = await fsReadFile(archivedPath, "utf8");
            let restorePermissions: (() => Promise<void>) | undefined;
            if (failure === "name_collision") {
                await savePlan(root, "renamed", "# Different Plan\n", { planId: "other", status: "draft" });
            } else if (failure === "publication_started") {
                const head = await git(tree, ["rev-parse", "HEAD"]);
                await updateEntry(root, "current", {
                    publication: createPublicationAttempt({
                        attemptId: "current",
                        planId: "demo",
                        planName: "demo",
                        targetBranch: "main",
                        executionBranch: "worktree/current",
                        executionCwd: tree,
                        publicationRoot: tree,
                        validatedCommit: head,
                        targetHeadAtSeal: head,
                    }),
                });
            } else {
                restorePermissions = await makeReadOnlyDirectoryFixture(join(tree, "docs/plans/archived"));
            }
            try {
                await assertRejects(() => restoreArchivedPlan(root, "demo", { to: "renamed" }));
                assertEquals(await fsReadFile(archivedPath, "utf8"), before);
                assertEquals(await loadPlan(tree, "renamed"), null);
                assertEquals((await findById(root, "current"))?.planName, "demo");
            } finally {
                await restorePermissions?.();
            }
        });
    });
}

for (const event of ["manual_user_verified", "validation_passed"] as const) {
    test(`${event} does not finish an Epic while a newer unstarted sibling remains`, async () => {
        await withProject(async (root, directory) => {
            await savePlan(root, "epic", "# Epic\n", {
                planId: "epic",
                classification: "PROJECT",
                status: "ready_for_work",
            });
            await savePlan(root, "epic/a", "# A\n", {
                planId: "epic/a",
                classification: "PLANNED_CHANGE",
                parentPlan: "epic",
                status: event === "validation_passed" ? "reviewed" : "implemented",
            });
            await git(root, ["add", "docs"]);
            await git(root, ["commit", "-m", "First child"]);
            const tree = await addTree(root, directory, "a", "epic/a");
            await savePlan(root, "epic/b", "# B\n", {
                planId: "epic/b",
                classification: "PLANNED_CHANGE",
                parentPlan: "epic",
                status: "ready_for_work",
            });
            await recordPlanEvent({
                cwd: root,
                planName: "epic/a",
                event,
                currentStatus: event === "validation_passed" ? "reviewed" : "implemented",
                details: {
                    userVerificationNote: "Checked independently.",
                    deliveryEvidence: {
                        version: 1,
                        mode: "worktree_merge",
                        executionCommit: await git(tree, ["rev-parse", "HEAD"]),
                        targetBranch: "main",
                        targetHeadBeforeMerge: await git(root, ["rev-parse", "HEAD"]),
                    },
                },
            });
            assertEquals((await loadPlan(tree, "epic"))?.attrs.status, "ready_for_work");
        });
    });
}

test("Epic completion reads published siblings without a permanent controller receipt", async () => {
    await withProject(async (root, directory) => {
        await savePlan(root, "epic/a", "# A\n", {
            planId: "epic/a",
            classification: "PLANNED_CHANGE",
            parentPlan: "epic",
            status: "implemented",
        });
        await savePlan(root, "epic/b", "# B\n", {
            planId: "epic/b",
            classification: "PLANNED_CHANGE",
            parentPlan: "epic",
            status: "ready_for_work",
            targetBranch: "main",
        });
        await git(root, ["add", "docs"]);
        await git(root, ["commit", "-m", "Initial sibling"]);
        await git(root, ["switch", "-c", "published-target-snapshot"]);
        const before = await loadPlan(root, "epic/b");
        assert(before);
        await updatePlanFrontMatter(
            root,
            "epic/b",
            {
                status: "validated",
                validatedCommit: await git(root, ["rev-parse", "HEAD"]),
            },
            {},
            { expectedRevision: before.revision },
        );
        await git(root, ["add", "docs"]);
        await git(root, ["commit", "-m", "Published sibling"]);
        const tree = await addTree(root, directory, "a", "epic/a");
        await git(root, ["switch", "main"]);
        const siblings = await findCompletionSiblings(tree, "epic");
        const b = siblings.find((child) => child.name === "epic/b");
        assertEquals(b?.attrs.status, "verified");
        assertEquals(b?.attrs.deliveryEvidence, undefined);
    });
});

for (const change of ["reparented", "archived", "uncommitted_completion"] as const) {
    test(`Epic completion does not revive a ${change} sibling from an old checkout`, async () => {
        await withProject(async (root, directory) => {
            await savePlan(root, "epic/a", "# A\n", {
                planId: "epic/a",
                classification: "PLANNED_CHANGE",
                parentPlan: "epic",
                status: "implemented",
            });
            await savePlan(root, "epic/b", "# B\n", {
                planId: "epic/b",
                classification: "PLANNED_CHANGE",
                parentPlan: "epic",
                status: change === "uncommitted_completion" ? "ready_for_work" : "validated",
                deliveryEvidence: {
                    version: 1,
                    mode: "worktree_merge",
                    executionCommit: await git(root, ["rev-parse", "HEAD"]),
                    targetBranch: "main",
                    targetHeadBeforeMerge: await git(root, ["rev-parse", "HEAD"]),
                },
            });
            await git(root, ["add", "docs"]);
            await git(root, ["commit", "-m", "Sibling snapshot"]);
            const tree = await addTree(root, directory, "a", "epic/a");
            if (change === "archived") await archivePlan(root, "epic/b");
            else {
                const documentRoot = change === "reparented" ? root : tree;
                const before = await loadPlan(documentRoot, "epic/b");
                assert(before);
                await updatePlanFrontMatter(
                    documentRoot,
                    "epic/b",
                    change === "reparented" ? { parentPlan: "another-epic" } : { status: "validated" },
                    {},
                    { expectedRevision: before.revision },
                );
            }
            const siblings = await findCompletionSiblings(tree, "epic");
            const b = siblings.find((child) => child.name === "epic/b");
            if (change === "uncommitted_completion") {
                assertEquals(b?.attrs.status, "ready_for_work");
                assertEquals(await fsRealpath(b!.path), await fsRealpath(join(root, "docs/plans/epic/b.md")));
            } else assertEquals(b, undefined);
        });
    });
}

test("execution startup uses the live successor despite a cached retired Session", async () => {
    await withProject(async (root, directory) => {
        await createPlan(root);
        const old = await addTree(root, directory, "old", "demo", true);
        const current = await addTree(root, directory, "current");
        await setStatus(old, "feedback");
        await setStatus(current, "in_progress");
        const plan = await loadPlan(current, "demo");
        assert(plan);
        const session = new HostedSession({ id: "cached", cwd: root, eventSink: () => {} });
        try {
            session.setActiveExecutionWorkflow({
                planName: "demo",
                triageMeta: plan.attrs,
                executionAgent: "engineer",
                executionMode: "worktree",
                projectRoot: root,
                executionCwd: old,
                worktreeId: "old",
                worktreeBranch: "worktree/old",
                worktreeBaseBranch: "main",
            });
            await startActiveExecutionWorkflow({
                planName: "demo",
                triageMeta: plan.attrs,
                currentStatus: plan.attrs.status,
                hostedSession: session,
                ports: createExecutionStartPorts(),
            });
            const started = session.getActiveExecutionWorkflow();
            assert(started?.executionCwd);
            assertEquals(await fsRealpath(started.executionCwd), await fsRealpath(current));
            assertEquals((await findById(root, "old"))?.status, "abandoned");
            assertEquals((await findById(root, "current"))?.status, "active");
        } finally {
            session.dispose();
        }
    });
});
