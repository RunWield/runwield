import { tmpdir } from "node:os";
import { mkdtemp } from "node:fs/promises";
import { captureForegroundProcess, type CapturedProcessOptions } from "../captured-process.ts";
import { rm as fsRm, writeFile as fsWriteFile } from "node:fs/promises";
/** Import published code before resuming an unstarted child's planning checkout. */
import { join } from "node:path";
import { injectFrontMatter, parsePlanFrontMatter, planDocumentMarkdown } from "../../plan-store.js";
import { gitStatusPaths } from "../git-runtime-safety.ts";
import { isRunWieldOwnedRuntimePath } from "../runwield-owned-paths.ts";
import {
    checkpointExecutionPreparation,
    hasExecutionChangesSince,
    PLANNING_CHECKPOINT_GIT_OPTIONS,
} from "../worktree.js";
import { findById, refreshPlanningWorktreeBase, type WorktreeRegistryEntry } from "../worktree-registry.js";
import { runExecutionPreparationTransition } from "./state-transition.ts";
import { healSettledTransitionRecords } from "./transition-recovery.ts";
import { isTransferredProjectContext, recordedProjectContextPaths } from "../worktree-project-context.ts";

async function git(cwd: string, args: string[], options: Pick<CapturedProcessOptions, "env" | "stdinText"> = {}) {
    const result = await captureForegroundProcess("git", { cwd, args, ...options });
    const stdout = new TextDecoder().decode(result.stdout);
    if (!result.success) throw new Error(`git ${args.join(" ")} failed: ${new TextDecoder().decode(result.stderr)}`);
    return stdout;
}

async function readPlanAt(cwd: string, ref: string, path: string) {
    const result = await captureForegroundProcess("git", { cwd, args: ["show", `${ref}:${path}`] });
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
    const locallyAssignedIdentity = own && !baseAttrs.planId && !incomingAttrs.planId;
    if (currentAttrs.planId !== incomingAttrs.planId && !locallyAssignedIdentity) {
        throw new Error(`Cannot refresh ${path}: the published Plan has a different identity.`);
    }
    const lifecycle = own || incomingAttrs.status === baseAttrs.status ? currentAttrs : incomingAttrs;
    const overrides = {
        ...(locallyAssignedIdentity ? { planId: currentAttrs.planId } : {}),
        status: lifecycle.status,
        userVerifiedAt: lifecycle.userVerifiedAt,
    };
    const versions = [current, base, incoming].map((text) => planDocumentMarkdown(injectFrontMatter(text, overrides)));
    const scratch = await mkdtemp(join(tmpdir(), "runwield-planning-merge-"));
    try {
        const paths = ["current", "base", "incoming"].map((name) => join(scratch, name));
        await Promise.all(paths.map((path, index) => fsWriteFile(path, versions[index])));
        const result = await captureForegroundProcess("git", { cwd, args: ["merge-file", "-p", ...paths] });
        if (!result.success) {
            throw new Error(
                `Cannot refresh ${path}: planning scope conflicts with published changes. Both versions are preserved.`,
            );
        }
        return new TextDecoder().decode(result.stdout);
    } finally {
        await fsRm(scratch, { recursive: true });
    }
}

async function isAncestor(cwd: string, ancestor: string, descendant: string) {
    const result = await captureForegroundProcess("git", {
        cwd,
        args: ["merge-base", "--is-ancestor", ancestor, descendant],
    });
    if (result.code === 0) return true;
    if (result.code === 1) return false;
    throw new Error(`Could not check planning branch history: ${new TextDecoder().decode(result.stderr)}`);
}

