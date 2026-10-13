/**
 * @module shared/session/file-session-store-types
 * Domain contracts for file-authoritative Session storage.
 */

export interface SessionTranscriptSegment {
    segmentId: string;
    runwieldSessionId: string;
    projectId: string;
    piSessionId: string;
    transcriptPath: string;
    transcriptCwd: string;
    ordinal: number;
    kind: string;
    sealedAt: string | null;
    headerVersion: number | null;
    headerTimestamp: string | null;
    firstCatalogedAt: string;
    lastCatalogedAt: string;
    lineageParentSegmentId: string | null;
    lineageParentPiSessionId: string | null;
    lineageGroupKey: string | null;
    lineageRecordedAt: string | null;
    sealedByteLength: number | null;
    sealedDigestHex: string | null;
    sealedTerminalEntryId: string | null;
}

export interface SessionSegmentLineageEvidence {
    segmentId: string;
    runwieldSessionId: string;
    parentSegmentId?: string | null;
    parentPiSessionId?: string | null;
    lineageGroupKey?: string | null;
    kind?: "planning" | "execution" | "semantic_repair";
}
export type SessionPhase = "bootstrap" | "preparing" | "hydrated" | "turning" | "checkpointing";
export type ProcessKind = "workspace" | "tui" | "acp" | "test";

export type SessionArtifactKind = "plan" | "prd" | "adr" | "work-record" | "epic-artifact" | "report";

export interface SessionArtifactReference {
    artifactId: string;
    kind: SessionArtifactKind;
    path: string;
    title: string;
    registeredAt: string;
    registeredBy: string;
    sourceSegmentId: string | null;
}

export interface LastPlanReviewReference {
    planId: string;
    planName: string;
    planningAgentName: string;
    requestedAt: string;
}

export type ManifestPlanAssociation = import("./plan-association.ts").ManifestPlanAssociation;
export type PlanAssociation = import("./plan-association.ts").PlanAssociation;

export interface RegisterSessionArtifactOptions {
    kind: SessionArtifactKind;
    path: string;
    title: string;
    registeredBy: string;
    sourceSegmentId?: string | null;
    idFactory?: () => string;
    now?: () => string;
}

export interface FileSessionProject {
    projectId: string;
    displayName: string;
    registeredRoot: string;
    currentRoot: string;
    lifecycle: "enabled" | "disabled" | "removed";
    accessScope?: "local_runtime" | "workspace";
    createdAt: string;
    updatedAt: string;
    disabledAt: string | null;
    removedAt: string | null;
    restoredAt: string | null;
    relinkedAt: string | null;
}

export interface FileSessionManifest {
    version: number;
    runwieldSessionId: string;
    projectId: string;
    transcriptCwd: string;
    displayName: string | null;
    source: string;
    createdAt: string;
    updatedAt: string;
    currentSegmentId: string;
    fence: number;
    archivedAt?: string | null;
    activation: FileSessionActivation;
    generation: FileSessionGeneration | null;
    segments: SessionTranscriptSegment[];
    artifacts?: SessionArtifactReference[];
    planAssociations?: ManifestPlanAssociation[];
    lastPlanReview?: LastPlanReviewReference;
}

export interface FileSessionActivation {
    state: "uninitialized" | "idle" | "active" | "uncertain" | "reconcile_required";
    phase: SessionPhase | null;
    ownerInstanceId: string | null;
    ownerProcessKind: ProcessKind | null;
    operationId: string | null;
    expectedGeneration: number | null;
    expectedCurrentSegmentId?: string | null;
    acquiredAt: string | null;
    blockedReason: string | null;
    baselineByteLength?: number | null;
    baselineDigestHex?: string | null;
}

export interface FileSessionGeneration {
    runwieldSessionId: string;
    projectId: string;
    generation: number;
    evidenceVersion: number;
    digestAlgorithm: string;
    byteLength: number;
    terminalEntryId: string | null;
    digestHex: string;
    operationId: string;
    fence: number;
    currentSegmentId: string;
    committedAt: string;
}

export interface FileActivationProof {
    runwieldSessionId: string;
    projectId: string;
    ownerInstanceId: string;
    ownerProcessKind: ProcessKind;
    operationId: string;
    fence: number;
    phase: SessionPhase;
    expectedGeneration: number | null;
    expectedCurrentSegmentId?: string | null;
}

/** Operations retained after acquiring a Session writer lock. */
export interface SessionWriterLockHandle {
    unlockSync(): void;
    close(): void;
}

export interface HeldFileLock {
    file: SessionWriterLockHandle;
    manifestPath: string;
}

export interface OpenFileSessionStoreOptions {
    baseDir?: string;
    now?: () => string;
}

export interface EnsureSessionCatalogOptions {
    projectId: string;
    piSessionId: string;
    transcriptPath: string;
    transcriptCwd: string;
    headerVersion?: number | null;
    headerTimestamp?: string | null;
    source?: "catalog" | "created" | "imported";
    idFactory?: () => string;
    now?: () => string;
}

export interface InitialSessionActivationOptions {
    ownerInstanceId: string;
    ownerProcessKind: ProcessKind;
    operationId?: string;
    idFactory?: () => string;
    phase?: SessionPhase;
    now?: () => string;
}

