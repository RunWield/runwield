import type { PlanTextLoaded } from "../plan-store.js";
import { isPublicationAttemptCleanupComplete } from "../shared/workflow/publication-attempt.ts";
import { withRetainedCheckoutSource, withoutRetainedCheckoutSource } from "./retained-source.ts";
import type { ProjectIdentity } from "../shared/project-identity.ts";
import {
    readPlanImportEvidence,
    readPlanPackage,
    savePlanPackageDocument,
    updatePlanPackageMetadata,
    withPlanPackageLocks,
    type LoadedPlanPackage,
} from "./packages.ts";
import { findById } from "../shared/worktree-registry.js";
import { inspectControllerDocumentWorktrees, assertControllerDocumentAvailable } from "./controllers.ts";
import { healSettledTransitionRecords } from "../shared/workflow/transition-recovery.ts";
import { resolveWorkflowPlanLocation } from "./location.ts";
import { verifyRecordedPublication } from "../shared/workflow/validation-merge-verification.ts";
import { pickControllerState } from "../shared/workflow/controller-state.ts";
import { writePackageControllerEvidence } from "./controllers.ts";

/** Resume exactly the imported owner; changing storage never creates a replacement execution attempt. */
export async function continueImportedPackage<T>(
    identity: ProjectIdentity,
    selected: LoadedPlanPackage,
    run: () => Promise<T>,
    canonical: () => Promise<T>,
): Promise<T> {
    const reference = selected.metadata.references.legacyImport;
    if (!reference || selected.metadata.workflow?.legacySettlement) return await canonical();
    const retained = await readPlanImportEvidence(identity, reference);
    if (!retained.attempts.length) return await canonical();
    if (retained.repositoryId !== identity.repositoryId)
        throw new Error("Imported execution belongs to another repository.");
    const unfinished = retained.attempts.filter((entry) => !["validated", "abandoned"].includes(entry.status));
    if (unfinished.length > 1)
        throw new Error("Imported execution ownership is ambiguous; preserve all attempts for recovery.");
    const prior = unfinished[0] || retained.attempts.at(-1)!;
    if (prior.planId !== selected.metadata.planId) throw new Error("Imported execution Plan identity changed.");
    return await withRetainedCheckoutSource(identity, async () => {
        const live = await findById(identity.checkoutRoot, prior.id);
        if (
            live &&
            (live.planId !== prior.planId ||
                live.path !== prior.path ||
                live.branch !== prior.branch ||
                live.baseBranch !== prior.baseBranch ||
                live.baseCommit !== prior.baseCommit)
        )
            throw new Error("Imported execution owner changed; preserve the original attempt for recovery.");
        const recovered = await healSettledTransitionRecords(identity.checkoutRoot, { planName: prior.planName });
        if (recovered.remaining.length) throw new Error(recovered.remaining[0].reason);
        const settle = async () => {
            const entry = await findById(identity.checkoutRoot, prior.id);
            const location = await resolveWorkflowPlanLocation(identity.checkoutRoot, prior.planName, {
                readOnly: true,
                loadFromTarget: true,
            });
            const plan = location.plan;
            if (!plan || plan.attrs.planId !== selected.metadata.planId)
                throw new Error("Original execution Plan evidence is unavailable.");
            const proof = await verifyRecordedPublication(identity.checkoutRoot, plan.attrs, {
                planName: prior.planName,
                markdown: plan.markdown,
            });
            const abandoned = entry?.status === "abandoned";
            if (entry?.publication && !isPublicationAttemptCleanupComplete(entry.publication)) return false;
            if (plan.attrs.validationCheckpoint && plan.attrs.validationCheckpoint.attemptId !== prior.id)
                throw new Error("Imported validation checkpoint belongs to another attempt.");
            if (!abandoned && (!proof.published || (entry && entry.status !== "validated"))) return false;
            await withPlanPackageLocks(identity, [selected.metadata.planId], async () => {
                const current = await readPlanPackage(identity, { planId: selected.metadata.planId });
                if (current.kind !== "loaded") throw new Error(current.message);
                if (current.metadata.workflow?.legacySettlement) return;
                const context = current.documents.find((doc) => doc.name === "context.md")!;
                await savePlanPackageDocument(identity, current.metadata.planId, "context.md", context.hash, plan.body);
                const controller = await writePackageControllerEvidence(
                    identity,
                    current.metadata.planId,
                    pickControllerState(plan.attrs),
                );
                await updatePlanPackageMetadata(identity, current.metadata.planId, current.metadata.revision, {
                    definition: {
                        ...current.metadata.definition,
                        status: abandoned || plan.attrs.status === "user_verified" ? plan.attrs.status : "verified",
                    },
                    workflow: {
                        ...current.metadata.workflow,
                        attempt: undefined,
                        controller,
                        workRecord: plan.attrs.workRecord,
                        legacySettlement: {
                            outcome: abandoned ? "abandoned" : "published",
                            attemptId: prior.id,
                            importRecordId: reference.recordId,
                            settledAt: new Date().toISOString(),
                            ...(proof.targetBranch ? { targetBranch: proof.targetBranch } : {}),
                            ...(plan.attrs.validatedCommit ? { commit: plan.attrs.validatedCommit } : {}),
                        },
                    },
                });
            });
            return true;
        };
        if (await settle()) return await withoutRetainedCheckoutSource(canonical);
        if (!live) throw new Error("Original execution attempt is unavailable; no replacement was started.");
        const [checked] = await inspectControllerDocumentWorktrees(identity.checkoutRoot, [live]);
        assertControllerDocumentAvailable(checked);
        const result = await run();
        await settle();
        return result;
    });
}

