import { hasRetainedCheckoutSource, withRetainedCheckoutSource } from "./retained-source.ts";
/** Legacy document inventory and evidence capture. Persistence belongs to plan-package-store. */
import fs from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { extractYaml, type FrontMatterRecord } from "../shared/front-matter.ts";
import { EPIC_ARTIFACT_FILE_NAMES } from "../plan-format.ts";
import { canonicalPlanStatus, getPlanDocumentRoot, normalizePlanId, parsePlanFrontMatter } from "../plan-store.ts";
import { PlanPackageError } from "./packages.ts";
import { resolveWorkflowPlanLocation, WorkflowPlanDocumentUnavailable } from "./location.ts";
import {
    controllerRecordPath,
    inspectControllerView,
    readControllerRecord,
    type ControllerRecord,
} from "./controllers.ts";
import {
    inspectWorktreeRegistry,
    getWorktreeRegistryPath,
    type WorktreeRegistryEntry,
} from "../shared/worktree-registry.ts";
import { resolvePrimaryCheckoutRoot, resolveProjectRoot } from "../shared/project-checkout.ts";
import {
    checkedProjectRuntimeLayout,
    ProjectRuntimeEntryRefusedError,
    withProjectRuntimeReadScope,
} from "../shared/project-runtime-layout.ts";
import type { ProjectIdentity } from "../shared/project-identity.ts";
import type { PackageDocuments, PlanPackageMetadata, PackageDefinition } from "./packages.ts";
import { isPublicationCleanupPending } from "../shared/workflow/publication-attempt.ts";
import { readTargetPlanMarkdown } from "./planning-source.ts";

export interface ImportAllocation {
    locator: string;
    name: string;
    idless: boolean;
    digest: string;
    planId: string;
    createdAt: string;
}
export interface ImportFileEvidence {
    path: string;
    bytes: string | null;
    digest: string | null;
}
export interface LegacyImportEvidence {
    format: "legacy-markdown";
    repositoryId: string | null;
    repositoryRelativePath: string | null;
    source: ImportFileEvidence;
    authority: ImportFileEvidence;
    authorityKind: "selected" | "registered" | "target-snapshot";
    controller: ControllerRecord | null;
    controllerFile: ImportFileEvidence | null;
    registryFile: ImportFileEvidence | null;
    attempts: WorktreeRegistryEntry[];
    pendingControllerRepairs: string[];
    /** Raw fields are historical provenance, never lifecycle admission or executable checks. */
    legacyFields: FrontMatterRecord;
    retainedFields: string[];
}
export interface ImportMember {
    allocation: ImportAllocation;
    metadata: PlanPackageMetadata;
    documents: PackageDocuments;
    evidence: LegacyImportEvidence;
}
interface SelectedImportSource {
    source: ImportFileEvidence;
    authority: ImportFileEvidence;
    authorityKind: LegacyImportEvidence["authorityKind"];
}
export interface PlanImportOptions {
    includeArchived?: true;
}
export interface PreparedPlanImport extends PlanImportOptions {
    selection: string;
    membership: string[];
    members: ImportMember[];
    existingPlanIds: string[];
    allocations: ImportAllocation[];
    observations: ImportFileEvidence[];
    folder?: true;
    archiveExcluded?: true;
    skipped?: SkippedPlanImport[];
}
export interface SkippedPlanImport {
    path: string;
    reason: string;
    action: string;
}
export interface PlanImportCommitted {
    kind: "committed" | "existing";
    planIds: string[];
    importedPlanIds: string[];
    existingPlanIds: string[];
    archiveExcluded?: true;
    skipped?: SkippedPlanImport[];
}
export interface PlanImportIssue {
    kind: "conflict" | "pending" | "unavailable" | "invalid";
    message: string;
}
export type PlanImportResult = PlanImportCommitted | PlanImportIssue;

class PlanImportSourceIssue extends Error {
    constructor(
        readonly kind: "collision" | "pending_recovery",
        reason: string,
        readonly action: string,
    ) {
        super(reason);
    }
}

