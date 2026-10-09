/** Import published code before resuming an unstarted child's planning checkout. */
import { join } from "@std/path";
import { injectFrontMatter, parsePlanFrontMatter, planDocumentMarkdown } from "../../plan-store.js";
import { gitStatusPaths } from "../git-runtime-safety.ts";
import { isRunWieldOwnedRuntimePath } from "../runwield-owned-paths.ts";
import { checkpointExecutionPreparation, hasExecutionChangesSince } from "../worktree.js";
import { findById, refreshPlanningWorktreeBase, type WorktreeRegistryEntry } from "../worktree-registry.js";
import { runExecutionPreparationTransition } from "./state-transition.ts";

async function git(cwd: string, args: string[]) {
    const result = await new Deno.Command("git", { cwd, args, stdout: "piped", stderr: "piped" }).output();
    const stdout = new TextDecoder().decode(result.stdout);
    if (!result.success) throw new Error(`git ${args.join(" ")} failed: ${new TextDecoder().decode(result.stderr)}`);
    return stdout;
}

async function readPlanAt(cwd: string, ref: string, path: string) {
    const result = await new Deno.Command("git", {
        cwd,
        args: ["show", `${ref}:${path}`],
        stdout: "piped",
        stderr: "piped",
    }).output();
    return result.success ? new TextDecoder().decode(result.stdout) : null;
}

/** Merge scope normally, while lifecycle state comes from the document's owner. */
async function mergePlanningDocument(
    cwd: string,
    path: string,
    base: string,
    current: string,
    incoming: string,
    own: boolean,
) {
    const baseAttrs = parsePlanFrontMatter(base).attrs;
    const currentAttrs = parsePlanFrontMatter(current).attrs;
    const incomingAttrs = parsePlanFrontMatter(incoming).attrs;
    if (currentAttrs.planId !== incomingAttrs.planId) {
        throw new Error(`Cannot refresh ${path}: the published Plan has a different identity.`);
    }
    const lifecycle = own || incomingAttrs.status === baseAttrs.status ? currentAttrs : incomingAttrs;
    const overrides = { status: lifecycle.status, userVerifiedAt: lifecycle.userVerifiedAt };
    const versions = [current, base, incoming].map((text) => planDocumentMarkdown(injectFrontMatter(text, overrides)));
    const scratch = await Deno.makeTempDir({ prefix: "runwield-planning-merge-" });
    try {
        const paths = ["current", "base", "incoming"].map((name) => join(scratch, name));
        await Promise.all(paths.map((path, index) => Deno.writeTextFile(path, versions[index])));
        const result = await new Deno.Command("git", {
            cwd,
            args: ["merge-file", "-p", ...paths],
            stdout: "piped",
            stderr: "piped",
        }).output();
        if (!result.success) {
            throw new Error(
                `Cannot refresh ${path}: planning scope conflicts with published changes. Both versions are preserved.`,
            );
        }
        return new TextDecoder().decode(result.stdout);
    } finally {
        await Deno.remove(scratch, { recursive: true });
    }
}

