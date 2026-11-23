import { projects, type ProjectId, type ProjectStoreIdentity } from "@runwield/projects";
import { openNativeFileLock } from "../shared/native-file-lock.ts";
/** Connection selection and durable requests stay inside the public Plan owner. */
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { join, relative, isAbsolute } from "node:path";
import { personalGlobalRoot } from "../shared/remote/personal-resources.ts";
import { readFile, rename } from "node:fs/promises";
import { ProjectStoreClient, ProjectStorePreconditionError } from "../shared/remote/project-store-client.ts";
import {
    validateProjectStoreBinding,
    sameProjectStoreBinding,
    parseHistoryList,
    parseMilestoneDocuments,
    validateProjectStoreRequest,
} from "../shared/remote/project-store-protocol.ts";
import type { RemoteSessionControlConnection } from "../shared/remote/session-control-client.ts";
import { enterProjectRuntime } from "../shared/project-runtime-layout.ts";
import { writeJsonAtomically, ensurePrivateDir } from "../shared/private-json-file.ts";
import { operationDigest, operationHash } from "./operation-receipts.ts";
import type { ProjectStoreBinding, ProjectStoreCommand } from "./project-service.ts";
import type { PlanAuthoringInput } from "./access.ts";
import type { PlanExecutionReservation } from "./workflows.ts";

interface ManagedConnection {
    closed: boolean;
    cwd: string;
    connection: RemoteSessionControlConnection;
    client?: ProjectStoreClient;
    admitted?: boolean;
}
export interface ManagedPlanSelection {
    kind: "managed-plan";
    retainedAttemptId?: string;
    binding: ProjectStoreBinding;
    planId: string;
    planName: string;
    revision: string;
}
const selections = new AsyncLocalStorage<ManagedPlanSelection>();
const projectConnections = new AsyncLocalStorage<ManagedConnection>();
const retainedExecutions = new AsyncLocalStorage<import("./retained-managed-execution.ts").RetainedManagedExecution>();
export function currentManagedRetainedExecution() {
    return retainedExecutions.getStore();
}
let active: ManagedConnection | undefined;
export function configureManagedPlanStore(cwd: string, connection: RemoteSessionControlConnection): () => void {
    if (active && !active.closed) throw new Error("Managed Plan owner is already configured.");
    const configured = { cwd, connection: { ...connection }, closed: false };
    active = configured;
    return () => {
        configured.closed = true;
    };
}
export function managedPersonalStoreActive(): boolean {
    return (projectConnections.getStore() ?? active) !== undefined && !projects.home.current();
}
export function managedPlanStoreActive(): boolean {
    return managedPersonalStoreActive() && !currentManagedRetainedExecution();
}
export function currentManagedPlanSelection(): ManagedPlanSelection | undefined {
    return selections.getStore();
}
function client(cwd: string, admit: true): Promise<ProjectStoreClient>;
function client(cwd: string, admit?: false): Promise<ProjectStoreClient | undefined>;
async function client(cwd: string, admit = false): Promise<ProjectStoreClient | undefined> {
    const selected = projectConnections.getStore() ?? active;
    if (!selected || selected !== active || selected.closed) throw new Error("Managed Plan owner is unavailable.");
    if (!selected.client || (admit && !selected.admitted)) {
        const endpoint = `http://127.0.0.1:${selected.connection.port}`;
        const response = await fetch(`${endpoint}/project-store/${admit ? "admit" : "inspect"}`, {
            method: "POST",
            headers: { Authorization: `Bearer ${selected.connection.credential}` },
        });
        if (!response.ok) throw new Error("Managed Plan owner admission is unavailable.");
        const binding: ProjectStoreBinding | null = await response.json();
        if (!binding && !admit) return undefined;
        if (!binding) throw new Error("Managed Plan owner admission returned no binding.");
        validateProjectStoreBinding(binding);
        if (active !== selected) throw new Error("Managed connection changed during admission.");
        selected.client = new ProjectStoreClient(endpoint, selected.connection.credential, binding);
        if (admit) selected.admitted = true;
    }
    const inspection = projects.checkout.inspect(cwd);
    if (
        inspection.kind !== "existing" ||
        inspection.identity.projectId !== selected.client.binding.projectId ||
        inspection.identity.repositoryId !== selected.client.binding.repositoryId ||
        operationHash(inspection.identity.personalOwner.identity) !== selected.client.binding.ownerId
    )
        throw new Error("Managed Plan request belongs to another execution repository.");
    return selected.client;
}

