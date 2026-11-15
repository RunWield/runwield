import {
    assertProjectStoreIdentity,
    projectStoreLocation,
    withHomeProjectOwner,
    type HomeProjectOwner,
} from "../shared/project-identity.ts";
import { authorLocalPlan, type PlanAuthoringInput } from "./access.ts";
import {
    getGlobalSecretStoreLocation,
    getProjectSecretStoreLocation,
    resolveCompatibleSecretRecord,
} from "../shared/collaboration/secrets.js";
import { createCollaborationClient, SYSTEM_COLLABORATION_FETCH } from "../shared/collaboration/client.js";
import { normalizeSharedSpaceMetadata } from "../shared/collaboration/protocol.js";
import { packageController } from "./workflows.ts";
import { readPublishedDeliverySources } from "./published-source.ts";
import {
    generatePreparedPackageRecord,
    inspectPreparedPackageRecord,
} from "../shared/work-records/package-recording.ts";
import { findWorkRecordById } from "../shared/work-records/store.ts";
import { searchWorkRecords } from "../shared/work-records/search.ts";
import { syncWorkRecordToIndex } from "../shared/work-records/index-adapter.ts";
import { SYSTEM_WORK_RECORD_MNEMOTECA_PORT } from "../shared/work-records/mnemoteca-port.ts";
import { sealPackagePublication } from "./publication.ts";
import { readPlanPackageInput, readPlanPackagePublication } from "./packages.ts";
/** Prepared owner service. Only trusted local registration supplies the Project location. */
import { join } from "node:path";
import { inspectLocalHomeStore, withLocalPlanWorkflow, readLocalHomeStore } from "./access.ts";
import { packageWorkflowLocks, selectedPackage } from "./workflows.ts";
import { readPlanDocuments, savePlanDocument, savePlanProse } from "./documents.ts";
import { savePlanDefinition, type PlanDefinitionChanges } from "./definition.ts";
import { recordPlanEvent } from "./events.ts";
import {
    inspectOperationReceipt,
    operationDigest,
    operationHash,
    runReceiptedOperation,
    type OperationOutcome,
} from "./operation-receipts.ts";

export interface ProjectStoreBinding {
    projectId: string;
    repositoryId: string;
    ownerId: string;
}
export interface ProjectStoreRead {
    kind: "read";
    planId: string;
    resource: string;
}
interface PlanMutation {
    operationId: string;
    planId: string;
    expectedRevision: string;
}
export interface ProjectStoreDocumentWrite extends PlanMutation {
    kind: "save-document";
    resource: string;
    body: string;
}
export interface ProjectStoreProseWrite extends PlanMutation {
    kind: "save-prose";
    body: string;
}
export interface ProjectStoreDefinitionWrite extends PlanMutation {
    kind: "save-definition";
    changes: PlanDefinitionChanges;
}
export interface ProjectStoreEventWrite extends PlanMutation {
    kind: "record-event";
    event: "review_approved" | "review_feedback" | "hold_reset_to_draft";
}
export interface ProjectStoreReconcile {
    kind: "reconcile";
    planId: string;
    operationId: string;
}
export interface ProjectStoreSeal extends PlanMutation {
    kind: "seal-publication";
    attemptId: string;
    validatedCommit: string;
    targetBranch: string;
}
export interface ProjectStoreFrozenRead {
    kind: "read-frozen";
    planId: string;
    snapshotId: string;
    snapshotDigest: string;
    attemptId: string;
    resource: string;
}
export interface ProjectStoreRecordSave extends PlanMutation {
    kind: "save-record";
    title: string;
    summary: string;
}
export interface ProjectStoreRecordRead {
    kind: "read-record";
    planId: string;
    recordId: string;
}
export interface ProjectStoreRecordSearch {
    kind: "search-records";
    planId: string;
    query: string;
    limit: number;
}
export interface ProjectStoreRecordIndex extends PlanMutation {
    kind: "reconcile-record-index";
    recordId: string;
}
export interface ProjectStoreRecord {
    recordId: string;
    markdown: string;
}
export interface ProjectStoreRecords {
    records: ProjectStoreRecord[];
}
export interface ProjectStoreCollaborationRead {
    kind: "read-collaboration";
    planId: string;
}
export interface ProjectStoreCollaboration {
    planId: string;
    spaceId: string;
    latestRevision: number;
}
export type ProjectStoreCommand =
    | ProjectStoreCollaborationRead
    | ProjectStoreRecordSave
    | ProjectStoreRecordRead
    | ProjectStoreRecordSearch
    | ProjectStoreRecordIndex
    | ProjectStoreSeal
    | ProjectStoreFrozenRead
    | ProjectStoreRead
    | ProjectStoreDocumentWrite
    | ProjectStoreProseWrite
    | ProjectStoreDefinitionWrite
    | ProjectStoreEventWrite
    | ProjectStoreReconcile;