/** Build the complete replacement before touching HEAD, the real index, or saved files. */
async function buildReplantedCommit(entry: WorktreeRegistryEntry, target: string, dirty: string[]) {
    const scratch = await mkdtemp(join(tmpdir(), "runwield-planning-replant-"));
    const options = { env: { GIT_INDEX_FILE: join(scratch, "index") } };
    try {
        await git(entry.path, ["read-tree", "HEAD"], options);
        for (const path of dirty) await git(entry.path, ["add", "-A", "--", path], options);
        // Preparation also owns transferred context even when Git ignores those files.
        for (const path of await recordedProjectContextPaths(entry.path)) {
            if (await isTransferredProjectContext(entry.path, path)) {
                await git(entry.path, ["add", "-f", "--", path], options);
            }
        }
        const currentTree = (await git(entry.path, ["write-tree"], options)).trim();
        const paths = (
            await git(entry.path, ["diff", "--no-renames", "--name-only", "-z", entry.baseCommit, currentTree])
        )
            .split("\0")
            .filter((path) => path && !isRunWieldOwnedRuntimePath(path));
        await git(entry.path, ["read-tree", target], options);
        for (const path of paths) {
            // Compare Git entries rather than decoded files, preserving bytes, modes, and deletions.
            const entries = await Promise.all(
                [entry.baseCommit, currentTree, target].map(async (ref) => {
                    const listing = await git(entry.path, ["ls-tree", "-z", ref, "--", path]);
                    return (
                        listing
                            .split("\0")
                            .find((line) => line.slice(line.indexOf("\t") + 1) === path)
                            ?.split("\t")[0] || ""
                    );
                }),
            );
            const [original, current, incoming] = entries;
            if (current === original || current === incoming) continue;
            let carried = current;
            if (incoming !== original) {
                if (
                    !entries.every((value) => /^100(644|755) blob [a-f0-9]+$/.test(value)) ||
                    !path.startsWith("docs/plans/") ||
                    !path.endsWith(".md")
                ) {
                    throw new Error(
                        `Cannot refresh ${path}: saved planning edits conflict with the rewritten branch. Your files are preserved.`,
                    );
                }
                const contents = await Promise.all(
                    entries.map((value) => git(entry.path, ["cat-file", "blob", value.split(" ")[2]])),
                );
                const merged = await mergePlanningDocument(
                    entry.path,
                    path,
                    contents[0],
                    contents[1],
                    contents[2],
                    path === `docs/plans/${entry.planName}.md`,
                );
                const oid = (await git(entry.path, ["hash-object", "-w", "--stdin"], { stdinText: merged })).trim();
                carried = `${current.split(" ")[0]} blob ${oid}`;
            }
            if (carried) {
                const [mode, , oid] = carried.split(" ");
                await git(entry.path, ["update-index", "--add", "--cacheinfo", mode, oid, path], options);
            } else {
                await git(entry.path, ["update-index", "--force-remove", "--", path], options);
            }
        }
        const tree = (await git(entry.path, ["write-tree"], options)).trim();
        const commit = (
            await git(entry.path, [
                ...PLANNING_CHECKPOINT_GIT_OPTIONS,
                "commit-tree",
                tree,
                "-p",
                target,
                "-m",
                `Refresh ${entry.planName} onto rewritten ${entry.baseBranch}`,
            ])
        ).trim();
        return { commit, currentTree };
    } finally {
        await fsRm(scratch, { recursive: true });
    }
}

