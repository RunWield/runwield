/**
 * Materialize and verify canonical Plan files inside execution worktrees.
 */

import { dirname, join, relative, SEPARATOR } from "@std/path";
import {
    atomicWriteTextFileIfAbsent,
    getPlanRevisionForText,
    getStoredPlanPath,
    mergeFrontMatterText,
    parsePlanFrontMatter,
    planDocumentMarkdown,
    writePlanMarkdownWithRevision,
} from "../../plan-store.js";

/**
 * @typedef {Object} ExecutionPlanFileResult
 * @property {"present"|"restored"|"reconciled"|"absent"|"unreadable"|"malformed"|"symlink"|"non_regular"|"restore_failed"} kind
 * @property {string} relativePath
 * @property {string} [path]
 * @property {string} [reason]
 * @property {{ from: string|undefined, to: string }} [healedPlanId] - Set when a diverged execution-copy Plan ID was reconciled to the canonical one.
 */

/** @param {import('../../plan-store.js').PlanFrontMatter[keyof import('../../plan-store.js').PlanFrontMatter]} value */
function isPlanId(value) {
    return typeof value === "string" && value.trim().length > 0;
}

/**
 * @param {import('../../plan-store.js').PlanFrontMatter["planId"]} canonicalPlanId
 * @param {import('../../plan-store.js').PlanFrontMatter["planId"]} executionPlanId
 */
function mustReconcilePlanId(canonicalPlanId, executionPlanId) {
    return isPlanId(canonicalPlanId) && canonicalPlanId !== executionPlanId;
}

/**
 * @param {import('../../plan-store.js').PlanFrontMatter["planId"]} canonicalPlanId
 * @param {import('../../plan-store.js').PlanFrontMatter["planId"]} executionPlanId
 */
function hasPlanIdConflict(canonicalPlanId, executionPlanId) {
    return isPlanId(canonicalPlanId) && isPlanId(executionPlanId) && canonicalPlanId !== executionPlanId;
}

/**
 * Metadata required to start execution comes from the locked canonical Plan.
 * The worktree can contain an older committed copy when readiness was recorded
 * only in the primary checkout. Reconcile only those RunWield-owned fields; the
 * execution copy's user-owned body and unrelated Front Matter remain untouched.
 *
 * @param {import('../../plan-store.js').PlanFrontMatter} canonicalAttrs
 * @param {import('../../plan-store.js').PlanFrontMatter} executionAttrs
 */
function executionMetadataOverrides(canonicalAttrs, executionAttrs) {
    /** @type {Partial<import('../../plan-store.js').PlanFrontMatter>} */
    const overrides = {};
    if (executionAttrs.classification !== canonicalAttrs.classification) {
        overrides.classification = canonicalAttrs.classification;
    }
    if (executionAttrs.status !== canonicalAttrs.status) {
        overrides.status = canonicalAttrs.status;
    }
    // At initial setup the source is the locked primary Plan; on continuation
    // it is the execution Plan itself. Runtime facts are not document fields.
    if (mustReconcilePlanId(canonicalAttrs.planId, executionAttrs.planId)) {
        overrides.planId = canonicalAttrs.planId;
    }
    /** @type {(keyof import('../../plan-store.js').PlanFrontMatter)[]} */
    const documentKeys = [
        "executionAgent",
        "collaborationRecommendation",
        "targetBranch",
        "deliveryBranch",
        "origin",
        "parentPlan",
        "order",
        "dependencies",
        "createdAt",
        "userVerifiedAt",
        "userVerificationNote",
        "closedWithoutVerificationReason",
        "closedWithoutVerificationAt",
        "workRecord",
        "epicCompletionMode",
        "epicDoneEnoughAt",
        "epicDoneEnoughSummary",
        "heldFromStatus",
        "heldAt",
        "holdReason",
        "archivedAt",
        "archiveReason",
        "archivedFromStatus",
        "archivedFromPath",
        "restoredAt",
        "restoredFromPath",
    ];
    for (const key of documentKeys) {
        if (JSON.stringify(canonicalAttrs[key]) !== JSON.stringify(executionAttrs[key])) {
            Object.assign(overrides, { [key]: canonicalAttrs[key] });
        }
    }
    return overrides;
}

/**
 * @param {Deno.FileInfo} info
 */
function classifyNonRegular(info) {
    if (info.isSymlink) return "symlink";
    if (!info.isFile) return "non_regular";
    return null;
}

/**
 * @param {string} projectRoot
 * @param {string} absolutePath
 */