export interface ProjectStoreDocument {
    planId: string;
    resource: string;
    revision: string;
    body: string;
    writable: boolean;
}
export interface ProjectStoreReply {
    binding: ProjectStoreBinding;
    result: ProjectStoreDocument | OperationOutcome | ProjectStoreRecords | ProjectStoreCollaboration;
}

export class PreparedProjectStore {
    readonly binding: ProjectStoreBinding;
    private readonly cwd: string;
    private readonly homeOwner?: HomeProjectOwner;
    constructor(registration: string | HomeProjectOwner) {
        this.cwd = typeof registration === "string" ? registration : projectStoreLocation(registration);
        this.homeOwner = typeof registration === "string" ? undefined : registration;
        if (this.homeOwner) assertProjectStoreIdentity(this.homeOwner);
        const owner = this.homeOwner
            ? { kind: "local" as const, identity: this.homeOwner }
            : inspectLocalHomeStore(this.cwd);
        if (owner.kind !== "local") throw new Error("Project store registration requires an existing local owner.");
        this.binding = Object.freeze({
            projectId: owner.identity.projectId,
            repositoryId: owner.identity.repositoryId,
            ownerId: operationHash(owner.identity.personalOwner.identity),
        });
    }
    private owner() {
        const owner = this.homeOwner
            ? (assertProjectStoreIdentity(this.homeOwner), { kind: "local" as const, identity: this.homeOwner })
            : inspectLocalHomeStore(this.cwd);
        if (
            owner.kind !== "local" ||
            owner.identity.projectId !== this.binding.projectId ||
            owner.identity.repositoryId !== this.binding.repositoryId ||
            operationHash(owner.identity.personalOwner.identity) !== this.binding.ownerId
        )
            throw new Error("Project store authority changed.");
        return owner.identity;
    }
    async author(input: PlanAuthoringInput): Promise<ProjectStoreDocument> {
        const author = async () => {
            await authorLocalPlan(this.cwd, input);
            return await withLocalPlanWorkflow(this.cwd, input.planName, async () => {
                const plan = await selectedPackage(input.planName);
                const document = await readPlanDocuments(plan.metadata.planId);
                return {
                    planId: document.planId,
                    resource: document.resource,
                    revision: document.revision,
                    body: document.body,
                    writable: document.writable,
                };
            });
        };
        return this.homeOwner ? await withHomeProjectOwner(this.homeOwner, author) : await author();
    }
    async execute(command: ProjectStoreCommand): Promise<ProjectStoreReply> {
        return this.homeOwner
            ? await withHomeProjectOwner(this.homeOwner, () => this.executeAdmitted(command))
            : await this.executeAdmitted(command);
    }
    private async executeAdmitted(command: ProjectStoreCommand): Promise<ProjectStoreReply> {
        const owner = this.owner();
        const directory = join(
            owner.executionAccountHome,
            ".wld",
            "projects",
            owner.projectId,
            "internal",
            "plan-packages",
        );
        const result = await readLocalHomeStore(
            this.cwd,
            async () => {
                const plan = await selectedPackage({ planId: command.planId });
                if (command.kind === "read-collaboration") {
                    const controller = await packageController(plan);
                    const spaceId = controller.collaborationSpaceId;
                    const serverUrl = controller.collaborationServerUrl;
                    if (!spaceId || !serverUrl) throw new Error("Plan is not shared.");
                    const secret = await resolveCompatibleSecretRecord(
                        [
                            await getProjectSecretStoreLocation(this.cwd),
                            getGlobalSecretStoreLocation(owner.executionAccountHome),
                        ],
                        command.planId,
                        spaceId,
                    );
                    const capability = secret?.record.maintainerCapability || secret?.record.reviewerCapability;
                    if (!capability) throw new Error("Shared Plan credentials are unavailable.");
                    const client = createCollaborationClient({
                        serverUrl,
                        bearerCapability: capability,
                        fetch: SYSTEM_COLLABORATION_FETCH,
                    });
                    const wire = await client.getSharedSpace(spaceId);
                    const response = normalizeSharedSpaceMetadata(
                        wire && typeof wire === "object" && "space" in wire ? wire.space : wire,
                    );
                    if (response.planId !== command.planId || response.spaceId !== spaceId)
                        throw new Error("Shared Plan identity changed.");
                    return { planId: command.planId, spaceId, latestRevision: response.latestRevision };
                }
                if (command.kind === "read-record") {
                    const record = await findWorkRecordById(this.cwd, command.recordId);
                    return { records: record ? [{ recordId: record.attrs.recordId, markdown: record.markdown }] : [] };
                }
                if (command.kind === "search-records") {
                    const result = await searchWorkRecords(this.cwd, command.query, {
                        limit: command.limit,
                        mnemotecaPort: SYSTEM_WORK_RECORD_MNEMOTECA_PORT,
                    });
                    const records = [];
                    for (const item of result.records) {
                        const record = await findWorkRecordById(this.cwd, item.recordId);
                        if (record) records.push({ recordId: record.attrs.recordId, markdown: record.markdown });
                    }
                    return { records };
                }
                if (command.kind === "read-frozen") {
                    const manifest = await readPlanPackagePublication(owner, {
                        kind: "package",
                        projectId: owner.projectId,
                        repositoryId: owner.repositoryId,
                        personalOwner: owner.personalOwner.identity,
                        planId: command.planId,
                        attemptId: command.attemptId,
                        inputId: command.snapshotId,
                        digest: command.snapshotDigest,
                    });
                    const member = manifest.members.find((entry) => entry.metadata.planId === command.planId);
                    if (!member) throw new Error("Frozen Plan is unavailable.");
                    const input = await readPlanPackageInput(owner, member.input);
                    const document = input.documents.find((entry) => entry.name === command.resource);
                    if (!document) throw new Error("Frozen resource is unavailable.");
                    return {
                        planId: command.planId,
                        resource: command.resource,
                        revision: document.hash,
                        body: new TextDecoder().decode(document.bytes),
                        writable: false,
                    };
                }
                if (command.kind === "read") {
                    const document = await readPlanDocuments(command.planId, command.resource);
                    return {
                        planId: document.planId,
                        resource: document.resource,
                        revision: document.revision,
                        body: document.body,
                        writable: document.writable,
                    };
                }
                return await packageWorkflowLocks([{ planId: command.planId }], async () => {
                    this.owner();
                    if (command.kind === "reconcile")
                        return inspectOperationReceipt(directory, command.operationId, command.planId);
                    const digest = operationDigest(JSON.stringify({ binding: this.binding, command }));
                    return await runReceiptedOperation(
                        directory,
                        command.operationId,
                        digest,
                        command.planId,
                        async (recovering) => {
                            if (command.kind === "save-document") {
                                await savePlanDocument(
                                    command.planId,
                                    command.resource,
                                    command.expectedRevision,
                                    command.body,
                                );
                            } else if (command.kind === "save-prose") {
                                await savePlanProse(
                                    this.cwd,
                                    plan.metadata.name,
                                    command.body,
                                    command.expectedRevision,
                                );
                            } else if (command.kind === "save-definition") {
                                await savePlanDefinition(this.cwd, plan.metadata.name, command.changes, {
                                    expectedRevision: command.expectedRevision,
                                });
                            } else if (command.kind === "save-record") {
                                const receipt = inspectOperationReceipt(directory, command.operationId, command.planId);
                                const retained = receipt.recordId
                                    ? await findWorkRecordById(this.cwd, receipt.recordId)
                                    : null;
                                const current = await selectedPackage({ planId: command.planId });
                                if (
                                    retained &&
                                    current.metadata.workflow?.workRecord?.recordId === retained.attrs.recordId
                                ) {
                                    if (!retained.attrs.provenance?.sourcePlans?.includes(command.planId))
                                        throw new Error("Retained Work Record has conflicting provenance.");
                                    await syncWorkRecordToIndex(this.cwd, retained, {
                                        mnemotecaPort: SYSTEM_WORK_RECORD_MNEMOTECA_PORT,
                                    });
                                    return { revision: (await readPlanDocuments(command.planId)).revision };
                                }
                                const before = await readPlanDocuments(command.planId);
                                if (before.revision !== command.expectedRevision)
                                    throw new Error("Plan revision changed.");
                                const reference = plan.metadata.workflow?.delivery?.source;
                                if (!reference) throw new Error("Work Record requires retained delivery evidence.");
                                if (recovering && !(await inspectPreparedPackageRecord(reference.attemptId)))
                                    throw new Error("Recording intent is unavailable; operation remains pending.");
                                const sources = await readPublishedDeliverySources(this.cwd, {
                                    phase: "publication_verified",
                                    planName: plan.metadata.name,
                                    planId: command.planId,
                                    packageInput: reference,
                                });
                                if (sources.workRecordOwner?.planId !== command.planId)
                                    throw new Error("Work Record belongs to a different recording owner.");
                                const saved = await withLocalPlanWorkflow(this.cwd, plan.metadata.name, () =>
                                    generatePreparedPackageRecord(
                                        this.cwd,
                                        sources.workRecordOwner!,
                                        reference.attemptId,
                                        {
                                            mnemotecaPort: SYSTEM_WORK_RECORD_MNEMOTECA_PORT,
                                            runRecorderStep: () =>
                                                Promise.resolve({
                                                    title: command.title,
                                                    summary: command.summary,
                                                }),
                                        },
                                    ),
                                );
                                if (saved.status !== "generated" && saved.status !== "linked")
                                    throw new Error("Canonical Work Record was not persisted.");
                                if ("indexWarning" in saved && saved.indexWarning)
                                    throw new Error("Canonical record retained; index reconciliation remains pending.");
                                return {
                                    revision: (await readPlanDocuments(command.planId)).revision,
                                    recordId: "recordId" in saved ? saved.recordId : undefined,
                                };
                            } else if (command.kind === "reconcile-record-index") {
                                if ((await readPlanDocuments(command.planId)).revision !== command.expectedRevision)
                                    throw new Error("Plan revision changed.");
                                const record = await findWorkRecordById(this.cwd, command.recordId);
                                if (!record || !record.attrs.provenance?.sourcePlans?.includes(command.planId))
                                    throw new Error("Work Record does not belong to this Plan.");
                                await syncWorkRecordToIndex(this.cwd, record, {
                                    mnemotecaPort: SYSTEM_WORK_RECORD_MNEMOTECA_PORT,
                                });
                            } else if (command.kind === "seal-publication") {
                                const before = await readPlanDocuments(command.planId);
                                if (before.revision !== command.expectedRevision)
                                    throw new Error("Plan revision changed.");
                                const snapshot = await withLocalPlanWorkflow(this.cwd, plan.metadata.name, () =>
                                    sealPackagePublication(
                                        plan.metadata.name,
                                        command.attemptId,
                                        command.validatedCommit,
                                        command.targetBranch,
                                    ),
                                );
                                return {
                                    revision: (await readPlanDocuments(command.planId)).revision,
                                    snapshotId: snapshot.inputId,
                                    snapshotDigest: snapshot.digest,
                                    attemptId: snapshot.attemptId,
                                };
                            } else {
                                await withLocalPlanWorkflow(this.cwd, plan.metadata.name, () =>
                                    recordPlanEvent({
                                        cwd: this.cwd,
                                        planName: plan.metadata.name,
                                        event: command.event,
                                        expectedRevision: command.expectedRevision,
                                    }),
                                );
                            }
                            return { revision: (await readPlanDocuments(command.planId)).revision };
                        },
                        command.kind === "save-record",
                    );
                });
            },
            () => {
                throw new Error("Project store authority is unavailable.");
            },
        );
        return { binding: this.binding, result };
    }
}
