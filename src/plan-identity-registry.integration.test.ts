import { test } from "node:test";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { assertEquals, assertRejects } from "./testing/assertions.ts";
import {
    ensurePlanIdentity,
    injectFrontMatter,
    listPlans,
    listPlanResources,
    loadPlan,
    mergeFrontMatterText,
    savePlan,
} from "./plan-store.js";
import { defineCommittedGitFixture, git } from "./shared/git-test-fixture.ts";
import { addEntry, getWorktreeRegistryPath, listEntries } from "./shared/worktree-registry.js";
import { findTargetBranchPlansByParent } from "./shared/workflow/planning-worktree.ts";
import { resolveWorkflowPlanLocation } from "./shared/workflow/plan-location.ts";
import { loadPlanActionEvidence } from "./shared/workflow/plan-actions.ts";

const fixture = defineCommittedGitFixture({ ".gitignore": ".wld/\n", "README.md": "# Identity\n" });
const planId = "4355a6d9-e0dc-4e52-b03f-7c22a1afa9bb";
const planName = "epic/child";

async function registeredPlan(
    status: "completed" | "planning" = "completed",
    anonymousAuthority = false,
    collisionOrder?: "before" | "after",
) {
    const root = await fixture.checkout();
    const tree = `${root}-execution`;
    await savePlan(root, "epic", "# Epic\n", { classification: "PROJECT", targetBranch: "main", planId: "epic-id" });
    const children = join(root, "docs/plans/epic");
    await mkdir(children, { recursive: true });
    let registeredName = planName;
    let otherName = "other";
    if (collisionOrder) {
        // Assign roles after observing real enumeration. In-place writes preserve the entries,
        // so both orders are exercised without depending on a filesystem's name/creation sorting.
        for (const child of ["first.md", "second.md"]) await writeFile(join(children, child), "# Placeholder\n");
        const entries = await readdir(children, { withFileTypes: true });
        const otherIndex = collisionOrder === "before" ? 0 : 1;
        registeredName = `epic/${entries[1 - otherIndex].name.slice(0, -3)}`;
        otherName = `epic/${entries[otherIndex].name.slice(0, -3)}`;
        await writeFile(join(root, `docs/plans/${otherName}.md`), injectFrontMatter("# Other\n", { planId }));
    }
    const primaryPath = join(root, `docs/plans/${registeredName}.md`);
    const primary =
        '---\nstatus: "draft"\nparentPlan: "epic"\ntargetBranch: "main"\n---\n\n# Child draft\n\nLocal body stays here.\n';
    await writeFile(primaryPath, primary);
    await git(root, ["add", "docs"]);
    await git(root, ["commit", "-m", "Anonymous primary child"]);
    const baseCommit = await git(root, ["rev-parse", "HEAD"]);
    await git(root, ["worktree", "add", "-b", "worktree/child", tree]);
    await writeFile(
        join(tree, `docs/plans/${registeredName}.md`),
        injectFrontMatter("# Authoritative child\n\nImplemented body.\n", {
            ...(anonymousAuthority ? {} : { planId }),
            status: status === "completed" ? "implemented" : "draft",
            parentPlan: "epic",
            targetBranch: "main",
        }),
    );
    await addEntry(root, {
        id: "child-attempt",
        planName: registeredName,
        planId,
        path: tree,
        branch: "worktree/child",
        baseBranch: "main",
        baseRef: "refs/heads/main",
        baseCommit,
        status,
        createdAt: "2026-10-18T00:00:00Z",
        updatedAt: "2026-10-18T00:00:00Z",
    });
    return {
        root,
        tree,
        planName: registeredName,
        otherName,
        otherPath: join(root, `docs/plans/${otherName}.md`),
        primaryPath,
        primary,
        cleanup: async () => {
            await git(root, ["worktree", "remove", "--force", tree]).catch(() => {});
            await rm(tree, { recursive: true, force: true });
            await rm(root, { recursive: true, force: true });
        },
    };
}