function projectRelativePath(projectRoot, absolutePath) {
    return relative(projectRoot, absolutePath).split(SEPARATOR).join("/");
}

/**
 * Inspect an existing canonical-source parent chain without following symlinked ancestors.
 *
 * @param {string} projectRoot
 * @param {string[]} segments
 * @param {string} sourceRelativePath
 * @returns {Promise<
 *   { ok: true } |
 *   { ok: false, kind: "absent"|"unreadable"|"symlink"|"non_regular", reason: string }
 * >}
 */
async function inspectCanonicalParentChain(projectRoot, segments, sourceRelativePath) {
    let current = projectRoot;
    for (const segment of segments) {
        current = join(current, segment);
        const currentRelativePath = projectRelativePath(projectRoot, current);
        let info;
        try {
            info = await lstatOrNull(current);
        } catch {
            return {
                ok: false,
                kind: "unreadable",
                reason:
                    `Canonical Plan source parent is unreadable at ${currentRelativePath}; source: ${sourceRelativePath}.`,
            };
        }
        if (!info) {
            return {
                ok: false,
                kind: "absent",
                reason:
                    `Canonical Plan source is absent: ${sourceRelativePath} (missing parent ${currentRelativePath}).`,
            };
        }
        if (info.isSymlink) {
            return {
                ok: false,
                kind: "symlink",
                reason:
                    `Canonical Plan source parent is a symlink at ${currentRelativePath}; source: ${sourceRelativePath}.`,
            };
        }
        if (!info.isDirectory) {
            return {
                ok: false,
                kind: "non_regular",
                reason:
                    `Canonical Plan source parent is not a directory at ${currentRelativePath}; source: ${sourceRelativePath}.`,
            };
        }
    }
    return { ok: true };
}

/**
 * @param {string} projectRoot
 * @param {string} planName
 * @returns {Promise<{ kind: "loaded", path: string, relativePath: string, markdown: string, attrs: import('../../plan-store.js').PlanFrontMatter } | ExecutionPlanFileResult>}
 */
export async function loadCanonicalExecutionPlanSource(projectRoot, planName) {
    const path = getStoredPlanPath(projectRoot, planName);
    const relativePath = projectRelativePath(projectRoot, path);
    const parentRelativePath = dirname(relativePath);
    const parentSegments = parentRelativePath === "." ? [] : parentRelativePath.split("/");
    const parents = await inspectCanonicalParentChain(projectRoot, parentSegments, relativePath);
    if (!parents.ok) return { kind: parents.kind, path, relativePath, reason: parents.reason };

    let info;
    try {
        info = await Deno.lstat(path);
    } catch (error) {
        if (error instanceof Deno.errors.NotFound) {
            return { kind: "absent", path, relativePath, reason: `Canonical Plan source is absent: ${relativePath}.` };
        }
        return {
            kind: "unreadable",
            path,
            relativePath,
            reason: `Canonical Plan source is unreadable: ${relativePath}.`,
        };
    }
    const nonRegular = classifyNonRegular(info);
    if (nonRegular) {
        return {
            kind: nonRegular,
            path,
            relativePath,
            reason: `Canonical Plan source is ${
                nonRegular === "symlink" ? "a symlink" : "not a regular file"
            }: ${relativePath}.`,
        };
    }
    let markdown;
    try {
        markdown = await Deno.readTextFile(path);
    } catch {
        return {
            kind: "unreadable",
            path,
            relativePath,
            reason: `Canonical Plan source is unreadable: ${relativePath}.`,
        };
    }
    try {
        const { attrs } = parsePlanFrontMatter(markdown);
        const recheckedParents = await inspectCanonicalParentChain(projectRoot, parentSegments, relativePath);
        if (!recheckedParents.ok) {
            return { kind: recheckedParents.kind, path, relativePath, reason: recheckedParents.reason };
        }
        return { kind: "loaded", path, relativePath, markdown, attrs };
    } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        return {
            kind: "malformed",
            path,
            relativePath,
            reason: `Canonical Plan source has malformed Front Matter at ${relativePath}: ${reason}`,
        };
    }
}

/**
 * @param {string} path
 */
async function lstatOrNull(path) {
    try {
        return await Deno.lstat(path);
    } catch (error) {
        if (error instanceof Deno.errors.NotFound) return null;
        throw error;
    }
}

/**
 * Inspect or create the directory chain one segment at a time without following symlinks.
 * @param {string} root
 * @param {string[]} segments
 * @param {boolean} createMissing
 * @returns {Promise<{ ok: true } | { ok: false, kind: "symlink"|"non_regular"|"restore_failed", path: string, reason: string }>}
 */
