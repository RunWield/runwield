import { hasRetainedCheckoutSource, withRetainedCheckoutSource } from "./retained-source.ts";
/** Legacy document inventory and evidence capture. Persistence belongs to plan-package-store. */
import fs from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { extractYaml, type FrontMatterRecord } from "../shared/front-matter.ts";
import { EPIC_ARTIFACT_FILE_NAMES } from "../plan-format.ts";
import { canonicalPlanStatus, getPlanDocumentRoot, normalizePlanId, parsePlanFrontMatter } from "../plan-store.js";
import { PlanPackageError } from "./packages.ts";
import { resolveWorkflowPlanLocation } from "./location.ts";
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
} from "../shared/worktree-registry.js";
import { resolvePrimaryCheckoutRoot } from "../shared/primary-checkout.ts";
import { checkedProjectRuntimeLayout } from "../shared/project-runtime-layout.ts";
import type { ProjectIdentity } from "../shared/project-identity.ts";
import type { LoadedPlanPackage, PackageDocuments, PlanPackageMetadata, PackageDefinition } from "./packages.ts";

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
export interface PreparedPlanImport {
    selection: string;
    membership: string[];
    members: ImportMember[];
    existingPlanIds: string[];
    allocations: ImportAllocation[];
    observations: ImportFileEvidence[];
}
export interface PlanImportCommitted {
    kind: "committed" | "existing";
    planIds: string[];
    importedPlanIds: string[];
    existingPlanIds: string[];
}
export interface PlanImportIssue {
    kind: "conflict" | "pending" | "unavailable" | "invalid";
    message: string;
}
export type PlanImportResult = PlanImportCommitted | PlanImportIssue;

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
async function inventory(selection: string): Promise<string[]> {
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
        if (entry.isSymbolicLink())
            throw new PlanPackageError("unsafe_path", `Import source contains a symbolic link: ${path}`);
        if (entry.isDirectory()) result.push(...(await inventory(path)));
        else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) result.push(path);
    }
    return result;
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
    catalog: LoadedPlanPackage[],
    createdAt: string,
): Promise<PreparedPlanImport> {
    if (!hasRetainedCheckoutSource(identity.checkoutRoot))
        return await withRetainedCheckoutSource(identity, () =>
            preparePlanPackageImport(identity, selection, allocations, catalog, createdAt),
        );
    if (!isAbsolute(selection) || selection.split(/[\\/]/).includes(".."))
        throw new PlanPackageError("unsafe_path", "Select an absolute path without traversal.");
    selection = resolve(selection);
    const plansRoot = join(identity.checkoutRoot, "docs", "plans");
    let membership: string[];
    let virtualSource: ImportFileEvidence | null = null;
    let virtualAuthority: ImportFileEvidence | null = null;
    try {
        membership = await inventory(selection);
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
        virtualSource = { path: selection, bytes: bytes.toString("base64"), digest: hash(bytes) };
        virtualAuthority = { ...virtualSource, path: located.plan.path };
        membership = [selection];
    }
    const selectedDirectory = virtualSource
        ? dirname(selection)
        : (await fs.lstat(selection)).isDirectory()
          ? selection
          : dirname(selection);
    const result: PreparedPlanImport = {
        selection,
        membership,
        members: [],
        existingPlanIds: [],
        allocations: [],
        observations: [],
    };
    const names = new Map<string, Set<string>>();
    const rememberName = (name: string, id: string) => names.set(name, new Set([...(names.get(name) || []), id]));
    for (const existing of catalog) rememberName(existing.metadata.name, existing.metadata.planId);
    for (const allocation of allocations)
        if (catalog.some((p) => p.metadata.planId === allocation.planId))
            rememberName(allocation.name, allocation.planId);
    const selectedIds = new Map<string, SelectedImportSource>();
    const artifacts = new Map<ImportFileEvidence, string>();
    for (const path of membership) {
        const source = virtualSource || (await inspectImportFile(path));
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
            continue;
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
        if (previous && previous.idless && previous.digest !== source.digest)
            throw new PlanPackageError("collision", `Source changed since import: ${path}`);
        const id = selected.attrs.planId || previous?.planId || randomUUID();
        if (previous && previous.planId !== id)
            throw new PlanPackageError("collision", `Source identity changed: ${path}`);
        const name = planName(sourceRelativePath);
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
        let authority = virtualAuthority || source;
        let authorityKind: LegacyImportEvidence["authorityKind"] = virtualAuthority ? "target-snapshot" : "selected";
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
                !path.includes(`${sourcePlansRoot}/archived/`) ||
                attempts.some((entry) => entry.status !== "abandoned")
            ) {
                const located = await resolveWorkflowPlanLocation(identity.checkoutRoot, name, {
                    readOnly: true,
                    loadFromTarget: true,
                });
                const archivedPath =
                    located.archived && within(join(sourcePlansRoot, "archived"), path)
                        ? join(located.documentRoot, "docs", "plans", "archived", `${name}.md`)
                        : null;
                if ((!located.plan && !archivedPath) || located.missingExecutionCheckout)
                    pending(`The authoritative Plan document is unavailable: ${name}`);
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
            if (controller && (controller.planName !== name || (controller.planId && controller.planId !== id)))
                pending(`Controller identity does not match ${name}.`);
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
            continue;
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
        if (within(join(sourcePlansRoot, "archived"), path) && !archived)
            refused(`Archived source lacks archive facts: ${path}`);
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
            archive: archived
                ? {
                      archivedAt: String(archived),
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
                (authorityKind !== "registered" && duplicate.evidence.authorityKind !== "registered") ||
                duplicate.evidence.authority.path !== authority.path ||
                duplicate.evidence.authority.digest !== authority.digest
            )
                throw new PlanPackageError("collision", `Conflicting duplicate Plan ID: ${id}`);
            continue;
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
    }
    // Never guess a suffix or silently choose one of two names/short-name matches.
    const all = [...catalog.map((item) => item.metadata), ...result.members.map((item) => item.metadata)];
    for (const member of result.members) {
        const name = member.metadata.name;
        if (all.some((other) => other.planId !== member.metadata.planId && namesCollide(other.name, name)))
            throw new PlanPackageError("collision", `Plan name already exists: ${name}`);
        const parsed = document(text(member.evidence.authority));
        const relationship = (value: string): string => {
            const reference = planName(value);
            const candidates = new Set(
                [...names]
                    .filter(
                        ([key]) =>
                            key === reference ||
                            (!reference.includes("/") &&
                                key === `${planName(parsed.attrs.parentPlan || dirname(name))}/${reference}`),
                    )
                    .flatMap(([, ids]) => [...ids]),
            );
            if (candidates.size !== 1)
                throw new PlanPackageError(
                    "collision",
                    `Unresolved or ambiguous relationship ${value} in ${name}; include its source or import it first.`,
                );
            return [...candidates][0];
        };
        member.metadata.parentPlanId = parsed.attrs.parentPlan ? relationship(parsed.attrs.parentPlan) : null;
        member.metadata.dependencyPlanIds = [...new Set((parsed.attrs.dependencies || []).map(relationship))];
    }
    for (const [artifact, owner] of artifacts) {
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
    }
    result.existingPlanIds = [...new Set(result.existingPlanIds)];
    return result;
}

export async function revalidatePlanImport(
    identity: ProjectIdentity,
    prepared: PreparedPlanImport,
    catalog: LoadedPlanPackage[],
    allocations: ImportAllocation[],
): Promise<void> {
    const current = await preparePlanPackageImport(
        identity,
        prepared.selection,
        [...allocations, ...prepared.allocations],
        catalog,
        prepared.allocations[0]?.createdAt || "",
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
