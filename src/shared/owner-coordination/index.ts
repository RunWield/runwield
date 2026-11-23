/**
 * @module shared/owner-coordination
 * Adapter-neutral owner coordination APIs.
 *
 * Slice boundaries:
 * - Workspace UI consumes these Project and Session catalog services for registration,
 *   health, restoration, relinking, and repair actions.
 * - Activation/generation, segment rollover, bounded operation receipts, and
 *   attention slices add their own migrations and APIs here.
 * - Runtime adapters and browser services must call shared APIs rather than
 *   issuing owner-database SQL directly.
 */

import {
    getOwnerCoordinationDatabaseEpoch,
    getOwnerCoordinationDatabasePath,
    OWNER_COORDINATION_DB_FILENAME,
    OWNER_COORDINATION_SCHEMA_VERSION,
    type OpenOwnerDatabaseOptions,
} from "@runwield/resources/owner-database";
import type { ProjectRegistry } from "@runwield/projects";
import { openProjectOwnerCoordination } from "@runwield/projects/owner-coordination";
import { openFileSessionStore, type FileSessionStore } from "../session/file-session-store.ts";
import { getRunWieldSessionsBaseDir } from "../session/root-session.ts";
import { listDevices, revokeDevice, verifyDeviceCredential, verifyDeviceCsrf } from "./devices.ts";
import {
    approvePairingRequest,
    claimPairingRequest,
    createPairingRequest,
    getPairingRequestByProof,
} from "./pairing.ts";
import {
    createOrGetOperationReceipt,
    findOperationReceiptByRequest,
    getOperationReceipt,
    updateOperationReceipt,
} from "./session-activations.ts";

export { getOwnerCoordinationDatabasePath, OWNER_COORDINATION_DB_FILENAME, OWNER_COORDINATION_SCHEMA_VERSION };
export { OWNER_CSRF_COOKIE, OWNER_DEVICE_COOKIE, OWNER_DEVICE_MAX_AGE_SECONDS } from "./devices.ts";

export interface OpenOwnerCoordinationStoreOptions extends OpenOwnerDatabaseOptions {
    sessionBaseDir?: string;
}

export interface OwnerCoordinationStore extends Pick<
    FileSessionStore,
    | "ensureRuntimeProject"
    | "listSessionProjects"
    | "getSessionProjectById"
    | "ensureSessionCatalogRecord"
    | "ensureSessionCatalogRecordAndAcquire"
    | "findSessionByLocator"
    | "getSessionById"
    | "readSessionManifest"
    | "archiveSession"
    | "unarchiveSession"
    | "listProjectSessions"
    | "catalogProjectSessions"
    | "listSessionTranscriptSegments"
    | "listSessionArtifacts"
    | "listSessionPlanAssociations"
    | "getLastPlanReview"
    | "getCurrentSessionSegment"
    | "appendSessionTranscriptSegment"
    | "validateSuccessorSegmentLocator"
    | "sealSessionTranscriptSegment"
    | "findOrphanRolloverCandidates"
    | "inspectSegmentRolloverRecovery"
    | "discardOrphanRolloverCandidate"
    | "createRemoteSessionOwner"
    | "recoverRemoteSession"
    | "readActiveSessionTranscript"
    | "writeActiveSessionTranscript"
    | "migrateActiveSessionTranscript"
    | "inspectSessionActivation"
    | "acquireSessionActivation"
    | "changeSessionActivationPhase"
    | "registerSessionArtifact"
    | "stagePlanAssociation"
    | "recordLastPlanReview"
    | "publishGenerationAndRelease"
    | "commitSegmentRolloverAndPublish"
    | "releaseUnchangedActivation"
    | "recoverSessionControl"
    | "markSessionReconcileRequired"
    | "markSessionReconcileRequiredWithProof"
    | "markSessionUncertain"