async function verifyParentChain(root, segments, createMissing) {
    let current = root;
    for (const segment of segments) {
        current = join(current, segment);
        let info;
        try {
            info = await lstatOrNull(current);
        } catch {
            return {
                ok: false,
                kind: "restore_failed",
                path: current,
                reason: `Cannot inspect execution Plan parent ${current}. Existing evidence was preserved.`,
            };
        }
        if (!info) {
            if (!createMissing) {
                return {
                    ok: false,
                    kind: "restore_failed",
                    path: current,
                    reason: `Execution Plan parent is absent: ${current}.`,
                };
            }
            try {
                await Deno.mkdir(current);
            } catch (error) {
                if (!(error instanceof Deno.errors.AlreadyExists)) {
                    return {
                        ok: false,
                        kind: "restore_failed",
                        path: current,
                        reason: `Cannot create execution Plan parent ${current}. Existing evidence was preserved.`,
                    };
                }
            }
            try {
                info = await Deno.lstat(current);
            } catch {
                return {
                    ok: false,
                    kind: "restore_failed",
                    path: current,
                    reason: `Cannot inspect created execution Plan parent ${current}. Existing evidence was preserved.`,
                };
            }
        }
        if (info.isSymlink) {
            return {
                ok: false,
                kind: "symlink",
                path: current,
                reason: `Execution Plan parent is a symlink: ${current}. Existing evidence was preserved.`,
            };
        }
        if (!info.isDirectory) {
            return {
                ok: false,
                kind: "non_regular",
                path: current,
                reason: `Execution Plan parent is not a directory: ${current}. Existing evidence was preserved.`,
            };
        }
    }
    return { ok: true };
}

/**
 * @param {{ executionCwd: string, planName: string, canonicalSource: Extract<Awaited<ReturnType<typeof loadCanonicalExecutionPlanSource>>, {kind:"loaded"}>, reconcileFromCanonical?: boolean, replaceFromCanonical?: boolean }} opts
 * @returns {Promise<ExecutionPlanFileResult>}
 */
