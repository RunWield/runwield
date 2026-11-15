import { rmdir } from "node:fs/promises";
import { relative } from "node:path";
import { archivePlan, restoreArchivedPlan, loadArchivedPlan, loadPlan, getPlanDocumentRoot } from "../plan-store.js";
import { runArchiveTransition, type TransitionResult } from "./transitions.ts";
import { currentPackageProject } from "./workflows.ts";
import { withLocalProjectAction } from "./access.ts";

export interface ArchivePlanOptions {
    reason?: string;
    force?: boolean;
    now?: string;
    expectedRevision?: string;
}
interface ArchiveTransitionValue<T> {
    value: T;
}
function committedArchive<T>(result: TransitionResult): T {
    if (result.status === "committed") return (result.value as ArchiveTransitionValue<T>).value;
    const recovery = (result.recoveryActions || [])
        .map((action) => (action.command ? `${action.label}: ${action.command}` : action.label))
        .join("; ");
    throw new Error(
        `${result.operation} for Plan needs recovery: ${result.message || result.status}${recovery ? `. Recovery: ${recovery}` : ""}`,
    );
}

/** Journal, source resolution, revision preconditions and moves are one owner operation. */
export async function archiveSavedPlan(cwd: string, name: string, options: ArchivePlanOptions = {}) {
    return await withLocalProjectAction(cwd, async () => {
        return committedArchive<Awaited<ReturnType<typeof archivePlan>>>(
            await runArchiveTransition({
                projectRoot: cwd,
                planName: name,
                action: "archive",
                expectedRevision: options.expectedRevision,
                move: () => archivePlan(cwd, name, options),
            }),
        );
    });
}

export async function restoreSavedPlan(cwd: string, reference: string, destination?: string) {
    return await withLocalProjectAction(cwd, async () => {
        const source = await loadArchivedPlan(cwd, reference);
        if (!source) throw new Error(`Archived Plan not found: ${reference}`);
        return committedArchive<Awaited<ReturnType<typeof restoreArchivedPlan>>>(
            await runArchiveTransition({
                projectRoot: cwd,
                planName: source.name,
                action: "restore",
                move: () => restoreArchivedPlan(cwd, reference, { to: destination }),
            }),
        );
    });
}

export async function archivedPlanProjectRoot(cwd: string, reference: string): Promise<string> {
    const source = await loadArchivedPlan(cwd, reference);
    return source ? getPlanDocumentRoot(source.path) : cwd;
}

/** The legacy child directory is disposable only after its Plans have been archived. */
export async function archiveEpicPlanFamily(cwd: string, epicName: string, childNames: string[]) {
    return await withLocalProjectAction(cwd, async () => {
        const epic = await loadPlan(cwd, epicName);
        if (!epic) throw new Error(`Epic not found: ${epicName}`);
        const legacyDirectory = currentPackageProject()
            ? null
            : epic.path.endsWith(".md")
              ? epic.path.slice(0, -3)
              : `${epic.path}.children`;
        const now = new Date().toISOString();
        const archived: Awaited<ReturnType<typeof archiveSavedPlan>>[] = [];
        for (const child of childNames) archived.push(await archiveSavedPlan(cwd, child, { now, force: true }));
        archived.push(await archiveSavedPlan(cwd, epicName, { now }));
        let cleanupMessage: string | undefined;
        if (legacyDirectory) {
            const path = relative(cwd, legacyDirectory).replaceAll("\\", "/");
            try {
                await rmdir(legacyDirectory);
            } catch (error) {
                cleanupMessage =
                    error instanceof Error && "code" in error && error.code === "ENOENT"
                        ? `Active Epic child directory was already absent: ${path}`
                        : `Active Epic child directory was left in place because it is missing protected cleanup preconditions or is not empty: ${path}. ${error instanceof Error ? error.message : String(error)}`;
            }
        }
        return { archived, cleanupMessage };
    });
}
