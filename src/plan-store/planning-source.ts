import { isEpicArtifactPlanName } from "../plan-format.ts";
import type { PlanDocumentDiagnostic } from "./index.ts";

import { captureForegroundProcess } from "../shared/captured-process.ts";
import { readFile as fsReadFile } from "node:fs/promises";
import { join } from "node:path";

import { inspectPlanTextStrict, getStoredPlanPath, withPlanCatalogLock } from "../plan-store.js";
import {
    canonicalizeStoredPlanName,
    isHiddenPlanName,
    PlanFrontMatterParseError,
    mergeFrontMatterText,
    parsePlanFrontMatter,
} from "../plan-format.ts";
import { loadPlan } from "./index.ts";
import { listEntries as listWorktreeRegistryEntries } from "../shared/worktree-registry.js";

import { resolvePrimaryCheckoutRoot } from "../shared/primary-checkout.ts";
import { ensureExecutionPlanFile } from "./index.ts";
import {
    assertControllerDocumentAvailable,
    inspectControllerDocumentWorktrees,
    listControllerDocumentWorktrees,
    writeControllerState,
} from "./controllers.ts";
import { enterProjectRuntime, withProjectRuntimeReadScope } from "../shared/project-runtime-layout.ts";

import {
    PlanningPlanAttributes,
    TargetBranchSnapshotUnavailableError,
    pathExists,
    targetBranchForPlan,
    runGit,
    gitRefExists,
    cachedTargetRemote,
    resolveExistingTargetSnapshot,
    prepareExistingTargetSnapshot,
    isPrimaryTargetCheckout,
} from "../shared/workflow/planning-target.ts";

export type LoadedPlan = NonNullable<Awaited<ReturnType<typeof loadPlan>>>;

export type LoadedCanonicalPlanSource = {
    kind: "loaded";
    path: string;
    relativePath: string;
    markdown: string;
    attrs: LoadedPlan["attrs"];
};

export function loadedCanonicalSource(planName: string, plan: LoadedPlan): LoadedCanonicalPlanSource {
    return {
        kind: "loaded",
        path: plan.path,
        relativePath: `docs/plans/${planName}.md`,
        markdown: plan.markdown,
        attrs: plan.attrs,
    };
}

export async function prepareTargetBranchPlansByParent(cwd: string, targetBranch: string, parentPlanName: string) {
    const projectRoot = resolvePrimaryCheckoutRoot(cwd);
    await enterProjectRuntime(projectRoot);
    const target = (await isPrimaryTargetCheckout(projectRoot, targetBranch))
        ? undefined
        : await prepareExistingTargetSnapshot(projectRoot, targetBranch);
    return (await readTargetBranchPlansByParent(projectRoot, targetBranch, parentPlanName, target)).plans;
}

