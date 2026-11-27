import { test } from "node:test";
import { deepEqual, equal, notEqual, ok, rejects } from "node:assert/strict";
import { plans } from "@runwield/plans";
import { resolveProjectRuntimeLayout } from "@runwield/project-runtime/layout";
import fs from "node:fs/promises";
import { join } from "node:path";
import { packageFixture, read, tree } from "../testing/plan-package-fixture.ts";
import { git } from "../git-test-fixture.ts";
import { capturePlanAccess, importPlans, openProjectPlanStore, withLocalPlanWorkflow } from "../../plan-store/index.ts";
import { addEntry, updateEntry, getWorktreeRegistryPath } from "../worktree-registry.ts";
import { loadPlan } from "../testing/plan-query-fixture.ts";
import { seedPlanController } from "../testing/plan-state-fixture.ts";

async function retainedFixture() {
    const fixture = await packageFixture();
    const planId = "retained-plan";
    ok(plans.identity.isValid(planId));
    const directory = join(fixture.root, "docs/plans");
    await fs.mkdir(directory, { recursive: true });
    const source = join(directory, "active.md");
    await fs.writeFile(
        source,
        `---\nplanId: ${planId}\nclassification: PLANNED_CHANGE\nstatus: implemented\n---\n# Original attempt\n`,
    );
    await git(fixture.root, ["add", "docs"]);
    await git(fixture.root, ["commit", "-m", "legacy fixture"]);
    const commit = await git(fixture.root, ["rev-parse", "HEAD"]);
    const execution = join(fixture.root, "execution");
    await git(fixture.root, ["worktree", "add", "-b", "execution", execution]);
    await addEntry(fixture.root, {
        id: "original-attempt",
        planName: "active",
        planId,
        path: execution,
        branch: "execution",
        baseBranch: "main",
        baseRef: "main",
        baseCommit: commit,
        status: "active",
        createdAt: "2026-01-01",
        updatedAt: "2026-01-01",
    });
    equal((await importPlans(fixture.root, source)).kind, "committed");
    const checkoutPath = join(execution, "docs/plans/active.md");
    const store = openProjectPlanStore(fixture.identity.projectId, { admitted: fixture.identity });
    return { ...fixture, planId, source, execution, checkoutPath, store };
}

async function passiveReadState(fixture: Awaited<ReturnType<typeof retainedFixture>>) {
    const { projectId, executionAccountHome } = fixture.identity;
    return {
        home: await tree(join(executionAccountHome, ".wld", "projects", projectId)),
        runtime: await tree(resolveProjectRuntimeLayout(fixture.root).primary.internalRoot),
        primary: await fs.readFile(fixture.source, "utf8"),
        worktrees: await git(fixture.root, ["worktree", "list", "--porcelain"]),
        refs: await git(fixture.root, ["show-ref"]),
    };
}

test("Project Plan reads see current retained execution bytes without updating the imported package", async () => {
    const fixture = await retainedFixture();
    try {
        const original = await fs.readFile(fixture.checkoutPath, "utf8");
        const first = original.replace("# Original attempt", "# Live execution");
        const second = first.replace("status: implemented", "status: validated_ci") + "\nLatest checkout edit.\n";
        await seedPlanController(
            fixture.root,
            { planId: fixture.planId, planName: "active" },
            { executionReport: "Report from the original execution" },
        );
        const before = await passiveReadState(fixture);
        await fs.writeFile(fixture.checkoutPath, first);
        const live = await fixture.store.read(fixture.planId);
        equal(live.planId, fixture.planId);
        equal(live.attrs.worktreeId, "original-attempt");
        equal(live.attrs.executionReport, "Report from the original execution");
        equal(live.body, "# Live execution\n");

        await fs.writeFile(fixture.checkoutPath, second);
        const updated = await fixture.store.read(fixture.planId);
        equal(updated.body, "# Live execution\n\nLatest checkout edit.\n");
        equal(updated.attrs.status, "implemented");
        equal(updated.attrs.validationPhase, "semantic");
        notEqual(updated.revision, live.revision);
        equal(await fs.readFile(fixture.checkoutPath, "utf8"), second);
        deepEqual(await passiveReadState(fixture), before);
    } finally {
        await fixture.cleanup();
    }
});