export interface EnsureRuntimeProjectOptions {
    root: string;
    idFactory?: () => string;
    now?: () => string;
}

export interface CatalogedTranscriptLocator {
    sessionPath: string;
    piSessionId: string;
    headerCwd: string;
    headerVersion: number | null;
    headerTimestamp: string | null;
}

export interface LocatedSegmentLineage {
    locator: CatalogedTranscriptLocator;
    lineage: SessionSegmentLineageEvidence;
}

export type LineageReadResult =
    | { kind: "absent" }
    | { kind: "valid"; lineage: SessionSegmentLineageEvidence }
    | { kind: "malformed"; reason: string };

export interface SessionLocator {
    transcriptPath?: string;
    projectId?: string;
    piSessionId?: string;
}

export interface CatalogedSession {
    archivedAt: string | null;
    runwieldSessionId: string;
    projectId: string;
    displayName: string | null;
    source: string;
    piSessionId: string;
    transcriptPath: string;
    transcriptCwd: string;
    headerVersion: number | null;
    headerTimestamp: string | null;
    firstCatalogedAt: string;
    lastCatalogedAt: string;
    planAssociations?: ManifestPlanAssociation[];
}

export interface CatalogDiagnostic {
    sessionPath: string;
    code: string;
    message: string;
}

export interface ListSessionOptions {
    archiveState?: "active" | "archived" | "all";
    /** Return the entire sorted catalog for a caller that filters its own visible page. */
    all?: boolean;
    catalog?: boolean;
    fullRescan?: boolean;
    page?: number;
    pageSize?: number;
    idFactory?: () => string;
    now?: () => string;
}

export interface SessionListResult {
    sessions: CatalogedSession[];
    diagnostics: CatalogDiagnostic[];
    page: number;
    pageSize: number;
    total: number;
    hasNext: boolean;
    hasPrevious: boolean;
}

export interface SessionCatalogResult {
    cataloged: CatalogedSession[];
    diagnostics: CatalogDiagnostic[];
}

export interface SegmentAppendOptions {
    runwieldSessionId: string;
    projectId: string;
    piSessionId: string;
    transcriptPath: string;
    transcriptCwd: string;
    kind: "planning" | "execution" | "semantic_repair";
    lineageParentSegmentId?: string | null;
    lineageParentPiSessionId?: string | null;
    lineageGroupKey?: string | null;
    idFactory?: () => string;
    now?: () => string;
}

export interface TranscriptEvidence {
    generation?: number;
    evidenceVersion?: number;
    digestAlgorithm?: string;
    byteLength: number;
    terminalEntryId: string | null;
    digestHex: string;
    currentSegmentId?: string | null;
}

export interface SegmentSealOptions {
    runwieldSessionId: string;
    segmentId: string;
    evidence?: TranscriptEvidence;
    now?: () => string;
}

export interface OrphanSearchOptions {
    runwieldSessionId: string;
    projectId: string;
    transcriptCwd: string;
}

export interface OrphanRolloverCandidate {
    runwieldSessionId: string;
    projectId: string;
    transcriptPath: string;
    transcriptCwd: string;
    piSessionId: string;
    parentSegmentId: string;
    parentPiSessionId: string | null;
    lineageGroupKey: string | null;
}

export interface InspectRolloverOptions extends OrphanSearchOptions {
    successorTranscriptPath?: string | null;
    predecessorSegmentId?: string | null;
}

export interface RolloverInspection {
    state: "no_op_retry" | "removable_orphan" | "recoverable_orphan" | "database_ahead";
    transcriptPath: string | null;
    segmentId: string | null;
    reason: string;
}

export interface DiscardOrphanOptions {
    runwieldSessionId: string;
    transcriptPath: string;
}

export interface SuccessorLocator {
    projectId: string;
    piSessionId: string;
    transcriptPath: string;
    transcriptCwd: string;
}

export interface ActivationOptions extends InitialSessionActivationOptions {
    runwieldSessionId: string;
    projectId: string;
    expectedGeneration?: number | null;
    expectedCurrentSegmentId?: string | null;
}

export interface SessionActivationView {
    runwieldSessionId: string;
    projectId: string;
    state: FileSessionActivation["state"];
    phase: SessionPhase | null;
    latestGeneration: number | null;
    fence: number;
    ownerInstanceId: string | null;
    ownerProcessKind: ProcessKind | null;
    operationId: string | null;
    expectedGeneration: number | null;
    currentSegmentId: string;
    expectedCurrentSegmentId: string | null | undefined;
    acquiredAt: string | null;
    updatedAt: string;
    blockedReason: string | null;
}

export interface SessionControlSnapshot {
    activation: SessionActivationView | null;
    generation: FileSessionGeneration | null;
}

export interface SessionRecoveryOptions {
    runwieldSessionId: string;
    projectId: string;
    expectedFence: number;
    expectedGeneration: number | null;
    expectedCurrentSegmentId?: string | null;
    ownerInstanceId: string;
    ownerProcessKind: ProcessKind;
    operationId?: string;
    transcriptEvidence: TranscriptEvidence;
    now?: () => string;
    idFactory?: () => string;
}

