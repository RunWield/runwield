import { tmpdir } from "node:os";
import { mkdtemp } from "node:fs/promises";
import { captureForegroundProcess } from "./captured-process.ts";
import { readFile as fsReadFile, rm as fsRm, writeFile as fsWriteFile } from "node:fs/promises";
/** Finalize only the Plan and Work Record documents owned by a sealed delivery. */
import { join } from "node:path";
import { mergeFrontMatterText, parsePlanFrontMatter } from "../plan-store.js";
import { listWorkRecords } from "./work-records/store.js";
import { syncWorkRecordToIndex } from "./work-records/index-adapter.ts";
import type { WorkRecordMnemotecaPort } from "./work-records/mnemoteca-port.ts";
import { formatWorkRecordMarkdown, parseWorkRecordMarkdown } from "./work-records/markdown.js";

async function sealedDocument(cwd: string, commit: string, path: string): Promise<string | null> {
    const result = await captureForegroundProcess("git", { cwd, args: ["show", `${commit}:${path}`] });
    return result.success ? new TextDecoder().decode(result.stdout) : null;
}

/** Compare Git content, including the repository's configured clean filters and line endings. */
async function matchesGitDocument(
    cwd: string,
    path: string,
    actual: string | null,
    expected: string | null,
): Promise<boolean> {
    if (actual === expected) return true;
    if (actual === null || expected === null) return false;
    const hashes = await Promise.all(
        [actual, expected].map(async (stdinText) => {
            const result = await captureForegroundProcess("git", {
                cwd,
                args: ["hash-object", `--path=${path}`, "--stdin"],
                stdinText,
            });
            if (!result.success) throw new Error(new TextDecoder().decode(result.stderr));
            return new TextDecoder().decode(result.stdout).trim();
        }),
    );
    return hashes[0] === hashes[1];
}

/** Match only the exact wrapper emitted by older publishers; never write this form. */
function legacyWrappedRecord(sealedRecord: string, sealedCommit: string, targetBranch?: string): string {
    const original = parseWorkRecordMarkdown(sealedRecord);
    if (original.attrs.status !== "pending_verification") {
        return formatWorkRecordMarkdown({ ...original.attrs, status: "approved" }, original.body);
    }
    const body = [
        `# ${original.title}`,
        "",
        "## Summary",
        "",
        "Delivery metadata has been finalized for this validated change.",
        `Candidate containing the implementation and draft record: \`${sealedCommit}\`.`,
        ...(targetBranch ? [`Delivery destination: \`${targetBranch}\`.`] : []),
        "This record accompanies the delivery commit. The publication receipt confirms whether that commit reached its destination; this metadata alone does not prove a remote push or a merge into another branch.",
        "",
        "Validation scope is the configured workflow gate. See the delivery card's test results for the actual command output; no additional or full test suite is claimed here.",
        "",
        "## Historical pre-publication notes",
        "",
        "The recorder draft below is preserved verbatim as historical context. Its publication-pending and outstanding-validation statements describe the earlier snapshot, not the current delivery status. Implementation details, deviations and deferred work remain available here; consult the delivery evidence for final validation outcomes.",
        "",
        ...original.body.split("\n").map((line) => `> ${line}`),
    ].join("\n");
    return formatWorkRecordMarkdown({ ...original.attrs, status: "approved" }, body);
}

/** Publication approves the sealed content without changing its prose. */
function finalizedRecord(sealedRecord: string): string {
    const original = parseWorkRecordMarkdown(sealedRecord);
    return formatWorkRecordMarkdown({ ...original.attrs, status: "approved" }, original.body);
}

/**
 * Called after the candidate has merged, before the target commit is published.
 * Exact sealed identities and bytes keep a retry from approving unrelated edits.
 * This writes documents only; the publication receipt owns runtime completion.
 */