test("Project Plan reads can use the verified original branch without recreating a missing checkout", async () => {
    const fixture = await retainedFixture();
    try {
        const original = await fs.readFile(fixture.checkoutPath, "utf8");
        await fs.writeFile(fixture.checkoutPath, original.replace("# Original attempt", "# Committed execution"));
        await git(fixture.execution, ["add", "docs/plans/active.md"]);
        await git(fixture.execution, ["commit", "-m", "Advance retained execution"]);
        await git(fixture.root, ["worktree", "remove", fixture.execution]);
        const before = await passiveReadState(fixture);

        equal((await fixture.store.read(fixture.planId)).body, "# Committed execution\n");
        await rejects(fs.lstat(fixture.execution), { code: "ENOENT" });
        deepEqual(await passiveReadState(fixture), before);

        const tree = await git(fixture.root, ["rev-parse", "refs/heads/execution^{tree}"]);
        const unrelated = await git(fixture.root, ["commit-tree", tree, "-m", "Same Plan outside recorded history"]);
        await git(fixture.root, ["update-ref", "refs/heads/execution", unrelated]);
        const unverified = await passiveReadState(fixture);
        await rejects(fixture.store.read(fixture.planId), /Original execution Plan evidence is unavailable/);
        deepEqual(await passiveReadState(fixture), unverified);
    } finally {
        await fixture.cleanup();
    }
});

test("imported active attempt continues its recorded owner and abandoned settlement survives checkout removal", async () => {
    const fixture = await retainedFixture();
    try {
        await withLocalPlanWorkflow(fixture.root, "active", async () => {
            equal(capturePlanAccess(), undefined);
            const plan = await loadPlan(fixture.root, "active");
            equal(plan?.attrs.worktreeId, "original-attempt");
            await updateEntry(fixture.root, "original-attempt", { status: "abandoned" });
        });
        const settled = await read(fixture.identity, "retained-plan");
        equal(settled.metadata.workflow?.legacySettlement?.outcome, "abandoned");
        equal(settled.metadata.workflow?.legacySettlement?.attemptId, "original-attempt");
        await fs.rm(join(fixture.root, "docs"), { recursive: true });
        await fs.rm(fixture.execution, { recursive: true });
        equal((await fixture.store.read(fixture.planId)).body, "# Original attempt\n");
        await withLocalPlanWorkflow(fixture.root, "active", async () => {
            ok(capturePlanAccess());
            equal((await loadPlan(fixture.root, "active"))?.body, "# Original attempt\n");
        });
    } finally {
        await fixture.cleanup();
    }
});

test("changed retained execution identity cannot silently start canonical work", async () => {
    const fixture = await retainedFixture();
    try {
        const registryPath = getWorktreeRegistryPath(fixture.root);
        const original = await fs.readFile(registryPath, "utf8");
        await fs.writeFile(registryPath, original.replace('"branch": "execution"', '"branch": "changed"'));
        await rejects(fixture.store.read(fixture.planId), /Imported execution owner changed/);
        let entered = false;
        await rejects(
            withLocalPlanWorkflow(fixture.root, "active", () => {
                entered = true;
                return Promise.resolve();
            }),
            /owner changed/,
        );
        equal(entered, false);
        equal((await read(fixture.identity, "retained-plan")).metadata.workflow?.legacySettlement, undefined);
    } finally {
        await fixture.cleanup();
    }
});

