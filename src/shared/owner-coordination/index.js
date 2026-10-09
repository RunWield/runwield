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

import { getOwnerCoordinationDatabaseEpoch, openOwnerCoordinationDatabase } from "./database.js";
import { openFileSessionStore } from "../session/file-session-store.ts";
import { getOwnerCoordinationDatabasePath, OWNER_COORDINATION_DB_FILENAME } from "./paths.ts";
import { OWNER_COORDINATION_SCHEMA_VERSION } from "./schema.ts";
import {
    getProjectById,
    getProjectHealth,
    listProjectRootEvidence,
    listProjects,
    registerProject,
    relinkProject,
    removeProject,
    requireEnabledProjectRoot,
    setProjectEnabled,
} from "./projects.js";
import { listDevices, revokeDevice, verifyDeviceCredential, verifyDeviceCsrf } from "./devices.ts";
import {
    approvePairingRequest,
    claimPairingRequest,
    createPairingRequest,
    getPairingRequestByProof,
} from "./pairing.js";
import {
    createOrGetOperationReceipt,
    findOperationReceiptByRequest,
    getOperationReceipt,
    updateOperationReceipt,
} from "./session-activations.js";

export { getOwnerCoordinationDatabasePath, OWNER_COORDINATION_DB_FILENAME, OWNER_COORDINATION_SCHEMA_VERSION };
export { OWNER_CSRF_COOKIE, OWNER_DEVICE_COOKIE, OWNER_DEVICE_MAX_AGE_SECONDS } from "./devices.ts";

