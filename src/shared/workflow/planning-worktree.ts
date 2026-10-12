import { join } from "@std/path";
import { effectiveDeliveryBranch } from "./plan-branch.ts";
import {
    canonicalizeStoredPlanName,
    getPlanRevisionForText,
    loadPlan,
    parsePlanFrontMatter,
} from "../../plan-store.js";
import {
    addEntry as addWorktreeRegistryEntry,
    listEntries as listWorktreeRegistryEntries,
    removeEntry as removeWorktreeRegistryEntry,
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
import { listControllerDocumentWorktrees, writeControllerState } from "./controller-registry.ts";
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

async function pathExists(path: string): Promise<boolean> {
    try {
        await Deno.stat(path);
        return true;
    } catch (error) {
        if (error instanceof Deno.errors.NotFound) return false;
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
    const output = await new Deno.Command("git", { cwd, args, stdout: "piped", stderr: "piped" }).output();
    const stdout = new TextDecoder().decode(output.stdout);
    const stderr = new TextDecoder().decode(output.stderr);
    if (!output.success) throw new Error(`git ${args.join(" ")} failed: ${stderr || stdout}`.trim());
    return stdout;
}

async function gitRefExists(projectRoot: string, ref: string): Promise<boolean> {
    const result = await new Deno.Command("git", {
        cwd: projectRoot,
        args: ["rev-parse", "--verify", "--quiet", ref],
        stdout: "null",
        stderr: "null",
    }).output();
    return result.success;
}

async function resolveExistingTargetSnapshot(projectRoot: string, targetBranch: string) {
    const target = targetBranch.trim();
    if (!target || target === "HEAD" || target.startsWith("refs/")) {
        throw new Error(`Invalid target branch name: ${targetBranch}`);
    }
    const branch = target.startsWith("origin/") ? target.slice("origin/".length) : target;
    const remote = await new Deno.Command("git", {
        cwd: projectRoot,
        args: ["remote", "get-url", "origin"],
        stdout: "null",
        stderr: "null",
    }).output();
    let remoteTargetExists = false;
    if (remote.success) {
        const fetched = await new Deno.Command("git", {
            cwd: projectRoot,
            args: ["fetch", "origin", `+refs/heads/${branch}:refs/remotes/origin/${branch}`],
            stdout: "piped",
            stderr: "piped",
        }).output();
        if (!fetched.success) {
            const error = new TextDecoder().decode(fetched.stderr);
            if (!error.includes("couldn't find remote ref")) {
                throw new Error(
                    `Could not refresh target branch origin/${branch}. Planning was stopped before Planner starts.`,
                );
            }
        } else remoteTargetExists = true;
    }
    const baseRef = remoteTargetExists && await gitRefExists(projectRoot, `refs/remotes/origin/${branch}`)
        ? `refs/remotes/origin/${branch}`
        : await gitRefExists(projectRoot, `refs/heads/${branch}`)
        ? `refs/heads/${branch}`
        : "";
    if (!baseRef) throw new Error(`Target branch does not exist: ${targetBranch}. Create it before planning.`);
    const commit = (await runGit(projectRoot, ["rev-parse", `${baseRef}^{commit}`])).trim();
    return { baseRef: commit, baseBranch: branch };
}

async function readTargetPlanMarkdown(projectRoot: string, planName: string, baseRef: string) {
    const relativePath = `docs/plans/${planName}.md`;
    const result = await new Deno.Command("git", {
        cwd: projectRoot,
        args: ["show", `${baseRef}:${relativePath}`],
        stdout: "piped",
        stderr: "piped",
    }).output();
    if (!result.success) return null;
    return {
        relativePath,
        markdown: new TextDecoder().decode(result.stdout),
    };
}

async function loadTargetPlan(projectRoot: string, planName: string, baseRef: string) {
    const source = await readTargetPlanMarkdown(projectRoot, planName, baseRef);
    if (!source) return null;
    const temp = await Deno.makeTempDir();
    const path = join(temp, source.relativePath);
    await Deno.mkdir(join(temp, "docs", "plans", ...planName.split("/").slice(0, -1)), { recursive: true });
    await Deno.writeTextFile(path, source.markdown);
    const plan = await loadPlan(temp, planName);
    await Deno.remove(temp, { recursive: true }).catch(() => {});
    return plan
        ? {
            ...plan,
            path: `${baseRef}:${source.relativePath}`,
            revision: await getPlanRevisionForText(source.markdown),
        }
        : null;
}

export async function findTargetBranchPlan(cwd: string, targetBranch: string, planName: string) {
    const projectRoot = resolvePrimaryCheckoutRoot(cwd);
    const target = await resolveExistingTargetSnapshot(projectRoot, targetBranch);
    return await loadTargetPlan(projectRoot, canonicalizeStoredPlanName(planName).name, target.baseRef);
}

/** Read remote target children in disposable Git storage without changing project refs or objects. */
export async function inspectTargetBranchPlansByParent(cwd: string, targetBranch: string, parentPlanName: string) {
    const projectRoot = resolvePrimaryCheckoutRoot(cwd);
    const branch = targetBranch.trim().replace(/^origin\//, "");
    if (!branch || branch === "HEAD" || branch.startsWith("refs/")) {
        throw new Error(`Invalid target branch name: ${targetBranch}`);
    }
    const remoteUrl = (await runGit(projectRoot, ["remote", "get-url", "origin"]).catch(() => "")).trim();
    if (!remoteUrl) {
        const localRef = await gitRefExists(projectRoot, `refs/heads/${branch}`) ? `refs/heads/${branch}` : "";
        if (!localRef) throw new Error(`Target branch does not exist: ${targetBranch}. Create it before planning.`);
        return await readTargetChildren(projectRoot, localRef, parentPlanName);
    }
    const scratch = await Deno.makeTempDir({ prefix: "runwield-target-inspect-" });
    try {
        await runGit(projectRoot, ["clone", "--no-hardlinks", projectRoot, scratch]);
        await runGit(scratch, ["remote", "add", "publication", remoteUrl]);
        await runGit(scratch, ["fetch", "publication", `refs/heads/${branch}:refs/runwield/target`]);
        return await readTargetChildren(scratch, "refs/runwield/target", parentPlanName);
    } finally {
        await Deno.remove(scratch, { recursive: true }).catch(() => {});
    }
}

async function readTargetChildren(projectRoot: string, ref: string, parentPlanName: string) {
    const listed = await runGit(projectRoot, ["ls-tree", "-r", "--name-only", ref, "docs/plans"]);
    const parentName = canonicalizeStoredPlanName(parentPlanName).name;
    const children: Array<{ name: string; path: string; attrs: ReturnType<typeof parsePlanFrontMatter>["attrs"] }> = [];
    for (const relativePath of listed.split(/\r?\n/).filter((line) => line.endsWith(".md"))) {
        const planName = relativePath.slice("docs/plans/".length, -".md".length);
        const source = await readTargetPlanMarkdown(projectRoot, planName, ref);
        if (!source) continue;
        const parsed = parsePlanFrontMatter(source.markdown);
        if (parsed.attrs.parentPlan !== parentName) continue;
        children.push({ name: planName, path: `${ref}:${source.relativePath}`, attrs: parsed.attrs });
    }
    return children;
}

export async function findTargetBranchPlansByParent(cwd: string, targetBranch: string, parentPlanName: string) {
    const projectRoot = resolvePrimaryCheckoutRoot(cwd);
    const target = await resolveExistingTargetSnapshot(projectRoot, targetBranch);
    const listed = await runGit(projectRoot, ["ls-tree", "-r", "--name-only", target.baseRef, "docs/plans"]);
    const parentName = canonicalizeStoredPlanName(parentPlanName).name;
    const children = new Map<
        string,
        { name: string; path: string; attrs: ReturnType<typeof parsePlanFrontMatter>["attrs"] }
    >();
    for (const relativePath of listed.split(/\r?\n/).filter((line) => line.endsWith(".md"))) {
        const planName = relativePath.slice("docs/plans/".length, -".md".length);
        const source = await readTargetPlanMarkdown(projectRoot, planName, target.baseRef);
        if (!source) continue;
        const parsed = parsePlanFrontMatter(source.markdown);
        if (parsed.attrs.parentPlan !== parentName) continue;
        children.set(planName, {
            name: planName,
            path: `${target.baseRef}:${source.relativePath}`,
            attrs: parsed.attrs,
        });
    }
    for (const entry of await listControllerDocumentWorktrees(projectRoot)) {
        const plan = await loadPlan(entry.path, entry.planName).catch(() => null);
        if (!plan || plan.attrs.parentPlan !== parentName) continue;
        const targetPlan = children.get(entry.planName);
        if (
            targetPlan?.attrs.planId && entry.planId && targetPlan.attrs.planId !== entry.planId
        ) {
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
    const projectRoot = resolvePrimaryCheckoutRoot(cwd);
    const planId = typeof planAttrs.planId === "string" ? planAttrs.planId.trim() : "";
    if (!planId) throw new Error(`Planning worktree for ${planName} requires a stable planId.`);

    const existing = (await listWorktreeRegistryEntries(projectRoot)).find((entry) =>
        entry.planId === planId && entry.status !== "abandoned"
    );
    if (existing) {
        if (existing.planName !== planName) {
            throw new Error(
                `Planning worktree for ${planName} found a different registered Plan: ${existing.planName}.`,
            );
        }
        if (await pathExists(existing.path)) {
            const plan = await loadPlan(existing.path, planName);
            if (!plan) throw new Error(`Registered worktree is missing its Plan: ${existing.path}`);
            if (plan.attrs.planId !== planId) {
                throw new Error(
                    `Registered worktree contains a different Plan ID. Your files were not changed.`,
                );
            }
            if (existing.status !== "planning") return { entry: existing, plan, reused: true };
            const target = await resolveExistingTargetSnapshot(projectRoot, targetBranchForPlan(planAttrs));
            if (existing.baseBranch !== target.baseBranch) {
                throw new Error(
                    `Planning worktree targets ${existing.baseBranch}, but Plan targets ${target.baseBranch}.`,
                );
            }
            if (target.baseRef !== existing.baseCommit) {
                const targetPlan = await loadTargetPlan(projectRoot, planName, target.baseRef);
                if (!targetPlan || targetPlan.attrs.planId !== planId) {
                    throw new Error(
                        `Target Plan ${planName} is missing or has a different Plan ID. Your files were not changed.`,
                    );
                }
            }
            const entry = await refreshPlanningWorktree(projectRoot, existing, target.baseRef);
            const refreshedPlan = await loadPlan(entry.path, planName);
            if (!refreshedPlan) throw new Error(`Registered worktree is missing its Plan: ${entry.path}`);
            return { entry, plan: refreshedPlan, reused: true };
        }
    }

    const targetBranch = targetBranchForPlan(planAttrs);
    const branch = targetBranch.replace(/^origin\//, "");
    if (!await gitRefExists(projectRoot, `refs/heads/${branch}`)) {
        await prepareTargetBranchRef(projectRoot, targetBranch);
    }
    const target = await resolveExistingTargetSnapshot(projectRoot, targetBranch);
    const targetPlan = await loadTargetPlan(projectRoot, planName, target.baseRef);
    if (!targetPlan) throw new Error(`Plan ${planName} does not exist on target ${target.baseBranch}.`);
    if (targetPlan.attrs.planId !== planId) {
        throw new Error(`Target Plan ${planName} has a different or missing Plan ID. Your files were not changed.`);
    }

    const attemptId = crypto.randomUUID().slice(0, 8);
    const transition = await runExecutionPreparationTransition({
        projectRoot,
        planName,
        planId,
        worktreeId: attemptId,
        targetRef: targetBranch,
        expectedPlanEvent: false,
        prepare: async ({ markEffect, registerRollback }) => {
            const concurrentExisting = (await listWorktreeRegistryEntries(projectRoot, { migrate: false })).find(
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
            const entry: WorktreeRegistryEntry = { ...artifacts, status: "planning" };
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
            await writeControllerState(projectRoot, { planName, planId }, { documentWorktreeId: entry.id });
            await markEffect("controller_document_worktree_recorded", { worktreeId: entry.id });
            const planFile = await ensureExecutionPlanFile({
                executionCwd: entry.path,
                planName,
                canonicalSource: loadedCanonicalSource(planName, targetPlan),
                reconcileFromCanonical: false,
                replaceFromCanonical: false,
            });
            if (!["present", "restored", "reconciled"].includes(planFile.kind)) {
                throw new Error(
                    `Cannot prepare planning Plan file ${planFile.relativePath}: ${planFile.reason || planFile.kind}`,
                );
            }
            const dirty = (await runGit(entry.path, ["status", "--porcelain"])).trim();
            if (dirty) {
                const preparation = await checkpointExecutionPreparation({
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