export async function finalizePublicationLifecycle(
    cwd: string,
    planName: string,
    sealedCommit: string,
    allowedPlanPaths: string[] = [`docs/plans/${planName}.md`],
    targetBranch?: string,
): Promise<string[]> {
    const firstPath = `docs/plans/${planName}.md`;
    const first = await sealedDocument(cwd, sealedCommit, firstPath);
    // The publisher is also used for Git-only delivery without a Plan document.
    if (!first) return [];
    const source = parsePlanFrontMatter(first).attrs;
    const paths = [firstPath];
    if (source.parentPlan && allowedPlanPaths.includes(`docs/plans/${source.parentPlan}.md`)) {
        const parentPath = `docs/plans/${source.parentPlan}.md`;
        const parent = await sealedDocument(cwd, sealedCommit, parentPath);
        if (parent) {
            const attrs = parsePlanFrontMatter(parent).attrs;
            if (attrs.status === "reviewed" && attrs.epicCompletionMode === "done_enough") paths.push(parentPath);
        }
    }
    const writes = new Map<string, string>();
    for (const path of paths) {
        const sealed = await sealedDocument(cwd, sealedCommit, path);
        if (!sealed) throw new Error(`Missing sealed Plan: ${path}`);
        const expected = parsePlanFrontMatter(sealed).attrs;
        const current = await fsReadFile(join(cwd, path), "utf8");
        const attrs = parsePlanFrontMatter(current).attrs;
        if (attrs.planId !== expected.planId) throw new Error(`Plan identity changed during publication: ${path}`);
        if (!["reviewed", "validated", "verified"].includes(attrs.status)) {
            throw new Error(`Cannot finalize publication of ${path} at ${attrs.status}.`);
        }
        if (attrs.status !== "verified") {
            writes.set(path, mergeFrontMatterText(current, { status: "verified" }));
        }
        const recordPath = expected.workRecord?.path;
        if (!recordPath || expected.workRecord?.status !== "generated") continue;
        if (!/^docs\/work-records\/[^/]+\.md$/.test(recordPath)) {
            throw new Error("Invalid publication Work Record path.");
        }
        const recordText = await fsReadFile(join(cwd, recordPath), "utf8");
        const record = parseWorkRecordMarkdown(recordText);
        if (
            record.attrs.recordId !== expected.workRecord.recordId ||
            !record.attrs.provenance?.sourcePlans?.includes(expected.planId || "")
        ) {
            throw new Error(`Work Record identity changed during publication: ${recordPath}`);
        }
        const sealedRecord = await sealedDocument(cwd, sealedCommit, recordPath);
        if (!sealedRecord) throw new Error(`Work Record is absent from the sealed candidate: ${recordPath}`);
        const approved = finalizedRecord(sealedRecord);
        const legacyWrapped = await matchesGitDocument(
            cwd,
            recordPath,
            recordText,
            legacyWrappedRecord(sealedRecord, sealedCommit, targetBranch),
        );
        if (
            !(await matchesGitDocument(cwd, recordPath, recordText, sealedRecord)) &&
            !(await matchesGitDocument(cwd, recordPath, recordText, approved)) &&
            !legacyWrapped
        ) {
            throw new Error(`Work Record changed outside its sealed publication: ${recordPath}`);
        }
        if (!legacyWrapped && !(await matchesGitDocument(cwd, recordPath, recordText, approved))) {
            writes.set(recordPath, approved);
        }
        const predecessorIds =
            typeof record.attrs.supersedes === "string" ? [record.attrs.supersedes] : record.attrs.supersedes || [];
        if (predecessorIds.length) {
            const records = await listWorkRecords(cwd);
            for (const id of predecessorIds) {
                const predecessor = records.find(
                    (candidate) => candidate.attrs.recordId.toLowerCase() === id.toLowerCase(),
                );
                if (
                    !predecessor ||
                    (predecessor.attrs.supersededBy && predecessor.attrs.supersededBy !== record.attrs.recordId)
                ) {
                    throw new Error(`Supersession changed during publication: ${id}`);
                }
                const text = formatWorkRecordMarkdown(
                    {
                        ...predecessor.attrs,
                        status: "superseded",
                        supersededBy: record.attrs.recordId,
                    },
                    predecessor.body,
                );
                if (text !== predecessor.markdown) writes.set(predecessor.relativePath, text);
            }
        }
    }
    // Validate the complete scope before any filesystem mutation.
    for (const [path, text] of writes) await fsWriteFile(join(cwd, path), text);
    return [...writes.keys()];
}

