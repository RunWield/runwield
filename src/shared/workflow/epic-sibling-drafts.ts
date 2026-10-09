/**
 * @module shared/workflow/epic-sibling-drafts
 * Scope moves between Epic children.
 *
 * While planning one child, Planner may reshape any sibling that has not
 * started: move scope into it, out of it, or add a new draft. Those edits are
 * made in the child's worktree and travel to the Epic branch with the child.
 * This module carries them into the child's preparation commit and returns an
 * edited sibling that was already approved to `draft`, so its own Planner
 * session can reshape it again. A started or finished sibling stays as it is.
 */

import {
    injectFrontMatter,
    loadPlan,
    parsePlanFrontMatter,
    planDocumentMarkdown,
    savePlan,
    updatePlanFrontMatter,
    withPlanCatalogLock,
    withPlanLock,
} from "../../plan-store.js";
import { join } from "@std/path";
import type { PlanFrontMatter } from "../../plan-store.js";
import { EPIC_ARTIFACT_FILE_NAMES } from "../epic-artifacts.ts";
import { resolvePrimaryCheckoutRoot } from "../primary-checkout.ts";
import { buildPlanEventUpdates } from "./plan-lifecycle.js";
import { listControllerDocumentWorktrees } from "./controller-registry.ts";

/** Sibling statuses Planner may still reshape. */
const RESHAPEABLE_STATUSES = new Set(["draft", "feedback", "approved", "ready_for_work"]);
/** Reshaped siblings in these statuses go back to draft: their approval covered different scope. */
const APPROVED_STATUSES = new Set(["approved", "ready_for_work"]);

interface GitResult {
    success: boolean;
    code: number;
    stdout: string;
    stderr: string;
}

async function runGitResult(cwd: string, args: string[]): Promise<GitResult> {
    const output = await new Deno.Command("git", { cwd, args, stdout: "piped", stderr: "piped" }).output();
    const decoder = new TextDecoder();
    return {
        success: output.success,
        code: output.code,
        stdout: decoder.decode(output.stdout),
        stderr: decoder.decode(output.stderr),
    };
}

/** Changed paths in the worktree, including untracked files, relative to its root. */
async function changedPaths(worktreePath: string): Promise<string[]> {
    const status = await runGitResult(worktreePath, ["status", "--porcelain", "-z", "--untracked-files=all"]);
    if (!status.success) return [];
    const entries = status.stdout.split("\0").filter(Boolean);
    const paths: string[] = [];
    for (let index = 0; index < entries.length; index++) {
        const entry = entries[index];
        const code = entry.slice(0, 2);
        paths.push(entry.slice(3));
        // A rename lists its source path as the next entry.
        if (code.includes("R") || code.includes("C")) index++;
    }
    return paths;
}

/** Compare planning content independently of lifecycle state and legacy formatting. */
function scopeMarkdown(markdown: string): string {
    return planDocumentMarkdown(injectFrontMatter(markdown, { status: "draft", userVerifiedAt: null }));
}

async function mergeSiblingScope(cwd: string, name: string, current: string, base: string, incoming: string) {
    if (current === base || current === incoming) return incoming;
    if (incoming === base) return current;
    const directory = await Deno.makeTempDir({ prefix: "runwield-sibling-scope-" });
    try {
        const paths = ["current", "base", "incoming"].map((name) => join(directory, name));
        await Promise.all(paths.map((path, index) => Deno.writeTextFile(path, [current, base, incoming][index])));
        const merged = await runGitResult(cwd, ["merge-file", "-p", ...paths]);
        if (merged.code > 127) throw new Error(`Cannot reconcile ${name}: ${merged.stderr.trim()}`);
        if (!merged.success) {
            throw new Error(
                `${name} has conflicting scope changes from two planning sessions. ` +
                    "Both versions are preserved. Review which requirements this sibling should implement before proceeding.",
            );
        }
        return merged.stdout;
    } finally {
        await Deno.remove(directory, { recursive: true });
    }
}

async function resetReshapedApproval(cwd: string, name: string) {
    const plan = await loadPlan(cwd, name);
    if (!plan || !APPROVED_STATUSES.has(String(plan.attrs.status))) return;
    const updates = buildPlanEventUpdates("manual_status_change", plan.attrs.status, {
        triageMeta: plan.attrs as Partial<PlanFrontMatter>,
        manualTargetStatus: "draft",
    });
    await updatePlanFrontMatter(cwd, name, updates, plan.attrs, { expectedRevision: plan.revision });
}