export async function ensureExecutionPlanFile({
    executionCwd,
    planName,
    canonicalSource,
    reconcileFromCanonical = true,
    replaceFromCanonical = false,
}) {
    const targetPath = getStoredPlanPath(executionCwd, planName);
    const relativePath = projectRelativePath(executionCwd, targetPath);
    const targetDir = dirname(targetPath);
    const parentRelative = dirname(relativePath);
    const parentSegments = parentRelative === "." ? [] : parentRelative.split("/");

    const parents = await verifyParentChain(executionCwd, parentSegments, true);
    if (!parents.ok) return { kind: parents.kind, path: parents.path, relativePath, reason: parents.reason };

    let targetInfo;
    try {
        targetInfo = await lstatOrNull(targetPath);
    } catch (error) {
        return {
            kind: "unreadable",
            path: targetPath,
            relativePath,
            reason: `Cannot inspect execution Plan path ${relativePath}: ${
                String(error)
            }. Existing evidence was preserved.`,
        };
    }
    if (targetInfo) {
        const nonRegular = classifyNonRegular(targetInfo);
        if (nonRegular) {
            return {
                kind: nonRegular,
                path: targetPath,
                relativePath,
                reason: `Execution Plan path ${relativePath} is ${
                    nonRegular === "symlink" ? "a symlink" : "not a regular file"
                }. Existing evidence was preserved.`,
            };
        }
        let markdown;
        try {
            markdown = await Deno.readTextFile(targetPath);
        } catch (error) {
            return {
                kind: "unreadable",
                path: targetPath,
                relativePath,
                reason: `Execution Plan path ${relativePath} is unreadable: ${
                    String(error)
                }. Existing evidence was preserved.`,
            };
        }
        try {
            const { attrs } = parsePlanFrontMatter(markdown);
            if (
                !replaceFromCanonical && !reconcileFromCanonical &&
                hasPlanIdConflict(canonicalSource.attrs.planId, attrs.planId)
            ) {
                return {
                    kind: "restore_failed",
                    path: targetPath,
                    relativePath,
                    reason: `Execution Plan identity does not match ${relativePath}. Existing evidence was preserved.`,
                };
            }
            if (replaceFromCanonical) {
                if (markdown === canonicalSource.markdown) return { kind: "present", path: targetPath, relativePath };
                const expectedRevision = await getPlanRevisionForText(markdown);
                try {
                    await writePlanMarkdownWithRevision(targetPath, canonicalSource.markdown, expectedRevision);
                } catch {
                    const concurrentMarkdown = await Deno.readTextFile(targetPath).catch(() => null);
                    if (concurrentMarkdown === canonicalSource.markdown) {
                        return { kind: "present", path: targetPath, relativePath };
                    }
                    return {
                        kind: "restore_failed",
                        path: targetPath,
                        relativePath,
                        reason:
                            `Could not materialize the latest execution Plan at ${relativePath}. Existing evidence was preserved.`,
                    };
                }
                if (await Deno.readTextFile(targetPath) !== planDocumentMarkdown(canonicalSource.markdown)) {
                    return {
                        kind: "restore_failed",
                        path: targetPath,
                        relativePath,
                        reason: `Could not verify the latest execution Plan at ${relativePath}.`,
                    };
                }
                return { kind: "reconciled", path: targetPath, relativePath };
            }
            if (!reconcileFromCanonical) {
                return { kind: "present", path: targetPath, relativePath };
            }
            const overrides = executionMetadataOverrides(canonicalSource.attrs, attrs);
            if (Object.keys(overrides).length > 0) {
                const reconciledMarkdown = planDocumentMarkdown(mergeFrontMatterText(markdown, overrides));
                const expectedRevision = await getPlanRevisionForText(markdown);
                try {
                    await writePlanMarkdownWithRevision(targetPath, reconciledMarkdown, expectedRevision);
                } catch {
                    // Another real writer may have won the revision race. Accept
                    // that outcome only when it independently produced the locked
                    // canonical metadata; otherwise preserve its evidence and stop.
                    const concurrentMarkdown = await Deno.readTextFile(targetPath).catch(() => null);
                    if (concurrentMarkdown !== null) {
                        try {
                            const concurrent = parsePlanFrontMatter(concurrentMarkdown);
                            if (
                                !hasPlanIdConflict(canonicalSource.attrs.planId, concurrent.attrs.planId) &&
                                Object.keys(executionMetadataOverrides(canonicalSource.attrs, concurrent.attrs))
                                        .length === 0
                            ) {
                                return { kind: "present", path: targetPath, relativePath };
                            }
                        } catch {
                            // The classified failure below preserves the new bytes.
                        }
                    }
                    return {
                        kind: "restore_failed",
                        path: targetPath,
                        relativePath,
                        reason:
                            `Could not synchronize execution Plan metadata at ${relativePath}. Existing evidence was preserved.`,
                    };
                }
                const verifiedMarkdown = await Deno.readTextFile(targetPath);
                const verified = parsePlanFrontMatter(verifiedMarkdown);
                if (
                    hasPlanIdConflict(canonicalSource.attrs.planId, verified.attrs.planId) ||
                    Object.keys(executionMetadataOverrides(canonicalSource.attrs, verified.attrs)).length > 0
                ) {
                    return {
                        kind: "restore_failed",
                        path: targetPath,
                        relativePath,
                        reason:
                            `Could not verify synchronized execution Plan metadata at ${relativePath}. Existing evidence was preserved.`,
                    };
                }
                return {
                    kind: "reconciled",
                    path: targetPath,
                    relativePath,
                    ...(overrides.planId ? { healedPlanId: { from: attrs.planId, to: overrides.planId } } : {}),
                };
            }
            return { kind: "present", path: targetPath, relativePath };
        } catch (error) {
            return {
                kind: "malformed",
                path: targetPath,
                relativePath,
                reason: `Execution Plan path ${relativePath} is malformed: ${
                    String(error)
                }. Existing evidence was preserved.`,
            };
        }
    }

    try {
        const { attrs } = parsePlanFrontMatter(canonicalSource.markdown);
        if (hasPlanIdConflict(canonicalSource.attrs.planId, attrs.planId)) {
            return {
                kind: "restore_failed",
                path: targetPath,
                relativePath,
                reason:
                    `Canonical execution Plan validation failed for ${relativePath}. Existing evidence was preserved.`,
            };
        }
        const recheckedParents = await verifyParentChain(executionCwd, parentSegments, false);
        if (!recheckedParents.ok) {
            return {
                kind: recheckedParents.kind,
                path: recheckedParents.path,
                relativePath,
                reason: recheckedParents.reason,
            };
        }
        const recheckedTarget = await lstatOrNull(targetPath);
        if (recheckedTarget) {
            const concurrent = await ensureExecutionPlanFile({ executionCwd, planName, canonicalSource });
            return concurrent.kind === "present" ? { kind: "present", path: targetPath, relativePath } : concurrent;
        }
        await Deno.mkdir(targetDir, { recursive: true });
        try {
            await atomicWriteTextFileIfAbsent(targetPath, planDocumentMarkdown(canonicalSource.markdown));
        } catch (error) {
            if (error instanceof Deno.errors.AlreadyExists) {
                const concurrent = await ensureExecutionPlanFile({ executionCwd, planName, canonicalSource });
                return concurrent.kind === "present" ? { kind: "present", path: targetPath, relativePath } : concurrent;
            }
            throw error;
        }
        const restoredMarkdown = await Deno.readTextFile(targetPath);
        if (restoredMarkdown !== planDocumentMarkdown(canonicalSource.markdown)) {
            return {
                kind: "restore_failed",
                path: targetPath,
                relativePath,
                reason: `Atomic execution Plan restore verification failed for ${relativePath}.`,
            };
        }
        return { kind: "restored", path: targetPath, relativePath };
    } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        return {
            kind: "restore_failed",
            path: targetPath,
            relativePath,
            reason:
                `Failed to restore execution Plan path ${relativePath}: ${reason}. Existing evidence was preserved.`,
        };
    }
}

