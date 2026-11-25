import { projects, type ProjectStoreIdentity as ProjectIdentity } from "@runwield/projects";
import {
    commitOperationEffect,
    recoverOperationEffect,
    captureBatchOperation,
    settleBatchOperation,
    type BatchOperationIntent,
} from "./operation-receipts.ts";
import { requestWorkspaceSearchRefresh } from "../shared/workspace-search-refresh.ts";
import { parseWorkRecordMarkdown } from "../shared/work-records/markdown.ts";
/** Explicit personal Plan packages. Legacy discovery and lifecycle admission remain separate. */
import fs from "node:fs/promises";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { dirname, isAbsolute, join, relative } from "node:path";
import { openNativeFileLock, type NativeFileLock } from "../shared/native-file-lock.ts";
import { assertContainedPath } from "@runwield/resources/fs";
import {
    ensurePrivateDir,
    syncParentDirectory,
    writeJsonAtomically,
    writeTextAtomically,
} from "../shared/private-json-file.ts";
import { plans, type PlanId, type PlanFrontMatter } from "@runwield/plans";
import {
    packageResourceRoles as roles,
    packageResources as resources,
    PlanPackageError,
    readRetainedPlanInput,
    rethrowPackagePathError,
    stageRetainedPlanInput,
    type PackageDocument,
    type PackageInput,
    type PackageInputReference,
    type PackageIssueKind,
    type PackageResource,
} from "@runwield/plans/file-snapshots";
import {
    EPIC_ARTIFACT_FILE_NAMES,
    type TicketReference,
    normalizePlanDeviations,
    type PlanDeviation,
    canonicalPlanStatus,
} from "@runwield/plans/format";
import { StalePlanWriteError } from "../plan-store.ts";
import {
    preparePlanPackageImport,
    revalidatePlanImport,
    type ImportAllocation,
    type LegacyImportEvidence,
    type PlanImportResult,
    type PreparedPlanImport,
} from "./import-source.ts";
import { CONTROLLER_STATE_FIELDS, type WorkflowControllerState } from "@runwield/plans/controller-state";

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
    title?: string;
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
export interface PackageWorkflowInput {
    inputs: PackageInputReference[];
    definitionHash: string;
}
export interface PackageAttemptContinuation {
    attemptId: string;
    repositoryRoot: string;
    input: PackageWorkflowInput;
}
export interface PackageAttemptReference {
    executionMode?: "non_git_in_place";
    personalOwner: string;
    repositoryId: string;
    repositoryRoot: string;
    attemptId: string;
    input: PackageWorkflowInput;
}
export interface PackageControllerReference {
    revisionId: string;
    planId: string;
}
export interface LegacyPackageSettlement {
    outcome: "published" | "abandoned";
    attemptId: string;
    importRecordId: string;
    settledAt: string;
    targetBranch?: string;
    commit?: string;
}
export interface PackageGeneratedArtifact {
    operationId?: string;
    attemptId: string;
    planId: string;
    name: "manual-qa.md";
    beforeHash: string | null;
    text: string;
    hash: string;
}
export interface ExecutionPublicationPolicy {
    plans: boolean;
    workRecords: boolean;
    autoGenerateRecords: boolean;
}
export interface FrozenExecutionPublicationPolicy extends ExecutionPublicationPolicy {
    attemptId: string;
}
export interface PackageWorkflowEvidence {
    publicationPolicy?: FrozenExecutionPublicationPolicy;
    generatedArtifact?: PackageGeneratedArtifact;
    legacySettlement?: LegacyPackageSettlement;
    workRecord?: import("@runwield/plans").PlanFrontMatter["workRecord"];
    integration?: PackageWorkflowInput;
    review?: PackageWorkflowInput;
    readiness?: PackageWorkflowInput;
    attempt?: PackageAttemptReference;
    controller?: PackageControllerReference;
    publication?: PackagePublicationReference;
    recordingSource?: PackagePublicationReference;
    recordingPreparation?: PackagePublicationReference;
    delivery?: PackageDeliveryReceipt;
}
export interface DeliveryCopy {
    kind: "plan" | "work-record";
    path: string;
    text: string;
}
export interface PackagePublicationReference {
    kind: "package";
    projectId: string;
    personalOwner: string;
    repositoryId: string;
    planId: string;
    attemptId: string;
    inputId: string;
    digest: string;
}
export interface PackagePublicationMember {
    metadata: PlanPackageMetadata;
    controller: WorkflowControllerState;
    input: PackageInputReference;
}
export interface PackagePublicationManifest {
    version: 1;
    projectId: string;
    personalOwner: string;
    repositoryId: string;
    planId: string;
    attemptId: string;
    inputId: string;
    validatedCommit: string;
    targetBranch: string;
    planCopies: boolean;
    stage?: "recording";
    workRecordCopies?: boolean;
    autoGenerateRecords?: boolean;
    preparedRecord?: DeliveryCopy;
    recordingOutcome?: PlanFrontMatter["workRecord"];
    members: PackagePublicationMember[];
    copies: DeliveryCopy[];
}
export interface PackageDeliveryReceipt {
    source: PackagePublicationReference;
    validatedCommit: string;
    publishedCommit: string;
    targetBranch: string;
    mode: "local" | "remote" | "non_git_in_place";
    verifiedAt: string;
}
export interface PlanMilestone {
    version: string;
    milestone: "approved" | "delivered" | "closed" | "archived";
    at: string;
    reason: string;
    digest: string;
}
export interface PlanPackageMetadata {
    history?: PlanMilestone[];
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
    workflow?: PackageWorkflowEvidence;
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
    history?: PlanMilestone[];
    workflow?: PackageWorkflowEvidence;
    definition?: PackageDefinition;
    controller?: PackageControllerState;
    references?: PackageReferences;
    parentPlanId?: string | null;
    dependencyPlanIds?: string[];
}
export interface LoadedPlanPackage {
    kind: "loaded";
    path: string;
    metadata: PlanPackageMetadata;
    documents: PackageDocument[];
}
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
interface PackageLayout {
    identity: ProjectIdentity;
    home: string;
    plans: string;
    internal: string;
    stages: string;
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
    authoring?: PlanPackageBatchWrite[];
    review?: PackageReviewCommit;
    operation?: BatchOperationIntent;
}
interface PackageIntent {
    receipt?: BatchOperationIntent;
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
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const missing = (error: Error) => "code" in error && error.code === "ENOENT";

function fail(kind: PlanPackageError["kind"], message: string): never {
    throw new PlanPackageError(kind, message);
}
function requireId(id: string): PlanId {
    if (!plans.identity.isValid(id)) fail("malformed_metadata", "Invalid Plan ID.");
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
    projects.home.assertStoreIdentity(identity);
    const home = join(identity.executionAccountHome, ".wld", "projects", identity.projectId);
    const internal = join(home, "internal", "plan-packages");
    return {
        identity,
        home: identity.executionAccountHome,
        plans: join(home, "plans"),
        internal,
        stages: join(internal, "staging"),
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
    await assertContainedPath(root, path).catch(rethrowPackagePathError);
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
export const packageDefinitionStrings = [
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
    "title",
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
export const packageControllerStrings = [
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
export const packageControllerNumbers = ["validationCiAttempts", "validationSemanticRounds", "collaborationRevision"];
export const packageControllerEnums: Record<string, string[]> = {
    executionMode: ["worktree", "non_git_in_place"],
    validationPhase: ["mechanical", "semantic", "delivery"],
    humanReviewMode: ["none", "ask", "always"],
    humanReviewDecision: ["not_required", "skipped", "approved", "changes_requested"],
};
function validateWorkflowInput(value: JsonValue, planId: string): void {
    const input = fields(value, ["inputs", "definitionHash"]);
    if (
        typeof input.definitionHash !== "string" ||
        !/^[0-9a-f]{64}$/.test(input.definitionHash) ||
        !Array.isArray(input.inputs) ||
        !input.inputs.length
    )
        fail("malformed_metadata", "Invalid package workflow input.");
    const ids = new Set<string>();
    for (const value of input.inputs) {
        const ref = fields(value, ["projectId", "planId", "inputId"]);
        if (
            typeof ref.projectId !== "string" ||
            !ref.projectId ||
            typeof ref.planId !== "string" ||
            !ref.planId ||
            typeof ref.inputId !== "string" ||
            !/^[0-9a-f-]{36}$/.test(ref.inputId) ||
            ids.has(ref.planId)
        )
            fail("malformed_metadata", "Invalid package retained-input reference.");
        requireId(ref.planId);
        ids.add(ref.planId);
    }
    if (!ids.has(planId)) fail("malformed_metadata", "Workflow input omits its owning Plan.");
}
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
        "history",
        "workflow",
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
    if (
        data.history !== undefined &&
        (!Array.isArray(data.history) ||
            data.history.some((item) => {
                const entry = fields(item, ["version", "milestone", "at", "reason", "digest"]);
                return (
                    typeof entry.version !== "string" ||
                    !/^[0-9a-f-]{36}$/.test(entry.version) ||
                    !["approved", "delivered", "closed", "archived"].includes(String(entry.milestone)) ||
                    typeof entry.at !== "string" ||
                    typeof entry.reason !== "string" ||
                    typeof entry.digest !== "string" ||
                    !/^[0-9a-f]{64}$/.test(entry.digest)
                );
            }))
    )
        fail("malformed_metadata", "Invalid Plan History reference.");
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
        ...packageDefinitionStrings,
    ]);
    if (
        !["PLANNED_CHANGE", "PROJECT"].includes(String(definition.classification)) ||
        typeof definition.status !== "string" ||
        canonicalPlanStatus(definition.status) !== definition.status ||
        packageDefinitionStrings.some((key) => key in definition && typeof definition[key] !== "string") ||
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
        ...packageControllerStrings,
        ...packageControllerNumbers,
        ...Object.keys(packageControllerEnums),
    ]);
    if (
        packageControllerStrings.some(
            (key) => key in controller && controller[key] !== null && typeof controller[key] !== "string",
        ) ||
        packageControllerNumbers.some(
            (key) => key in controller && (!Number.isSafeInteger(controller[key]) || Number(controller[key]) < 0),
        ) ||
        Object.entries(packageControllerEnums).some(
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
    if (data.workflow !== undefined) {
        const workflow = fields(data.workflow, [
            "legacySettlement",
            "generatedArtifact",
            "publicationPolicy",
            "integration",
            "review",
            "readiness",
            "attempt",
            "controller",
            "publication",
            "recordingSource",
            "recordingPreparation",
            "delivery",
            "workRecord",
        ]);
        if (workflow.publicationPolicy !== undefined) {
            const policy = fields(workflow.publicationPolicy, [
                "attemptId",
                "plans",
                "workRecords",
                "autoGenerateRecords",
            ]);
            if (
                typeof policy.attemptId !== "string" ||
                !policy.attemptId ||
                ["plans", "workRecords", "autoGenerateRecords"].some((key) => typeof policy[key] !== "boolean")
            )
                fail("malformed_metadata", "Invalid frozen execution publication policy.");
        }
        if (workflow.generatedArtifact !== undefined) {
            const artifact = fields(workflow.generatedArtifact, [
                "operationId",
                "attemptId",
                "planId",
                "name",
                "beforeHash",
                "text",
                "hash",
            ]);
            if (
                artifact.name !== "manual-qa.md" ||
                (artifact.operationId !== undefined &&
                    (typeof artifact.operationId !== "string" || !/^[a-f0-9-]{36}$/.test(artifact.operationId))) ||
                ["attemptId", "planId", "text", "hash"].some(
                    (key) => typeof artifact[key] !== "string" || !artifact[key],
                ) ||
                (artifact.beforeHash !== null &&
                    (typeof artifact.beforeHash !== "string" || !/^[a-f0-9]{64}$/.test(artifact.beforeHash))) ||
                typeof artifact.text !== "string" ||
                artifact.hash !== digest(new TextEncoder().encode(artifact.text))
            )
                fail("malformed_metadata", "Invalid generated package artifact.");
        }
        if (workflow.legacySettlement !== undefined) {
            const settlement = fields(workflow.legacySettlement, [
                "outcome",
                "attemptId",
                "importRecordId",
                "settledAt",
                "targetBranch",
                "commit",
            ]);
            if (
                !["published", "abandoned"].includes(String(settlement.outcome)) ||
                ["attemptId", "importRecordId", "settledAt"].some(
                    (key) => typeof settlement[key] !== "string" || !settlement[key],
                ) ||
                ["targetBranch", "commit"].some(
                    (key) => key in settlement && (typeof settlement[key] !== "string" || !settlement[key]),
                )
            )
                fail("malformed_metadata", "Invalid retained execution settlement.");
        }
        if (workflow.workRecord !== undefined) validateRecordingOutcome(workflow.workRecord);
        if (workflow.recordingPreparation !== undefined)
            assertPackagePublicationReference(JSON.parse(JSON.stringify(workflow.recordingPreparation)));
        if (workflow.recordingSource !== undefined)
            assertPackagePublicationReference(JSON.parse(JSON.stringify(workflow.recordingSource)));
        if (workflow.publication !== undefined) {
            assertPackagePublicationReference(JSON.parse(JSON.stringify(workflow.publication)));
            if (fields(workflow.publication, publicationReferenceFields).planId !== data.planId)
                fail("malformed_metadata", "Publication input belongs to another Plan.");
        }
        if (workflow.delivery !== undefined) {
            const receipt = fields(workflow.delivery, [
                "source",
                "validatedCommit",
                "publishedCommit",
                "targetBranch",
                "mode",
                "verifiedAt",
            ]);
            assertPackagePublicationReference(JSON.parse(JSON.stringify(receipt.source)));
            if (
                fields(receipt.source, publicationReferenceFields).planId !== data.planId ||
                !["local", "remote", "non_git_in_place"].includes(String(receipt.mode)) ||
                ["validatedCommit", "publishedCommit", "targetBranch", "verifiedAt"].some(
                    (key) => typeof receipt[key] !== "string",
                ) ||
                !receipt.verifiedAt
            )
                fail("malformed_metadata", "Invalid package delivery receipt.");
        }
        for (const key of ["integration", "review", "readiness"]) {
            if (workflow[key] !== undefined) validateWorkflowInput(workflow[key], data.planId);
        }
        if (workflow.attempt !== undefined) {
            const attempt = fields(workflow.attempt, [
                "executionMode",
                "personalOwner",
                "repositoryId",
                "repositoryRoot",
                "attemptId",
                "input",
            ]);
            if (attempt.executionMode !== undefined && attempt.executionMode !== "non_git_in_place")
                fail("malformed_metadata", "Invalid package attempt execution mode.");
            for (const key of ["personalOwner", "repositoryId", "repositoryRoot", "attemptId"]) {
                if (typeof attempt[key] !== "string" || !attempt[key])
                    fail("malformed_metadata", "Invalid package attempt binding.");
            }
            if (!isAbsolute(String(attempt.repositoryRoot)))
                fail("malformed_metadata", "Invalid attempt repository root.");
            validateWorkflowInput(attempt.input, data.planId);
        }
        if (workflow.controller !== undefined) {
            const ref = fields(workflow.controller, ["revisionId", "planId"]);
            if (
                typeof ref.revisionId !== "string" ||
                !/^[0-9a-f-]{36}$/.test(ref.revisionId) ||
                ref.planId !== data.planId
            )
                fail("malformed_metadata", "Invalid package controller reference.");
        }
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
        const pruneBefore = await readPruneJournal(paths);
        const catalog = await scanOnce(paths);
        const after = await readBatch(paths);
        const pruneAfter = await readPruneJournal(paths);
        if (
            JSON.stringify(before) !== JSON.stringify(after) ||
            JSON.stringify(pruneBefore) !== JSON.stringify(pruneAfter)
        )
            continue;
        if (pruneAfter && pruneAfter.phase !== "committed") {
            const affected = new Set(pruneAfter.members.map((member) => member.planId));
            catalog.packages = catalog.packages.filter((plan) => !affected.has(plan.metadata.planId));
            catalog.issues.push({
                kind: "pending_recovery",
                path: join(paths.internal, "pruning.json"),
                message: "An archived Plan family is pending prune recovery.",
            });
        }
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
        return { packages: [], issues: [issue(error, projects.home.storeLocation(identity))] };
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
        return issue(error, projects.home.storeLocation(identity));
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
        if (intent.receipt) {
            if (intent.receipt.planId !== intent.planId)
                fail("pending_recovery", "Package operation identity changed.");
            const committed = await inspectAt(paths, intent.to);
            if (committed.kind !== "loaded") fail(committed.kind, committed.message);
            settleBatchOperation(paths.internal, intent.receipt, packageWorkflowRevision(committed));
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
interface PackageLockScope {
    internal: string;
    planIds: Set<string>;
    discovering?: boolean;
}
const packageLocks = new AsyncLocalStorage<PackageLockScope>();

/** Catalog, sorted Plan IDs, then repository/attempt resources. Nested writes reuse held native locks. */
export async function withPlanPackageLocks<T>(
    identity: ProjectIdentity,
    planIds: string[],
    action: () => Promise<T>,
): Promise<T> {
    return await mutate(identity, planIds, () => action());
}

/** Hold the catalog before choosing identity, then acquire the complete Plan set once. */
export async function withPlanPackageCatalogDiscovery<T>(
    identity: ProjectIdentity,
    action: () => Promise<T>,
    onUninitialized?: () => T,
): Promise<T> {
    if (onUninitialized) {
        const paths = layout(identity);
        const catalogLock = join(paths.locks, "catalog.lock");
        await safe(paths.home, catalogLock);
        if (!(await stat(catalogLock))) {
            // A copied store can have packages or pending recovery before it has a local lock.
            const catalog = await listPlanPackages(identity, true);
            if (!catalog.packages.length && !catalog.issues.length) return onUninitialized();
        }
    }
    return await mutate(identity, null, () => action(), true);
}

export function planPackageControllerDirectory(identity: ProjectIdentity): string {
    return join(layout(identity).internal, "controller-evidence");
}

/** Validate every ancestor before the controller owner reads or creates evidence. */
export async function checkedPlanPackageControllerDirectory(
    identity: ProjectIdentity,
    create = false,
): Promise<string> {
    const path = planPackageControllerDirectory(identity);
    await safe(identity.executionAccountHome, path);
    if (create) await fs.mkdir(path, { recursive: true, mode: 0o700 });
    await safe(identity.executionAccountHome, path);
    return path;
}

/** Personal lifecycle journals share the package owner's layout, never the invoking checkout. */
export function planPackageJournalDirectory(identity: ProjectIdentity): string {
    return join(layout(identity).internal, "transitions");
}

async function mutate<T>(
    identity: ProjectIdentity,
    selected: string | string[] | null,
    action: (paths: PackageLayout) => Promise<T>,
    discovering = false,
): Promise<T> {
    const paths = layout(identity);
    const perform = async () => {
        projects.launch.verifyAccountHome(identity);
        const result = await action(paths);
        projects.launch.verifyAccountHome(identity);
        return result;
    };
    const planIds = selected === null ? [] : typeof selected === "string" ? [selected] : selected;
    for (const id of planIds) requireId(id);
    const held = packageLocks.getStore();
    if (held?.internal === paths.internal) {
        if (planIds.some((id) => !held.planIds.has(id))) {
            if (!held.discovering || held.planIds.size)
                fail("unavailable", "A package transition must declare every Plan before acquiring its locks.");
            const locks: NativeFileLock[] = [];
            try {
                for (const id of [...new Set(planIds)].sort()) {
                    const path = join(paths.locks, `${digest(new TextEncoder().encode(id))}.lock`);
                    await safe(paths.home, path);
                    const lock = openNativeFileLock(path);
                    locks.push(lock);
                    await lock.lock(true);
                }
                return await packageLocks.run({ internal: paths.internal, planIds: new Set(planIds) }, perform);
            } finally {
                for (const lock of locks.reverse()) lock.close();
            }
        }
        return await perform();
    }
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
                ...planIds,
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
        await resumePackagePrune(paths);
        await recover(paths);
        recoverOperationEffect(paths.internal, paths.plans);
        if (selected === null) {
            for (const lock of plans.reverse()) lock.close();
            plans.length = 0;
        }
        return await packageLocks.run({ internal: paths.internal, planIds: new Set(planIds), discovering }, perform);
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
/** Resolve a typed relationship only within the admitted canonical catalog. */
export function resolvePlanPackageReference(
    packages: LoadedPlanPackage[],
    reference: string,
    parentName?: string,
): string {
    const matches = packages.filter(
        (plan) =>
            (!plan.metadata.archive || plan.metadata.archive.restoredAt) &&
            (plan.metadata.planId === reference ||
                plan.metadata.name === reference ||
                (parentName && plan.metadata.name === `${parentName}/${reference}`)),
    );
    if (matches.length !== 1)
        throw new Error(`No canonical Plan named ${reference} is uniquely available; import or create it first.`);
    return matches[0].metadata.planId;
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
        if (!projects.home.isOwner(identity))
            await requestWorkspaceSearchRefresh(projects.checkout.primaryRoot(identity.checkoutRoot));
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
            "history",
            "workflow",
            "definition",
            "controller",
            "references",
            "parentPlanId",
            "dependencyPlanIds",
        ]);
        const next = metadataFrom(
            JSON.parse(JSON.stringify({ ...current.metadata, ...update, revision: revision + 1 })),
        );
        const path = join(current.path, "plan.wld.json");
        if (
            !commitOperationEffect(
                path,
                await fs.readFile(path, "utf8"),
                `${JSON.stringify(next, null, 2)}\n`,
                packageWorkflowRevision({ ...current, metadata: next }),
                JSON.stringify(next.workflow?.publication) !== JSON.stringify(current.metadata.workflow?.publication)
                    ? next.workflow?.publication
                    : JSON.stringify(next.workflow?.recordingPreparation) !==
                        JSON.stringify(current.metadata.workflow?.recordingPreparation)
                      ? next.workflow?.recordingPreparation
                      : undefined,
                next.workflow?.workRecord?.recordId,
            )
        )
            writeJsonAtomically(path, next);
        if (!projects.home.isOwner(identity))
            await requestWorkspaceSearchRefresh(projects.checkout.primaryRoot(identity.checkoutRoot));
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
        const path = join(current.path, name);
        const text = typeof bytes === "string" ? bytes : new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        const changed = {
            ...current,
            documents: current.documents.map((document) =>
                document.name === name ? { ...document, hash: digest(new TextEncoder().encode(text)) } : document,
            ),
        };
        if (
            !commitOperationEffect(
                path,
                live === null ? null : new TextDecoder().decode(live),
                text,
                packageWorkflowRevision(changed),
            )
        )
            writeTextAtomically(path, bytes);
        if (!projects.home.isOwner(identity))
            await requestWorkspaceSearchRefresh(projects.checkout.primaryRoot(identity.checkoutRoot));
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
            receipt: captureBatchOperation(),
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
    archivedAt: string = new Date().toISOString(),
): Promise<PlanPackageMetadata> {
    return await mutate(identity, planId, async (paths) => {
        const current = await loaded(paths, planId);
        expectedRevision(current.metadata, revision);
        if (current.metadata.archive && !current.metadata.archive.restoredAt) return current.metadata;
        const metadata = {
            ...current.metadata,
            revision: revision + 1,
            archive: {
                archivedAt,
                reason,
                fromStatus: current.metadata.definition.status,
                fromPath: join(current.path, "context.md"),
            },
        };
        metadata.history = await stagePackageMilestone(
            identity,
            { ...current, metadata },
            "archived",
            archivedAt,
            reason,
        );
        metadataFrom(metadata);
        const path = join(current.path, "plan.wld.json");
        if (
            !commitOperationEffect(
                path,
                await fs.readFile(path, "utf8"),
                `${JSON.stringify(metadata, null, 2)}\n`,
                packageWorkflowRevision({ ...current, metadata }),
            )
        )
            writeJsonAtomically(path, metadata);
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
            archive: {
                ...current.metadata.archive,
                restoredAt: new Date().toISOString(),
                restoredFromPath: current.metadata.archive.fromPath,
            },
        };
        metadataFrom(metadata);
        const path = join(current.path, "plan.wld.json");
        if (
            !commitOperationEffect(
                path,
                await fs.readFile(path, "utf8"),
                `${JSON.stringify(metadata, null, 2)}\n`,
                packageWorkflowRevision({ ...current, metadata }),
            )
        )
            writeJsonAtomically(path, metadata);
        return metadata;
    });
}
function milestoneDigest(documents: PackageDocument[]): string {
    return createHash("sha256")
        .update(JSON.stringify(documents.map(({ name, hash }) => [name, hash])))
        .digest("hex");
}

function historyDirectory(paths: PackageLayout, planId: string): string {
    const portable = /^[a-z0-9_-]{1,128}$/.test(planId) && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/.test(planId);
    const segment = portable ? planId : "~" + createHash("sha256").update(planId).digest("hex");
    return join(dirname(paths.plans), "history", segment);
}

/** Only a reference in committed package metadata makes a staged milestone visible. */
export async function stagePackageMilestone(
    identity: ProjectIdentity,
    plan: LoadedPlanPackage,
    milestone: PlanMilestone["milestone"],
    at: string,
    reason: string,
    input?: PackageInputReference,
): Promise<PlanMilestone[]> {
    const paths = layout(identity);
    const documents = input ? (await readPlanPackageInput(identity, input)).documents : plan.documents;
    const version = randomUUID();
    const destination = join(historyDirectory(paths, plan.metadata.planId), version);
    const stage = join(paths.stages, version);
    await directory(paths, stage);
    for (const document of documents) writeTextAtomically(join(stage, document.name), document.bytes);
    const { history: _history, ...metadata } = plan.metadata;
    writeJsonAtomically(join(stage, "plan.wld.json"), metadata);
    const digest = milestoneDigest(documents);
    if (!input && milestoneDigest(await readDocuments(paths, plan.path)) !== digest)
        fail("changed_input", "Plan documents changed during milestone capture.");
    await directory(paths, dirname(destination));
    await fs.rename(stage, destination);
    syncParentDirectory(destination);
    return [...(plan.metadata.history || []), { version, milestone, at, reason, digest }];
}

export async function readPackageMilestone(
    identity: ProjectIdentity,
    plan: LoadedPlanPackage,
    version: string,
): Promise<PackageDocuments> {
    const entry = plan.metadata.history?.find((item) => item.version === version);
    if (!entry) fail("missing", "Plan history version is unavailable.");
    const paths = layout(identity);
    const documents = await readDocuments(paths, join(historyDirectory(paths, plan.metadata.planId), entry.version));
    if (milestoneDigest(documents) !== entry.digest) fail("changed_input", "Frozen milestone documents changed.");
    return packageDocumentText(documents);
}

export function packageDocumentText(documents: PackageDocument[]): PackageDocuments {
    const result: PackageDocuments = { "context.md": "", "validation.md": "" };
    for (const document of documents) result[document.name] = decodePackageMarkdown(document.bytes);
    return result;
}

export async function capturePlanPackageInput(
    identity: ProjectIdentity,
    planId: string,
    reviewedContext?: string,
): Promise<PackageInputReference> {
    return await mutate(identity, planId, async (paths) => {
        const source = await loaded(paths, planId);
        const staged = await stageRetainedPlanInput(
            identity,
            { planId, metadataRevision: source.metadata.revision, documents: source.documents },
            reviewedContext,
        );
        const current = await loaded(paths, planId);
        if (
            current.metadata.revision !== source.metadata.revision ||
            current.documents.length !== source.documents.length ||
            current.documents.some(
                (doc, index) => doc.name !== source.documents[index].name || doc.hash !== source.documents[index].hash,
            )
        ) {
            await staged.discard();
            fail("changed_input", "Documents changed during capture. Capture the current input again.");
        }
        return await staged.commit();
    });
}
export async function readPlanPackageInput(
    identity: ProjectIdentity,
    reference: PackageInputReference,
): Promise<PackageInput> {
    return await readRetainedPlanInput(identity, reference);
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
    if (batch.authoring) return await recoverAuthoringBatch(paths, batch);
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

/** A complete package generation; existing documents carry their exact observed hashes. */
export interface PlanPackageBatchWrite {
    metadata: PlanPackageMetadata;
    documents: PackageDocuments;
    before: { metadata: PlanPackageMetadata; documents: PackageDocuments } | null;
}
/** Retain every reviewed document so a crash or an outside editor cannot authorize stale input. */
export interface PackageReviewCommit {
    inputs: Array<{ name: string; reference: PackageInputReference }>;
    reopened?: PlanPackageMetadata;
}

async function recoverReviewedBatch(
    paths: PackageLayout,
    batch: ImportBatch,
    write: PlanPackageBatchWrite,
    reportStale: boolean,
): Promise<void> {
    const review = batch.review!;
    if (!write.before || batch.authoring?.length !== 1 || !review.inputs.length)
        fail("pending_recovery", "Invalid reviewed package generation.");
    metadataFrom(write.metadata);
    metadataFrom(write.before.metadata);
    const members = [write.metadata.planId, ...(write.metadata.parentPlanId ? [write.metadata.parentPlanId] : [])];
    if (
        review.inputs.length !== members.length ||
        members.some((id) => !review.inputs.some((input) => input.reference.planId === id)) ||
        write.before.metadata.planId !== write.metadata.planId ||
        write.before.metadata.name !== write.metadata.name ||
        write.metadata.revision !== write.before.metadata.revision + 1 ||
        (review.reopened &&
            (review.reopened.planId !== write.metadata.planId ||
                review.reopened.name !== write.metadata.name ||
                review.reopened.revision !== write.metadata.revision))
    )
        fail("pending_recovery", "Reviewed package identity changed.");
    const path = join(paths.plans, normalizeName(write.metadata.name));
    const metadataPath = join(path, "plan.wld.json");
    const metadataBytes = await file(paths.home, metadataPath);
    if (!metadataBytes) fail("pending_recovery", "Reviewed package metadata is missing.");
    const metadata = parseMetadata(metadataBytes);
    const sameMetadata = (left: PlanPackageMetadata, right: PlanPackageMetadata) =>
        JSON.stringify(left) === JSON.stringify(right);
    const finish = () =>
        writeJsonAtomically(paths.batch, {
            version: 1,
            phase: "committed",
            recordId: batch.recordId,
            members: batch.members,
        } satisfies ImportBatch);
    if (!sameMetadata(metadata, write.metadata)) {
        if (review.reopened && sameMetadata(metadata, review.reopened)) {
            finish();
            if (reportStale) fail("changed_input", "Reviewed inputs changed before approval.");
            return;
        }
        if (!sameMetadata(metadata, write.before.metadata))
            fail("pending_recovery", "Reviewed package metadata changed outside its transaction.");
        const before = write.before.documents["context.md"];
        const after = write.documents["context.md"];
        const current = await file(paths.home, join(path, "context.md"));
        if (current && decodePackageMarkdown(current) === before && before !== after)
            writeTextAtomically(join(path, "context.md"), after);
        for (const input of review.inputs) {
            const plan = await inspectAt(paths, input.name);
            const retained = await readRetainedPlanInput(paths.identity, input.reference);
            if (
                plan.kind === "loaded" &&
                plan.metadata.planId === input.reference.planId &&
                plan.metadata.revision === retained.manifest.metadataRevision &&
                plan.documents.length === retained.documents.length &&
                plan.documents.every(
                    (doc, i) => doc.name === retained.documents[i]?.name && doc.hash === retained.documents[i]?.hash,
                )
            )
                continue;
            // Preserve all current prose, including the browser edit and concurrent filesystem edits.
            if (review.reopened) writeJsonAtomically(metadataPath, metadataFrom(review.reopened));
            finish();
            if (reportStale)
                fail("changed_input", "Reviewed inputs changed before approval. Review the current documents.");
            return;
        }
        writeJsonAtomically(metadataPath, write.metadata);
    }
    if (batch.operation) {
        const committed = await inspectAt(paths, write.metadata.name);
        if (committed.kind !== "loaded") fail(committed.kind, committed.message);
        if (batch.operation.planId !== write.metadata.planId)
            fail("pending_recovery", "Review receipt belongs to another Plan.");
        settleBatchOperation(paths.internal, batch.operation, packageWorkflowRevision(committed));
    }
    finish();
}

function batchBytes(metadata: PlanPackageMetadata, documents: PackageDocuments): Record<string, string> {
    return { ...documents, "plan.wld.json": JSON.stringify(metadata, null, 2) + "\n" };
}
async function batchResourceNeedsWrite(
    paths: PackageLayout,
    path: string,
    before: string | undefined,
    after: string | undefined,
): Promise<boolean> {
    const bytes = await file(paths.home, path);
    const current = bytes ? decodePackageMarkdown(bytes) : undefined;
    if (current === after) return false;
    if (current !== before)
        fail("pending_recovery", "A package changed during authoring; preserving both generations.");
    return true;
}

async function recoverAuthoringBatch(paths: PackageLayout, batch: ImportBatch, reportStale = false): Promise<void> {
    const writes = batch.authoring!;
    if (
        !writes.length ||
        JSON.stringify(batch.members) !==
            JSON.stringify(writes.map((write) => ({ planId: write.metadata.planId, name: write.metadata.name })))
    )
        fail("pending_recovery", "Authoring batch membership changed.");
    if (batch.review) return await recoverReviewedBatch(paths, batch, writes[0]!, reportStale);
    // Verify the whole generation before replacing any remaining resource. Outside edits are never rollback fodder.
    for (const write of writes) {
        metadataFrom(write.metadata);
        if (write.before) metadataFrom(write.before.metadata);
        const after = batchBytes(write.metadata, write.documents);
        const before = write.before ? batchBytes(write.before.metadata, write.before.documents) : {};
        if (
            Object.keys(write.documents).some((name) => !resources.includes(name as PackageResource)) ||
            typeof write.documents["context.md"] !== "string" ||
            typeof write.documents["validation.md"] !== "string"
        )
            fail("pending_recovery", "Invalid batch resources.");
        for (const name of [...resources, "plan.wld.json"]) {
            await batchResourceNeedsWrite(
                paths,
                join(paths.plans, write.metadata.name, name),
                before[name],
                after[name],
            );
        }
    }
    for (const write of writes) {
        const destination = join(paths.plans, write.metadata.name);
        await directory(paths, destination);
        const after = batchBytes(write.metadata, write.documents);
        const before = write.before ? batchBytes(write.before.metadata, write.before.documents) : {};
        for (const name of [...resources, "plan.wld.json"]) {
            const path = join(destination, name);
            if (!(await batchResourceNeedsWrite(paths, path, before[name], after[name]))) continue;
            if (after[name] === undefined) {
                await fs.unlink(path);
                syncParentDirectory(path);
            } else writeTextAtomically(path, after[name]);
        }
    }
    if (batch.operation) {
        if (!writes.some((write) => write.metadata.planId === batch.operation!.planId))
            fail("pending_recovery", "Authoring receipt belongs to another Plan.");
        const member = writes.find((write) => write.metadata.planId === batch.operation!.planId)!;
        const committed = await inspectAt(paths, member.metadata.name);
        if (committed.kind !== "loaded") fail(committed.kind, committed.message);
        settleBatchOperation(paths.internal, batch.operation, packageWorkflowRevision(committed));
    }
    writeJsonAtomically(paths.batch, { ...batch, phase: "committed" } satisfies ImportBatch);
}

/** Commit an authored family as one visible generation, with crash recovery and exact preconditions. */
export async function commitPlanPackageBatch(
    identity: ProjectIdentity,
    writes: PlanPackageBatchWrite[],
    review?: PackageReviewCommit,
): Promise<void> {
    if (!writes.length) return;
    await mutate(
        identity,
        writes.map((write) => write.metadata.planId),
        async (paths) => {
            const catalog = await scan(paths);
            if (catalog.issues.length) fail(catalog.issues[0].kind, catalog.issues[0].message);
            const ids = new Set(writes.map((write) => write.metadata.planId));
            const names = new Set(writes.map((write) => write.metadata.name));
            if (ids.size !== writes.length || names.size !== writes.length)
                fail("collision", "Duplicate authored Plan identity or name.");
            for (const write of writes) {
                metadataFrom(write.metadata);
                if (
                    typeof write.documents["context.md"] !== "string" ||
                    typeof write.documents["validation.md"] !== "string"
                )
                    fail("missing_document", "Authored packages require context and validation Markdown.");
                if (
                    Object.keys(write.documents).some((name) => !resources.includes(name as PackageResource)) ||
                    Object.values(write.documents).some((value) => typeof value !== "string")
                )
                    fail("missing_document", "Invalid authored package document.");
                const current = catalog.packages.find((plan) => plan.metadata.planId === write.metadata.planId);
                if (write.before) {
                    if (
                        !current ||
                        current.metadata.name !== write.metadata.name ||
                        JSON.stringify(current.metadata) !== JSON.stringify(write.before.metadata)
                    )
                        fail("changed_input", "An authored Plan's metadata changed.");
                    if (write.metadata.revision !== current.metadata.revision + 1)
                        fail("changed_input", "An authored Plan requires the next metadata revision.");
                    const observed = Object.fromEntries(
                        current.documents.map((doc) => [doc.name, decodePackageMarkdown(doc.bytes)]),
                    );
                    if (
                        Object.keys(observed).length !== Object.keys(write.before.documents).length ||
                        current.documents.some((doc) => observed[doc.name] !== write.before!.documents[doc.name])
                    )
                        fail("changed_input", "An authored Plan's documents changed.");
                } else {
                    if (current || write.metadata.revision !== 1) fail("collision", "An authored Plan already exists.");
                    await assertDestination(paths, write.metadata.name);
                }
                for (const related of [write.metadata.parentPlanId, ...write.metadata.dependencyPlanIds].filter(
                    Boolean,
                ))
                    if (!ids.has(related!) && !catalog.packages.some((plan) => plan.metadata.planId === related))
                        fail("missing", "An authored Plan relation is unavailable.");
            }
            const batch: ImportBatch = {
                version: 1,
                recordId: randomUUID(),
                phase: "pending",
                members: writes.map((write) => ({ planId: write.metadata.planId, name: write.metadata.name })),
                authoring: writes,
                review,
                operation: captureBatchOperation(),
            };
            writeJsonAtomically(paths.batch, batch);
            await recoverAuthoringBatch(paths, batch, true);
            if (!projects.home.isOwner(identity))
                await requestWorkspaceSearchRefresh(projects.checkout.primaryRoot(identity.checkoutRoot));
        },
    );
}

/** Explicit internal import; ordinary load/save/discovery never calls this operation. */
interface ManagedImportTransport {
    launch: import("../shared/remote/project-store-launch.ts").ManagedProjectStoreLaunch;
    operationId: string;
    signal?: AbortSignal;
}
export async function importPlanPackages(identity: ProjectIdentity, selection: string): Promise<PlanImportResult> {
    return await importObservedPlanPackages(identity, selection);
}
export async function importManagedPlanPackages(
    identity: ProjectIdentity,
    selection: string,
    transport: ManagedImportTransport,
): Promise<PlanImportResult> {
    if (!projects.home.isOwner(identity)) throw new Error("Managed import requires the personal home owner.");
    return await importObservedPlanPackages(identity, selection, transport);
}
async function importObservedPlanPackages(
    identity: ProjectIdentity,
    selection: string,
    transport?: ManagedImportTransport,
): Promise<PlanImportResult> {
    try {
        return await mutate(identity, null, async (paths) => {
            const catalog = await scan(paths);
            if (catalog.issues.length) fail(catalog.issues[0].kind, catalog.issues[0].message);
            const allocations = await readAllocations(paths);
            if (transport && (await file(paths.home, join(paths.imports, transport.operationId, "record.json")))) {
                const recorded = await importRecord(paths, transport.operationId);
                if (recorded.prepared.selection !== selection) throw new Error("Import operation selection changed.");
                const importedPlanIds = recorded.prepared.members.map((member) => member.metadata.planId);
                return {
                    kind: "committed",
                    planIds: [...new Set([...importedPlanIds, ...recorded.prepared.existingPlanIds])],
                    importedPlanIds,
                    existingPlanIds: recorded.prepared.existingPlanIds,
                };
            }
            if (!transport && !(await stat(selection))) {
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
            const request = {
                projectId: identity.projectId,
                repositoryId: identity.repositoryId,
                personalOwner: identity.personalOwner.identity,
                selection,
                allocations,
                catalog: catalog.packages.map((plan) => ({
                    metadata: {
                        planId: plan.metadata.planId,
                        name: plan.metadata.name,
                        definition: plan.metadata.definition,
                    },
                })),
                createdAt: new Date().toISOString(),
            };
            const prepared = transport
                ? await (
                      await import("../shared/remote/project-store-launch.ts")
                  ).readManagedImportSource(transport.launch, request, transport.signal)
                : await preparePlanPackageImport(
                      projects.home.requireCheckout(identity),
                      selection,
                      allocations,
                      catalog.packages,
                      request.createdAt,
                  );
            if (!prepared.members.length) {
                if (transport) {
                    await (
                        await import("../shared/remote/project-store-launch.ts")
                    ).readManagedImportSource(transport.launch, { ...request, prepared }, transport.signal);
                    const resultRoot = join(paths.imports, transport.operationId);
                    await directory(paths, resultRoot);
                    writeJsonAtomically(
                        join(resultRoot, "record.json"),
                        validateImportRecord({
                            version: 1,
                            recordId: transport.operationId,
                            projectId: identity.projectId,
                            prepared,
                        }),
                    );
                }
                return {
                    kind: "existing",
                    planIds: prepared.existingPlanIds,
                    importedPlanIds: [],
                    existingPlanIds: prepared.existingPlanIds,
                };
            }
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
                if (transport)
                    await (
                        await import("../shared/remote/project-store-launch.ts")
                    ).readManagedImportSource(transport.launch, { ...request, prepared }, transport.signal);
                else
                    await revalidatePlanImport(
                        projects.home.requireCheckout(identity),
                        prepared,
                        catalog.packages,
                        allocations,
                    );
                const recordId = transport?.operationId || randomUUID();
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

const publicationReferenceFields = [
    "kind",
    "projectId",
    "personalOwner",
    "repositoryId",
    "planId",
    "attemptId",
    "inputId",
    "digest",
];
export function assertPackagePublicationReference(reference: PackagePublicationReference): void {
    const value = fields(JSON.parse(JSON.stringify(reference)), publicationReferenceFields);
    if (
        value.kind !== "package" ||
        publicationReferenceFields.some((key) => typeof value[key] !== "string" || !value[key]) ||
        !/^[0-9a-f-]{36}$/.test(reference.inputId) ||
        !/^[0-9a-f]{64}$/.test(reference.digest)
    )
        fail("malformed_metadata", "Invalid package publication reference.");
    requireId(reference.planId);
}

/** Preserve UTF-8 Markdown byte identity, including BOM; malformed encoding cannot be copied lossily. */
export function decodePackageMarkdown(bytes: Uint8Array): string {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
}

export function assertDeliveryCopies(copies: DeliveryCopy[]): void {
    if (!Array.isArray(copies)) fail("malformed_metadata", "Invalid delivery copies.");
    const paths = new Set<string>();
    for (const copy of copies) {
        fields(JSON.parse(JSON.stringify(copy)), ["kind", "path", "text"]);
        if (
            typeof copy.text !== "string" ||
            typeof copy.path !== "string" ||
            !["plan", "work-record"].includes(copy.kind) ||
            !copy.path.startsWith(copy.kind === "plan" ? "docs/plans/" : "docs/work-records/") ||
            !copy.path.endsWith(".md") ||
            copy.path.includes("\\") ||
            copy.path
                .split("/")
                .some(
                    (part) =>
                        !part ||
                        part === "." ||
                        part === ".." ||
                        [...part].some((character) => character.charCodeAt(0) < 32),
                ) ||
            paths.has(copy.path)
        )
            fail("unsafe_path", "Unsafe or duplicate delivery copy destination.");
        if (decodePackageMarkdown(new TextEncoder().encode(copy.text)) !== copy.text)
            fail("malformed_metadata", "Delivery copy is not valid UTF-8 Markdown.");
        paths.add(copy.path);
    }
}

function validateRecordingOutcome(value: JsonValue): void {
    const record = fields(value, ["status", "recordId", "path", "lastAttemptAt", "error"]);
    if (
        Object.values(record).some((item) => typeof item !== "string") ||
        (record.status !== undefined && !["generated", "failed"].includes(String(record.status)))
    )
        fail("malformed_metadata", "Invalid package recording outcome.");
}

async function validatePublicationManifest(
    identity: ProjectIdentity,
    manifest: PackagePublicationManifest,
): Promise<void> {
    fields(JSON.parse(JSON.stringify(manifest)), [
        "version",
        "projectId",
        "personalOwner",
        "repositoryId",
        "planId",
        "attemptId",
        "inputId",
        "validatedCommit",
        "targetBranch",
        "planCopies",
        "stage",
        "workRecordCopies",
        "autoGenerateRecords",
        "preparedRecord",
        "recordingOutcome",
        "members",
        "copies",
    ]);
    if (
        manifest.version !== 1 ||
        manifest.projectId !== identity.projectId ||
        manifest.personalOwner !== identity.personalOwner.identity ||
        manifest.repositoryId !== identity.repositoryId ||
        typeof manifest.planCopies !== "boolean" ||
        typeof manifest.validatedCommit !== "string" ||
        typeof manifest.targetBranch !== "string" ||
        !manifest.attemptId ||
        !Array.isArray(manifest.members)
    )
        fail("malformed_metadata", "Publication manifest does not belong to this owner and repository.");
    assertDeliveryCopies(manifest.copies);
    if (manifest.stage !== undefined && manifest.stage !== "recording")
        fail("malformed_metadata", "Invalid publication stage.");
    for (const value of [manifest.workRecordCopies, manifest.autoGenerateRecords])
        if (value !== undefined && typeof value !== "boolean") fail("malformed_metadata", "Invalid recording policy.");
    if (manifest.recordingOutcome !== undefined)
        validateRecordingOutcome(JSON.parse(JSON.stringify(manifest.recordingOutcome)));
    if (manifest.preparedRecord) {
        assertDeliveryCopies([manifest.preparedRecord]);
        const record = parseWorkRecordMarkdown(manifest.preparedRecord.text);
        const ownerId =
            manifest.members.find((member) => member.metadata.planId === manifest.planId)?.metadata.parentPlanId ||
            manifest.planId;
        if (
            manifest.preparedRecord.kind !== "work-record" ||
            record.attrs.status !== "pending_verification" ||
            !record.attrs.provenance?.sourcePlans?.includes(ownerId) ||
            (manifest.recordingOutcome?.recordId && manifest.recordingOutcome.recordId !== record.attrs.recordId)
        )
            fail("malformed_metadata", "Prepared Work Record does not match its retained source.");
        const copies = manifest.copies.filter((copy) => copy.kind === "work-record");
        if (
            copies.some(
                (copy) => copy.path !== manifest.preparedRecord!.path || copy.text !== manifest.preparedRecord!.text,
            ) ||
            (manifest.workRecordCopies === false && copies.length)
        )
            fail("malformed_metadata", "Work Record copies do not match retained recording policy.");
    }
    const ids = new Set<string>();
    for (const member of manifest.members) {
        fields(JSON.parse(JSON.stringify(member)), ["metadata", "input", "controller"]);
        metadataFrom(member.metadata);
        fields(JSON.parse(JSON.stringify(member.controller)), [...CONTROLLER_STATE_FIELDS]);
        if (ids.has(member.metadata.planId) || member.input.planId !== member.metadata.planId)
            fail("malformed_metadata", "Invalid publication family identity.");
        ids.add(member.metadata.planId);
        const retained = await readPlanPackageInput(identity, member.input);
        for (const document of retained.documents) decodePackageMarkdown(document.bytes);
        const copies = manifest.copies.filter((copy) => copy.kind === "plan");
        if (
            manifest.planCopies &&
            member.metadata.planId === manifest.planId &&
            (copies.length !== retained.documents.length ||
                retained.documents.some(
                    (doc) =>
                        !copies.some(
                            (copy) =>
                                copy.path === `docs/plans/${member.metadata.name}/${doc.name}` &&
                                copy.text === decodePackageMarkdown(doc.bytes),
                        ),
                ))
        )
            fail("malformed_metadata", "Plan copies do not match the retained documents.");
    }
    const publishingMember = manifest.members.find((member) => member.metadata.planId === manifest.planId);
    const artifact = publishingMember?.metadata.workflow?.generatedArtifact;
    if (artifact) {
        const parent = manifest.members.find((member) => member.metadata.planId === artifact.planId);
        if (
            artifact.attemptId !== manifest.attemptId ||
            artifact.planId !== publishingMember?.metadata.parentPlanId ||
            !parent
        )
            fail("malformed_metadata", "Generated checklist does not belong to this publication.");
        const reviewed = await readPlanPackageInput(identity, parent.input);
        if ((reviewed.documents.find((doc) => doc.name === artifact.name)?.hash ?? null) !== artifact.beforeHash)
            fail("malformed_metadata", "Generated checklist does not extend the reviewed parent document.");
    }
    if (!ids.has(manifest.planId) || (!manifest.planCopies && manifest.copies.some((copy) => copy.kind === "plan")))
        fail("malformed_metadata", "Publication input omits its Plan or violates copy policy.");
}

/** Persist immutable source bytes before exposing a reference to any workflow owner. */
export async function retainPlanPackagePublication(
    identity: ProjectIdentity,
    input: Omit<PackagePublicationManifest, "version" | "inputId" | "projectId" | "personalOwner" | "repositoryId">,
): Promise<PackagePublicationReference> {
    const manifest: PackagePublicationManifest = {
        ...input,
        version: 1,
        inputId: publicationInputId(
            identity,
            input.planId,
            input.attemptId,
            input.validatedCommit + (input.stage ? ":recording" : ""),
        ),
        projectId: identity.projectId,
        personalOwner: identity.personalOwner.identity,
        repositoryId: identity.repositoryId,
    };
    const previous = await findPlanPackagePublication(
        identity,
        input.planId,
        input.attemptId,
        input.validatedCommit,
        input.stage,
    );
    if (previous) return previous;
    await validatePublicationManifest(identity, manifest);
    const paths = layout(identity);
    const root = join(paths.internal, "publications");
    await directory(paths, root);
    const text = JSON.stringify(manifest);
    writeTextAtomically(join(root, `${manifest.inputId}.json`), text);
    const reference: PackagePublicationReference = {
        kind: "package",
        projectId: manifest.projectId,
        personalOwner: manifest.personalOwner,
        repositoryId: manifest.repositoryId,
        planId: manifest.planId,
        attemptId: manifest.attemptId,
        inputId: manifest.inputId,
        digest: createHash("sha256").update(text).digest("hex"),
    };
    await readPlanPackagePublication(identity, reference);
    return reference;
}

export async function readPlanPackagePublication(
    identity: ProjectIdentity,
    reference: PackagePublicationReference,
): Promise<PackagePublicationManifest> {
    assertPackagePublicationReference(reference);
    if (
        reference.projectId !== identity.projectId ||
        reference.personalOwner !== identity.personalOwner.identity ||
        reference.repositoryId !== identity.repositoryId
    )
        fail("malformed_metadata", "Publication reference belongs to another owner or repository.");
    const paths = layout(identity);
    const bytes = await file(paths.home, join(paths.internal, "publications", `${reference.inputId}.json`));
    if (!bytes || createHash("sha256").update(bytes).digest("hex") !== reference.digest)
        fail("malformed_metadata", "Retained publication input is missing or changed.");
    const manifest: PackagePublicationManifest = JSON.parse(new TextDecoder().decode(bytes));
    if (
        manifest.planId !== reference.planId ||
        manifest.attemptId !== reference.attemptId ||
        manifest.inputId !== reference.inputId
    )
        fail("malformed_metadata", "Retained publication identity changed.");
    await validatePublicationManifest(identity, manifest);
    return manifest;
}

function publicationInputId(identity: ProjectIdentity, planId: string, attemptId: string, commit: string): string {
    const digest = createHash("sha256")
        .update(
            JSON.stringify([
                identity.projectId,
                identity.personalOwner.identity,
                identity.repositoryId,
                planId,
                attemptId,
                commit,
            ]),
        )
        .digest("hex");
    return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-${digest.slice(12, 16)}-${digest.slice(16, 20)}-${digest.slice(20, 32)}`;
}
/** Recover bytes made durable before the controller/registry acknowledged their reference. */
export async function findPlanPackagePublication(
    identity: ProjectIdentity,
    planId: string,
    attemptId: string,
    commit: string,
    stage?: "recording",
): Promise<PackagePublicationReference | null> {
    const inputId = publicationInputId(identity, planId, attemptId, commit + (stage ? ":recording" : ""));
    const paths = layout(identity);
    const bytes = await file(paths.home, join(paths.internal, "publications", `${inputId}.json`));
    if (!bytes) return null;
    const reference: PackagePublicationReference = {
        kind: "package",
        projectId: identity.projectId,
        personalOwner: identity.personalOwner.identity,
        repositoryId: identity.repositoryId,
        planId,
        attemptId,
        inputId,
        digest: createHash("sha256").update(bytes).digest("hex"),
    };
    const manifest = await readPlanPackagePublication(identity, reference);
    if (manifest.validatedCommit !== commit)
        fail("malformed_metadata", "Retained candidate does not match publication.");
    return reference;
}

export function samePackagePublicationReference(
    left: PackagePublicationReference | undefined,
    right: PackagePublicationReference,
): boolean {
    return Boolean(
        left &&
        left.kind === right.kind &&
        left.projectId === right.projectId &&
        left.personalOwner === right.personalOwner &&
        left.repositoryId === right.repositoryId &&
        left.planId === right.planId &&
        left.attemptId === right.attemptId &&
        left.inputId === right.inputId &&
        left.digest === right.digest,
    );
}

/** Recover recording input published before its Plan reference, without consulting newer documents. */
export async function findPlanPackageRecordingPreparation(
    identity: ProjectIdentity,
    planId: string,
    attemptId: string,
): Promise<PackagePublicationReference | null> {
    const paths = layout(identity);
    const root = join(paths.internal, "publications");
    await safe(paths.home, root);
    const entries = await fs.readdir(root).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return [];
        throw error;
    });
    let found: PackagePublicationReference | null = null;
    for (const entry of entries) {
        if (!entry.endsWith(".json")) continue;
        const bytes = await file(paths.home, join(root, entry));
        if (!bytes) throw new Error("Retained recording input disappeared during recovery.");
        const manifest: PackagePublicationManifest = JSON.parse(decodePackageMarkdown(bytes));
        if (
            manifest.stage !== "recording" ||
            manifest.planId !== planId ||
            manifest.attemptId !== attemptId ||
            manifest.repositoryId !== identity.repositoryId
        )
            continue;
        const reference: PackagePublicationReference = {
            kind: "package",
            projectId: manifest.projectId,
            personalOwner: manifest.personalOwner,
            repositoryId: manifest.repositoryId,
            planId,
            attemptId,
            inputId: manifest.inputId,
            digest: createHash("sha256").update(bytes).digest("hex"),
        };
        await readPlanPackagePublication(identity, reference);
        if (found && found.inputId !== reference.inputId)
            throw new Error("Multiple recording inputs claim this attempt.");
        found = reference;
    }
    return found;
}

/** Revision identity shared by local and connection-bound commands. */
export function packageWorkflowRevision(plan: LoadedPlanPackage): string {
    return createHash("sha256")
        .update(
            JSON.stringify({
                revision: plan.metadata.revision,
                documents: plan.documents.map(({ name, hash }) => ({ name, hash })),
            }),
        )
        .digest("hex");
}

export async function readManagedPlanImportResult(
    identity: ProjectIdentity,
    operationId: string,
): Promise<import("./import-source.ts").PlanImportCommitted> {
    const record = await importRecord(layout(identity), operationId);
    const importedPlanIds = record.prepared.members.map((member) => member.metadata.planId);
    return {
        kind: "committed",
        planIds: [...new Set([...importedPlanIds, ...record.prepared.existingPlanIds])],
        importedPlanIds,
        existingPlanIds: record.prepared.existingPlanIds,
    };
}

interface PruneMember {
    planId: string;
    name: string;
    metadataDigest: string;
    documents: { name: string; hash: string }[];
    versions: string[];
}
interface PruneJournal {
    phase: "staging" | "restoring" | "committed";
    members: PruneMember[];
}
async function restorePruneTree(paths: PackageLayout, staged: string, path: string): Promise<void> {
    await safe(paths.home, path);
    const original = await fs.lstat(staged);
    if (original.isDirectory()) {
        if (!(await stat(path))) {
            await fs.rename(staged, path);
        } else {
            for (const name of await fs.readdir(staged))
                await restorePruneTree(paths, join(staged, name), join(path, name));
            await fs.rmdir(staged);
        }
    } else {
        // An editor may have saved newer bytes at this name while the family was detached.
        try {
            await fs.link(staged, path);
        } catch (error) {
            if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
        }
        await fs.unlink(staged);
    }
    syncParentDirectory(path);
    syncParentDirectory(staged);
}
async function readPruneJournal(paths: PackageLayout): Promise<PruneJournal | null> {
    const bytes = await file(paths.home, join(paths.internal, "pruning.json"));
    if (!bytes) return null;
    const stored: PruneJournal | PruneMember[] = JSON.parse(new TextDecoder().decode(bytes));
    const journal: PruneJournal = Array.isArray(stored) ? { phase: "staging", members: stored } : stored;
    if (!["staging", "restoring", "committed"].includes(journal.phase)) throw new Error("Invalid prune journal.");
    return journal;
}
async function resumePackagePrune(paths: PackageLayout, freshlyApproved = false): Promise<boolean> {
    const intentPath = join(paths.internal, "pruning.json");
    const journal = await readPruneJournal(paths);
    if (!journal) return false;
    // An interrupted staging pass has lost the retention and Recorder locks. Restore it before checking eligibility again.
    if (journal.phase === "staging" && !freshlyApproved) {
        journal.phase = "restoring";
        writeJsonAtomically(intentPath, journal);
    }
    const stage = join(paths.internal, "prune-staging");
    await directory(paths, stage);
    const names = journal.members.map((member) => normalizeName(member.name));
    const roots = names
        .filter((name) => !names.some((other) => name.startsWith(other + "/")))
        .map((name, i) => ({
            name,
            path: join(paths.plans, name),
            staged: join(stage, String(i)),
        }));
    const members = journal.members.map((member) => {
        const id = requireId(member.planId);
        const root = roots.find((root) => root.name === member.name || member.name.startsWith(root.name + "/"))!;
        const directory = join(root.staged, relative(root.path, join(paths.plans, member.name)));
        if (
            member.documents.some((doc) => !resources.includes(doc.name as PackageResource)) ||
            member.versions.some((version) => !/^[a-f0-9-]{36}$/.test(version))
        )
            throw new Error("Invalid approved Plan resources.");
        return { ...member, directory, history: historyDirectory(paths, id) };
    });
    if (journal.phase === "staging") {
        let matches = true;
        try {
            // Detach each subtree before checking its contents. A pathname save can no longer replace a checked document.
            for (const root of roots) {
                await safe(paths.home, root.path);
                await safe(paths.home, root.staged);
                if (!(await stat(root.staged))) {
                    if (!(await stat(root.path))) {
                        matches = false;
                        break;
                    }
                    await fs.rename(root.path, root.staged);
                    syncParentDirectory(root.path);
                    syncParentDirectory(root.staged);
                }
                if (await stat(root.path)) matches = false;
            }
            for (const member of members) {
                const metadata = await file(paths.home, join(member.directory, "plan.wld.json"));
                if (
                    !metadata ||
                    digest(metadata) !== member.metadataDigest ||
                    parseMetadata(metadata).planId !== member.planId
                )
                    matches = false;
                for (const name of resources) {
                    const approved = member.documents.find((doc) => doc.name === name);
                    const current = await file(paths.home, join(member.directory, name));
                    if ((current ? digest(current) : undefined) !== approved?.hash) matches = false;
                }
            }
        } catch (error) {
            journal.phase = "restoring";
            writeJsonAtomically(intentPath, journal);
            await resumePackagePrune(paths);
            throw error;
        }
        journal.phase = matches ? "committed" : "restoring";
        writeJsonAtomically(intentPath, journal);
    }
    if (journal.phase === "committed") {
        for (const member of members) {
            for (const name of ["plan.wld.json", ...member.documents.map((doc) => doc.name)]) {
                const path = join(member.directory, name);
                await safe(paths.home, path);
                await fs.rm(path, { force: true });
            }
            for (const version of member.versions) {
                const path = join(member.history, version);
                await safe(paths.home, path);
                await fs.rm(path, { recursive: true, force: true });
            }
            for (const path of [member.directory, member.history]) {
                await safe(paths.home, path);
                await fs.rmdir(path).catch((error: NodeJS.ErrnoException) => {
                    if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes(error.code || "")) throw error;
                });
            }
        }
    }
    // Restore the family on a mismatch, or return unrelated files after committing the exact approved set.
    for (const root of roots) if (await stat(root.staged)) await restorePruneTree(paths, root.staged, root.path);
    await fs.rmdir(stage);
    await fs.unlink(intentPath);
    syncParentDirectory(intentPath);
    return journal.phase === "committed";
}
/** Catalog lock serializes replay before another writer can reuse an approved name. */
export async function prunePackageFamily(identity: ProjectIdentity, family: LoadedPlanPackage[]) {
    return await mutate(
        identity,
        family.map((plan) => plan.metadata.planId),
        async (paths) => {
            const members: PruneMember[] = [];
            for (const { metadata, documents, path } of family.toSorted((a, b) => b.path.length - a.path.length)) {
                const bytes = await file(paths.home, join(path, "plan.wld.json"));
                if (!bytes || JSON.stringify(parseMetadata(bytes)) !== JSON.stringify(metadata))
                    throw new Error("Approved Plan identity changed.");
                members.push({
                    planId: metadata.planId,
                    name: metadata.name,
                    metadataDigest: digest(bytes),
                    documents: documents.map(({ name, hash }) => ({ name, hash })),
                    versions: (metadata.history || []).map((h) => h.version),
                });
            }
            writeJsonAtomically(join(paths.internal, "pruning.json"), { phase: "staging", members });
            return await resumePackagePrune(paths, true);
        },
    );
}