export function skipPlanImportSource(prepared: PreparedPlanImport, path: string, error: Error): void {
    if (!prepared.folder && error instanceof PlanImportSourceIssue)
        throw new PlanPackageError(error.kind, error.message);
    if (!prepared.folder || error instanceof ProjectRuntimeEntryRefusedError) throw error;
    const skipped = (prepared.skipped ??= []);
    if (skipped.some((entry) => entry.path === path)) return;
    if (error instanceof WorkflowPlanDocumentUnavailable) {
        skipped.push({
            path,
            reason: "RunWield has a saved worktree for this Plan, but could not read the matching Plan file there.",
            action: "Run `wld plans doctor --check` to find the worktree. Restore the Plan from its branch or a backup, then retry.",
        });
        return;
    }
    const action =
        error instanceof PlanImportSourceIssue
            ? error.action
            : error instanceof PlanPackageError && error.kind === "pending_recovery"
              ? "Run `wld plans doctor --check` to inspect the saved Plan and worktree, then retry."
              : "Review the named file or conflicting Plan, then retry the import.";
    skipped.push({ path, reason: error.message, action });
}

/** Keep canonical links only when all Plans they point to will exist after this import. */
export function omitBlockedPlanImports(prepared: PreparedPlanImport, catalog: ImportCatalogEntry[]): void {
    if (!prepared.folder) return;
    const present = new Set([
        ...catalog.map(({ metadata }) => metadata.planId),
        ...prepared.members.map(({ metadata }) => metadata.planId),
    ]);
    let blocked: ImportMember[];
    do {
        blocked = prepared.members.filter(({ metadata }) =>
            [metadata.parentPlanId, ...metadata.dependencyPlanIds].some((id) => id && !present.has(id)),
        );
        for (const member of blocked) {
            const missing = [member.metadata.parentPlanId, ...member.metadata.dependencyPlanIds].find(
                (id) => id && !present.has(id),
            );
            const linked = prepared.allocations.find(({ planId }) => planId === missing);
            (prepared.skipped ??= []).push({
                path: member.evidence.source.path,
                reason: linked
                    ? `This Plan refers to ${linked.name}, which could not be imported.`
                    : "This Plan refers to another Plan that could not be imported.",
                action: "Recover the related Plan and retry the folder import so RunWield can save the link.",
            });
        }
        for (const { metadata } of blocked) present.delete(metadata.planId);
        if (blocked.length) prepared.members = prepared.members.filter(({ metadata }) => present.has(metadata.planId));
    } while (blocked.length);
    const accepted = new Set([...prepared.existingPlanIds, ...prepared.members.map(({ metadata }) => metadata.planId)]);
    prepared.allocations = prepared.allocations.filter(({ planId }) => accepted.has(planId));
}