/** Bind a project request to its configured managed connection for its lifetime. */
export function captureManagedProjectPlanAccess(projectId: ProjectId, admitted?: ProjectStoreIdentity) {
    if (!managedPersonalStoreActive()) return undefined;
    const configured = projectConnections.getStore() ?? active;
    if (!configured || configured.closed) throw new Error("Managed Plan owner is unavailable.");
    const inspect = () => {
        if (configured !== active || configured.closed || !managedPlanStoreActive())
            throw new Error("Managed Plan owner is unavailable.");
        const root = projects.checkout.inspect(configured.cwd);
        if (root.kind !== "existing" || root.identity.projectId !== projectId)
            throw new Error("Managed Plan access belongs to a different Project.");
        return root.identity;
    };
    const initial = inspect();
    if (admitted) {
        projects.home.assertStoreIdentity(admitted);
        if (
            projects.home.isOwner(admitted) ||
            initial.checkoutId !== admitted.checkoutId ||
            initial.repositoryId !== admitted.repositoryId ||
            initial.personalOwner.kind !== admitted.personalOwner.kind ||
            initial.personalOwner.identity !== admitted.personalOwner.identity ||
            initial.executionAccountHome !== admitted.executionAccountHome
        )
            throw new Error("Managed Plan access requires its configured Project checkout and account.");
    }
    return async <Result>(operation: (cwd: string) => Promise<Result>) => {
        const current = inspect();
        if (
            current.repositoryId !== initial.repositoryId ||
            current.checkoutId !== initial.checkoutId ||
            current.personalOwner.kind !== initial.personalOwner.kind ||
            current.personalOwner.identity !== initial.personalOwner.identity ||
            current.executionAccountHome !== initial.executionAccountHome
        )
            throw new Error("Managed Plan Project authority changed.");
        return await projectConnections.run(configured, () => operation(current.cwd));
    };
}
function managedLocator(cwd: string, path: string, toOwner = false): string {
    const inspected = projects.checkout.inspect(cwd);
    if (inspected.kind !== "existing") throw new Error("Managed locator requires admitted identity.");
    const ownerRoot = join(inspected.identity.personalOwner.identity, ".wld", "projects", inspected.identity.projectId);
    const mountedRoot = join(personalGlobalRoot(), "projects", inspected.identity.projectId);
    const source = toOwner ? mountedRoot : ownerRoot;
    const destination = toOwner ? ownerRoot : mountedRoot;
    if (toOwner && !path.startsWith(`${source}/`)) return path;
    const suffix = relative(source, path);
    if (isAbsolute(suffix) || suffix === ".." || suffix.startsWith("../"))
        throw new Error("Plan locator leaves its admitted personal Project.");
    return join(destination, suffix);
}
export function managedDocumentRoot(cwd: string): string {
    const inspected = projects.checkout.inspect(cwd);
    if (inspected.kind !== "existing") throw new Error("Managed document requires admitted identity.");
    return join(personalGlobalRoot(), "projects", inspected.identity.projectId, "plans");
}
export async function readManagedPlan(cwd: string, reference: string) {
    const owner = await client(cwd);
    if (!owner) return null;
    const result = (await owner.execute({ kind: "resolve-plan", reference: managedLocator(cwd, reference, true) }))
        .result;
    if (!("plan" in result)) throw new Error("Managed owner returned another query result.");
    const plan = result.plan;
    return plan
        ? {
              ...plan,
              path: managedLocator(cwd, plan.path),
              kind: "loaded" as const,
              frontMatterRevision: plan.frontMatterRevision,
              hasFrontMatter: plan.hasFrontMatter ?? false,
          }
        : null;
}
export async function listManagedPlans(cwd: string) {
    const owner = await client(cwd);
    if (!owner) return [];
    const result = (await owner.execute({ kind: "list-plans" })).result;
    if (!("plans" in result)) throw new Error("Managed owner returned another catalog result.");
    return result.plans.map((plan) => ({ ...plan, path: managedLocator(cwd, plan.path) }));
}
export async function selectManagedPlan(cwd: string, reference: string): Promise<ManagedPlanSelection> {
    const owner = await client(cwd, true);
    const plan = await readManagedPlan(cwd, reference);
    const retained = await readManagedRetainedExecution(cwd, reference);
    if (retained && !retained.cleanupComplete && !retained.abandonmentComplete)
        return {
            kind: "managed-plan",
            binding: owner.binding,
            planId: retained.planId,
            planName: retained.planName,
            retainedAttemptId: retained.attempt.id,
            revision: operationHash(JSON.stringify(retained.controller)),
        };
    if (!plan?.attrs.planId || !plan.revision)
        throw new Error("No canonical Plan or unfinished retained execution matches the requested reference.");
    const catalog = await listManagedPlans(cwd);
    const entry = catalog.find((item) => item.attrs.planId === plan.attrs.planId);
    if (!entry) throw new Error("Managed Plan identity changed during selection.");
    return {
        kind: "managed-plan",
        binding: owner.binding,
        planId: plan.attrs.planId,
        planName: entry.name,
        revision: plan.revision,
    };
}
export async function withManagedPlan<T>(
    cwd: string,
    selection: ManagedPlanSelection,
    run: () => Promise<T>,
): Promise<T> {
    const current = await selectManagedPlan(cwd, selection.planId);
    if (!sameProjectStoreBinding(current.binding, selection.binding) || current.revision !== selection.revision)
        throw new Error("Managed Plan admission changed; reload the current Plan.");
    if (current.retainedAttemptId) {
        const retained = await readManagedRetainedExecution(cwd, current.planId, current.retainedAttemptId);
        if (!retained) throw new Error("Retained execution is unavailable.");
        const { findById } = await import("../shared/worktree-registry.ts");
        await enterProjectRuntime(cwd);
        const live = await findById(cwd, retained.attempt.id);
        if (
            !live ||
            live.planId !== retained.planId ||
            live.path !== retained.attempt.path ||
            live.branch !== retained.attempt.branch ||
            live.baseRef !== retained.attempt.baseRef ||
            live.baseBranch !== retained.attempt.baseBranch ||
            live.baseCommit !== retained.attempt.baseCommit
        )
            throw new Error("Original execution owner changed; no replacement was started.");
        const inspected = projects.checkout.inspect(cwd);
        if (inspected.kind !== "existing") throw new Error("Retained execution Project is unavailable.");
        const { withRetainedCheckoutSource } = await import("./retained-source.ts");
        return await selections.run(current, () =>
            retainedExecutions.run(retained, () => withRetainedCheckoutSource(inspected.identity, run)),
        );
    }
    return await selections.run(current, run);
}
interface RetainedManagedCommand {
    acknowledged?: boolean;
    binding: ProjectStoreBinding;
    command: ProjectStoreCommand;
}
/** Retain the exact command identity in execution continuation before sending an owner mutation. */
export async function mutateManagedPlan(cwd: string, command: ProjectStoreCommand) {
    const owner = await client(cwd, true);
    if (!("operationId" in command)) throw new Error("Managed mutation requires an operation identity.");
    const { operationId: _operationId, ...intent } = command;
    // A CLI retry observes today's revision, but a pending restore still owns its original precondition.
    const stableIntent =
        command.kind === "restore-history"
            ? { kind: command.kind, planId: command.planId, version: command.version }
            : command.kind === "author-plan" && !command.input.expectedRevision
              ? { kind: command.kind, input: command.input }
              : intent;
    const key = operationDigest(JSON.stringify({ binding: owner.binding, command: stableIntent }));
    const directory = join((await enterProjectRuntime(cwd)).selected.transitionJournalsDir, "managed-operations");
    const path = join(directory, `managed-operation-${key}.json`);
    ensurePrivateDir(directory);
    const lock = openNativeFileLock(`${path}.lock`);
    try {
        await lock.lock(true);
        let retained: RetainedManagedCommand;
        try {
            retained = JSON.parse(await readFile(path, "utf8"));
        } catch (error) {
            if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
            retained = { binding: owner.binding, command };
            writeJsonAtomically(path, retained);
        }
        if (
            retained.acknowledged &&
            ((command.kind === "author-plan" && !command.input.expectedRevision) ||
                (command.kind === "restore-history" &&
                    retained.command.kind === "restore-history" &&
                    retained.command.expectedRevision !== command.expectedRevision))
        ) {
            retained = { binding: owner.binding, command };
            writeJsonAtomically(path, retained);
        }
        validateProjectStoreRequest({ binding: retained.binding, command: retained.command });
        if (!sameProjectStoreBinding(retained.binding, owner.binding))
            throw new Error("Managed operation owner changed.");
        const result = await owner.execute(retained.command).catch((error) => {
            if (
                error instanceof ProjectStorePreconditionError &&
                (command.kind === "restore-history" ||
                    (command.kind === "author-plan" && command.input.expectedRevision === undefined))
            )
                writeJsonAtomically(path, { ...retained, acknowledged: true });
            throw error;
        });
        if (!("status" in result.result) || result.result.status !== "completed")
            throw new Error("Managed Plan operation remains recoverable under its retained identity.");
        if (
            (command.kind === "restore-history" ||
                (command.kind === "author-plan" && !command.input.expectedRevision)) &&
            !retained.acknowledged
        )
            writeJsonAtomically(path, { ...retained, acknowledged: true });
        return result.result;
    } finally {
        lock.close();
    }
}
export async function authorManagedPlan(cwd: string, input: PlanAuthoringInput): Promise<void> {
    await authorManagedPlanWithIdentity(cwd, input);
}
export async function authorManagedPlanWithIdentity(cwd: string, input: PlanAuthoringInput): Promise<string> {
    await client(cwd, true);
    const prior = input.expectedRevision === undefined ? null : await readManagedPlan(cwd, input.planName);
    const result = await mutateManagedPlan(cwd, {
        kind: "author-plan",
        operationId: randomUUID(),
        planId: prior?.attrs.planId || randomUUID(),
        input,
    });
    if (!result.planId) throw new Error("Managed authoring did not return a Plan ID.");
    return result.planId;
}
export async function reserveManagedExecution(
    planName: string,
    reservation: PlanExecutionReservation,
): Promise<string> {
    if (!active) throw new Error("Managed Plan owner is unavailable.");
    const selected = selections.getStore();
    if (!selected || selected.planName !== planName) throw new Error("Managed execution requires Plan admission.");
    const current = await readManagedPlan(active.cwd, selected.planId);
    if (!current) throw new Error("Managed Plan is unavailable.");
    const result = await mutateManagedPlan(active.cwd, {
        kind: "reserve-execution",
        operationId: randomUUID(),
        planId: selected.planId,
        expectedRevision: current.revision,
        reservation,
    });
    if (!result.attemptId) throw new Error("Managed reservation has no retained attempt.");
    return result.attemptId;
}

export async function readManagedExecution(cwd: string, planId: string) {
    const owner = await client(cwd, true);
    const result = (await owner.execute({ kind: "read-execution", planId })).result;
    if (!("execution" in result)) throw new Error("Managed execution context is unavailable.");
    return result.execution;
}
export async function readManagedExecutionDocuments(
    planName: string,
    input: import("./packages.ts").PackageWorkflowInput | undefined,
) {
    const selected = currentManagedPlanSelection();
    if (!active || !selected || selected.planName !== planName || !input)
        throw new Error("Managed execution requires its reserved Plan input.");
    const result = (
        await (
            await client(active.cwd, true)
        ).execute({ kind: "read-execution-documents", planId: selected.planId, input })
    ).result;
    if (!("documents" in result)) throw new Error("Managed execution documents are unavailable.");
    return result.documents;
}
export async function captureManagedExecution(planName: string) {
    const selected = currentManagedPlanSelection();
    if (!active || !selected || selected.planName !== planName)
        throw new Error("Managed execution requires Plan admission.");
    const execution = await readManagedExecution(active.cwd, selected.planId);
    if (!execution) throw new Error("Managed execution attempt has not been reserved.");
    return { selection: await selectManagedPlan(active.cwd, selected.planId), execution };
}