for (const status of ["completed", "planning"] as const) {
    test(`anonymous primary reuses ${status} registered identity without replacing document authority`, async () => {
        const f = await registeredPlan(status);
        try {
            const authorityBefore = await readFile(join(f.tree, "docs/plans/epic/child.md"), "utf8");
            const registryBefore = await listEntries(f.root);
            const result = await ensurePlanIdentity(f.root, planName);
            assertEquals(result.planId, planId);
            assertEquals(await readFile(f.primaryPath, "utf8"), mergeFrontMatterText(f.primary, { planId }));
            assertEquals(await readFile(join(f.tree, "docs/plans/epic/child.md"), "utf8"), authorityBefore);
            assertEquals(await listEntries(f.root), registryBefore);
            const children = await findTargetBranchPlansByParent(f.root, "main", "epic", { refresh: false });
            assertEquals(
                children.map((child) => child.attrs.planId),
                [planId],
            );
            const expectedStatus = status === "completed" ? "implemented" : "draft";
            assertEquals(
                (await listPlanResources(f.root)).find((plan) => plan.name === planName)?.attrs.status,
                expectedStatus,
            );
            const opened = await resolveWorkflowPlanLocation(f.root, planName);
            assertEquals(opened.plan?.attrs.planId, planId);
            assertEquals(opened.plan?.body, "# Authoritative child\n\nImplemented body.\n");
            if (status === "completed") {
                const evidence = await loadPlanActionEvidence(f.root, planId);
                assertEquals(evidence.kind, "success");
                if (evidence.kind === "success") assertEquals(evidence.evidence.status, "implemented");
            }
        } finally {
            await f.cleanup();
        }
    });
}

test("explicit identity backfill reuses the registered ID even when the document authority is anonymous", async () => {
    const f = await registeredPlan("completed", true);
    try {
        const plans = await listPlanResources(f.root, { backfillMissing: true });
        assertEquals(plans.find((plan) => plan.name === planName)?.planId, planId);
        assertEquals((await loadPlan(f.root, planName))?.attrs.planId, planId);
        assertEquals(await readFile(f.primaryPath, "utf8"), mergeFrontMatterText(f.primary, { planId }));
    } finally {
        await f.cleanup();
    }
});

test("explicit backfill reserves registered IDs for unrelated new Plans", async () => {
    const f = await registeredPlan();
    try {
        // A missing authority is absent from the catalog, but its identity remains reserved.
        await rm(f.primaryPath);
        await rm(join(f.tree, "docs/plans/epic/child.md"));
        await savePlan(f.root, "new", "# New\n", { status: "draft" });
        const ids = [planId, "unique-new-id"];
        const plans = await listPlanResources(f.root, {
            backfillMissing: true,
            idGenerator: () => ids.shift() || "unexpected",
        });
        assertEquals(plans.find((plan) => plan.name === "new")?.planId, "unique-new-id");
    } finally {
        await f.cleanup();
    }
});

test("identity preparation refuses an existing primary ID that conflicts with its registered Plan", async () => {
    const f = await registeredPlan();
    try {
        const conflicting = mergeFrontMatterText(f.primary, { planId: "conflicting-id" });
        await writeFile(f.primaryPath, conflicting);
        await assertRejects(() => ensurePlanIdentity(f.root, planName), Error, "Plan ID");
        assertEquals(await readFile(f.primaryPath, "utf8"), conflicting);
    } finally {
        await f.cleanup();
    }
});

test("identity preparation refuses ambiguous registered authority without changing an anonymous primary", async () => {
    const f = await registeredPlan();
    try {
        const registryPath = getWorktreeRegistryPath(f.root);
        const registry = JSON.parse(await readFile(registryPath, "utf8"));
        registry.entries.push({ ...registry.entries[0], id: "competing-attempt", planId: "competing-id" });
        await writeFile(registryPath, JSON.stringify(registry));
        await assertRejects(() => ensurePlanIdentity(f.root, planName), Error, "ambiguous");
        assertEquals(await readFile(f.primaryPath, "utf8"), f.primary);
    } finally {
        await f.cleanup();
    }
});

