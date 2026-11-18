import {
    SYSTEM_WORK_RECORD_MNEMOTECA_PORT,
    type WorkRecordMnemotecaPort,
} from "../shared/work-records/mnemoteca-port.ts";
import { pruneWorkRecordIndex } from "../shared/work-records/index-adapter.ts";
import { pruneEffect } from "./prune-effects.ts";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { currentPackageProject } from "./workflows.ts";
import { readLocalHomeStore } from "./access.ts";
import { collectArchivedPlanUnits, type ArchivedPlanUnit } from "./archive-retention.ts";
import { selectArchivedPlansForPrune, type ArchiveRetentionPolicy } from "./retention-selection.ts";
import { getPlanArchiveRetentionPolicy, getWorkRecordRetentionPolicy } from "../shared/settings.js";
import { deleteWorkRecord, listLocalWorkRecords } from "../shared/work-records/store.ts";
import { unfinishedRecordingPins } from "../shared/work-records/package-recording.ts";
import { assertWorkRecordPath, withWorkRecordMutation } from "../shared/work-records/owner.ts";
import { readWorkRecordLocations } from "../shared/work-records/import.ts";
import { withPlanCatalogLock, deleteArchivedPlanUnit } from "../plan-store.js";
import {
    isHomeProjectOwner,
    inspectHomeProjectOwner,
    inspectProjectIdentity,
    type ProjectStoreIdentity,
} from "../shared/project-identity.ts";
import {
    listPlanPackages,
    packageWorkflowRevision,
    readPlanPackagePublication,
    readPlanImportEvidence,
    withPlanPackageCatalogDiscovery,
    withPlanPackageLocks,
    prunePackageFamily,
    type LoadedPlanPackage,
} from "./packages.ts";
import { managedPersonalStoreActive, requestManagedRetention } from "./managed.ts";