const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
function refused(message: string): never {
    throw new PlanPackageError("malformed_metadata", message);
}
function pending(message: string): never {
    throw new PlanPackageError("pending_recovery", message);
}
function within(root: string, path: string): boolean {
    const rel = relative(root, path);
    return !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`);
}
/** Reject symbolic links in the entire selected path, including ancestor directories. */
async function safeSource(path: string, root?: string): Promise<void> {
    for (let cursor = path; ; cursor = dirname(cursor)) {
        const info = await fs.lstat(cursor);
        if (info.isSymbolicLink())
            throw new PlanPackageError("unsafe_path", `Import source contains a symbolic link: ${cursor}`);
        if (cursor === root || dirname(cursor) === cursor) break;
    }
}
export async function inspectImportFile(path: string, root?: string): Promise<ImportFileEvidence> {
    try {
        await safeSource(path, root);
        if (!(await fs.lstat(path)).isFile()) refused(`Import evidence is not a regular file: ${path}`);
        const bytes = await fs.readFile(path);
        return { path, bytes: bytes.toString("base64"), digest: hash(bytes) };
    } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT")
            return { path, bytes: null, digest: null };
        throw error;
    }
}
function text(file: ImportFileEvidence): string {
    if (file.bytes === null) pending(`Import document is unavailable: ${file.path}`);
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(Buffer.from(file.bytes, "base64"));
}
async function inventory(
    selection: string,
    skip?: (path: string, error: Error) => void,
    exclude?: (path: string) => boolean,
): Promise<string[]> {
    await safeSource(selection);
    const info = await fs.lstat(selection);
    if (info.isFile()) {
        if (!selection.toLowerCase().endsWith(".md")) refused("Import selects a Markdown file or a folder.");
        return [selection];
    }
    if (!info.isDirectory()) refused("Import selects a regular file or folder.");
    const result: string[] = [];
    for (const entry of (await fs.readdir(selection, { withFileTypes: true })).sort((a, b) =>
        a.name.localeCompare(b.name),
    )) {
        const path = join(selection, entry.name);
        if (exclude?.(path)) continue;
        try {
            if (entry.isSymbolicLink())
                throw new PlanPackageError(
                    "unsafe_path",
                    "This path is a symbolic link. RunWield import reads regular files.",
                );
            if (entry.isDirectory()) result.push(...(await inventory(path, skip, exclude)));
            else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) result.push(path);
        } catch (error) {
            if (!skip || !(error instanceof Error)) throw error;
            skip(path, error);
        }
    }
    return result;
}

function isRepositoryArchivePath(path: string, primaryRoot: string): boolean {
    const checkout = path.replaceAll("\\", "/").match(/^(.*)\/docs\/plans\/archived(?:\/|$)/)?.[1];
    return !!checkout && resolveProjectRoot(resolvePrimaryCheckoutRoot(checkout)) === primaryRoot;
}
function document(markdown: string) {
    const prefix = /^\ufeff?(?:---(?:yaml)?|= yaml =)\s*\r?\n/.exec(markdown);
    let raw: FrontMatterRecord = {};
    let body = markdown;
    if (prefix) {
        const close = /^(?:---|= yaml =)[ \t]*\r?$(?:\n|$)/m.exec(markdown.slice(prefix[0].length));
        if (!close) refused("Unclosed Markdown front matter; repair it before importing.");
        raw = extractYaml(markdown).attrs;
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) refused("Front matter must be a mapping.");
        body = markdown.slice(prefix[0].length + close.index + close[0].length);
    }
    const legacy = ["planId", "classification", "workKind", "parentPlan", "executionAgent", "worktreeId"].some((key) =>
        Object.hasOwn(raw, key),
    );
    if (!legacy)
        return { legacy, raw, body: markdown, attrs: parsePlanFrontMatter("", { missingOrigin: "external" }).attrs };
    if (raw.planId != null && (typeof raw.planId !== "string" || normalizePlanId(raw.planId) !== raw.planId))
        refused("Invalid legacy Plan ID.");
    if (raw.status != null && (typeof raw.status !== "string" || !canonicalPlanStatus(raw.status)))
        refused("Unsupported legacy Plan status.");
    if (raw.classification != null && !["PROJECT", "PLANNED_CHANGE", "FEATURE"].includes(String(raw.classification)))
        refused("Unsupported legacy Plan classification.");
    if (raw.type != null && !["epic", "sequence"].includes(String(raw.type))) refused("Unsupported legacy Plan type.");
    for (const key of ["parentPlan", "createdAt", "archivedAt", "archiveReason", "restoredAt"]) {
        if (raw[key] != null && typeof raw[key] !== "string" && !(raw[key] instanceof Date))
            refused(`Invalid legacy ${key}.`);
    }
    for (const key of ["dependencies", "affectedPaths"]) {
        if (raw[key] != null && (!Array.isArray(raw[key]) || !raw[key].every((item) => typeof item === "string")))
            refused(`Invalid legacy ${key}.`);
    }
    if (raw.order != null && (!Number.isSafeInteger(raw.order) || Number(raw.order) < 0))
        refused("Invalid legacy order.");
    const attrs = parsePlanFrontMatter(markdown).attrs;
    if (raw.tickets != null && (!Array.isArray(raw.tickets) || attrs.tickets?.length !== raw.tickets.length))
        refused("Invalid legacy Tickets; no entries were imported.");
    if (raw.supersedes != null && (!Array.isArray(raw.supersedes) || (raw.supersedes.length > 0 && !attrs.supersedes)))
        refused("Invalid legacy supersedes references.");
    return { legacy, raw, body, attrs };
}
const definitionKeys = [
    "summary",
    "workKind",
    "complexity",
    "affectedPaths",
    "executionAgent",
    "collaborationRecommendation",
    "frontend",
    "devServerCommand",
    "devServerUrl",
    "devServerHmr",
    "origin",
    "targetBranch",
    "order",
    "userVerifiedAt",
    "userVerificationNote",
    "heldFromStatus",
    "heldAt",
    "holdReason",
    "type",
    "tickets",
    "supersedes",
    "planDeviations",
    "deliveryBranch",
    "closedWithoutVerificationReason",
    "closedWithoutVerificationAt",
    "epicCompletionMode",
    "epicDoneEnoughAt",
    "epicDoneEnoughSummary",
    "epicBaseCommit",
    "epicDeliveryTargetBranch",
    "epicIntegrationReport",
] as const;
function planName(value: string): string {
    return value
        .replaceAll("\\", "/")
        .replace(/^archived\//, "")
        .replace(/\.md$/i, "");
}

function namesCollide(left: string, right: string): boolean {
    if (left.toLowerCase() === right.toLowerCase()) return true;
    const leftParts = left.split("/"),
        rightParts = right.split("/");
    for (let index = 0; index < Math.min(leftParts.length, rightParts.length); index++) {
        if (leftParts[index] !== rightParts[index])
            return leftParts[index].toLowerCase() === rightParts[index].toLowerCase();
    }
    return false;
}

/** Capture is repeated before the store writes its durable publication intent. It never enters runtime or repairs it. */
export async function preparePlanPackageImport(
    identity: ProjectIdentity,
    selection: string,
    allocations: ImportAllocation[],
    catalog: ImportCatalogEntry[],
    createdAt: string,
    options: PlanImportOptions = {},
): Promise<PreparedPlanImport> {
    if (!hasRetainedCheckoutSource(identity.checkoutRoot))
        return await withRetainedCheckoutSource(identity, () =>
            preparePlanPackageImport(identity, selection, allocations, catalog, createdAt, options),
        );
    if (!isAbsolute(selection) || selection.split(/[\\/]/).includes(".."))
        throw new PlanPackageError("unsafe_path", "Select an absolute path without traversal.");
    selection = resolve(selection);
    const plansRoot = join(identity.checkoutRoot, "docs", "plans");
    const primaryRoot = resolveProjectRoot(resolvePrimaryCheckoutRoot(identity.checkoutRoot));
    const explicitlySelectedArchive = isRepositoryArchivePath(selection, primaryRoot);
    const result: PreparedPlanImport = {
        selection,
        membership: [],
        members: [],
        existingPlanIds: [],
        allocations: [],
        observations: [],
        ...(options.includeArchived ? { includeArchived: true } : {}),
    };
    const targetSources = new Map<string, SelectedImportSource>();
    try {
        if ((await fs.lstat(selection)).isDirectory()) result.folder = true;
        result.membership = await inventory(
            selection,
            result.folder ? (path, error) => skipPlanImportSource(result, path, error) : undefined,
            !options.includeArchived && !explicitlySelectedArchive
                ? (path) => {
                      if (!isRepositoryArchivePath(path, primaryRoot)) return false;
                      result.archiveExcluded = true;
                      return true;
                  }
                : undefined,
        );
    } catch (error) {
        if (
            !(error instanceof Error && "code" in error && error.code === "ENOENT") ||
            !within(plansRoot, selection) ||
            !selection.endsWith(".md")
        )
            throw error;
        const name = planName(relative(plansRoot, selection));
        const located = await resolveWorkflowPlanLocation(identity.checkoutRoot, name, {
            readOnly: true,
            loadFromTarget: true,
        });
        if (!located.plan || !located.publishedSnapshot)
            pending(`Selected Plan has no locally available target snapshot: ${name}`);
        const bytes = Buffer.from(located.plan.markdown);
        const source = { path: selection, bytes: bytes.toString("base64"), digest: hash(bytes) };
        targetSources.set(selection, {
            source,
            authority: { ...source, path: located.plan.path },
            authorityKind: "target-snapshot",
        });
        result.membership = [selection];
    }
    const selectedDirectory = result.folder ? selection : dirname(selection);
    const names = new Map<string, Set<string>>();
    const rememberName = (name: string, id: string) => names.set(name, new Set([...(names.get(name) || []), id]));
    for (const existing of catalog) rememberName(existing.metadata.name, existing.metadata.planId);
    for (const allocation of allocations)
        if (catalog.some((p) => p.metadata.planId === allocation.planId))
            rememberName(allocation.name, allocation.planId);
    const selectedIds = new Map<string, SelectedImportSource>();
    const artifacts = new Map<ImportFileEvidence, string>();
    const conflictingIds = new Set<string>();
    const queued = new Set(result.membership);
    const observe = async (path: string) => {
        const targetSource = targetSources.get(path);
        const source = targetSource?.source || (await inspectImportFile(path));
        result.observations.push(source);
        let sourceRoot = identity.checkoutRoot;
        let sourcePlansRoot = plansRoot;
        if (path.replaceAll("\\", "/").includes("/docs/plans/")) {
            const candidate = getPlanDocumentRoot(path);
            if (
                (await fs.realpath(resolvePrimaryCheckoutRoot(candidate))) ===
                (await fs.realpath(resolvePrimaryCheckoutRoot(identity.checkoutRoot)))
            ) {
                sourceRoot = candidate;
                sourcePlansRoot = join(candidate, "docs", "plans");
            }
        }
        const sourceRelativePath = relative(within(sourcePlansRoot, path) ? sourcePlansRoot : selectedDirectory, path);
        if (EPIC_ARTIFACT_FILE_NAMES.includes(basename(path))) {
            artifacts.set(source, planName(dirname(sourceRelativePath)));
            return;
        }
        const repositoryRelativePath = within(sourceRoot, path)
            ? relative(sourceRoot, path).replaceAll("\\", "/")
            : null;
        const locator = repositoryRelativePath
            ? `repository:${identity.repositoryId}:${repositoryRelativePath}`
            : `file:${path}`;
        const previous =
            allocations.find((item) => item.locator === locator) ||
            result.allocations.find((item) => item.locator === locator);
        const selected = document(text(source));
        if (
            result.folder &&
            !options.includeArchived &&
            !explicitlySelectedArchive &&
            selected.attrs.archivedAt &&
            !selected.attrs.restoredAt
        ) {
            result.archiveExcluded = true;
            return;
        }
        if (previous && previous.idless && previous.digest !== source.digest)
            throw new PlanPackageError("collision", `Source changed since import: ${path}`);
        const id = selected.attrs.planId || previous?.planId || randomUUID();
        if (previous && previous.planId !== id)
            throw new PlanPackageError("collision", `Source identity changed: ${path}`);
        const name = planName(sourceRelativePath);
        const archivedSource = within(join(sourcePlansRoot, "archived"), path);
        const allocation = previous || {
            locator,
            name,
            idless: !selected.attrs.planId,
            digest: source.digest!,
            planId: id,
            createdAt,
        };
        result.allocations.push(allocation);
        rememberName(name, id);
        let authority = targetSource?.authority || source;
        let authorityKind: LegacyImportEvidence["authorityKind"] = targetSource?.authorityKind || "selected";
        let controller: ControllerRecord | null = null;
        let controllerFile: ImportFileEvidence | null = null;
        let registryFile: ImportFileEvidence | null = null;
        let attempts: WorktreeRegistryEntry[] = [];
        let pendingControllerRepairs: string[] = [];
        if (selected.legacy && within(sourcePlansRoot, path)) {
            await checkedProjectRuntimeLayout(identity.checkoutRoot);
            const registry = await inspectWorktreeRegistry(identity.checkoutRoot);
            if (registry.readError || registry.integrityIssues.length)
                pending("Workflow registry evidence is unavailable or ambiguous.");
            registryFile = await inspectImportFile(
                getWorktreeRegistryPath(identity.checkoutRoot),
                identity.executionAccountHome,
            );
            attempts = registry.entries.filter((entry) => entry.planId === id || entry.planName === name);
            if (
                !archivedSource ||
                attempts.some(
                    (entry) => entry.status !== "abandoned" && !isPublicationCleanupPending(entry.publication),
                )
            ) {
                const located = await resolveWorkflowPlanLocation(identity.checkoutRoot, name, {
                    readOnly: true,
                    loadFromTarget: true,
                });
                const archivedPath =
                    located.archived && archivedSource
                        ? join(located.documentRoot, "docs", "plans", "archived", `${name}.md`)
                        : null;
                if (located.missingExecutionCheckout)
                    throw new WorkflowPlanDocumentUnavailable(`The saved execution checkout is missing for ${name}.`);
                if (!located.plan && !archivedPath)
                    throw new PlanImportSourceIssue(
                        "pending_recovery",
                        "RunWield could not find the Plan version it needs from the saved worktree or target branch.",
                        "Check that the Plan exists on its target branch or in its saved worktree, then retry the import.",
                    );
                if (located.plan?.readAvailability?.kind === "pending") {
                    const idlessDraft = !selected.attrs.planId && !attempts.length && located.plan.path === source.path;
                    const view = idlessDraft
                        ? await inspectControllerView(identity.checkoutRoot, { planName: name }, selected.attrs)
                        : null;
                    if (!view || view.pendingRepairs.length) pending(`Workflow evidence is pending: ${name}`);
                }
                if (
                    (located.plan?.attrs.planId && located.plan.attrs.planId !== id) ||
                    (archivedPath &&
                        attempts.some(
                            (entry) => entry.path === located.documentRoot && entry.planId && entry.planId !== id,
                        ))
                )
                    pending(`The authoritative Plan identity differs: ${name}`);
                if (
                    !located.publishedSnapshot &&
                    (await fs.realpath(resolvePrimaryCheckoutRoot(located.documentRoot))) !==
                        (await fs.realpath(resolvePrimaryCheckoutRoot(identity.checkoutRoot)))
                )
                    pending(`The authoritative document is not bound to this repository: ${name}`);
                if (located.publishedSnapshot) {
                    const bytes = Buffer.from(located.plan!.markdown);
                    authority = { path: located.plan!.path, bytes: bytes.toString("base64"), digest: hash(bytes) };
                    authorityKind = "target-snapshot";
                } else {
                    authority = await inspectImportFile(archivedPath || located.plan!.path);
                    authorityKind = authority.path === source.path ? "selected" : "registered";
                }
            }
            const workflowIdentity = { planId: selected.attrs.planId, planName: name };
            controller = await readControllerRecord(identity.checkoutRoot, workflowIdentity);
            if (controller) {
                const archivedController =
                    archivedSource &&
                    selected.attrs.planId === id &&
                    controller.planName === `archived/${name}` &&
                    controller.planId === id;
                if (
                    (!archivedController && controller.planName !== name) ||
                    (controller.planId && controller.planId !== id)
                )
                    pending(`Saved workflow identity does not match the Plan at ${path}.`);
            }
            controllerFile = await inspectImportFile(
                controllerRecordPath(identity.checkoutRoot, workflowIdentity),
                identity.executionAccountHome,
            );
            const view = await inspectControllerView(identity.checkoutRoot, workflowIdentity, selected.attrs);
            pendingControllerRepairs = view.pendingRepairs;
        }
        const parsed = document(text(authority));
        if (selected.legacy && (!parsed.legacy || (parsed.attrs.planId && parsed.attrs.planId !== id)))
            pending(`Authoritative document changed identity: ${name}`);

        // A published child can name a sibling added after this checkout diverged from the Epic branch.
        const targetCommit =
            authorityKind === "target-snapshot" && authority.path.match(/^([0-9a-f]{40,64}):docs\/plans\//)?.[1];
        const parent = parsed.attrs.parentPlan && planName(parsed.attrs.parentPlan);
        if (result.folder && targetCommit && parent) {
            for (const dependency of parsed.attrs.dependencies || []) {
                const reference = planName(dependency);
                const sibling = reference.includes("/") ? reference : `${parent}/${reference}`;
                if (dirname(sibling) !== parent || names.has(reference) || names.has(sibling)) continue;
                const siblingPath = join(sourcePlansRoot, `${sibling}.md`);
                if (!within(selection, siblingPath) || queued.has(siblingPath)) continue;
                const snapshot = await readTargetPlanMarkdown(sourceRoot, sibling, targetCommit);
                if (!snapshot) continue;
                const dependencyPlan = document(snapshot.markdown);
                if (!dependencyPlan.attrs.planId || dependencyPlan.attrs.parentPlan !== parsed.attrs.parentPlan)
                    continue;
                const bytes = Buffer.from(snapshot.markdown);
                const relatedSource = { path: siblingPath, bytes: bytes.toString("base64"), digest: hash(bytes) };
                targetSources.set(siblingPath, {
                    source: relatedSource,
                    authority: { ...relatedSource, path: `${targetCommit}:${snapshot.relativePath}` },
                    authorityKind: "target-snapshot",
                });
                queued.add(siblingPath);
                result.membership.push(siblingPath);
            }
        }
        if (catalog.some((item) => item.metadata.planId === id)) {
            const duplicate = selectedIds.get(id);
            if (
                duplicate &&
                duplicate.source.digest !== source.digest &&
                ((authorityKind !== "registered" && duplicate.authorityKind !== "registered") ||
                    duplicate.authority.path !== authority.path ||
                    duplicate.authority.digest !== authority.digest)
            )
                throw new PlanPackageError("collision", `Conflicting selected sources for existing Plan ID: ${id}`);
            selectedIds.set(id, { source, authority, authorityKind });
            result.existingPlanIds.push(id);
            return;
        }
        const definition: PackageDefinition = {
            classification: parsed.legacy
                ? parsed.attrs.classification === "PROJECT"
                    ? "PROJECT"
                    : "PLANNED_CHANGE"
                : "PLANNED_CHANGE",
            status: parsed.legacy ? parsed.attrs.status : "draft",
        };
        if (parsed.legacy) {
            for (const key of definitionKeys) {
                const value = parsed.attrs[key];
                if (value !== undefined && value !== null) Object.assign(definition, { [key]: value });
            }
        } else definition.origin = "external";
        const archived = parsed.attrs.archivedAt;
        const metadata: PlanPackageMetadata = {
            version: 1,
            planId: id,
            name,
            revision: 1,
            createdAt:
                parsed.legacy && parsed.raw.createdAt != null ? String(parsed.attrs.createdAt) : allocation.createdAt,
            parentPlanId: null,
            dependencyPlanIds: [],
            definition,
            controller: {},
            references: {
                sessionIds:
                    Array.isArray(parsed.raw.sessionIds) &&
                    parsed.raw.sessionIds.every((value) => typeof value === "string")
                        ? ([...parsed.raw.sessionIds] as string[])
                        : typeof parsed.raw.sessionId === "string"
                          ? [parsed.raw.sessionId]
                          : [],
            },
            archive:
                archived || archivedSource
                    ? {
                          archivedAt: archived ? String(archived) : "",
                          reason: parsed.attrs.archiveReason || "",
                          ...(parsed.attrs.restoredAt ? { restoredAt: String(parsed.attrs.restoredAt) } : {}),
                          ...(parsed.attrs.archivedFromStatus ? { fromStatus: parsed.attrs.archivedFromStatus } : {}),
                          ...(parsed.attrs.archivedFromPath ? { fromPath: parsed.attrs.archivedFromPath } : {}),
                          ...(parsed.attrs.restoredFromPath ? { restoredFromPath: parsed.attrs.restoredFromPath } : {}),
                      }
                    : null,
        };
        const duplicate = result.members.find((member) => member.metadata.planId === id);
        if (duplicate) {
            if (
                conflictingIds.has(id) ||
                (authorityKind !== "registered" && duplicate.evidence.authorityKind !== "registered") ||
                duplicate.evidence.authority.path !== authority.path ||
                duplicate.evidence.authority.digest !== authority.digest
            ) {
                const error = new PlanPackageError(
                    "collision",
                    "Multiple files claim this Plan ID with different content.",
                );
                skipPlanImportSource(result, duplicate.evidence.source.path, error);
                conflictingIds.add(id);
                throw error;
            }
            return;
        }
        result.members.push({
            allocation,
            metadata,
            documents: {
                "context.md": parsed.body,
                "validation.md": "Use the verification instructions in context.md.\n",
            },
            evidence: {
                format: "legacy-markdown",
                repositoryId: repositoryRelativePath ? identity.repositoryId : null,
                repositoryRelativePath,
                source,
                authority,
                authorityKind,
                controller,
                controllerFile,
                registryFile,
                attempts,
                pendingControllerRepairs,
                legacyFields: parsed.raw,
                retainedFields: Object.keys(parsed.raw).filter(
                    (key) =>
                        !definitionKeys.includes(key as (typeof definitionKeys)[number]) &&
                        !["planId", "status", "classification", "createdAt", "parentPlan", "dependencies"].includes(
                            key,
                        ),
                ),
            },
        });
    };
    // Each capture, including the verification before commit, checks the runtime afresh.
    await withProjectRuntimeReadScope(
        async () => {
            for (const path of result.membership) {
                try {
                    await observe(path);
                } catch (error) {
                    if (!(error instanceof Error)) throw error;
                    skipPlanImportSource(result, path, error);
                }
            }
        },
        { fresh: true },
    );
    result.members = result.members.filter(({ metadata }) => !conflictingIds.has(metadata.planId));
    // Never guess a suffix or silently choose one of two names/short-name matches.
    const all = [...catalog.map((item) => item.metadata), ...result.members.map((item) => item.metadata)];
    result.members = result.members.filter((member) => {
        try {
            const name = member.metadata.name;
            if (all.some((other) => other.planId !== member.metadata.planId && namesCollide(other.name, name)))
                throw new PlanPackageError("collision", `Plan name already exists: ${name}`);
            const parsed = document(text(member.evidence.authority));
            const legacyArchive = member.metadata.archive?.archivedAt === "" && !member.metadata.archive.restoredAt;
            const relationship = (value: string, allowArchivedSibling = false): string | null => {
                const reference = planName(value);
                const candidates = new Set(
                    [...names]
                        .filter(
                            ([key]) =>
                                key === reference ||
                                (!reference.includes("/") &&
                                    (key === `${planName(parsed.attrs.parentPlan || dirname(name))}/${reference}` ||
                                        (legacyArchive &&
                                            allowArchivedSibling &&
                                            key === `${dirname(name)}/${reference}`))),
                        )
                        .flatMap(([, ids]) => [...ids]),
                );
                // Legacy archive folders can outlive the Plans they referred to. Raw references stay in import evidence.
                if (legacyArchive && candidates.size === 0) return null;
                if (candidates.size === 0)
                    throw new PlanImportSourceIssue(
                        "collision",
                        `This Plan needs ${value}, which is missing from the import folder and the saved Plans.`,
                        "Put the related Plan in the import folder or import the related Plan first, then retry.",
                    );
                if (candidates.size > 1)
                    throw new PlanImportSourceIssue(
                        "collision",
                        `More than one Plan matches the reference ${value}.`,
                        "Update the reference to the intended Plan's full name, then retry.",
                    );
                return [...candidates][0];
            };
            member.metadata.parentPlanId = parsed.attrs.parentPlan ? relationship(parsed.attrs.parentPlan) : null;
            member.metadata.dependencyPlanIds = [
                ...new Set(
                    (parsed.attrs.dependencies || [])
                        .map((value) => relationship(value, true))
                        .filter((id) => id !== null),
                ),
            ];
            return true;
        } catch (error) {
            if (!(error instanceof Error)) throw error;
            skipPlanImportSource(result, member.evidence.source.path, error);
            return false;
        }
    });
    omitBlockedPlanImports(result, catalog);
    for (const [artifact, owner] of artifacts) {
        try {
            const ownerIds = names.get(owner);
            if (!ownerIds || ownerIds.size !== 1)
                refused(`Epic resource has no unambiguous selected or existing Epic: ${artifact.path}`);
            const [ownerId] = ownerIds;
            const member = result.members.find(
                (item) => item.metadata.planId === ownerId && item.metadata.definition.classification === "PROJECT",
            );
            if (member)
                member.documents[basename(artifact.path) as "manual-qa.md" | "integration-report.md"] = text(artifact);
            else if (
                !catalog.some(
                    (item) => item.metadata.planId === ownerId && item.metadata.definition.classification === "PROJECT",
                )
            )
                refused(`Epic resource has no selected or existing Epic: ${artifact.path}`);
        } catch (error) {
            if (!(error instanceof Error)) throw error;
            skipPlanImportSource(result, artifact.path, error);
        }
    }
    result.existingPlanIds = [...new Set(result.existingPlanIds)];
    return result;
}

export async function revalidatePlanImport(
    identity: ProjectIdentity,
    prepared: PreparedPlanImport,
    catalog: ImportCatalogEntry[],
    allocations: ImportAllocation[],
): Promise<void> {
    const current = await preparePlanPackageImport(
        identity,
        prepared.selection,
        [...allocations, ...prepared.allocations],
        catalog,
        prepared.allocations[0]?.createdAt || "",
        prepared,
    );
    if (JSON.stringify(current) !== JSON.stringify(prepared))
        throw new PlanPackageError("changed_input", "Import sources or workflow evidence changed; retry the import.");
    for (const member of prepared.members) {
        for (const evidence of [member.evidence.controllerFile, member.evidence.registryFile]) {
            if (
                evidence &&
                JSON.stringify(await inspectImportFile(evidence.path, identity.executionAccountHome)) !==
                    JSON.stringify(evidence)
            )
                throw new PlanPackageError(
                    "changed_input",
                    "Workflow evidence changed during capture; retry the import.",
                );
        }
    }
}

export interface ImportCatalogEntry {
    metadata: Pick<PlanPackageMetadata, "planId" | "name" | "definition">;
}
export interface ManagedImportPreparationRequest extends PlanImportOptions {
    projectId: string;
    repositoryId: string;
    personalOwner: string;
    selection: string;
    allocations: ImportAllocation[];
    catalog: ImportCatalogEntry[];
    createdAt: string;
    prepared?: PreparedPlanImport;
}
/** The trusted execution process observes source bytes; the personal owner commits packages. */
export async function inspectManagedImportSource(
    identity: ProjectIdentity,
    request: ManagedImportPreparationRequest,
): Promise<PreparedPlanImport> {
    if (
        identity.projectId !== request.projectId ||
        identity.repositoryId !== request.repositoryId ||
        identity.personalOwner.identity !== request.personalOwner
    )
        throw new Error("Import source belongs to another Project or owner.");
    if (request.prepared) {
        if (request.prepared.includeArchived !== request.includeArchived)
            throw new Error("Import archive selection changed.");
        await revalidatePlanImport(identity, request.prepared, request.catalog, request.allocations);
        return request.prepared;
    }
    return await preparePlanPackageImport(
        identity,
        request.selection,
        request.allocations,
        request.catalog,
        request.createdAt,
        request,
    );
}
