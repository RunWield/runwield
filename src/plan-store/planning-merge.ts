import { tmpdir } from "node:os";
import { mkdtemp, rm as fsRm, writeFile as fsWriteFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { captureForegroundProcess } from "../shared/captured-process.ts";
import { injectFrontMatter, parsePlanFrontMatter, planDocumentMarkdown } from "../plan-format.ts";
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

async function git(cwd: string, args: string[], stdinText?: string): Promise<string> {
    const result = await captureForegroundProcess("git", {
        cwd,
        args,
        ...(stdinText === undefined ? {} : { stdinText }),
    });
    if (!result.success) throw new Error(new TextDecoder().decode(result.stderr));
    return new TextDecoder().decode(result.stdout);
}
/** Merge immutable Plan blobs and retain the result as a Git object without exposing mutable metadata. */
export async function mergePlanningDocumentBlobs(
    cwd: string,
    path: string,
    planName: string,
    blobs: string[],
): Promise<string> {
    if (blobs.length !== 3 || blobs.some((blob) => !/^[a-f0-9]{40,64}$/.test(blob)))
        throw new Error("Invalid planning source blobs.");
    const contents = await Promise.all(blobs.map((blob) => git(cwd, ["cat-file", "blob", blob])));
    const merged = await mergePlanningDocument(
        cwd,
        path,
        contents[0],
        contents[1],
        contents[2],
        path === `docs/plans/${planName}.md`,
    );
    return (await git(cwd, ["hash-object", "-w", "--stdin"], merged)).trim();
}
const mergeToken = Symbol("Planning document merge");
export interface PlanningMergeDocuments {
    readonly paths: readonly string[];
    readonly [mergeToken]: true;
}
interface PlanningMergeState {
    cwd: string;
    documents: Map<string, string>;
}
const merges = new WeakMap<PlanningMergeDocuments, PlanningMergeState>();
export async function preparePlanningMergeDocuments(
    cwd: string,
    planName: string,
    base: string,
    head: string,
    incomingRef: string,
): Promise<PlanningMergeDocuments> {
    const changed = (await git(cwd, ["diff", "--name-only", "-z", base, head, "--", "docs/plans"]))
        .split("\0")
        .filter((path) => path.endsWith(".md"));
    const documents = new Map<string, string>();
    for (const path of changed) {
        const [original, current, incoming] = await Promise.all(
            [base, head, incomingRef].map((ref) => readPlanAt(cwd, ref, path)),
        );
        if (original && current && incoming)
            documents.set(
                path,
                await mergePlanningDocument(
                    cwd,
                    path,
                    original,
                    current,
                    incoming,
                    path === `docs/plans/${planName}.md`,
                ),
            );
    }
    const result: PlanningMergeDocuments = Object.freeze({
        paths: Object.freeze([...documents.keys()]),
        [mergeToken]: true as const,
    });
    merges.set(result, { cwd: resolve(cwd), documents });
    return result;
}
/** Install only the exact Plan merge results prepared by this owner. */
export async function applyPlanningMergeDocuments(
    cwd: string,
    prepared: PlanningMergeDocuments,
): Promise<readonly string[]> {
    const state = merges.get(prepared);
    if (!state || state.cwd !== resolve(cwd)) throw new Error("Planning merge belongs to another checkout.");
    for (const [path, markdown] of state.documents) await fsWriteFile(join(cwd, path), markdown);
    return prepared.paths;
}