> {
    path: string;
    sessionStorageDirectory: string;
    close: () => void;
    projects: ProjectRegistry;
    registerProject: ProjectRegistry["register"];
    listProjects: ProjectRegistry["list"];
    getProjectById: ProjectRegistry["get"];
    getProjectHealth: ProjectRegistry["getHealth"];
    listProjectRootEvidence: FileSessionStore["listProjectRootEvidence"];
    setProjectStatus: ProjectRegistry["setStatus"];
    removeProject: ProjectRegistry["remove"];
    relinkProject: ProjectRegistry["relink"];
    requireActiveProjectRoot: ProjectRegistry["requireActiveRoot"];
    requireSessionProjectRoot: (projectId: string) => string;
    createPairingRequest: (
        options?: Parameters<typeof createPairingRequest>[1],
    ) => ReturnType<typeof createPairingRequest>;
    approvePairingRequest: (
        code: string,
        options?: Parameters<typeof approvePairingRequest>[2],
    ) => ReturnType<typeof approvePairingRequest>;
    getPairingRequestByProof: (
        proof: string,
        options?: Parameters<typeof getPairingRequestByProof>[2],
    ) => ReturnType<typeof getPairingRequestByProof>;
    claimPairingRequest: (
        proof: string,
        options?: Parameters<typeof claimPairingRequest>[2],
    ) => ReturnType<typeof claimPairingRequest>;
    listDevices: () => ReturnType<typeof listDevices>;
    verifyDeviceCredential: (
        credential: string,
        options?: Parameters<typeof verifyDeviceCredential>[2],
    ) => ReturnType<typeof verifyDeviceCredential>;
    verifyDeviceCsrf: (deviceId: string, csrf: string) => ReturnType<typeof verifyDeviceCsrf>;
    revokeDevice: (deviceId: string, options?: Parameters<typeof revokeDevice>[2]) => ReturnType<typeof revokeDevice>;
    getDatabaseEpoch: () => string | null;
    findOperationReceiptByRequest: (
        options: Parameters<typeof findOperationReceiptByRequest>[1],
    ) => ReturnType<typeof findOperationReceiptByRequest>;
    createOrGetOperationReceipt: (
        options: Parameters<typeof createOrGetOperationReceipt>[1],
    ) => ReturnType<typeof createOrGetOperationReceipt>;
    updateOperationReceipt: (
        operationId: string,
        updates: Parameters<typeof updateOperationReceipt>[2],
    ) => ReturnType<typeof updateOperationReceipt>;
    getOperationReceipt: (operationId: string) => ReturnType<typeof getOperationReceipt>;
}

/**
 * Open the public owner coordination store without exposing raw SQLite handles.
 * Internal migration tests and service modules may import database.ts directly;
 * adapters should consume this narrow method surface.
 */
