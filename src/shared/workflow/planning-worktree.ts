import { resolvePublicationUpstream } from "../publication-target.ts";
import { captureForegroundProcess } from "../captured-process.ts";
import { readFile as fsReadFile, stat as fsStat } from "node:fs/promises";
import { join } from "node:path";
import { effectiveDeliveryBranch } from "./plan-branch.ts";
import {
    canonicalizeStoredPlanName,
    inspectPlanTextStrict,
    getStoredPlanPath,
    loadPlan,
    mergeFrontMatterText,
    parsePlanFrontMatter,
    withPlanCatalogLock,
} from "../../plan-store.js";
import {
    addEntry as addWorktreeRegistryEntry,
    listEntries as listWorktreeRegistryEntries,
    removeEntry as removeWorktreeRegistryEntry,
    renamePlanningWorktreePlan,
    updateEntry as updateWorktreeRegistryEntry,
    type WorktreeRegistryEntry,
} from "../worktree-registry.js";
import {
    checkpointExecutionPreparation,
    createWorktreeGitArtifacts,
    prepareTargetBranchRef,
    removeWorktreeGitArtifacts,
} from "../worktree.js";
import { runExecutionPreparationTransition } from "./state-transition.ts";
import { resolvePrimaryCheckoutRoot } from "../primary-checkout.ts";
import { ensureExecutionPlanFile } from "./execution-plan-file.js";
import {
    assertControllerDocumentAvailable,
    inspectControllerDocumentWorktrees,
    listControllerDocumentWorktrees,
    writeControllerState,
} from "./controller-registry.ts";
import { enterProjectRuntime, ProjectRuntimeReadPendingError } from "../project-runtime-layout.ts";
import { refreshPlanningWorktree } from "./planning-worktree-refresh.ts";

type LoadedPlan = NonNullable<Awaited<ReturnType<typeof loadPlan>>>;

type LoadedCanonicalPlanSource = {
    kind: "loaded";
    path: string;
    relativePath: string;
    markdown: string;
    attrs: LoadedPlan["attrs"];
};

export interface PlanningWorktreeResult {
    entry: WorktreeRegistryEntry;
    plan: LoadedPlan;
    reused: boolean;
}

interface PlanningPlanAttributes {
    planId?: string;
    targetBranch?: string;
    deliveryBranch?: string;
}

export class TargetBranchSnapshotUnavailableError extends Error {
    constructor(targetBranch: string) {
        super(`Local target branch evidence is unavailable: ${targetBranch}.`);
        this.name = "TargetBranchSnapshotUnavailableError";
    }
}

async function pathExists(path: string): Promise<boolean> {
    try {
        await fsStat(path);
        return true;
    } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
        throw error;
    }
}

function targetBranchForPlan(attrs: PlanningPlanAttributes): string {
    const targetBranch = effectiveDeliveryBranch(attrs) || "";
    if (!targetBranch) throw new Error("Epic child planning requires a targetBranch.");
    return targetBranch;
}

function loadedCanonicalSource(planName: string, plan: LoadedPlan): LoadedCanonicalPlanSource {
    return {
        kind: "loaded",
        path: plan.path,
        relativePath: `docs/plans/${planName}.md`,
        markdown: plan.markdown,
        attrs: plan.attrs,
    };
}

async function runGit(cwd: string, args: string[]): Promise<string> {
    const output = await captureForegroundProcess("git", { cwd, args, env: { GIT_NO_LAZY_FETCH: "1" } });
    const stdout = new TextDecoder().decode(output.stdout);
    const stderr = new TextDecoder().decode(output.stderr);
    if (!output.success) {
        if (["rev-parse", "ls-tree"].includes(args[0])) throw new TargetBranchSnapshotUnavailableError(args[1]);
        throw new Error(`git ${args.join(" ")} failed: ${stderr || stdout}`.trim());
    }
    return stdout;
}

async function gitRefExists(projectRoot: string, ref: string): Promise<boolean> {
    const result = await captureForegroundProcess("git", {
        cwd: projectRoot,
        env: { GIT_NO_LAZY_FETCH: "1" },
        args: ["rev-parse", "--verify", "--quiet", ref],
    });
    return result.success;
}

