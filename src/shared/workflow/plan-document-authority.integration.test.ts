import { assert, assertEquals, assertRejects } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import {
    archivePlan,
    hashPlanBody,
    listArchivedPlans,
    listPlans,
    loadPlan,
    restoreArchivedPlan,
    savePlan,
    updatePlanCollaborationMetadata,
    updatePlanFrontMatter,
    withPlanLock,
} from "../../plan-store.js";
import { COLLABORATION_LOCK_BYPASS } from "../collaboration/lock.js";
import { defineCommittedGitFixture, git } from "../git-test-fixture.ts";
import { addEntry } from "../worktree-registry.js";
import { getCwd } from "../../constants.js";
import { withProcessGlobalTestLock } from "../../testing/process-global-lock.ts";
import { runPlansArchiveCommand } from "../../cmd/plans/archive.ts";
import { resolveWorkflowPlanLocation } from "./plan-location.ts";

const fixture = defineCommittedGitFixture({ ".gitignore": ".wld/\n" });

async function withDocument(run: (root: string, tree: string) => Promise<void>) {
    const root = await fixture.checkout();
    const container = await Deno.makeTempDir({ prefix: "rw-document-authority-" });
    const tree = join(container, "execution");
    try {
        await savePlan(root, "demo", "# Demo\n\n## Context\n\nOriginal.\n", {
            planId: "document-plan",
            classification: "PLANNED_CHANGE",
            status: "ready_for_work",
            targetBranch: "main",
        });
        await git(root, ["add", "docs"]);
        await git(root, ["commit", "-m", "Plan"]);
        await git(root, ["worktree", "add", "-b", "worktree/demo", tree]);
        await addEntry(root, {
            id: "document-attempt",
            planId: "document-plan",
            planName: "demo",
            path: tree,
            branch: "worktree/demo",
            baseBranch: "main",
            baseRef: "refs/heads/main",
            baseCommit: await git(root, ["rev-parse", "HEAD"]),
            baseTree: await git(root, ["rev-parse", "HEAD^{tree}"]),
            status: "completed",
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
        });
        const plan = await loadPlan(tree, "demo");
        assert(plan);
        await updatePlanFrontMatter(tree, "demo", { status: "verified" }, {}, { expectedRevision: plan.revision });
        await run(root, tree);
    } finally {
        await git(root, ["worktree", "remove", "--force", tree]);
        await Deno.remove(container, { recursive: true });
        await Deno.remove(root, { recursive: true });
    }
}

Deno.test("Workspace body save waits for the execution document lock in another process", async () => {
    await withDocument(async (root, tree) => {
        const before = await loadPlan(root, "demo");
        assert(before);
        const child = new Deno.Command(Deno.execPath(), {
            args: [
                "run",
                "-A",
                fromFileUrl(new URL("./testing/plan-document-writer.ts", import.meta.url)),
                root,
                "document-plan",
            ],
            stdout: "piped",
            stderr: "piped",
        });
        let finishedWhileLocked = false;
        const process = await withPlanLock(tree, "demo", async () => {
            const process = child.spawn();
            const reader = process.stdout.getReader();
            try {
                const ready = await reader.read();
                assert(new TextDecoder().decode(ready.value).includes("ready"));
            } finally {
                reader.releaseLock();
            }
            let timer: ReturnType<typeof setTimeout> | undefined;
            finishedWhileLocked = await Promise.race([
                process.status.then(() => true),
                new Promise<boolean>((resolve) => {
                    timer = setTimeout(() => resolve(false), 500);
                }),
            ]);
            clearTimeout(timer);
            return process;
        });
        const result = await process.output();
        assert(result.success, new TextDecoder().decode(result.stderr));
        assertEquals(finishedWhileLocked, false, "writer bypassed the selected document lock");
        assert((await loadPlan(tree, "demo"))?.body.includes("Workspace edit."));
        assertEquals((await loadPlan(root, "demo"))?.markdown, before.markdown);
    });
});