export type RetentionKind = "plans" | "records";
export interface PruneCopy {
    repositoryId: string;
    path: string;
    digest: string;
    sourcePath?: string;
}
export interface PruneResult {
    deleted: boolean;
    indexWarning?: string;
    copies: PruneCopy[];
}
export interface RecordCandidate {
    recordId: string;
    title: string;
    token: string;
}
export interface RetentionPolicies {
    plans: ArchiveRetentionPolicy;
    records: ArchiveRetentionPolicy;
}
const digest = (text: string | Buffer) => createHash("sha256").update(text).digest("hex");
export function retentionPolicies(cwd: string): RetentionPolicies {
    return { plans: getPlanArchiveRetentionPolicy(cwd), records: getWorkRecordRetentionPolicy(cwd) };
}
export async function readExecutionRetention(cwd: string) {
    const policy = retentionPolicies(cwd);
    const registry = await (await import("../shared/worktree-registry.js")).inspectWorktreeRegistry(cwd);
    if (registry.readError || registry.integrityIssues.length)
        throw new Error("Cannot verify retention while the execution registry needs repair.");
    const { isPublicationAttemptCleanupComplete } = await import("../shared/workflow/publication-attempt.ts");
    const pending = registry.entries.flatMap((entry) =>
        entry.publication && !isPublicationAttemptCleanupComplete(entry.publication)
            ? [
                  {
                      planId: entry.publication.planId,
                      attemptId: entry.publication.attemptId,
                      source: entry.publication.packageInput,
                  },
              ]
            : [],
    );
    return { policy, pending };
}
export type RetentionContext = Awaited<ReturnType<typeof readExecutionRetention>>;
function archived(plan: LoadedPlanPackage) {
    return Boolean(plan.metadata.archive && !plan.metadata.archive.restoredAt);
}
async function catalogIn(owner?: ProjectStoreIdentity) {
    if (!owner) return [];
    const catalog = await listPlanPackages(owner, true);
    if (catalog.issues.length) throw new Error(catalog.issues[0].message);
    return catalog.packages;
}
function familyOf(root: LoadedPlanPackage, catalog: LoadedPlanPackage[]) {
    const ids = new Set([root.metadata.planId]);
    for (const id of ids)
        for (const plan of catalog) if (plan.metadata.parentPlanId === id) ids.add(plan.metadata.planId);
    return catalog
        .filter((plan) => ids.has(plan.metadata.planId))
        .sort((a, b) => a.metadata.planId.localeCompare(b.metadata.planId));
}
async function state(cwd: string, context: RetentionContext, empty = false) {
    const owner = currentPackageProject();
    const { policy } = context;
    const catalog = empty ? [] : await catalogIn(owner);
    const records = empty ? [] : await listLocalWorkRecords(cwd, { createDir: false });
    const pins = await unfinishedRecordingPins();
    for (const attempt of context.pending) {
        pins.plans.add(attempt.planId);
        pins.attempts.add(attempt.attemptId);
        if (owner && attempt.source && attempt.source.repositoryId === owner.repositoryId)
            for (const member of (await readPlanPackagePublication(owner, attempt.source)).members)
                pins.plans.add(member.metadata.planId);
    }
    for (const { metadata } of catalog) {
        const workflow = metadata.workflow;
        if (owner && isHomeProjectOwner(owner) && metadata.references.legacyImport) {
            const original = await (
                await import("./retained-managed-execution.ts")
            ).readRetainedManagedExecution(owner, metadata.planId);
            if (original && !original.cleanupComplete && !original.abandonmentComplete) pins.plans.add(metadata.planId);
        }
        if (workflow?.attempt) {
            pins.plans.add(metadata.planId);
            for (const input of workflow.attempt.input.inputs) pins.plans.add(input.planId);
        }
        for (const ref of [workflow?.publication, workflow?.recordingPreparation, workflow?.recordingSource]) {
            if (!ref || !owner) continue;
            if (!(
                pins.attempts.has(ref.attemptId) ||
                workflow?.workRecord?.status === "failed" ||
                (ref === workflow?.publication && workflow?.delivery?.source.digest !== ref.digest)
            ))
                continue;
            pins.plans.add(metadata.planId);
            const sourceOwner =
                ref.repositoryId === owner.repositoryId
                    ? owner
                    : inspectHomeProjectOwner(owner.projectId, ref.repositoryId);
            const manifest = await readPlanPackagePublication(sourceOwner, ref);
            for (const member of manifest.members) pins.plans.add(member.metadata.planId);
        }
    }
    const units: ArchivedPlanUnit[] = [];
    if (owner) {
        for (const plan of catalog.filter((p) => archived(p) && !p.metadata.parentPlanId)) {
            const family = familyOf(plan, catalog);
            units.push({
                name: plan.metadata.name,
                planId: plan.metadata.planId,
                archivedAt: plan.metadata.archive!.archivedAt,
                paths: family.map((p) => p.metadata.name),
                token: digest(
                    JSON.stringify([
                        owner.projectId,
                        owner.repositoryId,
                        owner.personalOwner.identity,
                        family.map((p) => [p.metadata.planId, packageWorkflowRevision(p)]),
                    ]),
                ),
                protected: family.some((p) => !archived(p) || pins.plans.has(p.metadata.planId)),
            });
        }
    } else if (!empty) {
        for (const unit of await collectArchivedPlanUnits(cwd))
            units.push({ ...unit, token: digest(JSON.stringify(unit)) });
    }
    const archivedIds = new Set(catalog.filter(archived).map((p) => p.metadata.planId));
    const covered = new Set<string>();
    for (const record of records) for (const id of record.attrs.provenance?.sourcePlans || []) covered.add(id);
    const plans = {
        units,
        policy: policy.plans,
        ...selectArchivedPlansForPrune({ units, workRecordPlanIds: covered, policy: policy.plans, now: new Date() }),
    };
    const sorted = records.toSorted(
        (a, b) =>
            Date.parse(b.attrs.createdAt) - Date.parse(a.attrs.createdAt) ||
            a.attrs.recordId.localeCompare(b.attrs.recordId),
    );
    const candidates = sorted
        .slice(policy.records.keepLast)
        .filter(
            (r) =>
                owner &&
                !pins.records.has(r.attrs.recordId) &&
                !(r.attrs.provenance?.sourcePlans || []).some((id) => archivedIds.has(id) || pins.plans.has(id)) &&
                (policy.records.retentionDays === 0 ||
                    Date.parse(r.attrs.createdAt) <= Date.now() - policy.records.retentionDays * 86400000),
        );
    const due: RecordCandidate[] = await Promise.all(
        candidates.map(async (r) => {
            const stat = await lstat(r.path);
            const token = digest(
                JSON.stringify([
                    owner!.projectId,
                    owner!.repositoryId,
                    owner!.personalOwner.identity,
                    r.markdown,
                    stat.dev,
                    stat.ino,
                    stat.birthtimeMs,
                ]),
            );
            return { recordId: r.attrs.recordId, title: r.title, token };
        }),
    );
    return { plans, records: { due, policy: policy.records }, catalog, resources: records };
}
export type RetentionPreview = Pick<Awaited<ReturnType<typeof state>>, "plans" | "records">;
export async function localRetentionPreview(
    cwd: string,
    context: () => Promise<RetentionContext> = () => readExecutionRetention(cwd),
): Promise<RetentionPreview> {
    const { plans, records } = await readLocalHomeStore(
        cwd,
        async () => state(cwd, await context()),
        () => state(cwd, { policy: retentionPolicies(cwd), pending: [] }, true),
    );
    return { plans, records };
}
async function preview(cwd: string) {
    return managedPersonalStoreActive()
        ? await requestManagedRetention(cwd, { kind: "preview-retention" })
        : await localRetentionPreview(cwd);
}
export async function previewPlanRetention(cwd: string) {
    return (await preview(cwd)).plans;
}
export async function previewRecordRetention(cwd: string) {
    return (await preview(cwd)).records;
}