export async function loadManagedWorkflowPlan(reference: string) {
    if (!active) throw new Error("Managed Plan owner is unavailable.");
    const plan = await readManagedPlan(active.cwd, reference);
    if (!plan) throw new Error("Managed Plan is unavailable.");
    return {
        ...plan,
        kind: "loaded" as const,
        frontMatterRevision: plan.frontMatterRevision,
        hasFrontMatter: plan.hasFrontMatter ?? false,
    };
}

export async function readManagedPublication(
    cwd: string,
    reference: import("./packages.ts").PackagePublicationReference,
) {
    const result = (
        await (await client(cwd, true)).execute({ kind: "read-publication", planId: reference.planId, reference })
    ).result;
    if (!("manifest" in result)) throw new Error("Managed publication input is unavailable.");
    return result.manifest;
}
export async function freezeManagedPublicationPolicy(
    planName: string,
    attemptId: string,
    policy: import("./packages.ts").ExecutionPublicationPolicy,
) {
    if (!active) throw new Error("Managed Plan owner is unavailable.");
    const plan = await loadManagedWorkflowPlan(planName);
    await mutateManagedPlan(active.cwd, {
        kind: "freeze-publication-policy",
        operationId: randomUUID(),
        planId: plan.attrs.planId!,
        expectedRevision: plan.revision,
        attemptId,
        policy,
    });
}
export async function sealManagedPublication(
    planName: string,
    attemptId: string,
    validatedCommit: string,
    targetBranch: string,
    preparation: boolean,
): Promise<import("./packages.ts").PackagePublicationReference> {
    if (!active) throw new Error("Managed Plan owner is unavailable.");
    const plan = await loadManagedWorkflowPlan(planName);
    const owner = await client(active.cwd, true);
    const result = await mutateManagedPlan(active.cwd, {
        kind: "seal-publication",
        operationId: randomUUID(),
        planId: plan.attrs.planId!,
        expectedRevision: plan.revision,
        attemptId,
        validatedCommit,
        targetBranch,
        preparation,
    });
    const inspected = projects.checkout.inspect(active.cwd);
    if (inspected.kind !== "existing" || !result.snapshotId || !result.snapshotDigest)
        throw new Error("Managed publication was not sealed.");
    return {
        kind: "package",
        projectId: owner.binding.projectId,
        repositoryId: owner.binding.repositoryId,
        personalOwner: inspected.identity.personalOwner.identity,
        planId: plan.attrs.planId!,
        attemptId,
        inputId: result.snapshotId,
        digest: result.snapshotDigest,
    };
}

export async function settleManagedPublication(
    root: string,
    reference: import("./packages.ts").PackagePublicationReference,
) {
    const plan = await readManagedPlan(root, reference.planId);
    if (!plan) throw new Error("Publication Plan is unavailable.");
    await mutateManagedPlan(root, {
        kind: "settle-publication",
        operationId: randomUUID(),
        planId: reference.planId,
        expectedRevision: plan.revision,
        reference,
    });
}

export async function settleManagedInPlace(planName: string): Promise<void> {
    if (!active) throw new Error("Managed Plan owner is unavailable.");
    const plan = await loadManagedWorkflowPlan(planName);
    const execution = await readManagedExecution(active.cwd, plan.attrs.planId!);
    if (!execution) throw new Error("In-place completion requires its reserved execution.");
    await mutateManagedPlan(active.cwd, {
        kind: "settle-in-place",
        operationId: randomUUID(),
        planId: plan.attrs.planId!,
        expectedRevision: plan.revision,
        attemptId: execution.attemptId,
    });
}

export async function saveManagedValidationCheckpoint(
    cwd: string,
    name: string,
    checkpoint: import("../plan-store.ts").PlanFrontMatter["validationCheckpoint"],
    expectedRevision: string,
) {
    const plan = await readManagedPlan(cwd, name);
    if (!plan?.attrs.planId) throw new Error("Managed Plan is unavailable.");
    const execution = await readManagedExecution(cwd, plan.attrs.planId);
    if (!execution) throw new Error("Validation checkpoint requires a reserved attempt.");
    await mutateManagedPlan(cwd, {
        kind: "execution-checkpoint",
        operationId: randomUUID(),
        planId: plan.attrs.planId,
        expectedRevision,
        attemptId: execution.attemptId,
        checkpoint: { event: "validation_checkpoint_saved", details: { validationCheckpoint: checkpoint } },
    });
    return (await loadManagedWorkflowPlan(name)).attrs;
}
export async function saveManagedDefinition(
    cwd: string,
    name: string,
    changes: import("./definition.ts").PlanDefinitionChanges,
    expectedRevision: string,
) {
    const plan = await readManagedPlan(cwd, name);
    if (!plan?.attrs.planId) throw new Error("Managed Plan is unavailable.");
    await mutateManagedPlan(cwd, {
        kind: "save-definition",
        operationId: randomUUID(),
        planId: plan.attrs.planId,
        changes,
        expectedRevision,
    });
    return (await loadManagedWorkflowPlan(name)).attrs;
}

export async function assertManagedPublicationOwner(claim: import("./publication.ts").PublicationOwnerClaim) {
    if (!active) throw new Error("Managed Plan owner is unavailable.");
    await (
        await client(active.cwd, true)
    ).execute({
        kind: "check-publication-owner",
        planId: claim.planId,
        claim: {
            planName: claim.planName,
            planId: claim.planId,
            attemptId: claim.attemptId,
            packageInput: claim.packageInput,
            validatedCommit: claim.validatedCommit,
            publishedCommit: claim.publishedCommit,
            targetBranch: claim.targetBranch,
        },
    });
}

export async function readManagedDocument(
    planId: string,
    resource: string,
    cwd = active?.cwd,
): Promise<import("./documents.ts").PlanDocumentView> {
    if (!cwd) throw new Error("Managed Plan owner is unavailable.");
    const result = (await (await client(cwd, true)).execute({ kind: "read-documents", planId, resource })).result;
    if (!("documentView" in result)) throw new Error("Managed Plan document is unavailable.");
    return result.documentView;
}
export async function saveManagedDocumentBatch(
    cwd: string,
    edits: import("./documents.ts").PreparedPlanDocumentEdit[],
) {
    const first = edits[0];
    if (!first) throw new Error("Document batch is empty.");
    await mutateManagedPlan(cwd, {
        kind: "edit-documents",
        operationId: randomUUID(),
        planId: first.planId,
        expectedRevision: first.expectedRevision,
        edits,
    });
}
export async function saveManagedDocument(
    planId: string,
    resource: string,
    expectedRevision: string,
    body: string,
): Promise<import("./documents.ts").PlanDocumentView> {
    if (!active) throw new Error("Managed Plan owner is unavailable.");
    await mutateManagedPlan(active.cwd, {
        kind: "save-document",
        operationId: randomUUID(),
        planId,
        resource,
        expectedRevision,
        body,
    });
    return await readManagedDocument(planId, resource);
}
export async function saveManagedProse(
    cwd: string,
    name: string,
    body: string,
    expectedRevision: string,
): Promise<string> {
    const plan = await readManagedPlan(cwd, name);
    if (!plan?.attrs.planId) throw new Error("Managed Plan is unavailable.");
    const result = await mutateManagedPlan(cwd, {
        kind: "save-prose",
        operationId: randomUUID(),
        planId: plan.attrs.planId,
        expectedRevision,
        body,
    });
    if (!result.revision) throw new Error("Managed prose write has no retained revision.");
    return result.revision;
}