/**
 * @typedef {Object} OwnerCoordinationStore
 * @property {string} path
 * @property {() => void} close
 * @property {(options: Parameters<typeof registerProject>[1]) => ReturnType<typeof registerProject>} registerProject
 * @property {ReturnType<typeof openFileSessionStore>['ensureRuntimeProject']} ensureRuntimeProject
 * @property {() => ReturnType<typeof listProjects>} listProjects
 * @property {ReturnType<typeof openFileSessionStore>['listSessionProjects']} listSessionProjects
 * @property {(projectId: string) => ReturnType<typeof getProjectById>} getProjectById
 * @property {(projectId: string) => ReturnType<typeof getProjectHealth>} getProjectHealth
 * @property {(projectId: string) => ReturnType<typeof listProjectRootEvidence>} listProjectRootEvidence
 * @property {(projectId: string, enabled: boolean, options?: Parameters<typeof setProjectEnabled>[3]) => ReturnType<typeof setProjectEnabled>} setProjectEnabled
 * @property {(projectId: string) => ReturnType<typeof removeProject>} removeProject
 * @property {(options: Parameters<typeof relinkProject>[1]) => ReturnType<typeof relinkProject>} relinkProject
 * @property {(projectId: string) => ReturnType<typeof requireEnabledProjectRoot>} requireEnabledProjectRoot
 * @property {(projectId: string) => string} requireSessionProjectRoot
 * @property {ReturnType<typeof openFileSessionStore>['ensureSessionCatalogRecord']} ensureSessionCatalogRecord
 * @property {ReturnType<typeof openFileSessionStore>['ensureSessionCatalogRecordAndAcquire']} ensureSessionCatalogRecordAndAcquire
 * @property {ReturnType<typeof openFileSessionStore>['findSessionByLocator']} findSessionByLocator
 * @property {ReturnType<typeof openFileSessionStore>['getSessionById']} getSessionById
 * @property {ReturnType<typeof openFileSessionStore>['archiveSession']} archiveSession
 * @property {ReturnType<typeof openFileSessionStore>['unarchiveSession']} unarchiveSession
 * @property {ReturnType<typeof openFileSessionStore>['listProjectSessions']} listProjectSessions
 * @property {ReturnType<typeof openFileSessionStore>['catalogProjectSessions']} catalogProjectSessions
 * @property {ReturnType<typeof openFileSessionStore>['listSessionTranscriptSegments']} listSessionTranscriptSegments
 * @property {ReturnType<typeof openFileSessionStore>['listSessionArtifacts']} listSessionArtifacts
 * @property {ReturnType<typeof openFileSessionStore>['listSessionPlanAssociations']} listSessionPlanAssociations
 * @property {ReturnType<typeof openFileSessionStore>['getLastPlanReview']} getLastPlanReview
 * @property {ReturnType<typeof openFileSessionStore>['getCurrentSessionSegment']} getCurrentSessionSegment
 * @property {ReturnType<typeof openFileSessionStore>['appendSessionTranscriptSegment']} appendSessionTranscriptSegment
 * @property {ReturnType<typeof openFileSessionStore>['validateSuccessorSegmentLocator']} validateSuccessorSegmentLocator
 * @property {ReturnType<typeof openFileSessionStore>['sealSessionTranscriptSegment']} sealSessionTranscriptSegment
 * @property {ReturnType<typeof openFileSessionStore>['findOrphanRolloverCandidates']} findOrphanRolloverCandidates
 * @property {ReturnType<typeof openFileSessionStore>['inspectSegmentRolloverRecovery']} inspectSegmentRolloverRecovery
 * @property {ReturnType<typeof openFileSessionStore>['discardOrphanRolloverCandidate']} discardOrphanRolloverCandidate
 * @property {(options?: Parameters<typeof createPairingRequest>[1]) => ReturnType<typeof createPairingRequest>} createPairingRequest
 * @property {(code: string, options?: Parameters<typeof approvePairingRequest>[2]) => ReturnType<typeof approvePairingRequest>} approvePairingRequest
 * @property {(proof: string, options?: Parameters<typeof getPairingRequestByProof>[2]) => ReturnType<typeof getPairingRequestByProof>} getPairingRequestByProof
 * @property {(proof: string, options?: Parameters<typeof claimPairingRequest>[2]) => ReturnType<typeof claimPairingRequest>} claimPairingRequest
 * @property {() => ReturnType<typeof listDevices>} listDevices
 * @property {(credential: string, options?: Parameters<typeof verifyDeviceCredential>[2]) => ReturnType<typeof verifyDeviceCredential>} verifyDeviceCredential
 * @property {(deviceId: string, csrf: string) => ReturnType<typeof verifyDeviceCsrf>} verifyDeviceCsrf
 * @property {(deviceId: string, options?: Parameters<typeof revokeDevice>[2]) => ReturnType<typeof revokeDevice>} revokeDevice
 * @property {() => string | null} getDatabaseEpoch
 * @property {ReturnType<typeof openFileSessionStore>['inspectSessionActivation']} inspectSessionActivation
 * @property {ReturnType<typeof openFileSessionStore>['acquireSessionActivation']} acquireSessionActivation
 * @property {ReturnType<typeof openFileSessionStore>['changeSessionActivationPhase']} changeSessionActivationPhase
 * @property {ReturnType<typeof openFileSessionStore>['registerSessionArtifact']} registerSessionArtifact
 * @property {ReturnType<typeof openFileSessionStore>['stagePlanAssociation']} stagePlanAssociation
 * @property {ReturnType<typeof openFileSessionStore>['recordLastPlanReview']} recordLastPlanReview
 * @property {ReturnType<typeof openFileSessionStore>['publishGenerationAndRelease']} publishGenerationAndRelease
 * @property {ReturnType<typeof openFileSessionStore>['commitSegmentRolloverAndPublish']} commitSegmentRolloverAndPublish
 * @property {ReturnType<typeof openFileSessionStore>['releaseUnchangedActivation']} releaseUnchangedActivation
 * @property {ReturnType<typeof openFileSessionStore>['recoverSessionControl']} recoverSessionControl
 * @property {ReturnType<typeof openFileSessionStore>['markSessionReconcileRequired']} markSessionReconcileRequired
 * @property {ReturnType<typeof openFileSessionStore>['markSessionReconcileRequiredWithProof']} markSessionReconcileRequiredWithProof
 * @property {ReturnType<typeof openFileSessionStore>['markSessionUncertain']} markSessionUncertain
 * @property {(options: Parameters<typeof findOperationReceiptByRequest>[1]) => ReturnType<typeof findOperationReceiptByRequest>} findOperationReceiptByRequest
 * @property {(options: Parameters<typeof createOrGetOperationReceipt>[1]) => ReturnType<typeof createOrGetOperationReceipt>} createOrGetOperationReceipt
 * @property {(operationId: string, updates: Parameters<typeof updateOperationReceipt>[2]) => ReturnType<typeof updateOperationReceipt>} updateOperationReceipt
 * @property {(operationId: string) => ReturnType<typeof getOperationReceipt>} getOperationReceipt
 */

/**
 * Open the public owner coordination store without exposing raw SQLite handles.
 * Internal migration tests and service modules may import database.js directly;
 * adapters should consume this narrow method surface.
 *
 * @param {import('./database.js').OpenOwnerDatabaseOptions & { sessionBaseDir?: string }} [options]
 * @returns {OwnerCoordinationStore}
 */