export interface ReconcileSession {
    runwieldSessionId: string;
    projectId: string;
}

export interface ReconcileOptions {
    reason?: string;
    now?: () => string;
}

export interface RolloverOptions {
    predecessorSegmentId: string;
    predecessorEvidence: TranscriptEvidence;
    successor: SegmentAppendOptions;
    successorSafeLocator: CatalogedTranscriptLocator;
    generationEvidence: TranscriptEvidence & { generation: number };
    now?: () => string;
}

export interface RolloverCommitResult extends SessionControlSnapshot {
    predecessor: SessionTranscriptSegment;
    successor: SessionTranscriptSegment;
}

export interface FileSessionStore {
    path: string;
    close(): void;
    ensureRuntimeProject(options: EnsureRuntimeProjectOptions): FileSessionProject;
    listSessionProjects(): FileSessionProject[];
    listProjects(): FileSessionProject[];
    getProjectById(projectId: string): FileSessionProject | null;
    listProjectRootEvidence(
        projectId: string,
    ): Array<{ enteredRoot: string; canonicalRoot: string; rootState: string }>;
    requireSessionProjectRoot(projectId: string): string;
    findSessionByLocator(locator: SessionLocator): CatalogedSession | null;
    getSessionById(runwieldSessionId: string, projectId?: string): CatalogedSession | null;
    archiveSession(runwieldSessionId: string, projectId?: string): CatalogedSession;
    unarchiveSession(runwieldSessionId: string, projectId?: string): CatalogedSession;
    ensureSessionCatalogRecord(locator: EnsureSessionCatalogOptions): Promise<CatalogedSession>;
    ensureSessionCatalogRecordAndAcquire(options: {
        locator: EnsureSessionCatalogOptions;
        activation: InitialSessionActivationOptions;
    }): Promise<{
        session: CatalogedSession;
        segment: SessionTranscriptSegment;
        proof: FileActivationProof;
    }>;
    listProjectSessions(projectId: string, options?: ListSessionOptions): Promise<SessionListResult>;
    catalogProjectSessions(projectId: string, options?: ListSessionOptions): Promise<SessionCatalogResult>;
    listSessionTranscriptSegments(runwieldSessionId: string): SessionTranscriptSegment[];
    listSessionArtifacts(runwieldSessionId: string, projectId?: string): SessionArtifactReference[];
    listSessionPlanAssociations(runwieldSessionId: string, projectId?: string): ManifestPlanAssociation[];
    getLastPlanReview(runwieldSessionId: string, projectId?: string): LastPlanReviewReference | null;
    getCurrentSessionSegment(runwieldSessionId: string): SessionTranscriptSegment | null;
    appendSessionTranscriptSegment(options: SegmentAppendOptions): Promise<SessionTranscriptSegment>;
    sealSessionTranscriptSegment(options: SegmentSealOptions): SessionTranscriptSegment;
    findOrphanRolloverCandidates(options: OrphanSearchOptions): Promise<OrphanRolloverCandidate[]>;
    inspectSegmentRolloverRecovery(options: InspectRolloverOptions): Promise<RolloverInspection>;
    discardOrphanRolloverCandidate(options: DiscardOrphanOptions): Promise<void>;
    validateSuccessorSegmentLocator(options: SuccessorLocator): Promise<CatalogedTranscriptLocator>;
    inspectSessionActivation(runwieldSessionId: string): SessionControlSnapshot;
    acquireSessionActivation(options: ActivationOptions): FileActivationProof;
    changeSessionActivationPhase(
        proof: FileActivationProof,
        nextPhase: SessionPhase,
        options?: { now?: () => string },
    ): FileActivationProof;
    registerSessionArtifact(
        proof: FileActivationProof,
        options: RegisterSessionArtifactOptions,
    ): SessionArtifactReference;
    stagePlanAssociation(proof: FileActivationProof, entry: PlanAssociation): ManifestPlanAssociation;
    recordLastPlanReview(
        proof: FileActivationProof,
        review: Pick<LastPlanReviewReference, "planId" | "planName" | "planningAgentName">,
    ): LastPlanReviewReference;
    publishGenerationAndRelease(
        proof: FileActivationProof,
        evidence: TranscriptEvidence & { generation: number },
        options?: { now?: () => string },
    ): SessionControlSnapshot;
    releaseUnchangedActivation(
        proof: FileActivationProof,
        options?: { now?: () => string },
    ): SessionControlSnapshot;
    recoverSessionControl(options: SessionRecoveryOptions): SessionControlSnapshot;
    markSessionReconcileRequired(session: ReconcileSession, options?: ReconcileOptions): SessionControlSnapshot;
    markSessionUncertain(proof: FileActivationProof, options?: ReconcileOptions): SessionControlSnapshot;
    markSessionReconcileRequiredWithProof(
        proof: FileActivationProof,
        options?: ReconcileOptions,
    ): SessionControlSnapshot;
    commitSegmentRolloverAndPublish(proof: FileActivationProof, options: RolloverOptions): RolloverCommitResult;
}