export function managedExecutionRoot(): string {
    if (!active || active.closed) throw new Error("Managed Plan owner is unavailable.");
    return active.cwd;
}
export async function readManagedRecordingContext(
    planName: string,
    automatic: boolean,
    pendingPublication = false,
): Promise<import("./recording.ts").PlanRecordingContext | undefined> {
    const cwd = managedExecutionRoot();
    const plan = await readManagedPlan(cwd, planName);
    if (!plan?.attrs.planId) throw new Error("Recording Plan is unavailable.");
    const result = (
        await (
            await client(cwd, true)
        ).execute({ kind: "read-recording-context", planId: plan.attrs.planId, automatic, pendingPublication })
    ).result;
    if (!("recording" in result)) throw new Error("Recording context is unavailable.");
    return result.recording ?? undefined;
}
function mountedRecordingSource(
    cwd: string,
    source: import("../shared/work-records/generation.ts").WorkRecordSource,
): import("../shared/work-records/generation.ts").WorkRecordSource {
    return {
        ...source,
        path: managedLocator(cwd, source.path),
        children: source.children?.map((child) => mountedRecordingSource(cwd, child)),
    };
}
export async function readManagedDeliverySources(
    cwd: string,
    reference: import("./packages.ts").PackagePublicationReference,
    confirmed: boolean,
): Promise<import("./published-source.ts").PublishedDeliverySources> {
    const result = (
        await (
            await client(cwd, true)
        ).execute({ kind: "read-delivery-sources", planId: reference.planId, reference, confirmed })
    ).result;
    if (!("sources" in result)) throw new Error("Recording sources are unavailable.");
    return {
        delivered: mountedRecordingSource(cwd, result.sources.delivered),
        workRecordOwner: result.sources.workRecordOwner
            ? mountedRecordingSource(cwd, result.sources.workRecordOwner)
            : undefined,
    };
}
export async function generateManagedPreparedRecord(
    cwd: string,
    source: import("../shared/work-records/generation.ts").WorkRecordSource,
    attemptId: string,
    options: import("../shared/work-records/generation.ts").WorkRecordGenerationOptions,
    reference: import("./packages.ts").PackagePublicationReference,
): ReturnType<typeof import("../shared/work-records/package-recording.ts").generatePreparedPackageRecord> {
    cwd = managedExecutionRoot();
    const plan = await readManagedPlan(cwd, source.planId);
    if (!plan) throw new Error("Recording Plan is unavailable.");
    const reserved = await mutateManagedPlan(cwd, {
        kind: "reserve-recording",
        reference,
        operationId: randomUUID(),
        planId: source.planId,
        expectedRevision: plan.revision,
        attemptId,
    });
    if (!reserved.recordId) throw new Error("Recorder identity was not retained.");
    const { generateRecorderSections } = await import("../shared/work-records/generation.ts");
    const context = await readManagedRecordingContext(
        reference.planId,
        Boolean(source.pendingPublication),
        Boolean(source.pendingPublication),
    );
    const sections =
        context?.preparedRecord?.sections ?? (await generateRecorderSections(cwd, source, options, reserved.recordId));
    const checkpointed = await readManagedPlan(cwd, source.planId);
    if (!checkpointed) throw new Error("Recording Plan is unavailable after the Recorder turn.");
    const saved = await mutateManagedPlan(cwd, {
        kind: "prepare-record",
        reference,
        operationId: randomUUID(),
        planId: source.planId,
        expectedRevision: checkpointed.revision,
        attemptId,
        sections,
    });
    if (!saved.recordId) throw new Error("Canonical Work Record was not retained.");
    const after = await readManagedPlan(cwd, source.planId);
    const path = after?.attrs.workRecord?.path;
    if (!path) throw new Error("Canonical Work Record has no retained locator.");
    return {
        source,
        status: "generated",
        recordId: saved.recordId,
        path: managedLocator(cwd, path),
        supersessionProposals: sections.supersessionProposals,
    };
}

export async function verifyManagedRecording(
    cwd: string,
    reference: import("./packages.ts").PackagePublicationReference,
) {
    const result = (
        await (
            await client(cwd, true)
        ).execute({ kind: "verify-recording-delivery", planId: reference.planId, reference })
    ).result;
    if (!("manifest" in result)) throw new Error("Recording delivery proof is unavailable.");
    return result.manifest;
}

export async function listManagedWorkRecords(
    cwd: string,
): Promise<import("@runwield/plans/work-record-schema").WorkRecordResource[]> {
    const owner = await client(cwd);
    if (!owner) return [];
    const result = (await owner.execute({ kind: "record-catalog" })).result;
    if (!("recordResources" in result)) throw new Error("Managed owner returned another record result.");
    return result.recordResources.map((record) => ({ ...record, path: managedLocator(cwd, record.path) }));
}
export async function searchManagedWorkRecords(
    cwd: string,
    query: string,
    options: import("../shared/work-records/search.ts").WorkRecordSearchOptions,
): Promise<import("../shared/work-records/search.ts").WorkRecordSearchResult> {
    const accessMode = options.includeAll ? "all" : options.accessMode || "current";
    const owner = await client(cwd);
    if (!owner) return { query, accessMode, records: [], staleRecordIds: [], bootstrapped: false, rebuild: null };
    const result = (await owner.execute({ kind: "record-query", query, limit: options.limit || 20, accessMode }))
        .result;
    if (!("recordSearch" in result)) throw new Error("Managed owner returned another record result.");
    return {
        ...result.recordSearch,
        records: result.recordSearch.records.map((record) => ({ ...record, path: managedLocator(cwd, record.path) })),
    };
}

export async function captureManagedReview(
    cwd: string,
    name: string,
    expectedRevision: string,
): Promise<import("./packages.ts").PackageWorkflowInput> {
    const selection = await selectManagedPlan(cwd, name);
    const result = (
        await (await client(cwd, true)).execute({ kind: "capture-review", planId: selection.planId, expectedRevision })
    ).result;
    if (!("reviewInput" in result)) throw new Error("Managed owner returned another review result.");
    return result.reviewInput;
}
export async function applyManagedReview(
    options: import("./review.ts").SharedPlanReviewActionOptions,
): Promise<import("./review.ts").SharedPlanReviewActionResult> {
    if (!options.packageInput) throw new Error("Review requires its retained input.");
    if (!options.trustedClassification) throw new Error("Review classification is required.");
    const selection = await selectManagedPlan(options.cwd, options.planName);
    if (options.expectedSessionId && options.reviewEvidence?.runwieldSessionId !== options.expectedSessionId)
        throw new Error("Review Session changed.");
    if (options.reviewEvidence) {
        const { loadPlanActionEvidence } = await import("../shared/workflow/plan-actions.ts");
        const current = await loadPlanActionEvidence(options.cwd, selection.planId);
        if (
            current.kind !== "success" ||
            current.evidence.status !== options.reviewEvidence.status ||
            JSON.stringify(current.evidence.worktree) !== JSON.stringify(options.reviewEvidence.worktree)
        )
            throw new Error("Review execution evidence changed.");
    }
    await mutateManagedPlan(options.cwd, {
        kind: "review-decision",
        operationId: randomUUID(),
        planId: selection.planId,
        expectedRevision: options.planRevision,
        input: options.packageInput,
        decision: options.decision,
        sourceStatus: options.originalAttrs.status,
        sourceMarkdown: options.planWithFrontMatter,
        controllerRevision: options.expectedControllerRevision ?? null,
        classification: options.trustedClassification,
        workKind: options.trustedWorkKind ?? null,
    });
    const current = await readManagedPlan(options.cwd, selection.planId);
    const approved = !options.decision.conversationTurn && options.decision.approved === true;
    return {
        approved,
        conversationTurn: options.decision.conversationTurn,
        feedback: options.decision.feedback,
        approvalAction: options.decision.approvalAction,
        revision: current?.revision,
        ...(approved ? { planAttrs: current?.attrs } : {}),
    };
}

export async function readManagedPlanResource(cwd: string, planId: string) {
    const owner = await client(cwd);
    if (!owner) throw new Error("Plan owner is unavailable.");
    const result = (await owner.execute({ kind: "plan-resource", planId })).result;
    if (!("planResource" in result)) throw new Error("Managed owner returned another resource result.");
    return { ...result.planResource, path: managedLocator(cwd, result.planResource.path) };
}

export async function readManagedActivePlanById(cwd: string, planId: string) {
    const resource = await readManagedPlanResource(cwd, planId);
    return resource.attrs.archivedAt ? null : resource;
}
export async function readManagedReviewPresentation(planId: string) {
    const owner = await client(managedExecutionRoot());
    if (!owner) throw new Error("Plan owner is unavailable.");
    const result = (await owner.execute({ kind: "review-presentation", planId })).result;
    if (!("presentation" in result)) throw new Error("Managed owner returned another review result.");
    return result.presentation;
}