export async function readTargetPlanMarkdown(projectRoot: string, planName: string, baseRef: string) {
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
export async function readTargetPlanMarkdowns(
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

/** Document authority is independent of the committed code baseline used for a new worktree. */
export async function loadPlanningTargetPlan(
    projectRoot: string,
    planName: string,
    targetBranch: string,
    baseRef: string,
) {
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
    return await withProjectRuntimeReadScope(async () => {
        const projectRoot = resolvePrimaryCheckoutRoot(cwd);
        const target = await resolveExistingTargetSnapshot(projectRoot, targetBranch);
        return await readTargetChildren(projectRoot, target.baseRef, parentPlanName);
    });
}

export function isActivePlanPath(path: string): boolean {
    if (!path.startsWith("docs/plans/") || !path.endsWith(".md")) return false;
    const name = path.slice("docs/plans/".length, -3);
    return !isHiddenPlanName(name) && !isEpicArtifactPlanName(name);
}

export async function readTargetChildren(projectRoot: string, ref: string, parentPlanName: string) {
    const listed = await runGit(projectRoot, ["ls-tree", "-r", "--name-only", ref, "docs/plans"]);
    const parentName = canonicalizeStoredPlanName(parentPlanName).name;
    const children: Array<{ name: string; path: string; attrs: ReturnType<typeof parsePlanFrontMatter>["attrs"] }> = [];
    const relativePaths = listed.split(/\r?\n/).filter(isActivePlanPath);
    const sources = await readTargetPlanMarkdowns(projectRoot, relativePaths, ref);
    for (const [relativePath, markdown] of sources) {
        const planName = relativePath.slice("docs/plans/".length, -".md".length);
        const parsed = parsePlanFrontMatter(markdown);
        if (parsed.attrs.parentPlan !== parentName) continue;
        const path = `${ref}:${relativePath}`;
        const inspected = await inspectPlanTextStrict(markdown, path, getStoredPlanPath(projectRoot, planName));
        if (inspected.kind === "malformed") throw inspected.error;
        children.push({ name: planName, path, attrs: inspected.attrs });
    }
    return children;
}

export async function findTargetBranchPlansByParent(cwd: string, targetBranch: string, parentPlanName: string) {
    return (await readTargetBranchPlansByParent(cwd, targetBranch, parentPlanName)).plans;
}

/** Display discovery isolates document failures without inferring their parent membership. */
export async function readTargetBranchPlanCatalogByParent(cwd: string, targetBranch: string, parentPlanName: string) {
    return await readTargetBranchPlansByParent(cwd, targetBranch, parentPlanName, undefined, true);
}

export async function readTargetBranchPlansByParent(
    cwd: string,
    targetBranch: string,
    parentPlanName: string,
    preparedTarget?: Awaited<ReturnType<typeof resolveExistingTargetSnapshot>>,
    display = false,
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
    const diagnostics = new Map<string, PlanDocumentDiagnostic>();
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
        for (const relativePath of new Set(listed.split("\0").filter(isActivePlanPath))) {
            if (await pathExists(join(projectRoot, relativePath))) {
                sources.set(relativePath, await fsReadFile(join(projectRoot, relativePath), "utf8"));
            }
        }
    } else if (target) {
        const listed = await runGit(projectRoot, ["ls-tree", "-r", "--name-only", target.baseRef, "docs/plans"]);
        const relativePaths = listed.split(/\r?\n/).filter(isActivePlanPath);
        for (const [path, markdown] of await readTargetPlanMarkdowns(projectRoot, relativePaths, target.baseRef)) {
            sources.set(path, markdown);
        }
    }
    for (const [relativePath, markdown] of sources) {
        const planName = relativePath.slice("docs/plans/".length, -".md".length);
        let parsed;
        try {
            parsed = parsePlanFrontMatter(markdown);
        } catch (error) {
            if (!display) throw error;
            diagnostics.set(planName, {
                name: planName,
                path: target ? `${target.baseRef}:${relativePath}` : join(projectRoot, relativePath),
                kind: "malformed",
                message: error instanceof Error ? error.message : String(error),
            });
            continue;
        }
        if (parsed.attrs.parentPlan !== parentName) continue;
        children.set(planName, {
            name: planName,
            path: target ? `${target.baseRef}:${relativePath}` : join(projectRoot, relativePath),
            attrs: parsed.attrs,
        });
    }
    for (const entry of await listControllerDocumentWorktrees(projectRoot)) {
        if (entry.documentUnavailable) continue;
        const targetPlan = children.get(entry.planName);
        let plan;
        try {
            plan = await loadPlan(entry.path, entry.planName);
        } catch (error) {
            if (!display || !(error instanceof PlanFrontMatterParseError)) throw error;
            children.delete(entry.planName);
            diagnostics.set(entry.planName, {
                name: entry.planName,
                path: error.path,
                kind: "malformed",
                message: error.cause instanceof Error ? error.cause.message : error.message,
                ...(entry.planId ? { planId: entry.planId } : {}),
            });
            continue;
        }
        if (!plan) continue;
        diagnostics.delete(entry.planName);
        if (plan.attrs.parentPlan !== parentName) {
            if (display) children.delete(entry.planName);
            continue;
        }
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
    return { plans: [...children.values()], diagnostics: [...diagnostics.values()] };
}

/** Keep identity admission locked until external checkout preparation saves its binding. */
export async function withPlanningPlanIdentity<T>(
    cwd: string,
    name: string,
    attrs: PlanningPlanAttributes,
    prepare: (planId: string) => Promise<T>,
): Promise<T> {
    return await withPlanCatalogLock(cwd, async () => {
        const registered = (await listWorktreeRegistryEntries(cwd)).find(
            (entry) => entry.planName === name && entry.status !== "abandoned",
        );
        let planId = registered?.planId;
        if (!planId) {
            const target = await prepareExistingTargetSnapshot(cwd, targetBranchForPlan(attrs));
            const plan = await loadPlanningTargetPlan(cwd, name, target.baseBranch, target.baseRef);
            if (!plan) throw new Error(`Plan ${name} does not exist on target ${target.baseBranch}.`);
            const committed = plan.attrs.planId ? null : await loadTargetPlan(cwd, name, target.baseRef);
            planId = plan.attrs.planId || committed?.attrs.planId || crypto.randomUUID();
        }
        return await prepare(planId);
    });
}

export async function assertPlanningDocumentAvailable(cwd: string, attemptId: string): Promise<void> {
    const { findById } = await import("../shared/worktree-registry.js");
    const entry = await findById(cwd, attemptId);
    if (!entry) throw new Error("Planning execution is no longer registered.");
    const [checked] = await inspectControllerDocumentWorktrees(cwd, [entry]);
    assertControllerDocumentAvailable(checked);
}

export async function bindPlanningDocument(
    cwd: string,
    name: string,
    planId: string,
    attemptId: string,
): Promise<void> {
    const { findById } = await import("../shared/worktree-registry.js");
    const entry = await findById(cwd, attemptId);
    if (!entry || entry.planId !== planId || entry.planName !== name || entry.status !== "planning")
        throw new Error("Planning document execution identity changed.");
    await assertPlanningDocumentAvailable(cwd, attemptId);
    await writeControllerState(cwd, { planName: name, planId }, { documentWorktreeId: attemptId });
}

export interface PlanningDocumentCopy {
    projectRoot: string;
    executionCwd: string;
    planName: string;
    planId: string;
    baseBranch: string;
    baseRef: string;
}
/** Select and validate the retained source, then install only its Plan document. */
export async function installPlanningDocument(options: PlanningDocumentCopy) {
    const { projectRoot, executionCwd, planName, planId, baseBranch, baseRef } = options;
    const targetPlan = await loadPlanningTargetPlan(projectRoot, planName, baseBranch, baseRef);
    if (!targetPlan || (targetPlan.attrs.planId && targetPlan.attrs.planId !== planId))
        throw new Error(`Target Plan ${planName} is missing or has a different Plan ID.`);
    const localTarget = await isPrimaryTargetCheckout(projectRoot, baseBranch);
    if (localTarget) {
        const committed = await loadTargetPlan(projectRoot, planName, baseRef);
        if (committed?.attrs.planId && committed.attrs.planId !== planId)
            throw new Error(`Target Plan ${planName} has a different Plan ID. Your files were not changed.`);
    }
    const canonical = targetPlan.attrs.planId
        ? targetPlan
        : {
              ...targetPlan,
              attrs: { ...targetPlan.attrs, planId },
              markdown: mergeFrontMatterText(targetPlan.markdown, { planId }),
          };
    return await ensureExecutionPlanFile({
        executionCwd,
        planName,
        canonicalSource: loadedCanonicalSource(planName, canonical),
        reconcileFromCanonical: !targetPlan.attrs.planId,
        replaceFromCanonical: localTarget,
    });
}

/** Refuse an identity replacement before checkout creation has any external effects. */
export async function loadPlanningTargetForPreparation(cwd: string, name: string, branch: string, baseRef: string) {
    const plan = await loadPlanningTargetPlan(cwd, name, branch, baseRef);
    if (plan && (await isPrimaryTargetCheckout(cwd, branch))) {
        const committed = await loadTargetPlan(cwd, name, baseRef);
        if (committed?.attrs.planId && plan.attrs.planId && committed.attrs.planId !== plan.attrs.planId)
            throw new Error(`Target Plan ${name} has a different Plan ID. Your files were not changed.`);
    }
    return plan;
}