/** Passive projection follows only the execution owner sealed by explicit import. */
export async function readImportedExecutionPlan(
    identity: ProjectIdentity,
    selected: LoadedPlanPackage,
): Promise<PlanTextLoaded | undefined> {
    const reference = selected.metadata.references.legacyImport;
    if (!reference || selected.metadata.workflow?.legacySettlement) return undefined;
    const retained = await readPlanImportEvidence(identity, reference);
    if (!retained.attempts.length) return undefined;
    if (retained.repositoryId !== identity.repositoryId)
        throw new Error("Imported execution belongs to another repository.");
    const unfinished = retained.attempts.filter((entry) => !["validated", "abandoned"].includes(entry.status));
    if (unfinished.length > 1)
        throw new Error("Imported execution ownership is ambiguous; preserve all attempts for recovery.");
    const prior = unfinished[0] || retained.attempts.at(-1)!;
    return await withRetainedCheckoutSource(identity, async () => {
        const live = await findById(identity.checkoutRoot, prior.id);
        if (
            live &&
            (live.planId !== prior.planId ||
                live.path !== prior.path ||
                live.branch !== prior.branch ||
                live.baseBranch !== prior.baseBranch ||
                live.baseCommit !== prior.baseCommit)
        )
            throw new Error("Imported execution owner changed; preserve the original attempt for recovery.");
        const location = await resolveWorkflowPlanLocation(identity.checkoutRoot, prior.planName, {
            readOnly: true,
            loadFromTarget: true,
        });
        const plan = location.plan;
        if (!plan || plan.attrs.planId !== selected.metadata.planId)
            throw new Error("Original execution Plan evidence is unavailable.");
        return { ...plan, kind: "loaded", hasFrontMatter: true, frontMatterRevision: plan.frontMatterRevision };
    });
}

/** Load Plan may inspect the recorded missing checkout before the user chooses restoration. */
export async function withMissingImportedExecutionRecovery(
    identity: ProjectIdentity,
    selected: LoadedPlanPackage,
    run: () => Promise<void>,
): Promise<boolean> {
    const reference = selected.metadata.references.legacyImport;
    if (!reference || selected.metadata.workflow?.legacySettlement) return false;
    const retained = await readPlanImportEvidence(identity, reference);
    if (retained.repositoryId !== identity.repositoryId)
        throw new Error("Imported execution belongs to another repository.");
    const unfinished = retained.attempts.filter((entry) => !["validated", "abandoned"].includes(entry.status));
    if (unfinished.length !== 1) return false;
    const prior = unfinished[0];
    if (prior.planId !== selected.metadata.planId) throw new Error("Imported execution Plan identity changed.");
    return await withRetainedCheckoutSource(identity, async () => {
        const live = await findById(identity.checkoutRoot, prior.id);
        if (
            !live ||
            live.planId !== prior.planId ||
            live.path !== prior.path ||
            live.branch !== prior.branch ||
            live.baseBranch !== prior.baseBranch ||
            live.baseCommit !== prior.baseCommit
        )
            throw new Error("Imported execution owner changed; preserve the original attempt for recovery.");
        const { executionWorktreePathExists } = await import("../shared/workflow/execution-worktree-rescue.ts");
        if (await executionWorktreePathExists(live.path)) return false;
        await run();
        return true;
    });
}