export async function recordManagedHumanReview(
    cwd: string,
    name: string,
    metadata: import("./definition.ts").PlanHumanReviewMetadata,
): Promise<void> {
    const selected = await selectManagedPlan(cwd, name);
    await mutateManagedPlan(cwd, {
        kind: "record-human-review",
        operationId: randomUUID(),
        planId: selected.planId,
        expectedRevision: selected.revision,
        metadata,
    });
}
export async function saveManagedEpicReview(
    cwd: string,
    name: string,
    review: import("../plan-store.ts").PlanFrontMatter["epicIntegrationReview"],
    expectedRevision: string,
) {
    const selected = await selectManagedPlan(cwd, name);
    await mutateManagedPlan(cwd, {
        kind: "save-epic-review",
        operationId: randomUUID(),
        planId: selected.planId,
        expectedRevision,
        review,
    });
    const plan = await readManagedPlan(cwd, selected.planId);
    if (!plan) throw new Error("Reviewed Epic is unavailable.");
    return plan.attrs;
}

export async function readManagedResourceCatalog(
    cwd: string,
): ReturnType<typeof import("../plan-store.ts").readPlanResourceCatalog> {
    const owner = await client(cwd);
    if (!owner) return { resources: [], diagnostics: [] };
    const result = (await owner.execute({ kind: "plan-resource-catalog" })).result;
    if (!("resourceCatalog" in result)) throw new Error("Managed owner returned another catalog result.");
    return {
        resources: result.resourceCatalog.resources.map((resource) => ({
            ...resource,
            path: managedLocator(cwd, resource.path),
        })),
        diagnostics: result.resourceCatalog.diagnostics.map((diagnostic) => ({
            ...diagnostic,
            path: managedLocator(cwd, diagnostic.path),
        })),
    };
}

export async function listManagedArchives(
    cwd: string,
): ReturnType<typeof import("../plan-store.ts").listArchivedPlans> {
    const owner = await client(cwd);
    if (!owner) return [];
    const result = (await owner.execute({ kind: "archive-catalog" })).result;
    if (!("archives" in result)) throw new Error("Managed owner returned another archive result.");
    return result.archives.map((entry) => ({ ...entry, path: managedLocator(cwd, entry.path) }));
}
export async function readManagedArchive(
    cwd: string,
    reference: string,
    byId = false,
): ReturnType<typeof import("../plan-store.ts").loadArchivedPlan> {
    if (byId) {
        const resource = await readManagedPlanResource(cwd, reference);
        return resource.attrs.archivedAt ? resource : null;
    }
    const owner = await client(cwd);
    if (!owner) return null;
    const result = (await owner.execute({ kind: "read-archive", reference })).result;
    if (!("archived" in result)) throw new Error("Managed owner returned another archive result.");
    return result.archived ? { ...result.archived, path: managedLocator(cwd, result.archived.path) } : null;
}
export async function archiveManagedPlan(
    cwd: string,
    name: string,
    options: import("./archiving.ts").ArchivePlanOptions,
): ReturnType<typeof import("../plan-store.ts").archivePlan> {
    const selected = options.expectedPlanId === undefined ? await selectManagedPlan(cwd, name) : undefined;
    const planId = options.expectedPlanId ?? selected?.planId;
    if (!planId) throw new Error("Archive source is unavailable.");
    const before = await readManagedActivePlanById(cwd, planId);
    if (!before) throw new Error("Archive source is unavailable.");
    await mutateManagedPlan(cwd, {
        kind: "archive-plan",
        operationId: randomUUID(),
        planId,
        expectedRevision: options.expectedRevision || selected?.revision || before.revision,
        reason: options.reason || "",
        force: options.force === true,
        now: options.now || "",
    });
    return {
        name: selected?.planName ?? name,
        fromPath: before.path,
        toPath: before.path,
        relativePath: `plans/${planId}/context.md`,
        attrs: before.attrs,
        artifacts: [],
    };
}
export async function renameManagedPlan(
    cwd: string,
    reference: string,
    name: string,
    expectedRevision: string,
): Promise<void> {
    const selected = await selectManagedPlan(cwd, reference);
    await mutateManagedPlan(cwd, {
        kind: "rename-plan",
        operationId: randomUUID(),
        planId: selected.planId,
        expectedRevision,
        name,
    });
}
export async function restoreManagedPlan(
    cwd: string,
    reference: string,
    destination?: string,
    expectedRevision?: string,
): ReturnType<typeof import("../plan-store.ts").restoreArchivedPlan> {
    let source = await readManagedArchive(cwd, reference, expectedRevision !== undefined);
    if (!source?.attrs.planId) throw new Error("Archived Plan is unavailable.");
    const planId = source.attrs.planId;
    const beforePath = source.path;
    if (destination && source.name !== destination) {
        await mutateManagedPlan(cwd, {
            kind: "rename-plan",
            operationId: randomUUID(),
            planId,
            expectedRevision: expectedRevision ?? (await readManagedPlanResource(cwd, planId)).revision,
            name: destination,
        });
        source = await readManagedArchive(cwd, planId, true);
        if (!source) throw new Error("Renamed archive is unavailable.");
        expectedRevision = undefined;
    }
    await mutateManagedPlan(cwd, {
        kind: "restore-plan",
        operationId: randomUUID(),
        planId,
        expectedRevision: expectedRevision ?? (await readManagedPlanResource(cwd, planId)).revision,
    });
    const restored = await readManagedActivePlanById(cwd, planId);
    if (!restored) throw new Error("Restored Plan is unavailable.");
    return {
        name: destination || source.name,
        fromPath: beforePath,
        toPath: restored.path,
        relativePath: `plans/${planId}/context.md`,
        attrs: restored.attrs,
        artifacts: [],
    };
}

export async function readManagedRetainedExecution(
    cwd: string,
    reference: string,
    attemptId?: string,
): Promise<import("./retained-managed-execution.ts").RetainedManagedExecution | undefined> {
    const owner = await client(cwd);
    if (!owner) return undefined;
    const result = (await owner.execute({ kind: "read-retained-execution", reference, attemptId: attemptId || null }))
        .result;
    if (!("retainedExecution" in result)) throw new Error("Managed owner returned another retained execution result.");
    return result.retainedExecution ?? undefined;
}

export async function writeManagedRetainedController(
    cwd: string,
    identity: import("./controllers.ts").WorkflowIdentity,
    updates: import("@runwield/plans/controller-state").WorkflowControllerState,
    options: import("./controllers.ts").ControllerWriteOptions,
): Promise<import("./controllers.ts").ControllerRecord> {
    const selected = currentManagedRetainedExecution();
    if (
        !selected ||
        selected.planName !== identity.planName ||
        (identity.planId && selected.planId !== identity.planId)
    )
        throw new Error("Retained controller names another Plan.");
    const current = await readManagedRetainedExecution(cwd, selected.planId, selected.attempt.id);
    if (!current) throw new Error("Retained controller is unavailable.");
    await mutateManagedPlan(cwd, {
        kind: "checkpoint-retained-execution",
        operationId: randomUUID(),
        planId: selected.planId,
        attemptId: selected.attempt.id,
        expectedRevision: operationHash(JSON.stringify(current.controller)),
        updates,
        options,
    });
    const saved = await readManagedRetainedExecution(cwd, selected.planId, selected.attempt.id);
    if (!saved) throw new Error("Retained controller disappeared after checkpoint.");
    return saved.controller;
}

/** No-op for ordinary local execution; managed retained cleanup settles with its personal owner before registry pruning. */
export async function settleRetainedExecutionCleanup(
    cwd: string,
    attempt: import("../shared/workflow/publication-attempt.ts").PublicationAttempt,
): Promise<void> {
    const selected = currentManagedRetainedExecution();
    if (!selected) return;
    if (selected.planId !== attempt.planId || selected.attempt.id !== attempt.attemptId)
        throw new Error("Cleanup names another retained execution.");
    const current = await readManagedRetainedExecution(cwd, selected.planId, selected.attempt.id);
    if (!current) throw new Error("Retained execution is unavailable before cleanup settlement.");
    await mutateManagedPlan(cwd, {
        kind: "settle-retained-cleanup",
        operationId: randomUUID(),
        planId: selected.planId,
        attemptId: selected.attempt.id,
        expectedRevision: operationHash(JSON.stringify(current.controller)),
    });
}