export function openOwnerCoordinationStore(options: OpenOwnerCoordinationStoreOptions = {}): OwnerCoordinationStore {
    const { database, projects, executionAccountHome, projectIdForRowKey, projectRowKeys } =
        openProjectOwnerCoordination(options);
    let sessionStore: FileSessionStore;
    try {
        sessionStore = openFileSessionStore({
            baseDir: options.sessionBaseDir || getRunWieldSessionsBaseDir(executionAccountHome),
        });
    } catch (error) {
        database.close();
        throw error;
    }
    const resolveSessionProject = (projectId: string) => {
        const direct = sessionStore.getSessionProjectById(projectId);
        if (direct) return direct;
        const workspaceProject = projects.get(projectId);
        return workspaceProject ? sessionStore.ensureRuntimeProject({ root: workspaceProject.currentRoot }) : null;
    };
    function withCanonicalReceiptProject<Receipt extends { projectId: string }>(
        receipt: Receipt | null,
    ): Receipt | null {
        if (!receipt) return null;
        const projectId = projectIdForRowKey(receipt.projectId);
        return projectId && projectId !== receipt.projectId ? { ...receipt, projectId } : receipt;
    }
    return {
        path: database.path,
        sessionStorageDirectory: sessionStore.path,
        close: () => {
            try {
                sessionStore.close();
            } finally {
                database.close();
            }
        },
        projects,
        registerProject: projects.register,
        listProjects: projects.list,
        getProjectById: projects.get,
        getProjectHealth: projects.getHealth,
        setProjectStatus: projects.setStatus,
        removeProject: projects.remove,
        relinkProject: projects.relink,
        requireActiveProjectRoot: projects.requireActiveRoot,
        ensureRuntimeProject: (projectOptions) => sessionStore.ensureRuntimeProject(projectOptions),
        listSessionProjects: () => sessionStore.listSessionProjects(),
        getSessionProjectById: (projectId) => sessionStore.getSessionProjectById(projectId),
        listProjectRootEvidence: (projectId) =>
            sessionStore.getSessionProjectById(projectId)
                ? sessionStore.listProjectRootEvidence(projectId)
                : projects.listRootEvidence(projectId),
        requireSessionProjectRoot: (projectId) =>
            sessionStore.getSessionProjectById(projectId)
                ? sessionStore.requireSessionProjectRoot(projectId)
                : projects.requireActiveRoot(projectId),
        ensureSessionCatalogRecord: (locator) => {
            const project = resolveSessionProject(locator.projectId);
            if (!project) throw new Error("Session project is unavailable");
            return sessionStore.ensureSessionCatalogRecord({ ...locator, projectId: project.projectId });
        },
        ensureSessionCatalogRecordAndAcquire: (catalogOptions) => {
            const project = resolveSessionProject(catalogOptions.locator.projectId);
            if (!project) throw new Error("Session project is unavailable");
            return sessionStore.ensureSessionCatalogRecordAndAcquire({
                ...catalogOptions,
                locator: { ...catalogOptions.locator, projectId: project.projectId },
            });
        },
        findSessionByLocator: (locator) => sessionStore.findSessionByLocator(locator),
        getSessionById: (runwieldSessionId, projectId) => sessionStore.getSessionById(runwieldSessionId, projectId),
        readSessionManifest: (runwieldSessionId, projectId) =>
            sessionStore.readSessionManifest(runwieldSessionId, projectId),
        archiveSession: (runwieldSessionId, projectId) => {
            const project = projectId ? resolveSessionProject(projectId) : null;
            if (projectId && !project) throw new Error("Session project is unavailable");
            return sessionStore.archiveSession(runwieldSessionId, project?.projectId);
        },
        unarchiveSession: (runwieldSessionId, projectId) => {
            const project = projectId ? resolveSessionProject(projectId) : null;
            if (projectId && !project) throw new Error("Session project is unavailable");
            return sessionStore.unarchiveSession(runwieldSessionId, project?.projectId);
        },
        listProjectSessions: async (projectId, sessionOptions) => {
            if (sessionOptions?.catalog === false) return sessionStore.listProjectSessions(projectId, sessionOptions);
            const runtimeProject = resolveSessionProject(projectId);
            return runtimeProject
                ? await sessionStore.listProjectSessions(runtimeProject.projectId, sessionOptions)
                : {
                      sessions: [],
                      diagnostics: [],
                      page: 0,
                      pageSize: 30,
                      total: 0,
                      hasNext: false,
                      hasPrevious: false,
                  };
        },
        catalogProjectSessions: async (projectId, sessionOptions) => {
            const runtimeProject = resolveSessionProject(projectId);
            return runtimeProject
                ? await sessionStore.catalogProjectSessions(runtimeProject.projectId, sessionOptions)
                : { cataloged: [], diagnostics: [] };
        },
        listSessionTranscriptSegments: (runwieldSessionId) =>
            sessionStore.listSessionTranscriptSegments(runwieldSessionId),
        listSessionArtifacts: (runwieldSessionId, projectId) =>
            sessionStore.listSessionArtifacts(runwieldSessionId, projectId),
        listSessionPlanAssociations: (runwieldSessionId, projectId) =>
            sessionStore.listSessionPlanAssociations(runwieldSessionId, projectId),
        getLastPlanReview: (runwieldSessionId, projectId) =>
            sessionStore.getLastPlanReview(runwieldSessionId, projectId),
        getCurrentSessionSegment: (runwieldSessionId) => sessionStore.getCurrentSessionSegment(runwieldSessionId),
        appendSessionTranscriptSegment: (segment) => {
            const project = resolveSessionProject(segment.projectId);
            if (!project) throw new Error("Session project is unavailable");
            return sessionStore.appendSessionTranscriptSegment({ ...segment, projectId: project.projectId });
        },
        validateSuccessorSegmentLocator: (locator) => {
            const project = resolveSessionProject(locator.projectId);
            if (!project) throw new Error("Session project is unavailable");
            return sessionStore.validateSuccessorSegmentLocator({ ...locator, projectId: project.projectId });
        },
        sealSessionTranscriptSegment: (segmentOptions) => sessionStore.sealSessionTranscriptSegment(segmentOptions),
        findOrphanRolloverCandidates: (orphanOptions) => {
            const project = resolveSessionProject(orphanOptions.projectId);
            if (!project) throw new Error("Session project is unavailable");
            return sessionStore.findOrphanRolloverCandidates({ ...orphanOptions, projectId: project.projectId });
        },
        inspectSegmentRolloverRecovery: (rolloverOptions) =>
            sessionStore.inspectSegmentRolloverRecovery(rolloverOptions),
        discardOrphanRolloverCandidate: (orphanOptions) => sessionStore.discardOrphanRolloverCandidate(orphanOptions),
        createPairingRequest: (pairingOptions) => createPairingRequest(database, pairingOptions),
        approvePairingRequest: (code, pairingOptions) => approvePairingRequest(database, code, pairingOptions),
        getPairingRequestByProof: (proof, pairingOptions) => getPairingRequestByProof(database, proof, pairingOptions),
        claimPairingRequest: (proof, pairingOptions) => claimPairingRequest(database, proof, pairingOptions),
        listDevices: () => listDevices(database),
        verifyDeviceCredential: (credential, deviceOptions) =>
            verifyDeviceCredential(database, credential, deviceOptions),
        verifyDeviceCsrf: (deviceId, csrf) => verifyDeviceCsrf(database, deviceId, csrf),
        revokeDevice: (deviceId, deviceOptions) => revokeDevice(database, deviceId, deviceOptions),
        getDatabaseEpoch: () => getOwnerCoordinationDatabaseEpoch(database.handle),
        createRemoteSessionOwner: (proof) => sessionStore.createRemoteSessionOwner(proof),
        recoverRemoteSession: (sessionId, ownerInstanceId, ownerProcessKind) =>
            sessionStore.recoverRemoteSession(sessionId, ownerInstanceId, ownerProcessKind),
        readActiveSessionTranscript: (proof) => sessionStore.readActiveSessionTranscript(proof),
        writeActiveSessionTranscript: (proof, contents, expectedDigestHex) =>
            sessionStore.writeActiveSessionTranscript(proof, contents, expectedDigestHex),
        migrateActiveSessionTranscript: (proof, contents, expectedDigestHex) =>
            sessionStore.migrateActiveSessionTranscript(proof, contents, expectedDigestHex),
        inspectSessionActivation: (runwieldSessionId) => sessionStore.inspectSessionActivation(runwieldSessionId),
        acquireSessionActivation: (activationOptions) => {
            const project = resolveSessionProject(activationOptions.projectId);
            if (!project) throw new Error("Session project is unavailable");
            return sessionStore.acquireSessionActivation({ ...activationOptions, projectId: project.projectId });
        },
        changeSessionActivationPhase: (proof, nextPhase, activationOptions) =>
            sessionStore.changeSessionActivationPhase(proof, nextPhase, activationOptions),
        registerSessionArtifact: (proof, artifactOptions) =>
            sessionStore.registerSessionArtifact(proof, artifactOptions),
        stagePlanAssociation: (proof, entry) => sessionStore.stagePlanAssociation(proof, entry),
        recordLastPlanReview: (proof, review) => sessionStore.recordLastPlanReview(proof, review),
        publishGenerationAndRelease: (proof, evidence, activationOptions) =>
            sessionStore.publishGenerationAndRelease(proof, evidence, activationOptions),
        commitSegmentRolloverAndPublish: (proof, rolloverOptions) =>
            sessionStore.commitSegmentRolloverAndPublish(proof, rolloverOptions),
        releaseUnchangedActivation: (proof, activationOptions) =>
            sessionStore.releaseUnchangedActivation(proof, activationOptions),
        recoverSessionControl: (recoveryOptions) => {
            const project = resolveSessionProject(recoveryOptions.projectId);
            if (!project) throw new Error("Session project is unavailable");
            return sessionStore.recoverSessionControl({ ...recoveryOptions, projectId: project.projectId });
        },
        markSessionReconcileRequired: (session, activationOptions) => {
            const project = resolveSessionProject(session.projectId);
            if (!project) throw new Error("Session project is unavailable");
            return sessionStore.markSessionReconcileRequired(
                { ...session, projectId: project.projectId },
                activationOptions,
            );
        },
        markSessionReconcileRequiredWithProof: (proof, activationOptions) =>
            sessionStore.markSessionReconcileRequiredWithProof(proof, activationOptions),
        markSessionUncertain: (proof, activationOptions) => sessionStore.markSessionUncertain(proof, activationOptions),
        findOperationReceiptByRequest: (operationOptions) => {
            const keys =
                operationOptions.projectId && !operationOptions.runwieldSessionId
                    ? projectRowKeys(operationOptions.projectId)
                    : undefined;
            if (keys?.length === 0) return null;
            return withCanonicalReceiptProject(findOperationReceiptByRequest(database, operationOptions, keys));
        },
        createOrGetOperationReceipt: (operationOptions) =>
            withCanonicalReceiptProject(createOrGetOperationReceipt(database, operationOptions))!,
        updateOperationReceipt: (operationId, updates) =>
            withCanonicalReceiptProject(updateOperationReceipt(database, operationId, updates)),
        getOperationReceipt: (operationId) => withCanonicalReceiptProject(getOperationReceipt(database, operationId)),
    };
}

export type {
    PairingRequestState,
    PairingRequest,
    PairingRequestClockOptions,
    CreatePairingRequestOptions,
    CreatedPairingRequest,
    ClaimPairingRequestOptions,
    ClaimedPairingRequest,
} from "./pairing.ts";

export type { OwnerCoordinationDatabase, OpenOwnerDatabaseOptions } from "./database.ts";

export type {
    ProjectStatus,
    ProjectHealthStatus,
    RegisteredProject,
    ProjectHealth,
    ProjectClockOptions,
    RegisterProjectOptions,
    RelinkProjectOptions,
    ProjectRootEvidence,
} from "@runwield/projects";