/**
 * @param {{ projectRoot: string, executionCwd: string, planName: string, executionAuthoritative?: boolean }} opts
 * @returns {Promise<ExecutionPlanFileResult>}
 */
export async function prepareExecutionPlanFile(
    { projectRoot, executionCwd, planName, executionAuthoritative = false },
) {
    if (executionAuthoritative) {
        const executionSource = await loadCanonicalExecutionPlanSource(executionCwd, planName);
        if (executionSource.kind === "loaded") {
            return await ensureExecutionPlanFile({
                executionCwd,
                planName,
                canonicalSource: executionSource,
                reconcileFromCanonical: false,
            });
        }
        if (executionSource.kind !== "absent") return executionSource;
    }
    const canonicalSource = await loadCanonicalExecutionPlanSource(projectRoot, planName);
    if (canonicalSource.kind !== "loaded") return canonicalSource;
    return await ensureExecutionPlanFile({ executionCwd, planName, canonicalSource });
}

/**
 * Restore a deleted execution Plan from the immutable pre-implementation tree.
 * Existing files are classified and preserved; only an absent path is restored.
 *
 * @param {{ executionCwd: string, planName: string, baselineTree: string }} opts
 * @returns {Promise<ExecutionPlanFileResult>}
 */
export async function restoreExecutionPlanFromBaseline({ executionCwd, planName, baselineTree }) {
    const existing = await loadCanonicalExecutionPlanSource(executionCwd, planName);
    if (existing.kind === "loaded") {
        return await ensureExecutionPlanFile({
            executionCwd,
            planName,
            canonicalSource: existing,
            reconcileFromCanonical: false,
        });
    }
    if (existing.kind !== "absent") return existing;
    if (!/^[0-9a-f]{40,64}$/i.test(baselineTree)) {
        return {
            kind: "restore_failed",
            relativePath: existing.relativePath,
            reason: `Execution baseline is not a Git object id: ${baselineTree}.`,
        };
    }
    const treeResult = await new Deno.Command("git", {
        cwd: executionCwd,
        args: ["rev-parse", `${baselineTree}^{tree}`],
        stdout: "piped",
        stderr: "piped",
    }).output();
    if (treeResult.code !== 0) {
        return {
            kind: "restore_failed",
            relativePath: existing.relativePath,
            reason: `Execution baseline tree is unavailable for ${existing.relativePath}.`,
        };
    }
    const tree = new TextDecoder().decode(treeResult.stdout).trim();
    const blobResult = await new Deno.Command("git", {
        cwd: executionCwd,
        args: ["show", `${tree}:${existing.relativePath}`],
        stdout: "piped",
        stderr: "piped",
    }).output();
    if (blobResult.code !== 0) {
        return {
            kind: "restore_failed",
            relativePath: existing.relativePath,
            reason: `Execution baseline does not contain ${existing.relativePath}.`,
        };
    }
    const markdown = new TextDecoder().decode(blobResult.stdout);
    try {
        const { attrs } = parsePlanFrontMatter(markdown);
        return await ensureExecutionPlanFile({
            executionCwd,
            planName,
            canonicalSource: {
                kind: "loaded",
                path: existing.path || getStoredPlanPath(executionCwd, planName),
                relativePath: existing.relativePath,
                markdown,
                attrs,
            },
            reconcileFromCanonical: false,
        });
    } catch (error) {
        return {
            kind: "restore_failed",
            relativePath: existing.relativePath,
            reason: `Execution baseline Plan is malformed: ${error instanceof Error ? error.message : String(error)}.`,
        };
    }
}