async function planCopies(owner: ProjectStoreIdentity, family: LoadedPlanPackage[]) {
    const copies: PruneCopy[] = [];
    for (const { metadata } of family) {
        const legacy = metadata.references.legacyImport;
        if (legacy) {
            const evidence = await readPlanImportEvidence(owner, legacy);
            if (evidence.repositoryRelativePath && evidence.repositoryId && evidence.source.digest)
                copies.push({
                    path: evidence.repositoryRelativePath,
                    repositoryId: evidence.repositoryId,
                    digest: evidence.source.digest,
                    sourcePath: evidence.source.path,
                });
        }
        const source = metadata.workflow?.delivery?.source;
        if (!source || source.repositoryId !== owner.repositoryId) continue;
        const manifest = await readPlanPackagePublication(owner, source);
        const name = manifest.members.find((m) => m.metadata.planId === metadata.planId)?.metadata.name;
        for (const copy of manifest.copies)
            if (copy.kind === "plan" && name && dirname(copy.path) === `docs/plans/${name}`)
                copies.push({ path: copy.path, repositoryId: source.repositoryId, digest: digest(copy.text) });
    }
    return copies;
}
export async function localConfirmRetention(
    cwd: string,
    kind: RetentionKind,
    token: string,
    context: () => Promise<RetentionContext> = () => readExecutionRetention(cwd),
    mnemotecaPort: WorkRecordMnemotecaPort = SYSTEM_WORK_RECORD_MNEMOTECA_PORT,
): Promise<PruneResult> {
    const skipped = { deleted: false, copies: [] };
    return await readLocalHomeStore(
        cwd,
        async () => {
            const owner = currentPackageProject();
            const run = async () => {
                const effect = owner ? pruneEffect(kind, token) : undefined;
                const retained = await effect?.read();
                const current = await state(cwd, await context());
                if (retained) {
                    const live =
                        kind === "records"
                            ? current.resources.some((r) => r.attrs.recordId === retained.identity)
                            : current.catalog.some((p) => p.metadata.planId === retained.identity);
                    if (retained.completed || !live) {
                        if (!retained.completed) effect!.write(retained.identity, retained.copies, true);
                        return { deleted: true, copies: live ? [] : retained.copies };
                    }
                }
                if (kind === "records") {
                    const approved = current.records.due.find((r) => r.token === token);
                    if (!approved || !owner) return skipped;
                    const record = current.resources.find((r) => r.attrs.recordId === approved.recordId)!;
                    const locations = await readWorkRecordLocations(approved.recordId);
                    const copies: PruneCopy[] = [];
                    for (const item of locations?.locations || [])
                        if (item.repositoryId && item.repositoryPath)
                            copies.push({
                                path: item.repositoryPath,
                                repositoryId: item.repositoryId,
                                digest: item.digest,
                                sourcePath: item.sourcePath,
                            });
                    effect!.write(approved.recordId, copies, false);
                    assertWorkRecordPath(record.path);
                    await deleteWorkRecord(cwd, record);
                    await (
                        await import("../shared/work-records/import.ts")
                    ).forgetWorkRecordLocations(approved.recordId);
                    effect!.write(approved.recordId, copies, true);
                    const indexWarning = await pruneWorkRecordIndex(cwd, approved.recordId, { mnemotecaPort });
                    return { deleted: true, copies, indexWarning };
                }
                const unit = current.plans.due.find((p) => p.token === token);
                if (!unit) return skipped;
                if (!owner) {
                    await deleteArchivedPlanUnit(cwd, unit.name);
                    return { deleted: true, copies: [] };
                }
                const family = familyOf(
                    current.catalog.find((p) => p.metadata.planId === unit.planId)!,
                    current.catalog,
                );
                const copies = await planCopies(owner, family);
                effect!.write(unit.planId!, copies, false);
                await prunePackageFamily(owner, family);
                effect!.write(unit.planId!, copies, true);
                return { deleted: true, copies };
            };
            if (!owner) return await withPlanCatalogLock(cwd, run);
            return await withPlanPackageCatalogDiscovery(owner, async () =>
                withPlanPackageLocks(
                    owner,
                    (await catalogIn(owner)).map((p) => p.metadata.planId),
                    () => withWorkRecordMutation(run),
                ),
            );
        },
        () => skipped,
    );
}
async function cleanCopy(root: string, copy: PruneCopy) {
    if (
        typeof copy.path !== "string" ||
        isAbsolute(copy.path) ||
        /[:\\]/.test(copy.path) ||
        copy.path.split("/").some((p) => !p || p === "." || p === ".." || p.toLowerCase() === ".git")
    )
        return;
    const path = join(root, copy.path);
    if (copy.sourcePath && resolve(copy.sourcePath) !== path) return;
    for (let cursor = path; ; cursor = dirname(cursor)) {
        const info = await lstat(cursor);
        if (info.isSymbolicLink() || (cursor === path && !info.isFile())) return;
        if (cursor === root) break;
    }
    const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    try {
        const original = await handle.stat();
        if (!original.isFile() || digest(await handle.readFile()) !== copy.digest) return;
        const current = await lstat(path);
        if (
            current.isFile() &&
            original.dev === current.dev &&
            original.ino === current.ino &&
            original.ctimeMs === current.ctimeMs &&
            (await realpath(path)) === path
        )
            await unlink(path);
    } finally {
        await handle.close();
    }
}
export async function settlePruneCopies(cwd: string, kind: RetentionKind, token: string): Promise<PruneResult> {
    return await readLocalHomeStore<PruneResult>(
        cwd,
        () =>
            withWorkRecordMutation(async () => {
                const effect = pruneEffect(kind, token);
                const receipt = await effect.read();
                if (!receipt?.completed) throw new Error("Prune cleanup requires a confirmed canonical deletion.");
                if (receipt.copies.length) effect.write(receipt.identity, [], true);
                return { deleted: true, copies: [] };
            }),
        () => ({ deleted: false, copies: [] }),
    );
}
export async function confirmRetention(
    cwd: string,
    kind: RetentionKind,
    token: string,
    mnemotecaPort?: WorkRecordMnemotecaPort,
) {
    const result = managedPersonalStoreActive()
        ? await requestManagedRetention(cwd, { kind: "confirm-retention", target: kind, token })
        : await localConfirmRetention(cwd, kind, token, undefined, mnemotecaPort);
    if (result.indexWarning) console.warn(result.indexWarning);
    if (result.deleted && result.copies.length) {
        const binding = inspectProjectIdentity(cwd);
        if (binding.kind === "existing") {
            for (const copy of result.copies)
                if (copy.repositoryId === binding.identity.repositoryId)
                    await cleanCopy(binding.identity.checkoutRoot, copy).catch(() => {});
            if (managedPersonalStoreActive())
                await requestManagedRetention(cwd, { kind: "settle-prune-copies", target: kind, token });
            else await settlePruneCopies(cwd, kind, token);
        }
    }
    return result.deleted;
}