/** Preserve cached origin history for read-only lookups without overriding an explicit local remote. */
async function cachedTargetRemote(projectRoot: string, branch: string): Promise<string | undefined> {
    const upstream = await resolvePublicationUpstream(projectRoot, branch);
    if (upstream) return upstream.remote;
    const configured = await captureForegroundProcess("git", {
        cwd: projectRoot,
        env: { GIT_NO_LAZY_FETCH: "1" },
        args: ["config", "--get", `branch.${branch}.remote`],
    });
    return configured.code === 1 ? "origin" : undefined;
}

/** Read only locally available target evidence. */
async function resolveExistingTargetSnapshot(projectRoot: string, targetBranch: string) {
    const target = targetBranch.trim();
    if (!target || target === "HEAD" || target.startsWith("refs/")) {
        throw new Error(`Invalid target branch name: ${targetBranch}`);
    }
    const branch = target.startsWith("origin/") ? target.slice("origin/".length) : target;
    const remote = await cachedTargetRemote(projectRoot, branch);
    const remoteRef = remote ? `refs/remotes/${remote}/${branch}` : "";
    const baseRef =
        remoteRef && (await gitRefExists(projectRoot, remoteRef))
            ? remoteRef
            : (await gitRefExists(projectRoot, `refs/heads/${branch}`))
              ? `refs/heads/${branch}`
              : "";
    if (!baseRef) throw new TargetBranchSnapshotUnavailableError(targetBranch);
    const commit = (await runGit(projectRoot, ["rev-parse", `${baseRef}^{commit}`])).trim();
    return { baseRef: commit, baseBranch: branch, targetRef: baseRef };
}

