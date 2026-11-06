/** Explicit personal Plan packages. Legacy discovery and lifecycle admission remain separate. */
import fs from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { dirname, isAbsolute, join, relative } from "node:path";
import { inspectProjectIdentity, type ProjectIdentity } from "./project-identity.ts";
import { openNativeFileLock, type NativeFileLock } from "./native-file-lock.ts";
import {
    ensurePrivateDir,
    syncParentDirectory,
    writeJsonAtomically,
    writeTextAtomically,
} from "./private-json-file.ts";
import { EPIC_ARTIFACT_FILE_NAMES } from "./epic-artifacts.ts";
import { canonicalPlanStatus, normalizePlanId, StalePlanWriteError } from "../plan-store.js";
import {
    preparePlanPackageImport,
    revalidatePlanImport,
    type ImportAllocation,
    type LegacyImportEvidence,
    type PlanImportResult,
    type PreparedPlanImport,
} from "./plan-package-import.ts";
import type { TicketReference } from "./ticket-references.ts";
import { normalizePlanDeviations, type PlanDeviation } from "./plan-deviations.ts";
import type { WorkflowControllerState } from "./workflow/controller-state.ts";

export type PackageResource = "context.md" | "validation.md" | "manual-qa.md" | "integration-report.md";
export type PackageResourceRole = "context" | "validation" | "manual-qa" | "integration-report";
export interface PackageDocuments {
    "context.md": string;
    "validation.md": string;
    "manual-qa.md"?: string;
    "integration-report.md"?: string;
}
/** Version 1 stores continuation references, not copies of execution registries/checkpoints. */
export interface PackageReferences {
    sessionIds: string[];
    legacyImport?: LegacyImportReference;
    executionAttemptId?: string;
    worktreeId?: string;
    validationCheckpointId?: string;
    workRecordId?: string;
}
export interface LegacyImportReference {
    recordId: string;
    locator: string;
    format: "legacy-markdown";
}
export interface PackageDefinition {
    classification: "PLANNED_CHANGE" | "PROJECT";
    type?: "epic" | "sequence";
    tickets?: TicketReference[];
    supersedes?: string[];
    planDeviations?: PlanDeviation[];
    deliveryBranch?: string;
    closedWithoutVerificationReason?: string;
    closedWithoutVerificationAt?: string;
    epicCompletionMode?: "done_enough";
    epicDoneEnoughAt?: string;
    epicDoneEnoughSummary?: string;
    epicBaseCommit?: string;
    epicDeliveryTargetBranch?: string;
    epicIntegrationReport?: string;
    status: string;
    summary?: string;
    workKind?: string;
    complexity?: string;
    affectedPaths?: string[];
    executionAgent?: string;
    collaborationRecommendation?: string;
    frontend?: boolean;
    devServerCommand?: string;
    devServerUrl?: string;
    devServerHmr?: boolean;
    origin?: string;
    targetBranch?: string;
    order?: number;
    userVerifiedAt?: string;
    userVerificationNote?: string;
    heldFromStatus?: string;
    heldAt?: string;
    holdReason?: string;
}
export type PackageControllerState = Pick<
    WorkflowControllerState,
    | "updatedAt"
    | "executionMode"
    | "validationPhase"
    | "validationCiAttempts"
    | "validationSemanticRounds"
    | "failureReason"
    | "failedAt"
    | "implementedAt"
    | "validatedAt"
    | "verifiedAt"
    | "executionReport"
    | "humanReviewMode"
    | "humanReviewDecision"
    | "humanReviewedAt"
    | "holdStalenessBaseline"
    | "collaborationState"
    | "collaborationServerUrl"
    | "collaborationSpaceId"
    | "collaborationRevision"
    | "collaborationBodyHash"
    | "collaborationSyncedAt"
>;
export interface PackageArchive {
    archivedAt: string;
    reason: string;
    restoredAt?: string;
    fromStatus?: string;
    fromPath?: string;
    restoredFromPath?: string;
}
export interface PlanPackageMetadata {
    version: 1;
    planId: string;
    name: string;
    revision: number;
    createdAt: string;
    parentPlanId: string | null;
    dependencyPlanIds: string[];
    definition: PackageDefinition;
    controller: PackageControllerState;
    references: PackageReferences;
    archive: PackageArchive | null;
}
export interface CreatePlanPackage {
    planId: string;
    name: string;
    documents: PackageDocuments;
    definition?: PackageDefinition;
    controller?: PackageControllerState;
    references?: PackageReferences;
    parentPlanId?: string | null;
    dependencyPlanIds?: string[];
}
export interface PackageMetadataUpdate {
    definition?: PackageDefinition;
    controller?: PackageControllerState;
    references?: PackageReferences;
    parentPlanId?: string | null;
    dependencyPlanIds?: string[];
}
export interface PackageDocument {
    name: PackageResource;
    role: PackageResourceRole;
    bytes: Uint8Array;
    hash: string;
}
export interface LoadedPlanPackage {
    kind: "loaded";
    path: string;
    metadata: PlanPackageMetadata;
    documents: PackageDocument[];
}
export type PackageIssueKind =
    | "missing"
    | "malformed_metadata"
    | "unsupported_metadata"
    | "missing_document"
    | "unsafe_path"
    | "pending_recovery"
    | "unavailable";
export interface PackageIssue {
    kind: PackageIssueKind;
    path: string;
    message: string;
}
export type PackageInspection = LoadedPlanPackage | PackageIssue;
export interface PackageCatalog {
    packages: LoadedPlanPackage[];
    issues: PackageIssue[];
}
export interface PackageSelector {
    planId?: string;
    name?: string;
}
export interface PackageInputReference {
    projectId: string;
    planId: string;
    inputId: string;
}
interface InputResource {
    name: PackageResource;
    role: PackageResourceRole;
    hash: string;
}
export interface PackageInputManifest extends PackageInputReference {
    version: 1;
    metadataRevision: number;
    documents: InputResource[];
}
export interface PackageInput {
    manifest: PackageInputManifest;
    documents: PackageDocument[];
}
interface PackageLayout {
    home: string;
    plans: string;
    internal: string;
    stages: string;
    inputs: string;
    intent: string;
    locks: string;
    imports: string;
    batch: string;
    allocations: string;
}
interface ImportRecord {
    version: 1;
    recordId: string;
    projectId: string;
    prepared: PreparedPlanImport;
}
interface ImportBatch {
    version: 1;
    recordId: string;
    phase: "pending" | "committed";
    members: PackageSelector[];
    record?: ImportRecord;
}
interface PackageIntent {
    version: 1;
    operation: "create" | "rename";
    planId: string;
    from: string;
    to: string;
    resources: PackageResource[];
    metadata: PlanPackageMetadata;
}
type JsonValue = null | string | number | boolean | JsonValue[] | JsonFields;
interface JsonFields {
    [key: string]: JsonValue;
}
const resources: PackageResource[] = ["context.md", "validation.md", "manual-qa.md", "integration-report.md"];
const roles: Record<PackageResource, PackageResourceRole> = {
    "context.md": "context",
    "validation.md": "validation",
    "manual-qa.md": "manual-qa",
    "integration-report.md": "integration-report",
};
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const missing = (error: Error) => "code" in error && error.code === "ENOENT";