export async function refreshPlanningWorktree(projectRoot: string, entry: WorktreeRegistryEntry, targetCommit: string) {
    await healSettledTransitionRecords(entry.path, { planName: entry.planName });
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
            const pendingMerge = await captureForegroundProcess("git", {
                cwd: entry.path,
                args: ["rev-parse", "--verify", "--quiet", "MERGE_HEAD"],
            });
            if (pendingMerge.success) throw new Error(`Planning worktree has an unfinished merge: ${entry.path}`);
            if (await isAncestor(entry.path, targetCommit, entry.baseCommit)) return entry;
            // A completed refresh may have moved HEAD before registry settlement.
            // Replanted history intentionally no longer contains the old base.
            const imported = await isAncestor(entry.path, targetCommit, "HEAD");
            if (!imported && !(await isAncestor(entry.path, entry.baseCommit, "HEAD"))) {
                throw new Error(
                    `Cannot refresh planning for ${entry.planName}: the planning branch history no longer contains its recorded base. Your files are preserved.`,
                );
            }
            const rewritten = !imported && !(await isAncestor(entry.path, entry.baseCommit, targetCommit));
            const importedBase = imported ? targetCommit : entry.baseCommit;
            if (
                await hasExecutionChangesSince({
                    worktreePath: entry.path,
                    baseRef: importedBase,
                    includeWorkingTree: true,
                })
            ) {
                throw new Error(
                    rewritten
                        ? `Cannot refresh planning for ${entry.planName}: the Epic branch was rewritten after planning started, and this worktree contains implementation changes. Your files are preserved.`
                        : `Cannot refresh planning for ${entry.planName}: this worktree already contains implementation changes.`,
                );
            }
            // Status normalization and saved planning edits are preparation, not
            // user implementation. Checkpoint them before importing publication.
            const dirty = (await gitStatusPaths(entry.path)).filter((path) => !isRunWieldOwnedRuntimePath(path));
            // Resolve every conflict before checkpointing, so refusal changes no saved state.
            const replanted = rewritten ? await buildReplantedCommit(entry, targetCommit, dirty) : null;
            if (dirty.length) {
                await checkpointExecutionPreparation({
                    phase: "planning",
                    worktreePath: entry.path,
                    branch: entry.branch,
                    baseCommit: importedBase,
                    planName: entry.planName,
                    planRelativePath: `docs/plans/${entry.planName}.md`,
                });
            }
            if (replanted) {
                const replacedHead = (await git(entry.path, ["rev-parse", "HEAD"])).trim();
                if ((await git(entry.path, ["rev-parse", `${replacedHead}^{tree}`])).trim() !== replanted.currentTree) {
                    throw new Error(
                        `Cannot refresh planning for ${entry.planName}: saved files changed during refresh. Your latest edits are preserved. Retry to use them.`,
                    );
                }
                await markEffect("planning_refresh_prepared", {
                    worktreeId: entry.id,
                    beforeHead: replacedHead,
                    afterHead: replanted.commit,
                });
                await git(entry.path, ["update-ref", `refs/runwield/planning-replaced/${entry.id}`, replacedHead]);
                // Checkout -B moves this same branch only after the complete tree is
                // installed, and unlike reset --keep it protects ignored local files.
                await git(entry.path, [
                    ...PLANNING_CHECKPOINT_GIT_OPTIONS,
                    "checkout",
                    "--no-overwrite-ignore",
                    "-B",
                    entry.branch,
                    replanted.commit,
                ]);
            }
            const head = (await git(entry.path, ["rev-parse", "HEAD"])).trim();
            const base = (await git(entry.path, ["merge-base", head, targetCommit])).trim();
            const changed = (await git(entry.path, ["diff", "--name-only", "-z", base, head, "--", "docs/plans"]))
                .split("\0")
                .filter((path) => path.endsWith(".md"));
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
                    const merged = await captureForegroundProcess("git", {
                        cwd: entry.path,
                        args: [
                            ...PLANNING_CHECKPOINT_GIT_OPTIONS,
                            "merge",
                            "--no-ff",
                            "--no-squash",
                            "--no-commit",
                            "--no-autostash",
                            "--no-overwrite-ignore",
                            targetCommit,
                        ],
                    });
                    const conflicts = (await git(entry.path, ["diff", "--name-only", "-z", "--diff-filter=U"]))
                        .split("\0")
                        .filter(Boolean);
                    if ((!merged.success && !conflicts.length) || conflicts.some((path) => !documents.has(path))) {
                        throw new Error(
                            `Cannot refresh planning for ${entry.planName}: ${new TextDecoder().decode(merged.stderr)}`,
                        );
                    }
                    for (const [path, markdown] of documents) {
                        await fsWriteFile(join(entry.path, path), markdown);
                        await git(entry.path, ["add", "--", path]);
                    }
                    await git(entry.path, [
                        ...PLANNING_CHECKPOINT_GIT_OPTIONS,
                        "commit",
                        "-m",
                        `Refresh ${entry.planName} from ${entry.baseBranch}`,
                    ]);
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
