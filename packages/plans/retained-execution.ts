import { lstat, readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { projects, type ProjectIdentity } from "@runwield/projects";
import {
    checkedProjectRuntimeLayout,
    withProjectRuntimeReadScope,
    WORKFLOW_DETAILS_PENDING,
} from "@runwield/project-runtime/layout";
import {
    inspectWorktreeRegistryAtPath,
    isNonterminalWorktreeStatus,
    type WorktreeRegistryEntry,
} from "@runwield/project-runtime/registry-inspection";
import { assertContainedPath } from "@runwield/resources/fs";
import { captureForegroundProcess } from "@runwield/resources/process";
import type { PlanId } from "@runwield/plan-storage-format";
import { PLANS_DIR_NAME } from "./classification.ts";
import {
    projectCheckoutControllerView,
    readControllerRecordAtPath,
    type PendingControllerRepair,
} from "./checkout-controller.ts";
import { effectivePlanLifecycleAttrs } from "./controller-state.ts";
import { readMissingExecutionPlan } from "./execution-git-snapshot.ts";
import { canonicalizeStoredPlanName, parsePlanTextStrict, type PlanTextLoaded } from "./format.ts";
import { readPlanImportEvidence, readPlanPackage, type LoadedPlanPackage } from "./package-storage.ts";
import { PlanNotFoundError } from "./store-errors.ts";
import type { ProjectPlanReadAvailability } from "./store.ts";

function unavailable(): never {
    throw new Error("Original execution Plan evidence is unavailable.");
}

async function inspectCheckoutPath(path: string) {
    if (!isAbsolute(path) || resolve(path) !== path) unavailable();
    try {
        if (!(await lstat(path)).isDirectory()) unavailable();
        return await realpath(path);
    } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
        throw error;
    }
}

async function readGitEvidence(checkoutRoot: string, args: string[]): Promise<string | undefined> {
    const result = await captureForegroundProcess("git", {
        cwd: checkoutRoot,
        env: { GIT_NO_LAZY_FETCH: "1" },
        args,
    });
    return result.success ? new TextDecoder().decode(result.stdout).replace(/\r?\n$/, "") : undefined;
}

/** The registration and the current directory must independently identify the same checkout. */
async function verifyWorktree(
    checkout: ProjectIdentity,
    repositoryRoot: string,
    attempt: WorktreeRegistryEntry,
    existingPath: string | undefined,
): Promise<void> {
    const listed = await readGitEvidence(repositoryRoot, ["worktree", "list", "--porcelain", "-z"]);
    if (listed === undefined) unavailable();

    const expectedBranch = `branch refs/heads/${attempt.branch}`;
    const worktrees = listed.split("\0\0");
    let attached = false;
    for (const worktree of worktrees) {
        const [path, ...fields] = worktree.split("\0");
        if (!path.startsWith("worktree ")) continue;
        const registeredPath = resolve(path.slice("worktree ".length));
        const samePath = registeredPath === attempt.path || registeredPath === existingPath;
        const sameBranch = fields.includes(expectedBranch);
        if (samePath !== sameBranch) throw new Error("Imported execution checkout path or branch changed.");
        if (samePath) {
            if (attached) throw new Error("Imported execution ownership is ambiguous.");
            attached = true;
        }
    }
    if (!existingPath) return;
    if (!attached) unavailable();

    const actual = projects.checkout.inspect(existingPath, {
        context: { executionAccountHome: checkout.executionAccountHome, personalOwner: checkout.personalOwner },
    });
    if (
        actual.kind !== "existing" ||
        actual.identity.checkoutRoot !== existingPath ||
        actual.identity.projectId !== checkout.projectId ||
        actual.identity.repositoryId !== checkout.repositoryId ||
        actual.identity.personalOwner.identity !== checkout.personalOwner.identity
    )
        throw new Error("Imported execution checkout belongs to a different repository or Project.");

    const [repositoryCommon, checkoutCommon, head] = await Promise.all([
        readGitEvidence(repositoryRoot, ["rev-parse", "--path-format=absolute", "--git-common-dir"]),
        readGitEvidence(existingPath, ["rev-parse", "--path-format=absolute", "--git-common-dir"]),
        readGitEvidence(existingPath, ["symbolic-ref", "--quiet", "HEAD"]),
    ]);
    const common = repositoryCommon && (await realpath(repositoryCommon));
    if (!common || !checkoutCommon || common !== (await realpath(checkoutCommon)))
        throw new Error("Imported execution checkout belongs to a different repository.");
    if (head !== `refs/heads/${attempt.branch}`) throw new Error("Imported execution checkout path or branch changed.");
    const gitEntry = join(existingPath, ".git");
    await assertContainedPath(existingPath, gitEntry);
    if (existingPath !== (await realpath(repositoryRoot))) {
        const backlink = await readGitEvidence(existingPath, [
            "rev-parse",
            "--path-format=absolute",
            "--git-path",
            "gitdir",
        ]);
        const worktrees = join(common, "worktrees");
        if (!backlink || dirname(dirname(resolve(backlink))) !== worktrees) unavailable();
        await assertContainedPath(worktrees, resolve(backlink));
        const target = (await readFile(backlink, "utf8")).replace(/\r?\n$/, "");
        if ((await realpath(resolve(dirname(backlink), target))) !== gitEntry)
            throw new Error("Imported execution checkout path or branch changed.");
    }
}

