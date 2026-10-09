/**
 * @module shared/workflow/epic-branch
 * Every Epic starts and ends on its own branch. This module names that branch,
 * creates it from the latest primary branch when the Epic first needs it, and
 * puts the Epic's child drafts on it so children can plan and run from it.
 *
 * Nothing here checks out, resets, or writes the user's working tree. The seed
 * commit is built with Git plumbing and the branch moves only by
 * compare-and-swap.
 */

import { join, relative } from "@std/path";
import {
    ensurePlanIdentity,
    findPlansByParent,
    loadPlan,
    parsePlanFrontMatter,
    updatePlanFrontMatter,
} from "../../plan-store.js";
import type { PlanFrontMatter } from "../../plan-store.js";
import { isPlannedChangeClassification } from "../../constants.js";
import { projectPlanType } from "../project-plan.ts";
import { isGitRepository } from "../git.ts";
import { prepareTargetBranchRef, resolveTargetBranchName } from "../worktree.js";
import { resolvePrimaryCheckoutRoot } from "../primary-checkout.ts";
import { resolveWorkflowPlanLocation } from "./plan-location.ts";
import { listControllerDocumentWorktrees } from "./controller-registry.ts";
import { listEntries as listWorktreeRegistryEntries } from "../worktree-registry.js";

/** Prefix for the branch RunWield names for an Epic when the author did not choose one. */
export const EPIC_BRANCH_PREFIX = "epic/";

/** Child statuses that mean no execution has started, so the Epic can still adopt a branch. */
const UNSTARTED_CHILD_STATUSES = new Set(["draft", "feedback", "approved", "ready_for_work"]);