export class PlanPackageError extends Error {
    constructor(
        public kind: PackageIssueKind | "collision" | "changed_input",
        message: string,
    ) {
        super(message);
        this.name = "PlanPackageError";
    }
}
function fail(kind: PlanPackageError["kind"], message: string): never {
    throw new PlanPackageError(kind, message);
}
function requireId(id: string): string {
    if (!normalizePlanId(id) || normalizePlanId(id) !== id) fail("malformed_metadata", "Invalid Plan ID.");
    return id;
}
function normalizeName(name: string): string {
    if (typeof name !== "string" || !name || name !== name.trim()) fail("unsafe_path", "Invalid package name.");
    const segments = name.split("/");
    const reserved = ["context", "validation", "plan.wld.json", ...EPIC_ARTIFACT_FILE_NAMES.map((n) => n.slice(0, -3))];
    if (
        segments.some(
            (segment) =>
                !segment ||
                segment === "." ||
                segment === ".." ||
                /[\\<>:"|?*]/.test(segment) ||
                [...segment].some((character) => character.charCodeAt(0) < 32) ||
                /[. ]$/.test(segment) ||
                /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(segment) ||
                reserved.includes(segment.toLowerCase().replace(/\.md$/, "")),
        )
    ) {
        fail("unsafe_path", "Unsafe or reserved package name.");
    }
    return segments.join("/");
}
function layout(identity: ProjectIdentity): PackageLayout {
    if (identity.personalOwner.kind !== "execution-account")
        fail("unavailable", "Managed-remote packages require their personal-store transport.");
    const inspected = inspectProjectIdentity(identity.checkoutRoot, {
        context: {
            executionAccountHome: identity.executionAccountHome,
            personalOwner: identity.personalOwner,
        },
    });
    if (
        inspected.kind !== "existing" ||
        inspected.identity.projectId !== identity.projectId ||
        inspected.identity.repositoryId !== identity.repositoryId ||
        inspected.identity.checkoutId !== identity.checkoutId
    )
        fail("unavailable", "Package operations require an established Project identity.");
    const home = join(identity.executionAccountHome, ".wld", "projects", identity.projectId);
    const internal = join(home, "internal", "plan-packages");
    return {
        home: identity.executionAccountHome,
        plans: join(home, "plans"),
        internal,
        stages: join(internal, "staging"),
        inputs: join(internal, "inputs"),
        intent: join(internal, "intent.json"),
        locks: join(internal, "locks"),
        imports: join(internal, "imports"),
        batch: join(internal, "batch.json"),
        allocations: join(internal, "allocations.json"),
    };
}
async function stat(path: string) {
    try {
        return await fs.lstat(path);
    } catch (error) {
        if (error instanceof Error && missing(error)) return null;
        throw error;
    }
}
async function safe(root: string, path: string): Promise<void> {
    const rel = relative(root, path);
    if (isAbsolute(rel) || rel === ".." || rel.startsWith("../") || rel.startsWith("..\\"))
        fail("unsafe_path", "Path leaves the personal Project store.");
    for (let cursor = path; ; cursor = dirname(cursor)) {
        const info = await stat(cursor);
        if (info?.isSymbolicLink()) fail("unsafe_path", `Symbolic link in package path: ${cursor}`);
        if (cursor === root) break;
    }
}
async function file(root: string, path: string): Promise<Uint8Array | null> {
    await safe(root, path);
    const info = await stat(path);
    if (!info) return null;
    if (!info.isFile()) fail("unsafe_path", `Package resource is not a regular file: ${path}`);
    return fs.readFile(path);
}
function fields(value: JsonValue, allowed: string[]): JsonFields {
    if (
        !value ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        Object.keys(value).some((key) => !allowed.includes(key))
    )
        fail("malformed_metadata", "Invalid metadata fields.");
    return value;
}
function strings(value: JsonValue): boolean {
    return Array.isArray(value) && value.every((v) => typeof v === "string");
}
const definitionStrings = [
    "type",
    "deliveryBranch",
    "closedWithoutVerificationReason",
    "closedWithoutVerificationAt",
    "epicCompletionMode",
    "epicDoneEnoughAt",
    "epicDoneEnoughSummary",
    "epicBaseCommit",
    "epicDeliveryTargetBranch",
    "epicIntegrationReport",
    "summary",
    "workKind",
    "complexity",
    "executionAgent",
    "collaborationRecommendation",
    "devServerCommand",
    "devServerUrl",
    "origin",
    "targetBranch",
    "userVerifiedAt",
    "userVerificationNote",
    "heldFromStatus",
    "heldAt",
    "holdReason",
];
const controllerStrings = [
    "updatedAt",
    "failureReason",
    "failedAt",
    "implementedAt",
    "validatedAt",
    "verifiedAt",
    "executionReport",
    "humanReviewedAt",
    "holdStalenessBaseline",
    "collaborationState",
    "collaborationServerUrl",
    "collaborationSpaceId",
    "collaborationBodyHash",
    "collaborationSyncedAt",
];
const controllerNumbers = ["validationCiAttempts", "validationSemanticRounds", "collaborationRevision"];
const controllerEnums: Record<string, string[]> = {
    executionMode: ["worktree", "non_git_in_place"],
    validationPhase: ["mechanical", "semantic", "delivery"],
    humanReviewMode: ["none", "ask", "always"],
    humanReviewDecision: ["not_required", "skipped", "approved", "changes_requested"],
};
function metadataFrom(value: PlanPackageMetadata): PlanPackageMetadata {
    const data = fields(JSON.parse(JSON.stringify(value)), [
        "version",
        "planId",
        "name",
        "revision",
        "createdAt",
        "parentPlanId",
        "dependencyPlanIds",
        "definition",
        "controller",
        "references",
        "archive",
    ]);
    if (data.version !== 1) fail("unsupported_metadata", "Unsupported Plan package metadata version.");
    if (
        typeof data.planId !== "string" ||
        typeof data.name !== "string" ||
        typeof data.createdAt !== "string" ||
        !Number.isSafeInteger(data.revision) ||
        Number(data.revision) < 1 ||
        !(data.parentPlanId === null || typeof data.parentPlanId === "string") ||
        !strings(data.dependencyPlanIds)
    )
        fail("malformed_metadata", "Invalid package identity, revision, or relationships.");
    requireId(data.planId);
    normalizeName(data.name);
    if (data.parentPlanId !== null) requireId(data.parentPlanId);
    for (const id of data.dependencyPlanIds as string[]) requireId(id);
    const definition = fields(data.definition, [
        "classification",
        "status",
        "affectedPaths",
        "order",
        "frontend",
        "devServerHmr",
        "tickets",
        "supersedes",
        "planDeviations",
        ...definitionStrings,
    ]);
    if (
        !["PLANNED_CHANGE", "PROJECT"].includes(String(definition.classification)) ||
        typeof definition.status !== "string" ||
        canonicalPlanStatus(definition.status) !== definition.status ||
        definitionStrings.some((key) => key in definition && typeof definition[key] !== "string") ||
        ("affectedPaths" in definition && !strings(definition.affectedPaths)) ||
        ("order" in definition && !Number.isSafeInteger(definition.order)) ||
        ["frontend", "devServerHmr"].some((key) => key in definition && typeof definition[key] !== "boolean")
    )
        fail("malformed_metadata", "Invalid package definition.");
    if (
        ("type" in definition && !["epic", "sequence"].includes(String(definition.type))) ||
        ("epicCompletionMode" in definition && definition.epicCompletionMode !== "done_enough") ||
        ("supersedes" in definition && !strings(definition.supersedes))
    )
        fail("malformed_metadata", "Invalid package definition facts.");
    if (
        "tickets" in definition &&
        (!Array.isArray(definition.tickets) ||
            definition.tickets.some(
                (ticket) =>
                    !ticket ||
                    typeof ticket !== "object" ||
                    Array.isArray(ticket) ||
                    typeof ticket.url !== "string" ||
                    !ticket.url.trim(),
            ))
    )
        fail("malformed_metadata", "Invalid package Tickets.");
    if ("planDeviations" in definition) {
        try {
            normalizePlanDeviations(value.definition.planDeviations);
        } catch {
            fail("malformed_metadata", "Invalid package deviations.");
        }
    }
    const controller = fields(data.controller, [
        ...controllerStrings,
        ...controllerNumbers,
        ...Object.keys(controllerEnums),
    ]);
    if (
        controllerStrings.some(
            (key) => key in controller && controller[key] !== null && typeof controller[key] !== "string",
        ) ||
        controllerNumbers.some(
            (key) => key in controller && (!Number.isSafeInteger(controller[key]) || Number(controller[key]) < 0),
        ) ||
        Object.entries(controllerEnums).some(
            ([key, values]) =>
                key in controller && controller[key] !== null && !values.includes(String(controller[key])),
        )
    )
        fail("malformed_metadata", "Invalid package controller state.");
    const refs = fields(data.references, [
        "sessionIds",
        "executionAttemptId",
        "worktreeId",
        "validationCheckpointId",
        "workRecordId",
        "legacyImport",
    ]);
    if (
        !strings(refs.sessionIds) ||
        Object.entries(refs).some(
            ([key, value]) => !["sessionIds", "legacyImport"].includes(key) && (typeof value !== "string" || !value),
        )
    )
        fail("malformed_metadata", "Invalid package references.");
    if (refs.legacyImport !== undefined) {
        const retained = fields(refs.legacyImport, ["recordId", "locator", "format"]);
        if (
            typeof retained.recordId !== "string" ||
            !/^[0-9a-f-]{36}$/.test(retained.recordId) ||
            typeof retained.locator !== "string" ||
            !retained.locator ||
            retained.format !== "legacy-markdown"
        )
            fail("malformed_metadata", "Invalid legacy import reference.");
    }
    if (data.archive !== null) {
        const archive = fields(data.archive, [
            "archivedAt",
            "reason",
            "restoredAt",
            "fromStatus",
            "fromPath",
            "restoredFromPath",
        ]);
        if (
            typeof archive.archivedAt !== "string" ||
            typeof archive.reason !== "string" ||
            ["restoredAt", "fromStatus", "fromPath", "restoredFromPath"].some(
                (key) => key in archive && typeof archive[key] !== "string",
            )
        )
            fail("malformed_metadata", "Invalid archive facts.");
    }
    return value;
}
function parseMetadata(text: Uint8Array): PlanPackageMetadata {
    try {
        return metadataFrom(JSON.parse(new TextDecoder().decode(text)));
    } catch (error) {
        if (error instanceof PlanPackageError) throw error;
        return fail("malformed_metadata", "Malformed Plan package JSON.");
    }
}
function issue(error: Error, path: string): PackageIssue {
    return {
        kind:
            error instanceof PlanPackageError && error.kind !== "collision" && error.kind !== "changed_input"
                ? error.kind
                : "unavailable",
        path,
        message: error.message,
    };
}
async function readIntent(paths: PackageLayout): Promise<PackageIntent | null> {
    const bytes = await file(paths.home, paths.intent);
    if (!bytes) return null;
    try {
        const data: PackageIntent = JSON.parse(new TextDecoder().decode(bytes));
        if (
            data.version !== 1 ||
            !["create", "rename"].includes(data.operation) ||
            !Array.isArray(data.resources) ||
            data.resources.some((name) => !resources.includes(name)) ||
            new Set(data.resources).size !== data.resources.length ||
            !data.resources.includes("context.md") ||
            !data.resources.includes("validation.md")
        )
            throw new Error("intent");
        requireId(data.planId);
        normalizeName(data.to);
        if (data.operation === "rename") normalizeName(data.from);
        else if (!/^[0-9a-f-]{36}$/.test(data.from)) throw new Error("stage");
        data.metadata = metadataFrom(JSON.parse(JSON.stringify(data.metadata)));
        if (data.metadata.planId !== data.planId || data.metadata.name !== data.to) throw new Error("identity");
        return data;
    } catch {
        return fail("pending_recovery", "Package publication intent needs recovery; its evidence is invalid.");
    }
}
async function readDocuments(paths: PackageLayout, directory: string): Promise<PackageDocument[]> {
    const documents: PackageDocument[] = [];
    for (const name of resources) {
        const bytes = await file(paths.home, join(directory, name));
        if (!bytes) {
            if (name === "context.md" || name === "validation.md")
                fail("missing_document", `Missing required document: ${name}`);
        } else documents.push({ name, role: roles[name], bytes, hash: digest(bytes) });
    }
    return documents;
}
async function inspectAt(paths: PackageLayout, name: string): Promise<PackageInspection> {
    const path = join(paths.plans, normalizeName(name));
    try {
        const bytes = await file(paths.home, join(path, "plan.wld.json"));
        if (!bytes) return { kind: "missing", path, message: "Plan package is missing." };
        const metadata = parseMetadata(bytes);
        if (metadata.name !== name) fail("pending_recovery", "Package location and metadata name disagree.");
        const documents = await readDocuments(paths, path);
        return { kind: "loaded", path, metadata, documents };
    } catch (error) {
        if (error instanceof Error) return issue(error, path);
        throw error;
    }
}
async function scanOnce(paths: PackageLayout): Promise<PackageCatalog> {
    const catalog: PackageCatalog = { packages: [], issues: [] };
    let intent: PackageIntent | null;
    try {
        intent = await readIntent(paths);
    } catch (error) {
        if (!(error instanceof Error)) throw error;
        catalog.issues.push(issue(error, paths.intent));
        return catalog;
    }
    if (intent)
        catalog.issues.push({
            kind: "pending_recovery",
            path: paths.intent,
            message: "Package publication is pending recovery.",
        });
    async function walk(path: string): Promise<void> {
        try {
            await safe(paths.home, path);
            if (!(await stat(path))) return;
            const entries = await fs.readdir(path, { withFileTypes: true });
            if (entries.some((entry) => entry.name === "plan.wld.json")) {
                const name = relative(paths.plans, path).replaceAll("\\", "/");
                if (!intent || (name !== intent.to && !(intent.operation === "rename" && name === intent.from))) {
                    const inspected = await inspectAt(paths, name);
                    if (inspected.kind === "loaded") catalog.packages.push(inspected);
                    else catalog.issues.push(inspected);
                }
            }
            for (const entry of entries) {
                if (entry.isSymbolicLink())
                    catalog.issues.push({
                        kind: "unsafe_path",
                        path: join(path, entry.name),
                        message: "Symbolic link in package store.",
                    });
                else if (entry.isDirectory()) await walk(join(path, entry.name));
            }
        } catch (error) {
            if (!(error instanceof Error)) throw error;
            catalog.issues.push(issue(error, path));
        }
    }
    await walk(paths.plans);
    // Passive scans take no locks: publication may have begun while walking the catalog.
    const pending = await readIntent(paths);
    if (pending) {
        catalog.packages = catalog.packages.filter(
            (entry) =>
                entry.metadata.planId !== pending.planId &&
                entry.metadata.name !== pending.to &&
                !(pending.operation === "rename" && entry.metadata.name === pending.from),
        );
        if (!catalog.issues.some((entry) => entry.kind === "pending_recovery"))
            catalog.issues.push({
                kind: "pending_recovery",
                path: paths.intent,
                message: "Package publication is pending recovery.",
            });
    }
    const duplicates = new Set(
        catalog.packages
            .filter((p, i, all) => all.some((other, j) => i !== j && other.metadata.planId === p.metadata.planId))
            .map((p) => p.metadata.planId),
    );
    catalog.packages = catalog.packages.filter((p) => {
        if (!duplicates.has(p.metadata.planId)) return true;
        catalog.issues.push({ kind: "malformed_metadata", path: p.path, message: "Duplicate Plan ID." });
        return false;
    });
    return catalog;
}
async function readBatch(paths: PackageLayout): Promise<ImportBatch | null> {
    const bytes = await file(paths.home, paths.batch);
    if (!bytes) return null;
    try {
        const batch: ImportBatch = JSON.parse(new TextDecoder().decode(bytes));
        if (
            batch.version !== 1 ||
            !/^[0-9a-f-]{36}$/.test(batch.recordId) ||
            !["pending", "committed"].includes(batch.phase) ||
            !Array.isArray(batch.members) ||
            !batch.members.length
        )
            throw new Error("batch");
        for (const member of batch.members) {
            requireId(member.planId!);
            normalizeName(member.name!);
        }
        return batch;
    } catch {
        return fail("pending_recovery", "Import batch evidence is damaged; preserving its packages.");
    }
}
async function scan(paths: PackageLayout): Promise<PackageCatalog> {
    for (let retry = 0; retry < 3; retry++) {
        const before = await readBatch(paths);
        const catalog = await scanOnce(paths);
        const after = await readBatch(paths);
        if (JSON.stringify(before) !== JSON.stringify(after)) continue;
        if (after?.phase === "pending") {
            catalog.packages = catalog.packages.filter(
                (p) =>
                    !after.members.some(
                        (member) => member.planId === p.metadata.planId || member.name === p.metadata.name,
                    ),
            );
            catalog.issues.push({
                kind: "pending_recovery",
                path: paths.batch,
                message: "The selected import batch is pending recovery.",
            });
        }
        return catalog;
    }
    return {
        packages: [],
        issues: [
            {
                kind: "pending_recovery",
                path: paths.batch,
                message: "The package catalog changed during inspection; retry the read.",
            },
        ],
    };
}
export async function listPlanPackages(identity: ProjectIdentity, includeArchived = false): Promise<PackageCatalog> {
    try {
        const catalog = await scan(layout(identity));
        if (!includeArchived)
            catalog.packages = catalog.packages.filter((p) => !p.metadata.archive || p.metadata.archive.restoredAt);
        return catalog;
    } catch (error) {
        if (!(error instanceof Error)) throw error;
        return { packages: [], issues: [issue(error, identity.checkoutRoot)] };
    }
}
async function select(paths: PackageLayout, selector: PackageSelector): Promise<PackageInspection> {
    if (!selector.planId && !selector.name) fail("malformed_metadata", "A Plan ID or name is required.");
    if (selector.name) normalizeName(selector.name);
    const intent = await readIntent(paths);
    if (
        intent &&
        (intent.planId === selector.planId ||
            intent.to === selector.name ||
            (intent.operation === "rename" && intent.from === selector.name))
    )
        return { kind: "pending_recovery", path: paths.intent, message: "This package is pending recovery." };
    const catalog = await scan(paths);
    const pending = await readIntent(paths);
    if (
        pending &&
        (pending.planId === selector.planId ||
            pending.to === selector.name ||
            (pending.operation === "rename" && pending.from === selector.name))
    )
        return { kind: "pending_recovery", path: paths.intent, message: "This package is pending recovery." };
    const match = catalog.packages.find(
        (p) =>
            (!selector.planId || p.metadata.planId === selector.planId) &&
            (!selector.name || p.metadata.name === selector.name),
    );
    if (match) return match;
    const batch = await readBatch(paths);
    if (
        batch?.phase === "pending" &&
        batch.members.some((member) => member.planId === selector.planId || member.name === selector.name)
    )
        return { kind: "pending_recovery", path: paths.batch, message: "This import is pending recovery." };
    if (catalog.issues.some((entry) => entry.kind === "pending_recovery"))
        return catalog.issues.find((entry) => entry.kind === "pending_recovery")!;
    if (selector.name) {
        const path = join(paths.plans, selector.name);
        await safe(paths.home, path);
        const problem = catalog.issues.find((entry) => entry.path === path);
        if (problem) return problem;
        return { kind: "missing", path, message: "No committed package matches the selected identity and name." };
    }
    return catalog.issues[0] ?? { kind: "missing", path: paths.plans, message: "Plan package is missing." };
}
export async function readPlanPackage(
    identity: ProjectIdentity,
    selector: PackageSelector,
): Promise<PackageInspection> {
    try {
        return await select(layout(identity), selector);
    } catch (error) {
        if (!(error instanceof Error)) throw error;
        return issue(error, identity.checkoutRoot);
    }
}
async function loaded(paths: PackageLayout, planId: string): Promise<LoadedPlanPackage> {
    const result = await select(paths, { planId });
    if (result.kind !== "loaded") fail(result.kind, result.message);
    return result;
}
async function directory(paths: PackageLayout, path: string): Promise<void> {
    await safe(paths.home, path);
    const created: string[] = [];
    for (let cursor = path; cursor !== paths.home; cursor = dirname(cursor)) {
        if (!(await stat(cursor))) created.push(cursor);
    }
    ensurePrivateDir(path);
    for (const entry of created) syncParentDirectory(entry);
}
async function recover(paths: PackageLayout): Promise<void> {
    await recoverImportBatch(paths);
    const intent = await readIntent(paths);
    if (intent) {
        const source = join(intent.operation === "create" ? paths.stages : paths.plans, intent.from);
        const destination = join(paths.plans, intent.to);
        await safe(paths.home, source);
        await safe(paths.home, destination);
        const sourceMetadata = await file(paths.home, join(source, "plan.wld.json"));
        if (sourceMetadata) {
            const previous = parseMetadata(sourceMetadata);
            const expected = intent.operation === "create" ? intent.metadata.revision : intent.metadata.revision - 1;
            if (
                previous.planId !== intent.planId ||
                previous.revision !== expected ||
                previous.name !== (intent.operation === "create" ? intent.to : intent.from)
            )
                fail("pending_recovery", "Publication source no longer matches its intent.");
        }
        await directory(paths, destination);
        for (const name of intent.resources) {
            const from = join(source, name),
                to = join(destination, name);
            const fromBytes = await file(paths.home, from),
                toBytes = await file(paths.home, to);
            if (fromBytes && toBytes)
                fail("pending_recovery", "Both publication locations contain a resource; preserving both.");
            if (fromBytes) {
                await fs.rename(from, to);
                syncParentDirectory(from);
                syncParentDirectory(to);
            } else if (!toBytes)
                fail("pending_recovery", "Publication resource is missing; preserving recovery evidence.");
        }
        const existing = await file(paths.home, join(destination, "plan.wld.json"));
        if (existing) {
            const metadata = parseMetadata(existing);
            if (
                metadata.planId !== intent.planId ||
                metadata.revision !== intent.metadata.revision ||
                metadata.name !== intent.to
            )
                fail("pending_recovery", "Publication metadata conflicts with its intent.");
        } else writeJsonAtomically(join(destination, "plan.wld.json"), intent.metadata);
        // The old metadata remains unreadable while intent exists. Retire it only after destination commit.
        if (source !== destination) {
            const old = join(source, "plan.wld.json");
            await safe(paths.home, old);
            await fs.rm(old, { force: true });
            syncParentDirectory(old);
        }
        await fs.rm(paths.intent);
        syncParentDirectory(paths.intent);
    }
    // Stages have no published reference. Catalog locking excludes every active creator/capture.
    if (await stat(paths.stages)) {
        await safe(paths.home, paths.stages);
        for (const entry of await fs.readdir(paths.stages)) {
            const path = join(paths.stages, entry);
            await safe(paths.home, path);
            await fs.rm(path, { recursive: true, force: true });
        }
        syncParentDirectory(join(paths.stages, "entry"));
    }
}
async function mutate<T>(
    identity: ProjectIdentity,
    planId: string | null,
    action: (paths: PackageLayout) => Promise<T>,
): Promise<T> {
    const paths = layout(identity);
    if (planId !== null) requireId(planId);
    await directory(paths, paths.locks);
    const catalogPath = join(paths.locks, "catalog.lock");
    await safe(paths.home, catalogPath);
    const catalog = openNativeFileLock(catalogPath);
    const plans: NativeFileLock[] = [];
    try {
        await catalog.lock(true);
        const intent = await readIntent(paths);
        const batch = await readBatch(paths);
        for (const id of [
            ...new Set([
                ...(planId === null ? [] : [planId]),
                ...(intent ? [intent.planId] : []),
                ...(batch?.phase === "pending" ? batch.members.map((member) => member.planId!) : []),
            ]),
        ].sort()) {
            const path = join(paths.locks, `${digest(new TextEncoder().encode(id))}.lock`);
            await safe(paths.home, path);
            const lock = openNativeFileLock(path);
            plans.push(lock);
            await lock.lock(true);
        }
        await recover(paths);
        if (planId === null) {
            for (const lock of plans.reverse()) lock.close();
            plans.length = 0;
        }
        return await action(paths);
    } finally {
        for (const lock of plans.reverse()) lock.close();
        catalog.close();
    }
}
export async function recoverPlanPackages(identity: ProjectIdentity): Promise<void> {
    await mutate(identity, null, async () => {});
}
function expectedRevision(metadata: PlanPackageMetadata, expected: number): void {
    if (metadata.revision !== expected) throw new StalePlanWriteError(String(expected), String(metadata.revision));
}
async function assertDestination(paths: PackageLayout, name: string): Promise<void> {
    const destination = join(paths.plans, normalizeName(name));
    await safe(paths.home, destination);
    let parent = paths.plans;
    for (const segment of name.split("/")) {
        const path = join(parent, segment);
        if (!(await stat(path))) break;
        // Case-insensitive lookup can resolve a name that directory enumeration spells differently.
        if (!(await fs.readdir(parent)).includes(segment))
            fail("collision", "Package destination must match existing directory spelling.");
        parent = path;
    }
    for (const resource of [...resources, "plan.wld.json"]) {
        if (await stat(join(destination, resource))) fail("collision", "Package destination already exists.");
    }
}
export async function createPlanPackage(
    identity: ProjectIdentity,
    input: CreatePlanPackage,
): Promise<LoadedPlanPackage> {
    normalizeName(input.name);
    requireId(input.planId);
    const metadata = metadataFrom(
        JSON.parse(
            JSON.stringify({
                version: 1,
                planId: input.planId,
                name: input.name,
                revision: 1,
                createdAt: new Date().toISOString(),
                parentPlanId: input.parentPlanId ?? null,
                dependencyPlanIds: input.dependencyPlanIds ?? [],
                definition: input.definition ?? { classification: "PLANNED_CHANGE", status: "draft" },
                controller: input.controller ?? {},
                references: input.references ?? { sessionIds: [] },
                archive: null,
            }),
        ),
    );
    if (
        !input.documents ||
        Object.keys(input.documents).some((name) => !resources.includes(name as PackageResource)) ||
        typeof input.documents["context.md"] !== "string" ||
        typeof input.documents["validation.md"] !== "string" ||
        Object.values(input.documents).some((value) => typeof value !== "string")
    )
        fail("missing_document", "Creation requires Markdown documents.");
    return await mutate(identity, input.planId, async (paths) => {
        const catalog = await scan(paths);
        if (catalog.issues.length)
            fail(catalog.issues[0].kind, "Cannot prove package uniqueness while catalog evidence is damaged.");
        if (catalog.packages.some((p) => p.metadata.planId === input.planId))
            fail("collision", "Plan ID already exists.");
        await assertDestination(paths, input.name);
        const stage = randomUUID();
        await directory(paths, join(paths.stages, stage));
        const names = resources.filter((name) => input.documents[name] !== undefined);
        for (const name of names) writeTextAtomically(join(paths.stages, stage, name), input.documents[name]!);
        writeJsonAtomically(join(paths.stages, stage, "plan.wld.json"), metadata);
        writeJsonAtomically(paths.intent, {
            version: 1,
            operation: "create",
            planId: input.planId,
            from: stage,
            to: input.name,
            resources: names,
            metadata,
        } satisfies PackageIntent);
        await recover(paths);
        return loaded(paths, input.planId);
    });
}
export async function updatePlanPackageMetadata(
    identity: ProjectIdentity,
    planId: string,
    revision: number,
    update: PackageMetadataUpdate,
): Promise<PlanPackageMetadata> {
    return await mutate(identity, planId, async (paths) => {
        const current = await loaded(paths, planId);
        expectedRevision(current.metadata, revision);
        // Validate update keys before merging: identity, location and archive are dedicated operations.
        fields(JSON.parse(JSON.stringify(update)), [
            "definition",
            "controller",
            "references",
            "parentPlanId",
            "dependencyPlanIds",
        ]);
        const next = metadataFrom(
            JSON.parse(JSON.stringify({ ...current.metadata, ...update, revision: revision + 1 })),
        );
        writeJsonAtomically(join(current.path, "plan.wld.json"), next);
        return next;
    });
}
export async function savePlanPackageDocument(
    identity: ProjectIdentity,
    planId: string,
    name: PackageResource,
    expectedHash: string | null,
    bytes: string | Uint8Array,
): Promise<string> {
    if (!resources.includes(name)) fail("unsafe_path", "Unknown package resource.");
    return await mutate(identity, planId, async (paths) => {
        const current = await loaded(paths, planId);
        // Recheck the selected file after catalog lookup: ordinary editors do not take Core locks.
        const live = await file(paths.home, join(current.path, name));
        const previous = live ? digest(live) : null;
        if (previous !== expectedHash) throw new StalePlanWriteError(expectedHash ?? "absent", previous ?? "absent");
        writeTextAtomically(join(current.path, name), bytes);
        return digest(typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes);
    });
}
export async function renamePlanPackage(
    identity: ProjectIdentity,
    planId: string,
    revision: number,
    name: string,
): Promise<PlanPackageMetadata> {
    normalizeName(name);
    return await mutate(identity, planId, async (paths) => {
        const current = await loaded(paths, planId);
        expectedRevision(current.metadata, revision);
        if (current.metadata.name === name) return current.metadata;
        await assertDestination(paths, name);
        const metadata = { ...current.metadata, name, revision: revision + 1 };
        writeJsonAtomically(paths.intent, {
            version: 1,
            operation: "rename",
            planId,
            from: current.metadata.name,
            to: name,
            resources: current.documents.map((doc) => doc.name),
            metadata,
        } satisfies PackageIntent);
        await recover(paths);
        return metadata;
    });
}
export async function archivePlanPackage(
    identity: ProjectIdentity,
    planId: string,
    revision: number,
    reason: string,
): Promise<PlanPackageMetadata> {
    return await mutate(identity, planId, async (paths) => {
        const current = await loaded(paths, planId);
        expectedRevision(current.metadata, revision);
        if (current.metadata.archive && !current.metadata.archive.restoredAt) return current.metadata;
        const metadata = {
            ...current.metadata,
            revision: revision + 1,
            archive: { archivedAt: new Date().toISOString(), reason },
        };
        metadataFrom(metadata);
        writeJsonAtomically(join(current.path, "plan.wld.json"), metadata);
        return metadata;
    });
}
export async function restorePlanPackage(
    identity: ProjectIdentity,
    planId: string,
    revision: number,
): Promise<PlanPackageMetadata> {
    return await mutate(identity, planId, async (paths) => {
        const current = await loaded(paths, planId);
        expectedRevision(current.metadata, revision);
        if (!current.metadata.archive || current.metadata.archive.restoredAt) return current.metadata;
        const metadata = {
            ...current.metadata,
            revision: revision + 1,
            archive: { ...current.metadata.archive, restoredAt: new Date().toISOString() },
        };
        metadataFrom(metadata);
        writeJsonAtomically(join(current.path, "plan.wld.json"), metadata);
        return metadata;
    });
}
export async function capturePlanPackageInput(
    identity: ProjectIdentity,
    planId: string,
): Promise<PackageInputReference> {
    return await mutate(identity, planId, async (paths) => {
        const source = await loaded(paths, planId);
        const inputId = randomUUID();
        const stage = join(paths.stages, inputId);
        await directory(paths, stage);
        for (const doc of source.documents) writeTextAtomically(join(stage, doc.name), doc.bytes);
        const manifest: PackageInputManifest = {
            version: 1,
            projectId: identity.projectId,
            planId,
            inputId,
            metadataRevision: source.metadata.revision,
            documents: source.documents.map(({ name, role, hash }) => ({ name, role, hash })),
        };
        writeJsonAtomically(join(stage, "input.wld.json"), manifest);
        const current = await loaded(paths, planId);
        if (
            current.metadata.revision !== source.metadata.revision ||
            current.documents.length !== source.documents.length ||
            current.documents.some(
                (doc, index) => doc.name !== source.documents[index].name || doc.hash !== source.documents[index].hash,
            )
        ) {
            await fs.rm(stage, { recursive: true });
            fail("changed_input", "Documents changed during capture. Capture the current input again.");
        }
        await directory(paths, paths.inputs);
        const destination = join(paths.inputs, inputId);
        await safe(paths.home, destination);
        await fs.rename(stage, destination);
        syncParentDirectory(stage);
        syncParentDirectory(destination);
        return { projectId: identity.projectId, planId, inputId };
    });
}
export async function readPlanPackageInput(
    identity: ProjectIdentity,
    reference: PackageInputReference,
): Promise<PackageInput> {
    const paths = layout(identity);
    if (reference.projectId !== identity.projectId || !/^[0-9a-f-]{36}$/.test(reference.inputId))
        fail("unsafe_path", "Invalid retained-input reference.");
    const directory = join(paths.inputs, reference.inputId);
    const bytes = await file(paths.home, join(directory, "input.wld.json"));
    if (!bytes) fail("missing", "Retained input is missing.");
    let manifest: PackageInputManifest;
    try {
        manifest = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
        return fail("malformed_metadata", "Malformed retained input.");
    }
    if (
        manifest.version !== 1 ||
        manifest.planId !== reference.planId ||
        manifest.inputId !== reference.inputId ||
        manifest.projectId !== reference.projectId ||
        !Number.isSafeInteger(manifest.metadataRevision) ||
        manifest.metadataRevision < 1 ||
        !Array.isArray(manifest.documents)
    )
        fail("malformed_metadata", "Invalid retained-input identity.");
    const documents = await readDocuments(paths, directory);
    if (
        documents.length !== manifest.documents.length ||
        documents.some((doc, index) => {
            const entry = manifest.documents[index];
            return !entry || entry.name !== doc.name || entry.role !== doc.role || entry.hash !== doc.hash;
        })
    )
        fail("malformed_metadata", "Retained-input bytes or membership do not match the committed manifest.");
    return { manifest, documents };
}

function validateImportRecord(record: ImportRecord): ImportRecord {
    if (
        record.version !== 1 ||
        !/^[0-9a-f-]{36}$/.test(record.recordId) ||
        !record.projectId ||
        !Array.isArray(record.prepared?.members) ||
        !Array.isArray(record.prepared.allocations)
    )
        fail("pending_recovery", "Invalid retained import record.");
    for (const member of record.prepared.members) {
        metadataFrom(member.metadata);
        if (
            member.metadata.planId !== member.allocation.planId ||
            member.evidence.format !== "legacy-markdown" ||
            member.metadata.references.legacyImport?.recordId !== record.recordId
        )
            fail("pending_recovery", "Import identity or provenance does not match its record.");
        for (const evidence of [
            member.evidence.source,
            member.evidence.authority,
            member.evidence.controllerFile,
            member.evidence.registryFile,
        ]) {
            if (
                evidence &&
                (evidence.bytes === null
                    ? evidence.digest !== null
                    : typeof evidence.bytes !== "string" ||
                      digest(Buffer.from(evidence.bytes, "base64")) !== evidence.digest)
            )
                fail("pending_recovery", "Retained import evidence does not match its digest.");
        }
        if (
            typeof member.documents["context.md"] !== "string" ||
            typeof member.documents["validation.md"] !== "string" ||
            Object.keys(member.documents).some((name) => !resources.includes(name as PackageResource))
        )
            fail("pending_recovery", "Invalid retained import documents.");
    }
    return record;
}
async function importRecord(paths: PackageLayout, recordId: string): Promise<ImportRecord> {
    if (!/^[0-9a-f-]{36}$/.test(recordId)) fail("unsafe_path", "Invalid import record reference.");
    const bytes = await file(paths.home, join(paths.imports, recordId, "record.json"));
    if (!bytes) fail("pending_recovery", "Retained import record is unavailable.");
    try {
        return validateImportRecord(JSON.parse(new TextDecoder().decode(bytes)));
    } catch (error) {
        if (error instanceof PlanPackageError) throw error;
        return fail("pending_recovery", "Retained import record is unreadable.");
    }
}
async function readAllocations(paths: PackageLayout): Promise<ImportAllocation[]> {
    const bytes = await file(paths.home, paths.allocations);
    if (!bytes) return [];
    try {
        const entries: ImportAllocation[] = JSON.parse(new TextDecoder().decode(bytes));
        if (
            !Array.isArray(entries) ||
            entries.some(
                (entry) =>
                    !entry.locator ||
                    typeof entry.idless !== "boolean" ||
                    !entry.createdAt ||
                    !/^[0-9a-f]{64}$/.test(entry.digest),
            )
        )
            throw new Error("allocations");
        for (const entry of entries) {
            requireId(entry.planId);
            normalizeName(entry.name);
        }
        if (new Set(entries.map((entry) => entry.locator)).size !== entries.length)
            throw new Error("duplicate allocation");
        return entries;
    } catch {
        return fail("pending_recovery", "Import allocations need recovery; their evidence is invalid.");
    }
}
async function recoverImportBatch(paths: PackageLayout): Promise<void> {
    const batch = await readBatch(paths);
    if (!batch || batch.phase === "committed") return;
    // The intent is also the durable ID reservation. It retains every byte needed after source deletion.
    const record = validateImportRecord(batch.record!);
    if (
        record.recordId !== batch.recordId ||
        JSON.stringify(batch.members) !==
            JSON.stringify(
                record.prepared.members.map((member) => ({
                    planId: member.metadata.planId,
                    name: member.metadata.name,
                })),
            )
    )
        fail("pending_recovery", "Import batch membership disagrees with its retained inputs.");
    const root = join(paths.imports, record.recordId);
    await directory(paths, root);
    const recordPath = join(root, "record.json");
    const previousRecord = await file(paths.home, recordPath);
    if (previousRecord) {
        if (JSON.stringify(await importRecord(paths, record.recordId)) !== JSON.stringify(record))
            fail("pending_recovery", "Retained import record changed.");
    } else writeJsonAtomically(recordPath, record);
    const allocations = await readAllocations(paths);
    for (const allocation of record.prepared.allocations) {
        const previous = allocations.find((entry) => entry.locator === allocation.locator);
        if (previous && JSON.stringify(previous) !== JSON.stringify(allocation))
            fail("pending_recovery", "Import source allocation conflicts with retained evidence.");
        if (!previous) allocations.push(allocation);
    }
    const previousAllocations = await file(paths.home, paths.allocations);
    if (
        !previousAllocations ||
        JSON.stringify(JSON.parse(new TextDecoder().decode(previousAllocations))) !== JSON.stringify(allocations)
    )
        writeJsonAtomically(paths.allocations, allocations);
    for (const member of record.prepared.members) {
        const stage = join(root, "staging", digest(new TextEncoder().encode(member.metadata.planId)));
        const destination = join(paths.plans, member.metadata.name);
        await directory(paths, stage);
        await directory(paths, destination);
        for (const name of resources.filter((name) => member.documents[name] !== undefined)) {
            const from = join(stage, name),
                to = join(destination, name);
            const published = await file(paths.home, to);
            const expected = new TextEncoder().encode(member.documents[name]!);
            if (published) {
                if (digest(published) !== digest(expected))
                    fail("pending_recovery", "Import destination changed; retaining both versions.");
                continue;
            }
            const staged = await file(paths.home, from);
            if (staged && digest(staged) !== digest(expected))
                fail("pending_recovery", "Import stage changed; retaining its evidence.");
            if (!staged) writeTextAtomically(from, expected);
        }
        const stageMetadata = join(stage, "plan.wld.json");
        if (!(await file(paths.home, stageMetadata))) writeJsonAtomically(stageMetadata, member.metadata);
    }
    for (const member of record.prepared.members) {
        const stage = join(root, "staging", digest(new TextEncoder().encode(member.metadata.planId)));
        const destination = join(paths.plans, member.metadata.name);
        for (const name of resources.filter((name) => member.documents[name] !== undefined)) {
            const from = join(stage, name),
                to = join(destination, name);
            if (!(await file(paths.home, to))) {
                await fs.rename(from, to);
                syncParentDirectory(from);
                syncParentDirectory(to);
            }
        }
        const metadataPath = join(destination, "plan.wld.json");
        const published = await file(paths.home, metadataPath);
        if (published) {
            if (JSON.stringify(parseMetadata(published)) !== JSON.stringify(member.metadata))
                fail("pending_recovery", "Import destination metadata changed.");
        } else writeJsonAtomically(metadataPath, member.metadata);
    }
    // Persistent generation evidence detects an entire batch starting and finishing during a passive scan.
    writeJsonAtomically(paths.batch, {
        version: 1,
        recordId: batch.recordId,
        phase: "committed",
        members: batch.members,
    } satisfies ImportBatch);
}

/** Explicit internal import; ordinary load/save/discovery never calls this operation. */
export async function importPlanPackages(identity: ProjectIdentity, selection: string): Promise<PlanImportResult> {
    try {
        return await mutate(identity, null, async (paths) => {
            const catalog = await scan(paths);
            if (catalog.issues.length) fail(catalog.issues[0].kind, catalog.issues[0].message);
            const allocations = await readAllocations(paths);
            if (!(await stat(selection))) {
                const recordedIds = new Set<string>();
                if (await stat(paths.imports)) {
                    await safe(paths.home, paths.imports);
                    for (const id of await fs.readdir(paths.imports)) {
                        const record = await importRecord(paths, id);
                        if (record.prepared.selection === selection) {
                            for (const member of record.prepared.members) recordedIds.add(member.metadata.planId);
                            for (const planId of record.prepared.existingPlanIds) recordedIds.add(planId);
                        } else {
                            for (const member of record.prepared.members)
                                if (member.evidence.source.path === selection) recordedIds.add(member.metadata.planId);
                        }
                    }
                }
                if (recordedIds.size) {
                    const planIds = [...recordedIds];
                    if (planIds.some((id) => !catalog.packages.some((p) => p.metadata.planId === id)))
                        fail("pending_recovery", "A previously imported package is unavailable.");
                    return { kind: "existing", planIds, importedPlanIds: [], existingPlanIds: planIds };
                }
            }
            const prepared = await preparePlanPackageImport(
                identity,
                selection,
                allocations,
                catalog.packages,
                new Date().toISOString(),
            );
            if (!prepared.members.length)
                return {
                    kind: "existing",
                    planIds: prepared.existingPlanIds,
                    importedPlanIds: [],
                    existingPlanIds: prepared.existingPlanIds,
                };
            const locks: NativeFileLock[] = [];
            try {
                for (const id of prepared.members.map((member) => member.metadata.planId).sort()) {
                    const path = join(paths.locks, `${digest(new TextEncoder().encode(id))}.lock`);
                    await safe(paths.home, path);
                    const lock = openNativeFileLock(path);
                    locks.push(lock);
                    await lock.lock(true);
                }
                for (const member of prepared.members) {
                    metadataFrom(member.metadata);
                    await assertDestination(paths, member.metadata.name);
                }
                await revalidatePlanImport(identity, prepared, catalog.packages, allocations);
                const recordId = randomUUID();
                for (const member of prepared.members)
                    member.metadata.references.legacyImport = {
                        recordId,
                        locator: member.allocation.locator,
                        format: "legacy-markdown",
                    };
                const record = validateImportRecord({ version: 1, recordId, projectId: identity.projectId, prepared });
                writeJsonAtomically(paths.batch, {
                    version: 1,
                    recordId,
                    phase: "pending",
                    members: prepared.members.map((member) => ({
                        planId: member.metadata.planId,
                        name: member.metadata.name,
                    })),
                    record,
                } satisfies ImportBatch);
                await recoverImportBatch(paths);
                const importedPlanIds = prepared.members.map((member) => member.metadata.planId);
                return {
                    kind: "committed",
                    planIds: [...new Set([...importedPlanIds, ...prepared.existingPlanIds])],
                    importedPlanIds,
                    existingPlanIds: prepared.existingPlanIds,
                };
            } finally {
                for (const lock of locks.reverse()) lock.close();
            }
        });
    } catch (error) {
        return {
            kind:
                error instanceof PlanPackageError
                    ? error.kind === "collision"
                        ? "conflict"
                        : ["pending_recovery", "changed_input"].includes(error.kind)
                          ? "pending"
                          : ["malformed_metadata", "unsupported_metadata", "unsafe_path"].includes(error.kind)
                            ? "invalid"
                            : "unavailable"
                    : "unavailable",
            message: error instanceof Error ? error.message : String(error),
        };
    }
}
/** Resolve immutable evidence independently of source availability or later package edits/renames. */
export async function readPlanImportEvidence(
    identity: ProjectIdentity,
    reference: LegacyImportReference,
): Promise<LegacyImportEvidence> {
    const record = await importRecord(layout(identity), reference.recordId);
    if (record.projectId !== identity.projectId || reference.format !== "legacy-markdown")
        fail("malformed_metadata", "Import evidence belongs to a different Project or format.");
    const member = record.prepared.members.find((member) => member.allocation.locator === reference.locator);
    if (!member) fail("missing", "Import source evidence is missing.");
    return member.evidence;
}