/**
 * Prepare sibling Plans that Planner edited in this child's worktree.
 *
 * Returns the sibling Plan paths to include in the preparation commit. Throws,
 * before anything is committed, when scope conflicts or a sibling has started.
 * Registered, unstarted siblings are reconciled under their own Plan lock.
 */
export async function prepareEditedSiblingPlans(
    worktreePath: string,
    planName: string,
    planRelativePath: string,
): Promise<string[]> {
    const plan = await loadPlan(worktreePath, planName);
    const epicPlanName = typeof plan?.attrs.parentPlan === "string" ? plan.attrs.parentPlan.trim() : "";
    if (!epicPlanName) return [];
    const prefix = `docs/plans/${epicPlanName}/`;
    const siblingPaths = (await changedPaths(worktreePath)).filter((path) =>
        path.startsWith(prefix) && path.endsWith(".md") && path !== planRelativePath &&
        !path.slice(prefix.length).includes("/") && !EPIC_ARTIFACT_FILE_NAMES.includes(path.slice(prefix.length))
    );
    if (siblingPaths.length === 0) return [];

    const registered = await listControllerDocumentWorktrees(resolvePrimaryCheckoutRoot(worktreePath));
    for (const path of siblingPaths) {
        const siblingName = path.slice("docs/plans/".length, -".md".length);
        const committed = await runGitResult(worktreePath, ["show", `HEAD:${path}`]);
        const before = committed.success ? parsePlanFrontMatter(committed.stdout).attrs : null;
        // A new draft Planner split out of this child starts as a draft of its own.
        if (!before) continue;
        const sibling = await loadPlan(worktreePath, siblingName);
        if (!sibling) continue;
        const base = scopeMarkdown(committed.stdout);
        const incoming = scopeMarkdown(sibling.markdown);
        // Reading old Plans can normalize their metadata without changing scope.
        if (incoming === base) continue;
        const authority = registered.find((entry) => entry.planName === siblingName);
        const authorityRoot = authority?.path || worktreePath;
        const synchronized = await withPlanCatalogLock(
            authorityRoot,
            () =>
                withPlanLock(authorityRoot, siblingName, async () => {
                    const authoritative = await loadPlan(authorityRoot, siblingName);
                    if (!authoritative || authoritative.attrs.planId !== sibling.attrs.planId) {
                        throw new Error(
                            `Cannot confirm the authoritative Plan identity for ${siblingName}. Both copies are preserved.`,
                        );
                    }
                    const sameWorktree = await Deno.realPath(authorityRoot) === await Deno.realPath(worktreePath);
                    const currentScope = scopeMarkdown(authoritative.markdown);
                    // A previous attempt may already have synchronized this scope and the
                    // sibling may since have started. Refresh the copy without reshaping it.
                    if (!sameWorktree && currentScope === incoming) {
                        return authoritative.markdown;
                    }
                    if (!RESHAPEABLE_STATUSES.has(String(authoritative.attrs.status))) {
                        throw new Error(
                            `${siblingName} has already started (${authoritative.attrs.status}), so its Plan stays as it is. ` +
                                `Undo the edit to ${path} and put that work in a new child instead.`,
                        );
                    }
                    const merged = await mergeSiblingScope(
                        worktreePath,
                        siblingName,
                        currentScope,
                        base,
                        incoming,
                    );
                    await savePlan(authorityRoot, siblingName, merged, { status: authoritative.attrs.status }, {
                        expectedRevision: authoritative.revision,
                    });
                    // A retry must not revoke a new approval of scope already synchronized
                    // into the authoritative worktree since the previous preparation.
                    if (sameWorktree || merged !== currentScope) {
                        await resetReshapedApproval(authorityRoot, siblingName);
                    }
                    if (!sameWorktree) {
                        const settled = await loadPlan(authorityRoot, siblingName);
                        if (!settled) throw new Error(`Plan disappeared while synchronizing ${siblingName}.`);
                        return settled.markdown;
                    }
                }),
        );
        // Never hold one worktree's Plan lock while acquiring another's.
        if (synchronized !== undefined) {
            await savePlan(worktreePath, siblingName, synchronized, {}, { expectedRevision: sibling.revision });
        }
    }
    return siblingPaths;
}