test("Project Plan reads reject replacements for an imported attempt or its Plan document", async () => {
    const fixture = await retainedFixture();
    try {
        const unrelated = await fixture.store.create({ planName: "unrelated", contextMarkdown: "# Canonical\n" });
        const registryPath = getWorktreeRegistryPath(fixture.root);
        const registry = await fs.readFile(registryPath, "utf8");
        await fs.writeFile(registryPath, registry.replace('"id": "original-attempt"', '"id": "replacement-attempt"'));
        const replacedAttempt = await passiveReadState(fixture);

        await rejects(fixture.store.read(fixture.planId), /Original execution attempt is unavailable/);
        equal((await fixture.store.read(unrelated.planId)).body, "# Canonical\n");
        deepEqual(await passiveReadState(fixture), replacedAttempt);

        await fs.writeFile(registryPath, registry);
        const original = await fs.readFile(fixture.checkoutPath, "utf8");
        const replacedPlan = original.replace(fixture.planId, unrelated.planId);
        await fs.writeFile(fixture.checkoutPath, replacedPlan);
        const before = await passiveReadState(fixture);

        await rejects(fixture.store.read(fixture.planId), /different Plan/);
        equal(await fs.readFile(fixture.checkoutPath, "utf8"), replacedPlan);
        deepEqual(await passiveReadState(fixture), before);
    } finally {
        await fixture.cleanup();
    }
});

test("Project Plan reads reject a different repository at the recorded execution path", async () => {
    const fixture = await retainedFixture();
    try {
        await fs.rename(fixture.execution, `${fixture.execution}-original`);
        await git(fixture.root, ["clone", "--no-local", "--branch", "execution", fixture.root, fixture.execution]);
        const original = await fs.readFile(fixture.checkoutPath, "utf8");
        const foreignMarkdown = original.replace("# Original attempt", "# Foreign repository bytes");
        await fs.writeFile(fixture.checkoutPath, foreignMarkdown);
        const before = await passiveReadState(fixture);
        ok(before.worktrees.includes(`worktree ${fixture.execution.replaceAll("\\", "/")}`));

        await rejects(fixture.store.read(fixture.planId), /different repository/);
        equal(await fs.readFile(fixture.checkoutPath, "utf8"), foreignMarkdown);
        deepEqual(await passiveReadState(fixture), before);
    } finally {
        await fixture.cleanup();
    }
});

test("publication settlement requires target evidence and remains canonical after legacy documents disappear", async () => {
    const fixture = await retainedFixture();
    try {
        const original = await fs.readFile(fixture.checkoutPath, "utf8");
        const delivered = original
            .replace("status: implemented", "status: validated\ntargetBranch: main")
            .replace("# Original attempt", "# Delivered requirements");
        await fs.writeFile(fixture.checkoutPath, delivered);
        await git(fixture.execution, ["add", "docs/plans/active.md"]);
        await git(fixture.execution, ["commit", "-m", "validated legacy delivery"]);
        await updateEntry(fixture.root, "original-attempt", { status: "validated" });
        // A terminal registry label alone cannot prove that the target received this work.
        equal((await fixture.store.read(fixture.planId)).body, "# Delivered requirements\n");
        await withLocalPlanWorkflow(fixture.root, "active", () => {
            equal(capturePlanAccess(), undefined);
            return Promise.resolve();
        });
        equal((await read(fixture.identity, "retained-plan")).metadata.workflow?.legacySettlement, undefined);
        await git(fixture.root, ["merge", "--ff-only", "execution"]);
        await withLocalPlanWorkflow(fixture.root, "active", () => {
            ok(capturePlanAccess());
            return Promise.resolve();
        });
        const settled = await read(fixture.identity, "retained-plan");
        equal(settled.metadata.workflow?.legacySettlement?.outcome, "published");
        equal(settled.metadata.workflow?.legacySettlement?.targetBranch, "main");
        await fs.rm(join(fixture.root, "docs"), { recursive: true });
        await fs.rm(fixture.execution, { recursive: true });
        const canonical = await fixture.store.read(fixture.planId);
        equal(canonical.body, "# Delivered requirements\n");
        equal(canonical.attrs.status, "verified");
        await withLocalPlanWorkflow(fixture.root, "active", async () => {
            ok(capturePlanAccess());
            equal((await loadPlan(fixture.root, "active"))?.attrs.status, "verified");
        });
    } finally {
        await fixture.cleanup();
    }
});