export async function generateManagedRetainedRecord(
    args: import("../shared/work-records/auto-generation.ts").AutoGenerateWorkRecordArgs,
    automatic: boolean,
): Promise<import("../shared/work-records/auto-generation.ts").WorkRecordAutoGenerationResult | undefined> {
    if (!managedPersonalStoreActive()) return undefined;
    const owner = await client(args.cwd, true);
    const response = (
        await owner.execute({
            kind: "read-retained-recording",
            reference: args.planName,
            pendingPublication: Boolean(args.pendingPublication),
        })
    ).result;
    if (!("retainedRecording" in response)) throw new Error("Owner returned another recording context.");
    const context = response.retainedRecording;
    if (!context) return undefined;
    if (automatic && context.proof.retainedPublicationPolicy?.autoGenerateRecords === false)
        return { status: "disabled", planName: args.planName, message: "Work Record generation is disabled." };
    if (!context.source)
        return {
            status: "skipped",
            planName: args.planName,
            reason: "parent_not_terminal",
            message: "Parent recording source is not ready.",
        };
    const command = {
        kind: "prepare-retained-record" as const,
        operationId: randomUUID(),
        planId: context.execution.planId,
        attemptId: context.execution.attempt.id,
        expectedRevision: operationHash(JSON.stringify(context.execution.controller)),
        pendingPublication: Boolean(args.pendingPublication),
    };
    try {
        const reserved = await mutateManagedPlan(args.cwd, { ...command, sections: null });
        if (!("recordId" in reserved) || !reserved.recordId)
            throw new Error("Retained recording identity is unavailable.");
        const { generateRecorderSections } = await import("../shared/work-records/generation.ts");
        const sections =
            context.preparation?.sections ||
            (await generateRecorderSections(args.cwd, context.source, args, reserved.recordId));
        await mutateManagedPlan(args.cwd, { ...command, operationId: randomUUID(), sections });
        const record = (await listManagedWorkRecords(args.cwd)).find(
            (entry) => entry.attrs.recordId === reserved.recordId,
        );
        if (!record) throw new Error("Retained canonical record is unavailable.");
        if (args.pendingPublication && context.proof.retainedPublicationPolicy?.workRecords) {
            const { mkdir, lstat, writeFile } = await import("node:fs/promises");
            const { basename, dirname } = await import("node:path");
            const copyPath = `docs/work-records/${basename(record.path)}`;
            let cursor = context.execution.attempt.path;
            for (const segment of copyPath.split("/")) {
                cursor = join(cursor, segment);
                const entry = await lstat(cursor).catch((error) => {
                    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
                    throw error;
                });
                if (entry?.isSymbolicLink()) throw new Error("Retained delivery copy contains a symbolic link.");
            }
            const existing = await readFile(cursor, "utf8").catch((error) => {
                if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
                throw error;
            });
            if (existing !== undefined && existing !== record.markdown)
                throw new Error("Retained record copy collides with editor content.");
            await mkdir(dirname(cursor), { recursive: true });
            await writeFile(cursor, record.markdown);
            const { recordPlanWorkRecord } = await import("./recording.ts");
            await recordPlanWorkRecord(
                context.execution.attempt.path,
                {
                    name: context.source.name,
                    planId: context.source.planId,
                    sourceKind: "active",
                    recordingAttemptId: context.execution.attempt.id,
                },
                {
                    status: "generated",
                    recordId: record.attrs.recordId,
                    path: copyPath,
                    lastAttemptAt: record.attrs.createdAt,
                },
            );
        }
        return {
            status: "generated",
            planName: args.planName,
            recordId: record.attrs.recordId,
            path: record.path,
            message: "Work Record retained by its personal owner.",
        };
    } catch (error) {
        return {
            status: "failed",
            planName: args.planName,
            error: error instanceof Error ? error.message : String(error),
            message: "Retained recording remains recoverable.",
        };
    }
}

export async function settleRetainedExecutionRecording(
    cwd: string,
    attempt: import("../shared/workflow/publication-attempt.ts").PublicationAttempt,
): Promise<boolean> {
    const selected = currentManagedRetainedExecution();
    if (!selected) return false;
    if (selected.planId !== attempt.planId || selected.attempt.id !== attempt.attemptId)
        throw new Error("Recording settlement names another retained execution.");
    const current = await readManagedRetainedExecution(cwd, selected.planId, selected.attempt.id);
    if (!current) throw new Error("Retained execution is unavailable before recording settlement.");
    await mutateManagedPlan(cwd, {
        kind: "settle-retained-record",
        operationId: randomUUID(),
        planId: selected.planId,
        attemptId: selected.attempt.id,
        expectedRevision: operationHash(JSON.stringify(current.controller)),
    });
    return true;
}

export async function authorManagedChildren(
    cwd: string,
    parentName: string,
    children: import("../plan-store.ts").ChildFeaturePlanDescriptor[],
    options: import("../plan-store.ts").PlanWriteOptions,
    finalize: boolean,
): Promise<import("../plan-store.ts").SavedChildFeaturePlan[]> {
    const selected = await selectManagedPlan(cwd, parentName);
    const { onChildPlanWritten, collaborationLockBypass, ...preconditions } = options;
    if (collaborationLockBypass) throw new Error("Collaboration authorization must be handled by the personal owner.");
    const receipt = await mutateManagedPlan(cwd, {
        kind: "author-children",
        operationId: randomUUID(),
        planId: selected.planId,
        expectedRevision: selected.revision,
        children,
        options: preconditions,
        finalize,
    });
    const owner = await client(cwd, true);
    if (!("operationId" in receipt)) throw new Error("Child authoring receipt is unavailable.");
    const result = (
        await owner.execute({ kind: "read-children-result", planId: selected.planId, operationId: receipt.operationId })
    ).result;
    if (!("children" in result)) throw new Error("Owner returned another child authoring result.");
    const written = result.children.map((child) => ({ ...child, path: managedLocator(cwd, child.path) }));
    for (const child of written) await onChildPlanWritten?.(child);
    return written;
}

export async function snapshotManagedSequence(cwd: string, name: string) {
    const selected = await selectManagedPlan(cwd, name);
    const owner = await client(cwd, true);
    const result = (await owner.execute({ kind: "sequence-snapshot", planId: selected.planId })).result;
    if (!("sequenceDocuments" in result)) throw new Error("Owner returned another Sequence snapshot.");
    return result.sequenceDocuments.map((document) => ({
        ...document,
        planPath: managedLocator(cwd, document.planPath),
    }));
}
export async function prepareManagedSequence(
    cwd: string,
    name: string,
    inputs?: import("./sequence-review.ts").SequenceChildInput[],
) {
    const selected = await selectManagedPlan(cwd, name);
    await mutateManagedPlan(cwd, {
        kind: "prepare-sequence",
        planId: selected.planId,
        operationId: randomUUID(),
        expectedRevision: selected.revision,
        inputs: inputs ?? null,
    });
    return await snapshotManagedSequence(cwd, name);
}
export async function applyManagedSequenceDecision(
    options: import("./sequence-review.ts").ApplySequenceReviewOptions,
): Promise<import("./sequence-review.ts").SequenceReviewResult> {
    const parent = options.documents[0];
    if (!parent) throw new Error("Sequence review has no parent.");
    const receipt = await mutateManagedPlan(options.cwd, {
        kind: "sequence-decision",
        planId: parent.planId,
        operationId: randomUUID(),
        expectedRevision: parent.revision,
        documents: options.documents,
        decision: options.decision,
    });
    if (!("operationId" in receipt)) throw new Error("Sequence receipt is unavailable.");
    const owner = await client(options.cwd, true);
    const response = (
        await owner.execute({ kind: "read-sequence-result", planId: parent.planId, operationId: receipt.operationId })
    ).result;
    if (!("sequenceResult" in response)) throw new Error("Owner returned another Sequence result.");
    const result = response.sequenceResult;
    if (options.hostedSession && options.toolCallId && result.workflowOutcome) {
        if (result.workflowOutcome.outcome === "approved_execute" && result.workflowOutcome.planName)
            options.hostedSession.setWorkflowPlanName(result.workflowOutcome.planName);
        const { publishWorkflowToolEvent } = await import("../shared/workflow/workflow-tool-events.ts");
        try {
            publishWorkflowToolEvent({
                hostedSession: options.hostedSession,
                toolCallId: options.toolCallId,
                kind: "plan_written",
                payload: result.workflowOutcome,
            });
        } catch (error) {
            return {
                ...result,
                cancellationReason: "sequence_handoff_failed",
                feedback: `The Sequence decision was saved, but its workflow handoff could not be published. Reopen the saved Sequence to retry. ${error instanceof Error ? error.message : String(error)}`,
            };
        }
    }
    return result;
}