/** What `ensureEpicBranch` did. */
export interface EpicBranchState {
    kind: "none" | "ready";
    /** The Epic branch name, when the Epic has one. */
    branch?: string;
    /** Whether RunWield created the branch during this call. */
    created?: boolean;
    /** Child Plans RunWield added to the Epic branch during this call. */
    seededChildren?: string[];
    /** Why the Epic has no branch to prepare. */
    reason?:
        | "not_git"
        | "not_epic"
        | "missing"
        | "started_without_branch"
        | "branch_unavailable"
        | "sequence_without_branch";
    /** Why a default branch could not be created. */
    error?: string;
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

interface GitResult {
    success: boolean;
    stdout: string;
    stderr: string;
}

async function runGitResult(cwd: string, args: string[], env?: Record<string, string>): Promise<GitResult> {
    const output = await new Deno.Command("git", { cwd, args, env, stdout: "piped", stderr: "piped" }).output();
    return {
        success: output.success,
        stdout: new TextDecoder().decode(output.stdout),
        stderr: new TextDecoder().decode(output.stderr),
    };
}

async function runGit(cwd: string, args: string[], env?: Record<string, string>): Promise<string> {
    const result = await runGitResult(cwd, args, env);
    if (!result.success) throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`.trim());
    return result.stdout;
}

/** The branch RunWield gives an Epic whose author did not choose one: `epic/<epic-name>`. */
export function defaultEpicBranchName(epicPlanName: string): string {
    const name = epicPlanName.trim().replace(/\.md$/, "").split("/").filter(Boolean).at(-1) || "";
    const slug = name.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
    if (!slug) throw new Error(`Cannot name an Epic branch for ${epicPlanName}.`);
    return `${EPIC_BRANCH_PREFIX}${slug}`;
}

function epicTargetBranch(attrs: Partial<PlanFrontMatter>): string {
    return typeof attrs.targetBranch === "string" ? attrs.targetBranch.trim() : "";
}

function isProjectEpic(attrs: Partial<PlanFrontMatter> | undefined): boolean {
    return attrs?.classification === "PROJECT";
}

function isSequenceEpic(attrs: Partial<PlanFrontMatter>): boolean {
    try {
        return projectPlanType(attrs) === "sequence";
    } catch {
        return false;
    }
}

/**
 * Whether an Epic without a branch can still adopt one: no child has started,
 * so no child has delivered anywhere a branch would contradict.
 */
async function canAdoptEpicBranch(
    primaryRoot: string,
    children: Array<{ name: string; attrs: PlanFrontMatter }>,
): Promise<boolean> {
    if (children.some((child) => !UNSTARTED_CHILD_STATUSES.has(child.attrs.status) || child.attrs.deliveryEvidence)) {
        return false;
    }
    const childIds = new Set(children.map((child) => child.attrs.planId).filter(Boolean));
    const attempts = await listWorktreeRegistryEntries(primaryRoot);
    return !attempts.some((entry: { planId?: string }) => entry.planId && childIds.has(entry.planId));
}

/** Record an existing default Epic branch on an unstarted Epic and its children. */
async function adoptDefaultEpicBranch(
    documentRoot: string,
    epicPlanName: string,
    branch: string,
    children: Array<{ name: string; attrs: PlanFrontMatter }>,
): Promise<void> {
    const epic = await loadPlan(documentRoot, epicPlanName);
    if (!epic) throw new Error(`Epic not found: ${epicPlanName}`);
    if (!epicTargetBranch(epic.attrs)) {
        await updatePlanFrontMatter(documentRoot, epicPlanName, { targetBranch: branch }, epic.attrs, {
            expectedRevision: epic.revision,
        });
    }
    await inheritEpicBranch(documentRoot, branch, children);
}

/** Give unstarted children without a branch of their own the Epic branch. */
async function inheritEpicBranch(
    documentRoot: string,
    branch: string,
    children: Array<{ name: string; attrs: PlanFrontMatter }>,
): Promise<void> {
    for (const child of children) {
        if (!UNSTARTED_CHILD_STATUSES.has(child.attrs.status)) continue;
        if (epicTargetBranch(child.attrs)) continue;
        const current = await loadPlan(documentRoot, child.name);
        if (!current || epicTargetBranch(current.attrs)) continue;
        await updatePlanFrontMatter(documentRoot, child.name, { targetBranch: branch }, current.attrs, {
            expectedRevision: current.revision,
        });
    }
}

async function remoteExists(primaryRoot: string): Promise<boolean> {
    return (await runGitResult(primaryRoot, ["remote", "get-url", "origin"])).success;
}

async function refCommit(primaryRoot: string, ref: string): Promise<string | null> {
    const result = await runGitResult(primaryRoot, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
    return result.success ? result.stdout.trim() : null;
}

/** Whether a local branch exists locally or on origin, refreshing the remote ref. */
async function epicBranchExists(primaryRoot: string, branch: string): Promise<boolean> {
    if (await remoteExists(primaryRoot)) {
        const fetched = await runGitResult(primaryRoot, [
            "fetch",
            "origin",
            `+refs/heads/${branch}:refs/remotes/origin/${branch}`,
        ]);
        if (fetched.success) return true;
        if (!fetched.stderr.includes("couldn't find remote ref")) {
            throw new Error(`Could not refresh Epic branch origin/${branch}: ${fetched.stderr || fetched.stdout}`);
        }
    }
    return Boolean(await refCommit(primaryRoot, `refs/heads/${branch}`));
}

/** The checkout that has `branch` checked out, if any. */
async function checkoutForBranch(primaryRoot: string, branch: string): Promise<string | null> {
    const listing = await runGit(primaryRoot, ["worktree", "list", "--porcelain"]);
    let path = "";
    for (const line of listing.split(/\r?\n/)) {
        if (line.startsWith("worktree ")) path = line.slice("worktree ".length);
        if (line === `branch refs/heads/${branch}`) return path;
    }
    return null;
}

/**
 * The ref that holds the Epic's published state: origin's copy when the branch
 * is on origin, otherwise the local branch. This matches how child planning and
 * continuation read the Epic family.
 */
async function canonicalEpicRef(primaryRoot: string, branch: string): Promise<{ ref: string; remote: boolean }> {
    if (await refCommit(primaryRoot, `refs/remotes/origin/${branch}`)) {
        return { ref: `refs/remotes/origin/${branch}`, remote: true };
    }
    return { ref: `refs/heads/${branch}`, remote: false };
}

async function plansOnRef(primaryRoot: string, ref: string, epicPlanName: string): Promise<Set<string>> {
    const listing = await runGit(primaryRoot, ["ls-tree", "-r", "--name-only", ref, `docs/plans/${epicPlanName}`]);
    const onRef = new Set<string>();
    for (const relativePath of listing.split(/\r?\n/).filter((line) => line.endsWith(".md"))) {
        // A draft committed before RunWield gave it an identity is not yet adopted work; the identified copy replaces it.
        const text = await runGitResult(primaryRoot, ["show", `${ref}:${relativePath}`]);
        const attrs = text.success ? parsePlanFrontMatter(text.stdout).attrs : null;
        if (attrs && !attrs.planId && UNSTARTED_CHILD_STATUSES.has(attrs.status)) continue;
        onRef.add(relativePath);
    }
    return onRef;
}

/**
 * Commit child drafts onto the Epic branch without touching any working tree.
 * Existing documents on the branch are never replaced: the branch copy of a
 * child is the authority once it is there.
 */
async function seedEpicChildren(
    primaryRoot: string,
    documentRoot: string,
    epicPlanName: string,
    branch: string,
    children: Array<{ name: string; path: string; attrs: PlanFrontMatter }>,
): Promise<string[]> {
    const { ref, remote } = await canonicalEpicRef(primaryRoot, branch);
    const head = await refCommit(primaryRoot, ref);
    if (!head) throw new Error(`Epic branch ${branch} has no commit to add child drafts to.`);
    const onBranch = await plansOnRef(primaryRoot, ref, epicPlanName);
    const pending = children.filter((child) => {
        const relativePath = relative(documentRoot, child.path).replaceAll("\\", "/");
        return !onBranch.has(relativePath) && epicTargetBranch(child.attrs) === branch;
    });
    if (pending.length === 0) return [];

    const checkout = await checkoutForBranch(primaryRoot, branch);
    if (checkout) {
        throw new Error(
            `Epic branch ${branch} is checked out at ${checkout}, so RunWield cannot add the child drafts to it ` +
                `without changing that checkout. Switch that checkout to another branch and load the Epic again.`,
        );
    }

    const indexDir = await Deno.makeTempDir({ prefix: "wld-epic-seed-" });
    try {
        const env = { GIT_INDEX_FILE: join(indexDir, "index") };
        await runGit(primaryRoot, ["read-tree", head], env);
        for (const child of pending) {
            const relativePath = relative(documentRoot, child.path).replaceAll("\\", "/");
            const blob = (await runGit(primaryRoot, ["hash-object", "-w", "--path", relativePath, child.path])).trim();
            await runGit(primaryRoot, ["update-index", "--add", "--cacheinfo", `100644,${blob},${relativePath}`], env);
        }
        const tree = (await runGit(primaryRoot, ["write-tree"], env)).trim();
        const message = `Add ${epicPlanName} child drafts to the Epic branch\n\n${
            pending.map((child) => `- ${child.name}`).join("\n")
        }\n`;
        const commit = (await runGit(primaryRoot, ["commit-tree", tree, "-p", head, "-m", message])).trim();
        if (remote) {
            // Origin holds the Epic family; a plain push fails rather than overwriting work published meanwhile.
            await runGit(primaryRoot, ["push", "origin", `${commit}:refs/heads/${branch}`]);
            // Push normally advances the tracking ref itself. Only settle it
            // explicitly when it still holds the old head; never rewind a newer fetch.
            if (await refCommit(primaryRoot, `refs/remotes/origin/${branch}`) === head) {
                await runGit(primaryRoot, ["update-ref", `refs/remotes/origin/${branch}`, commit, head]);
            }
            const local = await refCommit(primaryRoot, `refs/heads/${branch}`);
            if (local === head) await runGit(primaryRoot, ["update-ref", `refs/heads/${branch}`, commit, head]);
        } else {
            await runGit(primaryRoot, ["update-ref", `refs/heads/${branch}`, commit, head]);
        }
    } finally {
        await Deno.remove(indexDir, { recursive: true }).catch(() => {});
    }
    return pending.map((child) => child.name);
}

/** Child drafts the Epic owns in its document checkout, excluding those already registered elsewhere. */
async function localEpicChildren(primaryRoot: string, documentRoot: string, epicPlanName: string) {
    const registered = new Set((await listControllerDocumentWorktrees(primaryRoot)).map((entry) => entry.planName));
    const children = [];
    for (const child of await findPlansByParent(documentRoot, epicPlanName)) {
        if (!isPlannedChangeClassification(child.attrs.classification) || registered.has(child.name)) continue;
        // The catalog can report a branch copy; the Epic's own draft is the local document.
        const local = child.path.includes(":docs/plans/") ? await loadPlan(documentRoot, child.name) : child;
        if (local && !local.path.includes(":docs/plans/")) {
            children.push({ name: child.name, path: local.path, attrs: local.attrs });
        }
    }
    return children;
}

/**
 * Make sure an Epic has its branch and that its child drafts are on it.
 *
 * - An unstarted Epic without a branch gets `epic/<epic-name>`; an Epic whose
 *   children already started without one keeps the legacy behavior. A Sequence
 *   gets a branch only when the user named one.
 * - A missing branch is created from the latest primary branch and its starting
 *   commit is recorded as `epicBaseCommit`. An existing branch is used as it is.
 * - Child drafts missing from the branch are committed onto it.
 */
export async function ensureEpicBranch(projectRoot: string, epicPlanName: string): Promise<EpicBranchState> {
    if (!await isGitRepository(projectRoot)) return { kind: "none", reason: "not_git" };
    const primaryRoot = resolvePrimaryCheckoutRoot(projectRoot);
    const location = await resolveWorkflowPlanLocation(primaryRoot, epicPlanName);
    const epic = location.plan;
    if (!epic) return { kind: "none", reason: "missing" };
    if (!isProjectEpic(epic.attrs)) return { kind: "none", reason: "not_epic" };
    const documentRoot = location.documentRoot;

    let children = await localEpicChildren(primaryRoot, documentRoot, epicPlanName);
    const namedBranch = epicTargetBranch(epic.attrs);
    // Sequences are lightweight on purpose: they get a branch only when the user asks for one.
    if (!namedBranch && isSequenceEpic(epic.attrs)) return { kind: "none", reason: "sequence_without_branch" };
    if (!namedBranch && !await canAdoptEpicBranch(primaryRoot, children)) {
        return { kind: "none", reason: "started_without_branch" };
    }
    const branch = await resolveTargetBranchName(primaryRoot, namedBranch || defaultEpicBranchName(epicPlanName));

    // Create the branch before recording anything, so a failure never leaves the
    // Epic pointing at a branch that does not exist.
    let created = false;
    if (!await epicBranchExists(primaryRoot, branch)) {
        try {
            await prepareTargetBranchRef(primaryRoot, branch);
        } catch (error) {
            // An Epic nobody named a branch for keeps working as it did; a named one cannot.
            if (namedBranch) throw error;
            return { kind: "none", reason: "branch_unavailable", error: errorMessage(error) };
        }
        created = true;
    }

    if (!namedBranch) {
        await adoptDefaultEpicBranch(documentRoot, epicPlanName, branch, children);
        children = await localEpicChildren(primaryRoot, documentRoot, epicPlanName);
    }
    if (created) {
        const baseCommit = await refCommit(primaryRoot, `refs/heads/${branch}`);
        const current = await loadPlan(documentRoot, epicPlanName);
        if (baseCommit && current && !current.attrs.epicBaseCommit) {
            await updatePlanFrontMatter(documentRoot, epicPlanName, { epicBaseCommit: baseCommit }, current.attrs, {
                expectedRevision: current.revision,
            });
        }
    }

    // Children are found on the Epic branch by Plan ID, so every draft needs one before it goes there.
    if (children.some((child) => !child.attrs.planId)) {
        for (const child of children.filter((candidate) => !candidate.attrs.planId)) {
            await ensurePlanIdentity(documentRoot, child.name);
        }
        children = await localEpicChildren(primaryRoot, documentRoot, epicPlanName);
    }
    const seededChildren = await seedEpicChildren(primaryRoot, documentRoot, epicPlanName, branch, children);
    return { kind: "ready", branch, created, seededChildren };
}