/** Recovery must see the finalized Plan in the commit, not only candidate ancestry. */
export async function hasFinalizedPublicationLifecycle(
    cwd: string,
    commit: string,
    planName: string,
    planId: string,
    sealedCommit?: string,
    planPaths: string[] = [`docs/plans/${planName}.md`],
    targetBranch?: string,
): Promise<boolean> {
    const text = await sealedDocument(cwd, commit, `docs/plans/${planName}.md`);
    if (!text) return false;
    const attrs = parsePlanFrontMatter(text).attrs;
    if (attrs.planId !== planId || attrs.status !== "verified") return false;
    if (!sealedCommit) return true;
    for (const path of planPaths) {
        const sourceText = await sealedDocument(cwd, sealedCommit, path);
        const targetText = await sealedDocument(cwd, commit, path);
        if (!sourceText || !targetText) return false;
        const source = parsePlanFrontMatter(sourceText).attrs;
        const target = parsePlanFrontMatter(targetText).attrs;
        if (source.planId !== target.planId || target.status !== "verified") return false;
        if (source.workRecord?.status === "generated" && source.workRecord.path) {
            const originalText = await sealedDocument(cwd, sealedCommit, source.workRecord.path);
            const finalText = await sealedDocument(cwd, commit, source.workRecord.path);
            if (!originalText || !finalText) return false;
            // Both historical wrapper publication and status-only approval remain valid proof.
            if (
                finalText !== finalizedRecord(originalText) &&
                finalText !== legacyWrappedRecord(originalText, sealedCommit, targetBranch)
            ) {
                return false;
            }
        }
    }
    return true;
}

async function git(cwd: string, args: string[]): Promise<string> {
    const result = await captureForegroundProcess("git", { cwd, args });
    if (!result.success) throw new Error(new TextDecoder().decode(result.stderr));
    return new TextDecoder().decode(result.stdout).trim();
}

/** A failed listing must stop publication, not imply that the branch is unchecked out. */
async function localPublicationCheckout(cwd: string, targetBranch: string): Promise<string | null> {
    const listing = await git(cwd, ["worktree", "list", "--porcelain", "-z"]);
    for (const entry of listing.split("\0\0")) {
        const fields = entry.split("\0");
        if (!fields.includes(`branch refs/heads/${targetBranch}`)) continue;
        const checkout = fields.find((field) => field.startsWith("worktree "));
        if (!checkout) throw new Error(`Cannot identify the checkout holding ${targetBranch}.`);
        return checkout.slice("worktree ".length);
    }
    return null;
}

/** Check the complete metadata scope before moving a ref or restoring any files. */
async function checkLocalPublicationMetadata(cwd: string, beforeRef: string, afterRef: string): Promise<string[]> {
    const paths = (await git(cwd, ["diff", "--name-only", "-z", beforeRef, afterRef, "--"]))
        .split("\0")
        .filter(Boolean);
    const blockingPaths: string[] = [];
    for (const path of paths) {
        if (!/^docs\/(plans|work-records)\/.+\.md$/.test(path)) throw new Error("Unexpected delivery metadata path.");
        const before = await sealedDocument(cwd, beforeRef, path);
        const after = await sealedDocument(cwd, afterRef, path);
        const disk = await fsReadFile(join(cwd, path), "utf8").catch(() => null);
        const index = await sealedDocument(cwd, "", path);
        if (
            (!(await matchesGitDocument(cwd, path, disk, before)) &&
                !(await matchesGitDocument(cwd, path, disk, after))) ||
            (index !== before && index !== after)
        ) {
            blockingPaths.push(path);
        }
    }
    if (blockingPaths.length) {
        throw Object.assign(new Error(`Preserved edited delivery metadata: ${blockingPaths.join(", ")}`), {
            mergeFailureKind: "primary_checkout_dirty",
            blockingPaths,
        });
    }
    return paths;
}