export async function projectManagedEpic(
    cwd: string,
    parentName: string,
    childName: string,
    projection: "notes" | "deviations",
    notes: import("../tools/review-complete.ts").ReviewIntegrationNote[] = [],
): Promise<string | null> {
    const parent = await selectManagedPlan(cwd, parentName);
    const child = await selectManagedPlan(cwd, childName);
    const outcome = await mutateManagedPlan(cwd, {
        kind: "epic-projection",
        operationId: randomUUID(),
        planId: parent.planId,
        expectedRevision: parent.revision,
        childPlanId: child.planId,
        childRevision: child.revision,
        projection,
        notes,
    });
    return "revision" in outcome && outcome.revision !== parent.revision ? `docs/plans/${parentName}.md` : null;
}
export async function recordManagedDeviation(
    cwd: string,
    name: string,
    proposal: import("@runwield/plans/format").PlanDeviationProposal,
    expectedRevision: string,
) {
    const before = await readManagedPlan(cwd, name);
    if (!before?.attrs.planId) throw new Error("Deviation Plan is unavailable.");
    const { appendPlanDeviation } = await import("@runwield/plans/format");
    const result = appendPlanDeviation(before.attrs.planDeviations, proposal);
    await mutateManagedPlan(cwd, {
        kind: "record-deviation",
        operationId: randomUUID(),
        planId: before.attrs.planId,
        expectedRevision,
        proposal,
    });
    return result;
}

/** Retire the pending pointer only after its typed result is received; keep its exact request as evidence. */
async function acknowledgeCollaboration(
    cwd: string,
    intent: import("./collaboration/operations.ts").CollaborationIntent,
    operationId: string,
): Promise<void> {
    const owner = await client(cwd, true);
    const key = operationDigest(JSON.stringify({ binding: owner.binding, command: { kind: "collaboration", intent } }));
    const directory = join((await enterProjectRuntime(cwd)).selected.transitionJournalsDir, "managed-operations");
    const path = join(directory, `managed-operation-${key}.json`);
    const lock = openNativeFileLock(`${path}.lock`);
    try {
        await lock.lock(true);
        const pending: RetainedManagedCommand | undefined = await readFile(path, "utf8")
            .then((text) => JSON.parse(text))
            .catch((error) => {
                if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
                throw error;
            });
        if (!pending || !("operationId" in pending.command) || pending.command.operationId !== operationId) return;
        const completed = join(directory, "completed");
        ensurePrivateDir(completed);
        await rename(path, join(completed, `${operationId}.json`));
    } finally {
        lock.close();
    }
}
async function managedCollaboration(cwd: string, intent: import("./collaboration/operations.ts").CollaborationIntent) {
    const receipt = await mutateManagedPlan(cwd, { kind: "collaboration", operationId: randomUUID(), intent });
    if (!("operationId" in receipt)) throw new Error("Collaboration operation receipt is unavailable.");
    const owner = await client(cwd, true);
    const result = (await owner.execute({ kind: "read-collaboration-result", operationId: receipt.operationId }))
        .result;
    if (!("collaborationResult" in result)) throw new Error("Owner returned another collaboration result.");
    await acknowledgeCollaboration(cwd, intent, receipt.operationId);
    return result.collaborationResult;
}
export async function shareManagedPlan(options: import("./collaboration/share.ts").SharePlanForReviewOptions) {
    const { cwd = managedExecutionRoot(), ...intent } = options;
    const result = await managedCollaboration(cwd, { action: "share", options: intent });
    if (result.action !== "share") throw new Error("Collaboration action changed.");
    return result.value;
}
export async function pushManagedPlan(options: import("./collaboration/push.ts").PushPlanRevisionOptions) {
    const { cwd = managedExecutionRoot(), ...intent } = options;
    const result = await managedCollaboration(cwd, { action: "push", options: intent });
    if (result.action !== "push") throw new Error("Collaboration action changed.");
    return result.value;
}
export async function pullManagedPlan(options: import("./collaboration/pull.ts").PullPlanForRevisionOptions) {
    const { cwd = managedExecutionRoot(), ...intent } = options;
    const result = await managedCollaboration(cwd, { action: "pull", options: intent });
    if (result.action !== "pull") throw new Error("Collaboration action changed.");
    return {
        ...result.value,
        ...(result.value.planPath ? { planPath: managedLocator(cwd, result.value.planPath) } : {}),
    };
}
export async function unshareManagedPlan(options: import("./collaboration/unshare.ts").UnsharePlanOptions) {
    const { cwd = managedExecutionRoot(), ...intent } = options;
    const owner = await client(cwd, true);
    const preview = async () => {
        const response = (await owner.execute({ kind: "unshare-preview", options: intent })).result;
        if (!("unsharePreview" in response)) throw new Error("Owner returned another unshare preview.");
        const answer = globalThis.prompt(`${response.unsharePreview.message}\nType yes to continue: `) || "";
        if (!/^(?:y|yes)$/i.test(answer.trim()))
            throw new Error(
                "Unshare cancelled; remote Shared Space and local collaboration metadata were not changed.",
            );
        return response.unsharePreview;
    };
    const confirmed = intent.force ? undefined : await preview();
    const run = async (confirmation?: string) => {
        const result = await managedCollaboration(cwd, {
            action: "unshare",
            options: { ...intent, ...(confirmation ? { confirmation } : {}) },
        });
        if (result.action !== "unshare") throw new Error("Collaboration action changed.");
        return result.value;
    };
    try {
        return await run(confirmed?.confirmation);
    } catch (error) {
        if (!confirmed || confirmed.alreadyDeleted) throw error;
        const response = (await owner.execute({ kind: "unshare-preview", options: intent })).result;
        if (
            !("unsharePreview" in response) ||
            !response.unsharePreview.alreadyDeleted ||
            response.unsharePreview.confirmation === confirmed.confirmation
        )
            throw error;
        return await run((await preview()).confirmation);
    }
}

export async function reopenManagedPlanReview(
    cwd: string,
    name: string,
    attemptId: string,
    expectedRevision?: string,
): Promise<void> {
    const selected = await selectManagedPlan(cwd, name);
    await mutateManagedPlan(cwd, {
        kind: "reopen-review",
        operationId: randomUUID(),
        planId: selected.planId,
        expectedRevision: expectedRevision ?? selected.revision,
        attemptId,
    });
}

export async function recoverManagedExecution(
    cwd: string,
    name: string,
    action: import("./project-service.ts").ProjectStoreRecoveryAction["action"],
    expectedRevision?: string,
    attemptId?: string,
    controllerRevision?: number,
) {
    const selected = await selectManagedPlan(cwd, name);
    const execution = await readManagedExecution(cwd, selected.planId);
    if (attemptId && execution?.attemptId !== attemptId) throw new Error("Recovery attempt changed.");
    await mutateManagedPlan(cwd, {
        kind: "recover-execution",
        operationId: randomUUID(),
        planId: selected.planId,
        expectedRevision: expectedRevision ?? selected.revision,
        attemptId: execution?.attemptId ?? null,
        action,
        controllerRevision: controllerRevision ?? null,
    });
    const current = await readManagedPlan(cwd, selected.planId);
    if (!current) throw new Error("Recovered Plan is unavailable.");
    return current.attrs;
}