interface RetainedExecutionDocument extends PlanTextLoaded {
    readAvailability: ProjectPlanReadAvailability;
    pendingControllerRepairs: PendingControllerRepair[];
}

export interface RetainedExecutionRead {
    selected: LoadedPlanPackage;
    retained?: RetainedExecutionDocument;
}

/** Keep the selected package and its retained execution projection in the same read generation. */
export async function readRetainedExecutionPlan(
    checkout: ProjectIdentity,
    planId: PlanId,
): Promise<RetainedExecutionRead> {
    const selected = await readPlanPackage(checkout, { planId });
    if (selected.kind === "missing") throw new PlanNotFoundError(planId);
    if (selected.kind !== "loaded") throw new Error(selected.message);
    if (selected.metadata.planId !== planId) throw new Error("Imported execution Plan identity changed.");
    const { references, workflow, archive } = selected.metadata;
    if (!references.legacyImport || workflow?.legacySettlement || (archive && !archive.restoredAt)) return { selected };
    const retained = await readPlanImportEvidence(checkout, references.legacyImport, planId);
    if (!retained.attempts.length) return { selected };
    if (retained.repositoryId !== checkout.repositoryId)
        throw new Error("Imported execution belongs to another repository.");
    const unfinished = retained.attempts.filter((attempt) => !["validated", "abandoned"].includes(attempt.status));
    if (unfinished.length > 1)
        throw new Error("Imported execution ownership is ambiguous; preserve all attempts for recovery.");
    const prior = unfinished[0] || retained.attempts.at(-1)!;
    if (prior.planId !== planId) throw new Error("Imported execution Plan identity changed.");

    const document = await withProjectRuntimeReadScope(async () => {
        const repositoryRoot = projects.checkout.primaryRoot(checkout.checkoutRoot);
        const checkoutPath = await inspectCheckoutPath(prior.path);
        await verifyWorktree(checkout, repositoryRoot, prior, checkoutPath);
        const layout = await projects.launch.withContext(checkout, () =>
            checkedProjectRuntimeLayout(checkout.checkoutRoot),
        );
        const registry = await inspectWorktreeRegistryAtPath(layout.primary.worktreeRegistryPath);
        if (registry.readError) throw registry.readError;
        const relevant = registry.entries.filter(
            (entry) => entry && (entry.id === prior.id || entry.planId === planId || entry.planName === prior.planName),
        );
        const ids = new Set(relevant.map((entry) => entry.id));
        const issue = registry.integrityIssues.find(
            (item) => item.ids.length === 0 || item.ids.some((id) => ids.has(id)),
        );
        if (issue) throw new Error(`Imported execution registry is ambiguous or invalid: ${issue.message}`);
        const live = relevant.find((entry) => entry.id === prior.id);
        if (!live) throw new Error("Original execution attempt is unavailable.");
        if (
            live.planId !== planId ||
            live.planName !== prior.planName ||
            live.path !== prior.path ||
            live.branch !== prior.branch ||
            live.baseBranch !== prior.baseBranch ||
            live.baseCommit !== prior.baseCommit ||
            (!isNonterminalWorktreeStatus(live.status) && live.status !== "abandoned")
        )
            throw new Error("Imported execution owner changed; preserve the original attempt for recovery.");
        if (relevant.some((entry) => entry !== live && isNonterminalWorktreeStatus(entry.status)))
            throw new Error("Imported execution ownership is ambiguous; preserve all attempts for recovery.");

        const { name, segments } = canonicalizeStoredPlanName(live.planName);
        if (name !== live.planName) unavailable();
        let plan;
        if (checkoutPath) {
            const path = join(live.path, PLANS_DIR_NAME, ...segments) + ".md";
            await assertContainedPath(live.path, path);
            try {
                if (!(await lstat(path)).isFile()) unavailable();
                plan = await parsePlanTextStrict(await readFile(path, "utf8"), path);
            } catch (error) {
                if (error instanceof Error && "code" in error && error.code === "ENOENT") unavailable();
                throw error;
            }
        } else {
            plan = await readMissingExecutionPlan(layout.primary.checkoutRoot, live);
        }
        if (plan?.kind === "malformed") throw plan.error;
        if (!plan) unavailable();
        if (plan.attrs.planId !== planId) throw new Error("The execution directory contains a different Plan.");

        const identity = { planId, planName: live.planName };
        const record = await readControllerRecordAtPath(layout.primary.controllerPlansDir, identity);
        if (record && (record.planId !== planId || record.planName !== live.planName))
            throw new Error("Imported execution controller belongs to a different Plan.");
        if (record?.state.validationCheckpoint && record.state.validationCheckpoint.attemptId !== live.id)
            throw new Error("Imported validation checkpoint belongs to another attempt.");
        const view = projectCheckoutControllerView(
            { kind: live.status === "abandoned" ? "retired" : "live", entry: live },
            record,
            plan.attrs,
            checkoutPath ?? checkout.checkoutRoot,
        );
        return {
            ...plan,
            attrs: effectivePlanLifecycleAttrs(plan.attrs, view.state, view.publicationConfirmed),
            controllerRevision: view.revision,
            readAvailability: view.pendingRepairs.length
                ? { kind: "pending" as const, message: WORKFLOW_DETAILS_PENDING }
                : { kind: "ready" as const },
            pendingControllerRepairs: view.pendingRepairs,
        };
    });
    return { selected, retained: document };
}