export async function refreshPlanningWorktree(projectRoot: string, entry: WorktreeRegistryEntry, targetCommit: string) {
    if (entry.baseCommit === targetCommit) return entry;
    const transition = await runExecutionPreparationTransition({
        projectRoot: entry.path,
        planName: entry.planName,
        planId: entry.planId,
        worktreeId: entry.id,
        targetRef: entry.baseBranch,
        expectedPlanEvent: false,
        prepare: async ({ markEffect }) => {
            const currentEntry = await findById(projectRoot, entry.id);
            if (!currentEntry) throw new Error(`Planning worktree is no longer registered: ${entry.id}`);
            if (currentEntry.status !== "planning" || currentEntry.baseCommit === targetCommit) return currentEntry;
            entry = currentEntry;
            const branch = (await git(entry.path, ["branch", "--show-current"])).trim();
            if (branch !== entry.branch) throw new Error(`Planning worktree is no longer on ${entry.branch}.`);
            const pendingMerge = await new Deno.Command("git", {
                cwd: entry.path,
                args: ["rev-parse", "--verify", "--quiet", "MERGE_HEAD"],
                stdout: "null",
                stderr: "null",
            }).output();
            if (pendingMerge.success) throw new Error(`Planning worktree has an unfinished merge: ${entry.path}`);
            const newerBase = await new Deno.Command("git", {
                cwd: entry.path,
                args: ["merge-base", "--is-ancestor", targetCommit, entry.baseCommit],
                stdout: "null",
                stderr: "null",
            }).output();
            if (newerBase.success) return entry;
            // On retry the merge may already be durable while registry settlement
            // is pending. Published code is never mistaken for child implementation.
            const importedBase = (await git(entry.path, ["merge-base", "HEAD", targetCommit])).trim();
            if (
                await hasExecutionChangesSince({
                    worktreePath: entry.path,
                    baseRef: importedBase,
                    includeWorkingTree: true,
                })
            ) {
                throw new Error(
                    `Cannot refresh planning for ${entry.planName}: this worktree already contains implementation changes.`,
                );
            }
            // Status normalization and saved planning edits are preparation, not
            // user implementation. Checkpoint them before importing publication.
            const dirty = (await gitStatusPaths(entry.path)).filter((path) => !isRunWieldOwnedRuntimePath(path));
            if (dirty.length) {
                await checkpointExecutionPreparation({
                    worktreePath: entry.path,
                    branch: entry.branch,
                    baseCommit: importedBase,
                    planName: entry.planName,
                    planRelativePath: `docs/plans/${entry.planName}.md`,
                });
            }
            const head = (await git(entry.path, ["rev-parse", "HEAD"])).trim();
            const base = (await git(entry.path, ["merge-base", head, targetCommit])).trim();
            const changed = (await git(entry.path, ["diff", "--name-only", "-z", base, head, "--", "docs/plans"]))
                .split("\0").filter((path) => path.endsWith(".md"));
            const documents = new Map<string, string>();
            for (const path of changed) {
                const original = await readPlanAt(entry.path, base, path);
                const current = await readPlanAt(entry.path, head, path);
                const incoming = await readPlanAt(entry.path, targetCommit, path);
                if (original && current && incoming) {
                    documents.set(
                        path,
                        await mergePlanningDocument(
                            entry.path,
                            path,
                            original,
                            current,
                            incoming,
                            path === `docs/plans/${entry.planName}.md`,
                        ),
                    );
                }
            }
            // No autostash: all saved preparation is now durable, and a failed
            // merge can be aborted without losing it or touching the primary checkout.
            if (base !== targetCommit) {
                try {
                    const merged = await new Deno.Command("git", {
                        cwd: entry.path,
                        args: [
                            "merge",
                            "--no-ff",
                            "--no-squash",
                            "--no-commit",
                            "--no-autostash",
                            "--no-overwrite-ignore",
                            targetCommit,
                        ],
                        stdout: "piped",
                        stderr: "piped",
                    }).output();
                    const conflicts = (await git(entry.path, ["diff", "--name-only", "-z", "--diff-filter=U"]))
                        .split("\0").filter(Boolean);
                    if ((!merged.success && !conflicts.length) || conflicts.some((path) => !documents.has(path))) {
                        throw new Error(
                            `Cannot refresh planning for ${entry.planName}: ${new TextDecoder().decode(merged.stderr)}`,
                        );
                    }
                    for (const [path, markdown] of documents) {
                        await Deno.writeTextFile(join(entry.path, path), markdown);
                        await git(entry.path, ["add", "--", path]);
                    }
                    await git(entry.path, ["commit", "-m", `Refresh ${entry.planName} from ${entry.baseBranch}`]);
                } catch (error) {
                    await git(entry.path, ["merge", "--abort"]).catch(() => {});
                    throw error;
                }
            }
            const updated = await refreshPlanningWorktreeBase(projectRoot, entry.id, entry.baseCommit, {
                baseRef: targetCommit,
                baseCommit: targetCommit,
                baseTree: (await git(entry.path, ["rev-parse", `${targetCommit}^{tree}`])).trim(),
            });
            await markEffect("planning_target_refreshed", { worktreeId: entry.id, baseCommit: targetCommit });
            return updated;
        },
    });
    if (transition.status !== "committed") {
        throw new Error(transition.message || `Cannot refresh planning for ${entry.planName}.`);
    }
    return transition.value as WorktreeRegistryEntry;
}
