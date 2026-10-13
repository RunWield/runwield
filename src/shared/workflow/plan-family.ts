import { captureForegroundProcess } from "../captured-process.ts";
import { readFile as fsReadFile } from "node:fs/promises";
/** Child completion combines current definitions with already-published branch history. */
import { join } from "node:path";
import { findPlansByParent, loadArchivedPlan, loadPlan } from "../../plan-store.js";
import { resolvePrimaryCheckoutRoot } from "../primary-checkout.ts";
import { listControllerDocumentWorktrees } from "./controller-registry.ts";

export async function findCompletionSiblings(cwd: string, parentPlan: string) {
    const primaryRoot = resolvePrimaryCheckoutRoot(cwd);
    const primary = await findPlansByParent(primaryRoot, parentPlan);
    if (primaryRoot === cwd) return primary;
    const selected = await listControllerDocumentWorktrees(primaryRoot);
    const attempt = selected.find((entry) => entry.path === cwd);
    if (!attempt) return primary;
    const siblings = new Map(primary.map((child) => [child.name, child]));
    for (const child of await findPlansByParent(cwd, parentPlan)) {
        // A live or reopened sibling already has an authoritative document in the
        // primary catalog. Never replace it with another branch's copy.
        if (selected.some((entry) => entry.planName === child.name)) continue;
        if (child.attrs.status !== "validated" && child.attrs.status !== "verified") continue;
        const primaryChild = await loadPlan(primaryRoot, child.name);
        if (
            primaryChild &&
            (primaryChild.attrs.planId !== child.attrs.planId ||
                primaryChild.attrs.parentPlan !== child.attrs.parentPlan)
        ) continue;
        if (await loadArchivedPlan(primaryRoot, child.name)) continue;
        // The attempt's recorded target snapshot must contain this exact completed
        // document. A status edited into the checkout is not publication evidence.
        const committed = await captureForegroundProcess("git", {
            cwd,
            args: ["show", `${attempt.baseCommit}:docs/plans/${child.name}.md`],
        });
        if (
            committed.success &&
            new TextDecoder().decode(committed.stdout) ===
                await fsReadFile(join(cwd, `docs/plans/${child.name}.md`), "utf8")
        ) siblings.set(child.name, child);
    }
    return [...siblings.values()];
}