/** Restore only exact old/new bytes after a metadata ref update interrupted the checkout refresh. */
export async function recoverLocalPublicationLifecycle(
    cwd: string,
    targetBranch: string,
    sealedCommit: string,
): Promise<void> {
    const branch = await git(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"]).catch(() => "");
    if (branch !== targetBranch) return;
    const message = await git(cwd, ["show", "-s", "--format=%B", "HEAD"]);
    if (!message.split("\n").includes(`RunWield-Delivery-Candidate: ${sealedCommit}`)) return;
    const paths = await checkLocalPublicationMetadata(cwd, "HEAD^", "HEAD");
    if (paths.length) await git(cwd, ["restore", "--source=HEAD", "--staged", "--worktree", "--", ...paths]);
}

/** Build metadata in a disposable checkout, then advance exactly the selected local branch. */
export async function finalizeLocalPublicationLifecycle(
    cwd: string,
    targetBranch: string,
    planName: string,
    sealedCommit: string,
    allowedPlanPaths: string[],
): Promise<string> {
    const checkout = await localPublicationCheckout(cwd, targetBranch);
    if (checkout) await recoverLocalPublicationLifecycle(checkout, targetBranch, sealedCommit);
    const before = await git(cwd, ["rev-parse", `refs/heads/${targetBranch}`]);
    const temporary = await mkdtemp(join(tmpdir(), "runwield-delivery-metadata-"));
    let attached = false;
    try {
        await git(cwd, ["worktree", "add", "--detach", temporary, before]);
        attached = true;
        const paths = await finalizePublicationLifecycle(
            temporary,
            planName,
            sealedCommit,
            allowedPlanPaths,
            targetBranch,
        );
        if (!paths.length) return before;
        await git(temporary, ["add", "--", ...paths]);
        await git(temporary, [
            "commit",
            "-m",
            `Record verified delivery for ${planName}`,
            "-m",
            `RunWield-Delivery-Candidate: ${sealedCommit}`,
        ]);
        const commit = await git(temporary, ["rev-parse", "HEAD"]);
        const targetCheckout = await localPublicationCheckout(cwd, targetBranch);
        if (targetCheckout) await checkLocalPublicationMetadata(targetCheckout, before, commit);
        await git(cwd, ["update-ref", `refs/heads/${targetBranch}`, commit, before]);
        if (targetCheckout) await recoverLocalPublicationLifecycle(targetCheckout, targetBranch, sealedCommit);
        return commit;
    } finally {
        if (attached) await git(cwd, ["worktree", "remove", "--force", temporary]);
        else await fsRm(temporary, { recursive: true });
    }
}

/** Derive the search index from confirmed published bytes, never the pending candidate. */
export async function indexPublishedWorkRecords(
    projectRoot: string,
    gitRoot: string,
    commit: string,
    planPaths: string[],
    mnemotecaPort: WorkRecordMnemotecaPort,
    sourcePlanCommit = commit,
): Promise<void> {
    const linkedIds = new Set<string>();
    for (const path of planPaths) {
        // The original delivery owns these record identities even if its Plan
        // was renamed, removed, or linked to a newer record on the target.
        const text = await sealedDocument(gitRoot, sourcePlanCommit, path);
        if (!text) continue;
        const source = parsePlanFrontMatter(text).attrs;
        if (source.workRecord?.status === "generated" && source.workRecord.recordId) {
            linkedIds.add(source.workRecord.recordId);
        }
    }
    if (!linkedIds.size) return;
    const paths = (await git(gitRoot, ["ls-tree", "-r", "--name-only", commit, "--", "docs/work-records/"]))
        .split("\n")
        .filter((path) => path.endsWith(".md"));
    for (const path of paths) {
        const text = await sealedDocument(gitRoot, commit, path);
        if (!text) continue;
        const record = parseWorkRecordMarkdown(text, { path: join(projectRoot, path), relativePath: path });
        if (
            linkedIds.has(record.attrs.recordId) ||
            (record.attrs.supersededBy && linkedIds.has(record.attrs.supersededBy))
        ) {
            await syncWorkRecordToIndex(projectRoot, record, { mnemotecaPort });
        }
    }
}