for (const collisionOrder of ["before", "after"] as const) {
    for (const backfillMissing of [false, true]) {
        test(`registered identity cannot overwrite another catalog Plan's ID (backfill=${backfillMissing}, collision=${collisionOrder})`, async () => {
            const f = await registeredPlan("completed", true, collisionOrder);
            try {
                const otherPath = f.otherPath;
                const authorityPath = join(f.tree, `docs/plans/${f.planName}.md`);
                const otherBefore = await readFile(otherPath, "utf8");
                const authorityBefore = await readFile(authorityPath, "utf8");
                const registryBefore = await listEntries(f.root);
                await assertRejects(
                    () =>
                        backfillMissing
                            ? listPlanResources(f.root, { backfillMissing: true })
                            : ensurePlanIdentity(f.root, f.planName),
                    Error,
                    "belongs to another Plan",
                );
                assertEquals(await readFile(f.primaryPath, "utf8"), f.primary);
                assertEquals(await readFile(otherPath, "utf8"), otherBefore);
                assertEquals(await readFile(authorityPath, "utf8"), authorityBefore);
                assertEquals(await listEntries(f.root), registryBefore);
            } finally {
                await f.cleanup();
            }
        });
    }

    test(`target catalog overlay preserves a competing Plan ID (collision=${collisionOrder})`, async () => {
        const f = await registeredPlan("completed", false, collisionOrder);
        try {
            const otherPath = f.otherPath;
            const otherBefore = await readFile(otherPath, "utf8");
            const plans = await listPlans(f.root);
            assertEquals(
                plans
                    .filter((plan) => plan.attrs.planId === planId)
                    .map((plan) => plan.name)
                    .sort(),
                [f.planName, f.otherName].sort(),
            );
            assertEquals(
                plans.find((plan) => plan.name === f.planName)?.path,
                join(f.tree, `docs/plans/${f.planName}.md`),
            );
            await assertRejects(() => ensurePlanIdentity(f.root, f.planName), Error, "Duplicate planId");
            assertEquals(await readFile(f.primaryPath, "utf8"), f.primary);
            assertEquals(await readFile(otherPath, "utf8"), otherBefore);
        } finally {
            await f.cleanup();
        }
    });

    for (const authority of ["missing", "archived"] as const) {
        test(`${authority} authority hides only its same-name primary copy (collision=${collisionOrder})`, async () => {
            const f = await registeredPlan("completed", true, collisionOrder);
            try {
                const authorityPath = join(f.tree, `docs/plans/${f.planName}.md`);
                const otherPath = f.otherPath;
                const otherBefore = await readFile(otherPath, "utf8");
                const registryBefore = await listEntries(f.root);
                if (authority === "missing") await rm(authorityPath);
                else {
                    const archive = join(f.tree, "docs/plans/archived/epic");
                    await mkdir(archive, { recursive: true });
                    await rename(authorityPath, join(archive, "child.md"));
                }
                const plans = await listPlans(f.root);
                assertEquals(plans.map((plan) => plan.name).sort(), ["epic", f.otherName].sort());
                assertEquals(plans.find((plan) => plan.name === f.otherName)?.attrs.planId, planId);
                assertEquals(await readFile(f.primaryPath, "utf8"), f.primary);
                assertEquals(await readFile(otherPath, "utf8"), otherBefore);
                assertEquals(await listEntries(f.root), registryBefore);
            } finally {
                await f.cleanup();
            }
        });
    }
}

test("registered identity cannot be reused when another registry Plan owns the same ID", async () => {
    const f = await registeredPlan();
    try {
        const registryPath = getWorktreeRegistryPath(f.root);
        const registry = JSON.parse(await readFile(registryPath, "utf8"));
        registry.entries.push({ ...registry.entries[0], id: "other-attempt", planName: "other" });
        await writeFile(registryPath, JSON.stringify(registry));
        await assertRejects(() => ensurePlanIdentity(f.root, planName), Error, "belongs to multiple Plans");
        assertEquals(await readFile(f.primaryPath, "utf8"), f.primary);
    } finally {
        await f.cleanup();
    }
});