for (const target of ["demo", "document-plan"]) {
    Deno.test(`archive and restore ${target} use the listed execution document without changing primary`, async () => {
        await withDocument(async (root, tree) => {
            const primary = await loadPlan(root, "demo");
            assert(primary);
            assertEquals((await listPlans(root)).find((plan) => plan.name === "demo")?.attrs.status, "verified");
            const archived = await archivePlan(root, target);
            assertEquals(archived.attrs.status, "verified");
            assertEquals(archived.fromPath, join(tree, "docs/plans/demo.md"));
            assertEquals(archived.toPath, join(tree, "docs/plans/archived/demo.md"));
            assertEquals((await listPlans(root)).some((plan) => plan.name === "demo"), false);
            assertEquals((await resolveWorkflowPlanLocation(root, "demo")).plan, null);
            const history = await listArchivedPlans(root);
            assertEquals(history.filter((plan) => plan.planId === "document-plan").length, 1);
            await restoreArchivedPlan(root, target);
            assertEquals((await listPlans(root)).find((plan) => plan.name === "demo")?.path, archived.fromPath);
            assertEquals((await loadPlan(root, "demo"))?.markdown, primary.markdown);
        });
    });
}

for (const mode of ["single", "bulk"]) {
    Deno.test(`archive CLI ${mode} resolves execution evidence and restores from the primary checkout`, async () => {
        await withProcessGlobalTestLock(async () => {
            await withDocument(async (root, tree) => {
                const previousCwd = getCwd();
                const primary = await loadPlan(root, "demo");
                assert(primary);
                try {
                    Deno.chdir(root);
                    await runPlansArchiveCommand(
                        mode === "single" ? ["document-plan"] : ["--all", "--status", "verified"],
                    );
                    assertEquals((await listPlans(root)).some((plan) => plan.name === "demo"), false);
                    assertEquals((await listArchivedPlans(root))[0]?.path, join(tree, "docs/plans/archived/demo.md"));
                    await runPlansArchiveCommand(["restore", "document-plan"]);
                    assertEquals((await resolveWorkflowPlanLocation(root, "demo")).plan?.attrs.status, "verified");
                    assertEquals((await loadPlan(root, "demo"))?.markdown, primary.markdown);
                } finally {
                    Deno.chdir(previousCwd);
                }
            });
        });
    });
}

Deno.test("failed collaboration document write rolls back controller revision and hash, then retries", async () => {
    const root = await Deno.makeTempDir({ prefix: "rw-collaboration-rollback-" });
    const plansDir = join(root, "docs/plans");
    const original = "# Demo\n\n## Context\n\nOriginal.\n";
    const revised = "# Demo\n\n## Context\n\nRevised.\n";
    try {
        await savePlan(root, "demo", original, { planId: "demo-id", status: "draft" });
        await updatePlanCollaborationMetadata(
            root,
            "demo",
            {
                collaborationState: "remote_canonical",
                collaborationServerUrl: "https://example.test",
                collaborationSpaceId: "space-1",
                collaborationRevision: 1,
            },
            COLLABORATION_LOCK_BYPASS.pull,
            { body: original },
        );
        const before = await loadPlan(root, "demo");
        assert(before);
        await Deno.chmod(plansDir, 0o555);
        await assertRejects(() =>
            updatePlanCollaborationMetadata(
                root,
                "demo",
                {
                    collaborationRevision: 2,
                },
                COLLABORATION_LOCK_BYPASS.pull,
                { body: revised },
            )
        );
        const after = await loadPlan(root, "demo");
        assertEquals(after?.body, before.body);
        assertEquals(after?.attrs.collaborationRevision, 1);
        assertEquals(after?.attrs.collaborationBodyHash, await hashPlanBody(original));
        await Deno.chmod(plansDir, 0o755);
        await updatePlanCollaborationMetadata(
            root,
            "demo",
            {
                collaborationRevision: 2,
            },
            COLLABORATION_LOCK_BYPASS.pull,
            { body: revised },
        );
        assertEquals((await loadPlan(root, "demo"))?.body, revised);
        assertEquals((await loadPlan(root, "demo"))?.attrs.collaborationBodyHash, await hashPlanBody(revised));
    } finally {
        await Deno.chmod(plansDir, 0o755);
        await Deno.remove(root, { recursive: true });
    }
});