/** Explicit workflow preparation owns remote refresh. */
async function prepareExistingTargetSnapshot(projectRoot: string, targetBranch: string) {
    const branch = targetBranch.trim().replace(/^origin\//, "");
    if (!branch || branch === "HEAD" || branch.startsWith("refs/")) {
        throw new Error(`Invalid target branch name: ${targetBranch}`);
    }
    const upstream = await resolvePublicationUpstream(projectRoot, branch);
    if (upstream) {
        const fetched = await captureForegroundProcess("git", {
            cwd: projectRoot,
            args: ["fetch", upstream.remote, `+refs/heads/${branch}:refs/remotes/${upstream.remote}/${branch}`],
        });
        if (!fetched.success && !new TextDecoder().decode(fetched.stderr).includes("couldn't find remote ref")) {
            throw new Error(
                `Could not refresh target branch ${upstream.remote}/${branch}. Planning was stopped before Planner starts.`,
            );
        }
        if (!fetched.success) {
            // A removed remote branch must not leave a stale remote-tracking ref authoritative.
            if (!(await gitRefExists(projectRoot, `refs/heads/${branch}`))) {
                throw new TargetBranchSnapshotUnavailableError(targetBranch);
            }
            const commit = (await runGit(projectRoot, ["rev-parse", `refs/heads/${branch}^{commit}`])).trim();
            return { baseRef: commit, baseBranch: branch, targetRef: `refs/heads/${branch}` };
        }
        return await resolveExistingTargetSnapshot(projectRoot, targetBranch);
    }
    const localRef = `refs/heads/${branch}`;
    if (!(await gitRefExists(projectRoot, localRef))) throw new TargetBranchSnapshotUnavailableError(targetBranch);
    const commit = (await runGit(projectRoot, ["rev-parse", `${localRef}^{commit}`])).trim();
    return { baseRef: commit, baseBranch: branch, targetRef: localRef };
}

export async function prepareTargetBranchPlansByParent(cwd: string, targetBranch: string, parentPlanName: string) {
    const projectRoot = resolvePrimaryCheckoutRoot(cwd);
    await enterProjectRuntime(projectRoot);
    const target = (await isPrimaryTargetCheckout(projectRoot, targetBranch))
        ? undefined
        : await prepareExistingTargetSnapshot(projectRoot, targetBranch);
    return await readTargetBranchPlansByParent(projectRoot, targetBranch, parentPlanName, target);
}

async function readTargetPlanMarkdown(projectRoot: string, planName: string, baseRef: string) {
    const relativePath = `docs/plans/${planName}.md`;
    const result = await captureForegroundProcess("git", {
        cwd: projectRoot,
        env: { GIT_NO_LAZY_FETCH: "1" },
        args: ["show", `${baseRef}:${relativePath}`],
    });
    if (!result.success) {
        // A missing path is different from a promised object that is not local.
        const listed = await runGit(projectRoot, ["ls-tree", baseRef, "--", relativePath]);
        if (listed.trim()) throw new TargetBranchSnapshotUnavailableError(baseRef);
        return null;
    }
    return {
        relativePath,
        markdown: new TextDecoder().decode(result.stdout),
    };
}

/** Read many Plan documents from one ref with a single Git process; missing paths are omitted. */
async function readTargetPlanMarkdowns(
    projectRoot: string,
    relativePaths: string[],
    baseRef: string,
): Promise<Map<string, string>> {
    const found = new Map<string, string>();
    if (relativePaths.length === 0) return found;
    const output = await captureForegroundProcess("git", {
        cwd: projectRoot,
        env: { GIT_NO_LAZY_FETCH: "1" },
        args: ["cat-file", "--batch"],
        stdinText: relativePaths.map((path) => `${baseRef}:${path}\n`).join(""),
    });
    if (!output.success) throw new TargetBranchSnapshotUnavailableError(baseRef);
    const bytes = output.stdout;
    const decoder = new TextDecoder();
    let offset = 0;
    for (const relativePath of relativePaths) {
        const headerEnd = bytes.indexOf(10, offset);
        if (headerEnd < 0) throw new TargetBranchSnapshotUnavailableError(baseRef);
        const header = decoder.decode(bytes.subarray(offset, headerEnd));
        offset = headerEnd + 1;
        const [, type, size] = header.split(" ");
        if (type === undefined || size === undefined) throw new TargetBranchSnapshotUnavailableError(baseRef);
        const end = offset + Number(size);
        if (type === "blob") found.set(relativePath, decoder.decode(bytes.subarray(offset, end)));
        offset = end + 1;
    }
    return found;
}

export async function loadTargetPlan(projectRoot: string, planName: string, baseRef: string) {
    const source = await readTargetPlanMarkdown(projectRoot, planName, baseRef);
    if (!source) return null;
    const plan = await inspectPlanTextStrict(
        source.markdown,
        `${baseRef}:${source.relativePath}`,
        getStoredPlanPath(projectRoot, planName),
    );
    if (plan.kind === "malformed") throw plan.error;
    return plan;
}

/** Only the primary checkout on the named target can supply unpublished family edits. */
async function isPrimaryTargetCheckout(projectRoot: string, targetBranch: string): Promise<boolean> {
    const branch = targetBranch.trim().replace(/^origin\//, "");
    const current = await captureForegroundProcess("git", {
        cwd: projectRoot,
        env: { GIT_NO_LAZY_FETCH: "1" },
        args: ["symbolic-ref", "--quiet", "HEAD"],
    });
    return current.success && new TextDecoder().decode(current.stdout).trim() === `refs/heads/${branch}`;
}

/** Document authority is independent of the committed code baseline used for a new worktree. */
async function loadPlanningTargetPlan(projectRoot: string, planName: string, targetBranch: string, baseRef: string) {
    return (await isPrimaryTargetCheckout(projectRoot, targetBranch))
        ? await loadPlan(projectRoot, planName)
        : await loadTargetPlan(projectRoot, planName, baseRef);
}

export async function findTargetBranchPlan(cwd: string, targetBranch: string, planName: string) {
    const projectRoot = resolvePrimaryCheckoutRoot(cwd);
    const branch = targetBranch.trim().replace(/^origin\//, "");
    if (!branch || branch === "HEAD" || branch.startsWith("refs/")) {
        throw new Error(`Invalid target branch name: ${targetBranch}`);
    }
    if (await isPrimaryTargetCheckout(projectRoot, targetBranch)) {
        return await loadPlan(projectRoot, canonicalizeStoredPlanName(planName).name);
    }
    // Lookup uses the known snapshot. Only session preparation fetches into project refs.
    const remote = await cachedTargetRemote(projectRoot, branch);
    const remoteRef = remote ? `refs/remotes/${remote}/${branch}` : `refs/heads/${branch}`;
    const ref = (await gitRefExists(projectRoot, remoteRef)) ? remoteRef : `refs/heads/${branch}`;
    // Undefined means this checkout has not fetched the branch; null means the
    // known branch has no document at this path.
    if (!(await gitRefExists(projectRoot, ref))) return undefined;
    const commit = (await runGit(projectRoot, ["rev-parse", `${ref}^{commit}`])).trim();
    return await loadTargetPlan(projectRoot, canonicalizeStoredPlanName(planName).name, commit);
}

/** Inspect committed target children using local evidence only. */
export async function inspectTargetBranchPlansByParent(cwd: string, targetBranch: string, parentPlanName: string) {
    const projectRoot = resolvePrimaryCheckoutRoot(cwd);
    const target = await resolveExistingTargetSnapshot(projectRoot, targetBranch);
    return await readTargetChildren(projectRoot, target.baseRef, parentPlanName);
}

async function readTargetChildren(projectRoot: string, ref: string, parentPlanName: string) {
    const listed = await runGit(projectRoot, ["ls-tree", "-r", "--name-only", ref, "docs/plans"]);
    const parentName = canonicalizeStoredPlanName(parentPlanName).name;
    const children: Array<{ name: string; path: string; attrs: ReturnType<typeof parsePlanFrontMatter>["attrs"] }> = [];
    const relativePaths = listed.split(/\r?\n/).filter((line) => line.endsWith(".md"));
    const sources = await readTargetPlanMarkdowns(projectRoot, relativePaths, ref);
    for (const [relativePath, markdown] of sources) {
        const planName = relativePath.slice("docs/plans/".length, -".md".length);
        const parsed = parsePlanFrontMatter(markdown);
        if (parsed.attrs.parentPlan !== parentName) continue;
        children.push({ name: planName, path: `${ref}:${relativePath}`, attrs: parsed.attrs });
    }
    return children;
}

export async function findTargetBranchPlansByParent(cwd: string, targetBranch: string, parentPlanName: string) {
    return await readTargetBranchPlansByParent(cwd, targetBranch, parentPlanName);
}

async function readTargetBranchPlansByParent(
    cwd: string,
    targetBranch: string,
    parentPlanName: string,
    preparedTarget?: Awaited<ReturnType<typeof resolveExistingTargetSnapshot>>,
) {
    const projectRoot = resolvePrimaryCheckoutRoot(cwd);
    const localTarget = await isPrimaryTargetCheckout(projectRoot, targetBranch);
    const target = localTarget
        ? null
        : preparedTarget || (await resolveExistingTargetSnapshot(projectRoot, targetBranch));
    const parentName = canonicalizeStoredPlanName(parentPlanName).name;
    const children = new Map<
        string,
        { name: string; path: string; attrs: ReturnType<typeof parsePlanFrontMatter>["attrs"] }
    >();
    const sources = new Map<string, string>();
    if (localTarget) {
        const listed = await runGit(projectRoot, [
            "ls-files",
            "-z",
            "--cached",
            "--others",
            "--exclude-standard",
            "--",
            "docs/plans",
        ]);
        for (const relativePath of new Set(listed.split("\0").filter((path) => path.endsWith(".md")))) {
            if (await pathExists(join(projectRoot, relativePath))) {
                sources.set(relativePath, await fsReadFile(join(projectRoot, relativePath), "utf8"));
            }
        }
    } else if (target) {
        const listed = await runGit(projectRoot, ["ls-tree", "-r", "--name-only", target.baseRef, "docs/plans"]);
        const relativePaths = listed.split(/\r?\n/).filter((line) => line.endsWith(".md"));
        for (const [path, markdown] of await readTargetPlanMarkdowns(projectRoot, relativePaths, target.baseRef)) {
            sources.set(path, markdown);
        }
    }
    for (const [relativePath, markdown] of sources) {
        const planName = relativePath.slice("docs/plans/".length, -".md".length);
        const parsed = parsePlanFrontMatter(markdown);
        if (parsed.attrs.parentPlan !== parentName) continue;
        children.set(planName, {
            name: planName,
            path: target ? `${target.baseRef}:${relativePath}` : join(projectRoot, relativePath),
            attrs: parsed.attrs,
        });
    }
    for (const entry of await listControllerDocumentWorktrees(projectRoot)) {
        if (entry.documentUnavailable) continue;
        const plan = await loadPlan(entry.path, entry.planName);
        if (!plan || plan.attrs.parentPlan !== parentName) continue;
        const targetPlan = children.get(entry.planName);
        // The branch owns membership and names; a saved planning checkout cannot restore a removed child.
        if (!targetPlan && entry.status === "planning") continue;
        if (targetPlan?.attrs.planId && entry.planId && targetPlan.attrs.planId !== entry.planId) {
            throw new Error(`Registered Plan ${entry.planName} does not match the target Plan ID.`);
        }
        if (entry.planId && plan.attrs.planId && entry.planId !== plan.attrs.planId) {
            throw new Error(`Registered Plan ${entry.planName} contains a different Plan ID.`);
        }
        children.set(entry.planName, { name: entry.planName, path: plan.path, attrs: plan.attrs });
    }
    return [...children.values()];
}

export async function preparePlanningWorktreeForPlan(
    cwd: string,
    planName: string,
    planAttrs: PlanningPlanAttributes,
): Promise<PlanningWorktreeResult> {
    for (;;) {
        try {
            return await preparePlanningWorktreeForPlanEntered(cwd, planName, planAttrs);
        } catch (error) {
            if (!(error instanceof ProjectRuntimeReadPendingError)) throw error;
            // A concurrent admission can briefly hold the migration lock after our
            // entry returns. The action, unlike a browser read, owns recovery.
            await enterProjectRuntime(cwd);
        }
    }
}

async function preparePlanningWorktreeForPlanEntered(
    cwd: string,
    planName: string,
    planAttrs: PlanningPlanAttributes,
): Promise<PlanningWorktreeResult> {
    const projectRoot = resolvePrimaryCheckoutRoot(cwd);
    await enterProjectRuntime(projectRoot);
    const planId = typeof planAttrs.planId === "string" ? planAttrs.planId.trim() : "";
    if (!planId) {
        // Serialize onboarding until the generated identity is saved in a registered document.
        return await withPlanCatalogLock(projectRoot, async () => {
            const registered = (await listWorktreeRegistryEntries(projectRoot)).find(
                (entry) => entry.planName === planName && entry.status !== "abandoned",
            );
            let stablePlanId = registered?.planId;
            if (!stablePlanId) {
                const target = await prepareExistingTargetSnapshot(projectRoot, targetBranchForPlan(planAttrs));
                const targetPlan = await loadPlanningTargetPlan(
                    projectRoot,
                    planName,
                    target.baseBranch,
                    target.baseRef,
                );
                if (!targetPlan) throw new Error(`Plan ${planName} does not exist on target ${target.baseBranch}.`);
                // A local draft can omit an existing identity, but must not replace it with a new one.
                const committedPlan = targetPlan.attrs.planId
                    ? null
                    : await loadTargetPlan(projectRoot, planName, target.baseRef);
                stablePlanId = targetPlan.attrs.planId || committedPlan?.attrs.planId || crypto.randomUUID();
            }
            return await preparePlanningWorktreeForPlan(projectRoot, planName, { ...planAttrs, planId: stablePlanId });
        });
    }

    let existing = (await listWorktreeRegistryEntries(projectRoot)).find(
        (entry) => entry.planId === planId && entry.status !== "abandoned",
    );
    if (existing) {
        if (await pathExists(existing.path)) {
            const [checked] = await inspectControllerDocumentWorktrees(projectRoot, [existing]);
            assertControllerDocumentAvailable(checked);
        }
        if (existing.planName !== planName) {
            if (existing.status !== "planning") {
                throw new Error(
                    `Planning worktree for ${planName} found a different registered Plan: ${existing.planName}.`,
                );
            }
            const target = await prepareExistingTargetSnapshot(projectRoot, targetBranchForPlan(planAttrs));
            const targetPlan = await loadPlanningTargetPlan(projectRoot, planName, target.baseBranch, target.baseRef);
            if (!targetPlan || targetPlan.attrs.planId !== planId || existing.baseBranch !== target.baseBranch) {
                throw new Error(`Target Plan ${planName} does not match the saved planning identity.`);
            }
            existing = await refreshPlanningWorktree(projectRoot, existing, target.baseRef, target.targetRef);
            const renamed = await loadPlan(existing.path, planName);
            if (!renamed || renamed.attrs.planId !== planId) {
                throw new Error(`Refreshed planning worktree is missing ${planName}. Your saved work is preserved.`);
            }
            existing = await renamePlanningWorktreePlan(projectRoot, existing.id, existing.planName, planName);
        }
        if (await pathExists(existing.path)) {
            const plan = await loadPlan(existing.path, planName);
            if (!plan) throw new Error(`Registered worktree is missing its Plan: ${existing.path}`);
            if (plan.attrs.planId !== planId) {
                throw new Error(`Registered worktree contains a different Plan ID. Your files were not changed.`);
            }
            if (existing.status !== "planning") return { entry: existing, plan, reused: true };
            const target = await prepareExistingTargetSnapshot(projectRoot, targetBranchForPlan(planAttrs));
            if (existing.baseBranch !== target.baseBranch) {
                throw new Error(
                    `Planning worktree targets ${existing.baseBranch}, but Plan targets ${target.baseBranch}.`,
                );
            }
            if (target.baseRef !== existing.baseCommit) {
                const targetPlan = await loadPlanningTargetPlan(
                    projectRoot,
                    planName,
                    target.baseBranch,
                    target.baseRef,
                );
                if (!targetPlan || (targetPlan.attrs.planId && targetPlan.attrs.planId !== planId)) {
                    throw new Error(
                        `Target Plan ${planName} is missing or has a different Plan ID. Your files were not changed.`,
                    );
                }
            }
            const entry = await refreshPlanningWorktree(projectRoot, existing, target.baseRef, target.targetRef);
            const refreshedPlan = await loadPlan(entry.path, planName);
            if (!refreshedPlan) throw new Error(`Registered worktree is missing its Plan: ${entry.path}`);
            return { entry, plan: refreshedPlan, reused: true };
        }
    }

    const targetBranch = targetBranchForPlan(planAttrs);
    const branch = targetBranch.replace(/^origin\//, "");
    if (!(await gitRefExists(projectRoot, `refs/heads/${branch}`))) {
        await prepareTargetBranchRef(projectRoot, targetBranch);
    }
    const target = await prepareExistingTargetSnapshot(projectRoot, targetBranch);
    const targetPlan = await loadPlanningTargetPlan(projectRoot, planName, target.baseBranch, target.baseRef);
    if (!targetPlan) throw new Error(`Plan ${planName} does not exist on target ${target.baseBranch}.`);
    if (targetPlan.attrs.planId && targetPlan.attrs.planId !== planId) {
        throw new Error(`Target Plan ${planName} has a different Plan ID. Your files were not changed.`);
    }
    const localTarget = await isPrimaryTargetCheckout(projectRoot, target.baseBranch);
    if (localTarget) {
        const committedPlan = await loadTargetPlan(projectRoot, planName, target.baseRef);
        if (committedPlan?.attrs.planId && committedPlan.attrs.planId !== planId) {
            throw new Error(`Target Plan ${planName} has a different Plan ID. Your files were not changed.`);
        }
    }
    const canonicalPlan = targetPlan.attrs.planId
        ? targetPlan
        : {
              ...targetPlan,
              attrs: { ...targetPlan.attrs, planId },
              markdown: mergeFrontMatterText(targetPlan.markdown, { planId }),
          };

    const attemptId = crypto.randomUUID().slice(0, 8);
    const transition = await runExecutionPreparationTransition({
        projectRoot,
        planName,
        planId,
        worktreeId: attemptId,
        targetRef: targetBranch,
        expectedPlanEvent: false,
        prepare: async ({ markEffect, registerRollback }) => {
            const concurrentExisting = (await listWorktreeRegistryEntries(projectRoot)).find(
                (entry) => entry.planId === planId && entry.status !== "abandoned",
            );
            if (concurrentExisting) {
                if (concurrentExisting.planName !== planName) {
                    throw new Error(
                        `Planning worktree for ${planName} found a different registered Plan: ${concurrentExisting.planName}.`,
                    );
                }
                const plan = await loadPlan(concurrentExisting.path, planName);
                if (!plan) throw new Error(`Registered worktree is missing its Plan: ${concurrentExisting.path}`);
                if (plan.attrs.planId !== planId) {
                    throw new Error(`Registered worktree contains a different Plan ID. Your files were not changed.`);
                }
                return { entry: concurrentExisting, plan, reused: true };
            }
            const artifacts = await createWorktreeGitArtifacts({
                projectRoot,
                planName,
                planId,
                baseRef: target.baseRef,
                baseBranch: target.baseBranch,
                attemptId,
            });
            const entry: WorktreeRegistryEntry = { ...artifacts, baseRef: target.targetRef, status: "planning" };
            registerRollback("remove_clean_created_worktree_and_registry_entry", async () => {
                await removeWorktreeGitArtifacts({ projectRoot, path: entry.path, force: true });
                await removeWorktreeRegistryEntry(projectRoot, entry.id);
            });
            await markEffect("git_worktree_created", {
                worktreeId: entry.id,
                path: entry.path,
                branch: entry.branch,
                baseCommit: entry.baseCommit,
            });
            await addWorktreeRegistryEntry(projectRoot, entry);
            await markEffect("worktree_registry_settled", {
                worktreeId: entry.id,
                path: entry.path,
                branch: entry.branch,
                status: entry.status,
            });
            const planFile = await ensureExecutionPlanFile({
                executionCwd: entry.path,
                planName,
                canonicalSource: loadedCanonicalSource(planName, canonicalPlan),
                reconcileFromCanonical: !targetPlan.attrs.planId,
                // Only the selected document transfers; all code stays on the latest target snapshot.
                replaceFromCanonical: localTarget,
            });
            if (!["present", "restored", "reconciled"].includes(planFile.kind)) {
                throw new Error(
                    `Cannot prepare planning Plan file ${planFile.relativePath}: ${planFile.reason || planFile.kind}`,
                );
            }
            const dirty = (await runGit(entry.path, ["status", "--porcelain"])).trim();
            if (dirty) {
                const preparation = await checkpointExecutionPreparation({
                    phase: "planning",
                    worktreePath: entry.path,
                    branch: entry.branch,
                    baseCommit: entry.baseCommit,
                    planName,
                    planRelativePath: planFile.relativePath,
                    relatedPlanPaths: [],
                });
                await runGit(entry.path, ["rev-parse", preparation.preparationCommit]);
                await markEffect("planning_preparation_checkpoint_settled", {
                    preparationCommit: preparation.preparationCommit,
                    worktreeId: entry.id,
                });
            }
            await updateWorktreeRegistryEntry(projectRoot, entry.id, { status: "planning" });
            const plan = await loadPlan(entry.path, planName);
            if (!plan) throw new Error(`Planning worktree is missing its Plan after preparation: ${entry.path}`);
            await writeControllerState(projectRoot, { planName, planId }, { documentWorktreeId: entry.id });
            await markEffect("controller_document_worktree_recorded", { worktreeId: entry.id });
            return { entry, plan, reused: false };
        },
        verifyPreparation: (result) => ({
            planName,
            worktreeId: result.entry.id,
            status: result.entry.status,
            documentWorktreeId: result.entry.id,
        }),
    });
    if (transition.status !== "committed") {
        throw new Error(transition.message || `Planning worktree preparation did not commit for ${planName}.`);
    }
    return transition.value as PlanningWorktreeResult;
}