export function openOwnerCoordinationStore(options = {}) {
    const database = openOwnerCoordinationDatabase(options);
    const sessionStore = openFileSessionStore({ baseDir: options.sessionBaseDir });
    /** @param {string} projectId */
    const resolveSessionProject = (projectId) => {
        const direct = sessionStore.getProjectById(projectId);
        if (direct) return direct;
        const workspaceProject = getProjectById(database, projectId);
        return workspaceProject ? sessionStore.ensureRuntimeProject({ root: workspaceProject.registeredRoot }) : null;
    };
    return {
        path: database.path,
        close: () => {
            sessionStore.close();
            database.close();
        },
        registerProject: (projectOptions) => registerProject(database, projectOptions),
        ensureRuntimeProject: (projectOptions) => sessionStore.ensureRuntimeProject(projectOptions),
        listProjects: () => listProjects(database),
        listSessionProjects: () => sessionStore.listSessionProjects(),
        getProjectById: (projectId) => getProjectById(database, projectId),
        getProjectHealth: (projectId) => getProjectHealth(database, projectId),
        listProjectRootEvidence: (projectId) =>
            sessionStore.getProjectById(projectId)
                ? sessionStore.listProjectRootEvidence(projectId)
                : listProjectRootEvidence(database, projectId),
        setProjectEnabled: (projectId, enabled, projectOptions) =>
            setProjectEnabled(database, projectId, enabled, projectOptions),
        removeProject: (projectId) => removeProject(database, projectId),
        relinkProject: (projectOptions) => relinkProject(database, projectOptions),
        requireEnabledProjectRoot: (projectId) => requireEnabledProjectRoot(database, projectId),
        requireSessionProjectRoot: (projectId) =>
            sessionStore.getProjectById(projectId)
                ? sessionStore.requireSessionProjectRoot(projectId)
                : requireEnabledProjectRoot(database, projectId),
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
        getSessionById: (runwieldSessionId, projectId) => {
            const runtimeProject = projectId ? resolveSessionProject(projectId) : null;
            return sessionStore.getSessionById(runwieldSessionId, runtimeProject?.projectId);
        },
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
            const runtimeProject = resolveSessionProject(projectId);
            return runtimeProject ? await sessionStore.listProjectSessions(runtimeProject.projectId, sessionOptions) : {
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
        listSessionArtifacts: (runwieldSessionId, projectId) => {
            const runtimeProject = projectId ? resolveSessionProject(projectId) : null;
            return sessionStore.listSessionArtifacts(runwieldSessionId, runtimeProject?.projectId);
        },
        listSessionPlanAssociations: (runwieldSessionId, projectId) => {
            const runtimeProject = projectId ? resolveSessionProject(projectId) : null;
            return sessionStore.listSessionPlanAssociations(runwieldSessionId, runtimeProject?.projectId);
        },
        getLastPlanReview: (runwieldSessionId, projectId) => {
            const runtimeProject = projectId ? resolveSessionProject(projectId) : null;
            return sessionStore.getLastPlanReview(runwieldSessionId, runtimeProject?.projectId);
        },
        getCurrentSessionSegment: (runwieldSessionId) => sessionStore.getCurrentSessionSegment(runwieldSessionId),
        appendSessionTranscriptSegment: (segment) => sessionStore.appendSessionTranscriptSegment(segment),
        validateSuccessorSegmentLocator: (locator) => {
            const project = resolveSessionProject(locator.projectId);
            if (!project) throw new Error("Session project is unavailable");
            return sessionStore.validateSuccessorSegmentLocator({ ...locator, projectId: project.projectId });
        },
        sealSessionTranscriptSegment: (segmentOptions) => sessionStore.sealSessionTranscriptSegment(segmentOptions),
        findOrphanRolloverCandidates: (orphanOptions) => sessionStore.findOrphanRolloverCandidates(orphanOptions),
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
        findOperationReceiptByRequest: (operationOptions) => findOperationReceiptByRequest(database, operationOptions),
        createOrGetOperationReceipt: (operationOptions) => createOrGetOperationReceipt(database, operationOptions),
        updateOperationReceipt: (operationId, updates) => updateOperationReceipt(database, operationId, updates),
        getOperationReceipt: (operationId) => getOperationReceipt(database, operationId),
    };
}
