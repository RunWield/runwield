import { projects } from "@runwield/projects";
import { enterProjectRuntime } from "@runwield/project-runtime/layout";
import { withRetainedCheckoutSource, withoutRetainedCheckoutSource } from "@runwield/plans/retained-checkout";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { git } from "../git-test-fixture.ts";
import { addEntry } from "../worktree-registry.ts";
import { read as readPackage } from "./plan-package-fixture.ts";

/** Exercise the original checkout owner explicitly. Public import/settlement is covered by cutover acceptance. */
export async function withRetainedPlanFixture<T>(root: string, run: () => Promise<T>): Promise<T> {
    await enterProjectRuntime(root);
    const identity = projects.checkout.inspect(root);
    if (identity.kind !== "existing") throw new Error("Retained fixture requires real Project identity.");
    return await withRetainedCheckoutSource(identity.identity, run);
}

/** Select the retained document owner without adopting pending controller/runtime files. */
export async function withRetainedPlanReadFixture<T>(root: string, run: () => Promise<T>): Promise<T> {
    const admitted = await projects.checkout.admit(root);
    if (admitted.kind !== "existing") throw new Error("Retained read fixture requires real Project identity.");
    return await withRetainedCheckoutSource(admitted.identity, run);
}

import { importPlans } from "../../plan-store/index.ts";
/** Arrange a cutover while preserving the test’s retained execution context. */
export async function importCanonicalPlanFixture(root: string, source: string) {
    return await withoutRetainedCheckoutSource(() => importPlans(root, source));
}

/** Import a Plan with an unfinished attempt whose checkout has moved ahead of the import. */
export async function importUnfinishedPlanFixture(checkoutRoot: string, planName: string) {
    const root = await realpath(checkoutRoot);
    await enterProjectRuntime(root);
    const inspected = projects.checkout.inspect(root);
    if (inspected.kind !== "existing") throw new Error("Retained fixture requires real Project identity.");
    const planId = crypto.randomUUID();
    const relativePath = `docs/plans/${planName}.md`;
    const markdown =
        `---\nplanId: ${planId}\nclassification: PLANNED_CHANGE\nstatus: implemented\n` +
        "executionAgent: engineer\ncollaborationRecommendation: autonomous\n---\n# Imported requirements\n";
    await mkdir(join(root, "docs/plans"), { recursive: true });
    await writeFile(join(root, relativePath), markdown);
    await git(root, ["add", relativePath]);
    await git(root, ["commit", "-m", "Add legacy Plan"]);
    const path = join(root, "retained-worktree");
    const baseCommit = await git(root, ["rev-parse", "HEAD"]);
    await git(root, ["worktree", "add", "-b", "legacy-attempt", path]);
    await addEntry(root, {
        id: "legacy-attempt",
        planName,
        planId,
        baseBranch: "main",
        baseRef: "main",
        baseCommit,
        branch: "legacy-attempt",
        path,
        status: "validation_failed",
        createdAt: "2026-01-01",
        updatedAt: "2026-01-01",
    });
    const imported = await importPlans(root, join(root, relativePath));
    if (imported.kind !== "committed") throw new Error("Could not import the unfinished Plan.");
    const checkoutPath = join(path, relativePath);
    await writeFile(checkoutPath, markdown + "\nUse the retained checkout requirements.\n");
    const canonical = await readPackage(inspected.identity, planId);
    return { planId, checkoutPath, packagePath: join(canonical.path, "plan.wld.json") };
}