export async function readManagedRelatedController(cwd: string, member: import("./controllers.ts").WorkflowIdentity) {
    const selected = currentManagedRetainedExecution();
    if (!selected) throw new Error("Related controller has no original execution admission.");
    const result = (
        await (
            await client(cwd, true)
        ).execute({
            kind: "read-retained-family-controller",
            executionPlanId: selected.planId,
            attemptId: selected.attempt.id,
            member,
        })
    ).result;
    if (!("familyController" in result)) throw new Error("Owner returned another family result.");
    return result.familyController;
}
export async function writeManagedRelatedController(
    cwd: string,
    member: import("./controllers.ts").WorkflowIdentity,
    updates: import("@runwield/plans/controller-state").WorkflowControllerState,
    options: import("./controllers.ts").ControllerWriteOptions,
) {
    const selected = currentManagedRetainedExecution();
    if (!selected) throw new Error("Related controller has no original execution admission.");
    await mutateManagedPlan(cwd, {
        kind: "checkpoint-retained-family-controller",
        operationId: randomUUID(),
        executionPlanId: selected.planId,
        attemptId: selected.attempt.id,
        member,
        updates,
        options,
    });
    const saved = await readManagedRelatedController(cwd, member);
    if (!saved) throw new Error("Retained family controller is unavailable after checkpoint.");
    return saved;
}

export async function saveManagedEpicArtifact(cwd: string, name: string, resource: string, body: string) {
    const plan = await selectManagedPlan(cwd, name);
    await mutateManagedPlan(cwd, {
        kind: "save-epic-artifact",
        operationId: randomUUID(),
        planId: plan.planId,
        expectedRevision: plan.revision,
        resource,
        body,
    });
}
export async function appendManagedEpicQa(args: import("./artifacts.ts").AppendEpicManualQaSectionArgs) {
    const parent = await selectManagedPlan(args.projectRoot, args.epicPlanName);
    const child = await selectManagedPlan(args.projectRoot, args.childPlanName);
    await mutateManagedPlan(args.projectRoot, {
        kind: "append-epic-qa",
        operationId: randomUUID(),
        planId: parent.planId,
        expectedRevision: parent.revision,
        childPlanId: child.planId,
        childRevision: child.revision,
        childHeading: args.childHeading,
        checklistMarkdown: args.checklistMarkdown,
    });
}

export async function importManagedPlans(cwd: string, selection: string) {
    const completed = await mutateManagedPlan(cwd, { kind: "import-plans", operationId: randomUUID(), selection });
    const result = (
        await (await client(cwd, true)).execute({ kind: "read-import-result", operationId: completed.operationId })
    ).result;
    if (!("importResult" in result)) throw new Error("Managed import result is unavailable.");
    const owner = await client(cwd, true);
    const key = operationDigest(
        JSON.stringify({ binding: owner.binding, command: { kind: "import-plans", selection } }),
    );
    const directory = join((await enterProjectRuntime(cwd)).selected.transitionJournalsDir, "managed-operations");
    const path = join(directory, `managed-operation-${key}.json`);
    const lock = openNativeFileLock(`${path}.lock`);
    await lock.lock(true);
    try {
        const retained: RetainedManagedCommand = JSON.parse(await readFile(path, "utf8"));
        if ("operationId" in retained.command && retained.command.operationId === completed.operationId) {
            ensurePrivateDir(join(directory, "completed"));
            await (
                await import("node:fs/promises")
            ).rename(path, join(directory, "completed", `${completed.operationId}.json`));
        }
    } finally {
        lock.close();
    }
    return result.importResult;
}

export async function inspectManagedOwner(cwd: string, repair: boolean): Promise<import("./doctor.ts").DoctorIssue[]> {
    const owner = repair ? await client(cwd, true) : await client(cwd);
    if (!owner) return [];
    if (repair) {
        // Repair is idempotent and must run again for a later independent fault.
        const result = (await owner.execute({ kind: "repair-owner", operationId: randomUUID() })).result;
        if (!("status" in result) || result.status !== "completed")
            throw new Error("Managed owner repair remains pending.");
    }
    const result = (await owner.execute({ kind: "inspect-owner" })).result;
    if (!("ownerDiagnostics" in result)) throw new Error("Managed owner diagnostics are unavailable.");
    return result.ownerDiagnostics;
}

export async function settleRetainedExecutionAbandonment(cwd: string, name: string): Promise<void> {
    const selected = currentManagedRetainedExecution();
    if (!selected) return;
    if (selected.planName !== name) throw new Error("Abandonment names another retained execution.");
    let current = await readManagedRetainedExecution(cwd, selected.planId, selected.attempt.id);
    if (!current) throw new Error("Retained execution is unavailable before abandonment.");
    if (current.controller.recovery) {
        await writeManagedRetainedController(cwd, { planId: selected.planId, planName: name }, {}, { recovery: null });
        current = await readManagedRetainedExecution(cwd, selected.planId, selected.attempt.id);
        if (!current) throw new Error("Retained abandonment controller is unavailable.");
    }
    await mutateManagedPlan(cwd, {
        kind: "settle-retained-abandonment",
        operationId: randomUUID(),
        planId: selected.planId,
        attemptId: selected.attempt.id,
        expectedRevision: operationHash(JSON.stringify(current.controller)),
    });
}

async function readHistoryPages(cwd: string, reference: string, version?: string) {
    const owner = await client(cwd);
    if (!owner) throw new Error("Plan history requires an admitted Plan.");
    return await readPagedStoreText(owner, (offset, snapshot) =>
        version === undefined
            ? { kind: "list-history", reference, offset, snapshot }
            : { kind: "show-history", reference, version, offset, snapshot },
    );
}
type PagedCommand = Extract<ProjectStoreCommand, { kind: "list-history" | "show-history" | "preview-retention" }>;
async function readPagedStoreText(
    owner: ProjectStoreClient,
    request: (offset: number, snapshot: string) => PagedCommand,
) {
    const chunks: string[] = [];
    let offset = 0,
        snapshot = "";
    while (true) {
        const { result } = await owner.execute(request(offset, snapshot));
        const page =
            "historyPage" in result ? result.historyPage : "retentionPage" in result ? result.retentionPage : null;
        if (!page) throw new Error("Missing Project store page.");
        chunks.push(page.text);
        if (page.complete) {
            const text = chunks.join("");
            if (operationHash(text) !== page.snapshot) throw new Error("Incomplete Plan history response.");
            return text;
        }
        offset += page.text.length;
        snapshot = page.snapshot;
    }
}

export async function readManagedPlanHistory(cwd: string, reference: string) {
    return parseHistoryList(await readHistoryPages(cwd, reference));
}

export async function showManagedPlanMilestone(cwd: string, reference: string, version: string) {
    return parseMilestoneDocuments(await readHistoryPages(cwd, reference, version));
}

type PreviewRetentionCommand = { kind: "preview-retention" };
type ConfirmRetentionCommand = Extract<ProjectStoreCommand, { kind: "confirm-retention" | "settle-prune-copies" }>;
export function requestManagedRetention(
    cwd: string,
    command: PreviewRetentionCommand,
): Promise<import("./retention.ts").RetentionPreview>;
export function requestManagedRetention(
    cwd: string,
    command: ConfirmRetentionCommand,
): Promise<import("./retention.ts").PruneResult>;
export async function requestManagedRetention(cwd: string, command: PreviewRetentionCommand | ConfirmRetentionCommand) {
    const owner = command.kind === "preview-retention" ? await client(cwd) : await client(cwd, true);
    if (!owner) {
        const policy = (await import("./retention.ts")).retentionPolicies(cwd);
        return {
            plans: {
                policy: policy.plans,
                units: [],
                due: [],
                ineligible: [],
                sparedByKeepLast: [],
                withinRetention: [],
            },
            records: { policy: policy.records, due: [] },
        };
    }
    if (command.kind === "preview-retention") {
        const preview: import("./retention.ts").RetentionPreview = JSON.parse(
            await readPagedStoreText(owner, (offset, snapshot) => ({ kind: "preview-retention", offset, snapshot })),
        );
        if (!Array.isArray(preview.plans?.due) || !Array.isArray(preview.records?.due))
            throw new Error("Invalid prune preview.");
        return preview;
    }
    const { result } = await owner.execute(command);
    if ("pruneResult" in result) return result.pruneResult;
    throw new Error("Missing retention result from the Project owner.");
}
