/*
 * @module shared/owner-coordination/session-activations
 * Fenced Session Activation Lease and committed generation APIs.
 */

import type { SQLOutputValue } from "node:sqlite";
import type { JsonRecord } from "../jsonc.ts";
import type { ProcessKind } from "../session/file-session-store-types.ts";
import type { OwnerCoordinationDatabase } from "./database.ts";
import { insertSessionTranscriptSegmentRow, sealSessionTranscriptSegmentRow } from "./sessions.ts";

export type SessionActivationState = "uninitialized" | "idle" | "active" | "uncertain" | "reconcile_required";
export type SessionActivationPhase = "bootstrap" | "preparing" | "hydrated" | "turning" | "checkpointing";

interface SessionIdentity {
    runwieldSessionId: string;
    projectId: string;
}

export interface ActivationProof extends SessionIdentity {
    ownerInstanceId: string;
    ownerProcessKind: ProcessKind;
    operationId: string;
    fence: number;
    phase: SessionActivationPhase;
    expectedGeneration: number | null;
    expectedCurrentSegmentId?: string | null;
}

export interface GenerationEvidence {
    generation: number;
    byteLength: number;
    terminalEntryId: string | null;
    digestHex: string;
    digestAlgorithm?: string;
    evidenceVersion?: number;
    currentSegmentId?: string | null;
}

interface ClockOptions {
    now?: () => string;
}

interface OwnerOperationOptions extends ClockOptions {
    ownerInstanceId: string;
    ownerProcessKind: ProcessKind;
    operationId?: string;
    expectedCurrentSegmentId?: string | null;
    idFactory?: () => string;
}

interface AcquireActivationOptions extends SessionIdentity, OwnerOperationOptions {
    expectedGeneration?: number | null;
    phase?: SessionActivationPhase;
}

interface RecoverSessionOptions extends SessionIdentity, OwnerOperationOptions {
    expectedFence: number;
    expectedGeneration: number | null;
    transcriptEvidence: GenerationEvidence;
}

interface RolloverOptions extends ClockOptions {
    predecessorSegmentId: string;
    predecessorEvidence: NonNullable<Parameters<typeof sealSessionTranscriptSegmentRow>[1]["evidence"]>;
    successor: Parameters<typeof insertSessionTranscriptSegmentRow>[1];
    successorSafeLocator: Parameters<typeof insertSessionTranscriptSegmentRow>[2];
    generationEvidence: GenerationEvidence;
}

interface ActivationReasonOptions extends ClockOptions {
    reason?: string;
}

type OperationKind = "bootstrap" | "continuation" | "plan_action";
type OperationStatus = "accepted" | "running" | "completed" | "failed" | "conflict";

interface OperationRequestIdentity {
    deviceId?: string | null;
    requestId: string;
    requestHash: string;
}

interface CreateReceiptOptions extends SessionIdentity, OperationRequestIdentity, ClockOptions {
    expectedGeneration?: number | null;
    kind: OperationKind;
    operationId?: string;
    idFactory?: () => string;
}

interface FindReceiptOptions extends Partial<SessionIdentity>, OperationRequestIdentity {}

interface UpdateReceiptOptions extends ClockOptions {
    status: OperationStatus;
    resultGeneration?: number | null;
    resultHttpStatus?: number | null;
    resultBody?: JsonRecord;
    errorCode?: string | null;
    errorMessage?: string | null;
}

// SQLite exposes generic values. These row shapes follow the owner schema.
type SqlRow = Record<string, SQLOutputValue>;

interface ActivationRow extends SqlRow {
    runwield_session_id: string;
    project_id: string;
    state: SessionActivationState;
    phase: SessionActivationPhase | null;
    latest_generation: number | null;
    fence: number;
    owner_instance_id: string | null;
    owner_process_kind: ProcessKind | null;
    operation_id: string | null;
    expected_generation: number | null;
    current_segment_id: string | null;
    expected_current_segment_id: string | null;
    acquired_at: string | null;
    heartbeat_at: string | null;
    heartbeat_deadline_at: string | null;
    updated_at: string;
    blocked_reason: string | null;
}

interface GenerationRow extends SqlRow {
    runwield_session_id: string;
    project_id: string;
    generation: number;
    evidence_version: number;
    digest_algorithm: string;
    byte_length: number;
    terminal_entry_id: string | null;
    digest_hex: string;
    operation_id: string;
    fence: number;
    current_segment_id: string | null;
    committed_at: string;
}

interface OperationRow extends SqlRow {
    id: string;
    device_id: string | null;
    request_id: string;
    request_hash: string;
    runwield_session_id: string;
    project_id: string;
    expected_generation: number | null;
    kind: OperationKind;
    status: OperationStatus;
    operation_id: string;
    started_at: string;
    updated_at: string;
    completed_at: string | null;
    result_generation: number | null;
    result_http_status: number | null;
    result_json: string | null;
    error_code: string | null;
    error_message: string | null;
}

function requireDatabase(value: OwnerCoordinationDatabase) {
    if (!value || typeof value !== "object" || !("handle" in value)) throw new Error("Owner database is required");
    return value;
}

function isoNow(now?: () => string) {
    return now ? now() : new Date().toISOString();
}

function newId(idFactory?: () => string) {
    return idFactory ? idFactory() : crypto.randomUUID();
}

const MAX_OPERATION_RESULT_JSON_BYTES = 32 * 1024;

function encodeOperationResult(result: JsonRecord | undefined) {
    if (result === undefined) return null;
    const text = JSON.stringify(result);
    if (new TextEncoder().encode(text).byteLength > MAX_OPERATION_RESULT_JSON_BYTES) {
        throw new Error("Operation receipt result is too large");
    }
    return text;
}

function decodeOperationResult(value: SQLOutputValue | undefined): JsonRecord | null {
    if (typeof value !== "string") return null;
    if (!value) return null;
    try {
        return JSON.parse(value) as JsonRecord;
    } catch {
        return null;
    }
}

function activationFromRow(row: SqlRow | undefined) {
    if (!row) return null;
    const stored = row as ActivationRow;
    return {
        runwieldSessionId: stored.runwield_session_id,
        projectId: stored.project_id,
        state: stored.state,
        phase: stored.phase,
        latestGeneration:
            stored.latest_generation === null || stored.latest_generation === undefined
                ? null
                : Number(stored.latest_generation),
        fence: Number(stored.fence),
        ownerInstanceId: stored.owner_instance_id,
        ownerProcessKind: stored.owner_process_kind,
        operationId: stored.operation_id,
        expectedGeneration:
            stored.expected_generation === null || stored.expected_generation === undefined
                ? null
                : Number(stored.expected_generation),
        currentSegmentId: stored.current_segment_id,
        expectedCurrentSegmentId: stored.expected_current_segment_id,
        acquiredAt: stored.acquired_at,
        heartbeatAt: stored.heartbeat_at,
        heartbeatDeadlineAt: stored.heartbeat_deadline_at,
        updatedAt: stored.updated_at,
        blockedReason: stored.blocked_reason,
    };
}

function generationFromRow(row: SqlRow | undefined) {
    if (!row) return null;
    const stored = row as GenerationRow;
    return {
        runwieldSessionId: stored.runwield_session_id,
        projectId: stored.project_id,
        generation: Number(stored.generation),
        evidenceVersion: Number(stored.evidence_version),
        digestAlgorithm: stored.digest_algorithm,
        byteLength: Number(stored.byte_length),
        terminalEntryId: stored.terminal_entry_id,
        digestHex: stored.digest_hex,
        operationId: stored.operation_id,
        fence: Number(stored.fence),
        currentSegmentId: stored.current_segment_id,
        committedAt: stored.committed_at,
    };
}

type SessionActivation = NonNullable<ReturnType<typeof activationFromRow>>;

export function inspectSessionActivation(database: OwnerCoordinationDatabase, runwieldSessionId: string) {
    const db = requireDatabase(database).handle;
    const activation = activationFromRow(
        db.prepare("SELECT * FROM session_activation_state WHERE runwield_session_id = ?").get(runwieldSessionId),
    );
    const generation = generationFromRow(
        db
            .prepare(
                "SELECT * FROM session_committed_generations WHERE runwield_session_id = ? ORDER BY generation DESC LIMIT 1",
            )
            .get(runwieldSessionId),
    );
    return { activation, generation };
}

function requireProof(proof: ActivationProof) {
    const value: Partial<ActivationProof> = proof || {};
    for (const field of [
        "runwieldSessionId",
        "projectId",
        "ownerInstanceId",
        "ownerProcessKind",
        "operationId",
    ] satisfies (keyof ActivationProof)[]) {
        if (typeof value[field] !== "string" || !value[field]) throw new Error(`Activation proof missing ${field}`);
    }
    if (!Number.isInteger(proof.fence) || proof.fence <= 0) throw new Error("Activation proof fence is invalid");
    if (!proof.phase) throw new Error("Activation proof phase is required");
}

const LEGAL_PHASE_TRANSITIONS = new Map([
    ["bootstrap", new Set(["checkpointing"])],
    ["preparing", new Set(["hydrated"])],
    ["hydrated", new Set(["turning", "checkpointing"])],
    ["turning", new Set(["checkpointing"])],
    ["checkpointing", new Set()],
]);

function proofMatches(current: SessionActivation, proof: ActivationProof) {
    return (
        current.ownerInstanceId === proof.ownerInstanceId &&
        current.ownerProcessKind === proof.ownerProcessKind &&
        current.operationId === proof.operationId &&
        current.fence === proof.fence &&
        current.phase === proof.phase &&
        current.expectedGeneration === proof.expectedGeneration &&
        current.expectedCurrentSegmentId === (proof.expectedCurrentSegmentId ?? null)
    );
}

function assertActiveProofFresh(
    ownerDb: OwnerCoordinationDatabase,
    current: SessionActivation,
    proof: ActivationProof,
    now: string,
) {
    if (current.state !== "active") throw new Error("Activation is not active");
    if (!proofMatches(current, proof)) throw new Error("Activation proof was rejected");
    if (current.heartbeatDeadlineAt && current.heartbeatDeadlineAt <= now) {
        ownerDb.handle
            .prepare(
                `UPDATE session_activation_state
                SET state = 'uncertain', phase = NULL, owner_instance_id = NULL, owner_process_kind = NULL,
                    operation_id = NULL, expected_generation = NULL, expected_current_segment_id = NULL, heartbeat_deadline_at = NULL,
                    updated_at = ?, blocked_reason = 'heartbeat_expired'
              WHERE runwield_session_id = ? AND project_id = ? AND state = 'active'
                AND owner_instance_id = ? AND owner_process_kind = ? AND operation_id = ? AND fence = ? AND phase = ?
                AND expected_generation IS ?`,
            )
            .run(
                now,
                proof.runwieldSessionId,
                proof.projectId,
                proof.ownerInstanceId,
                proof.ownerProcessKind,
                proof.operationId,
                proof.fence,
                proof.phase,
                proof.expectedGeneration ?? null,
            );
        throw new Error("Activation heartbeat expired");
    }
}

export function heartbeatSessionActivation(
    database: OwnerCoordinationDatabase,
    proof: ActivationProof,
    options: ClockOptions = {},
) {
    requireProof(proof);
    const ownerDb = requireDatabase(database);
    const now = isoNow(options.now);
    const transactionResult = ownerDb.transaction(() => {
        const current = activationFromRow(
            ownerDb.handle
                .prepare("SELECT * FROM session_activation_state WHERE runwield_session_id = ? AND project_id = ?")
                .get(proof.runwieldSessionId, proof.projectId),
        );
        if (!current || current.state !== "active") throw new Error("Activation is not active");
        if (!proofMatches(current, proof)) throw new Error("Activation proof was rejected");
        if (current.heartbeatDeadlineAt && current.heartbeatDeadlineAt <= now) {
            ownerDb.handle
                .prepare(
                    `UPDATE session_activation_state
                    SET state = 'uncertain', phase = NULL, owner_instance_id = NULL, owner_process_kind = NULL,
                        operation_id = NULL, expected_generation = NULL, expected_current_segment_id = NULL, heartbeat_deadline_at = NULL,
                        updated_at = ?, blocked_reason = 'heartbeat_expired'
                  WHERE runwield_session_id = ? AND project_id = ? AND state = 'active'
                    AND owner_instance_id = ? AND owner_process_kind = ? AND operation_id = ? AND fence = ? AND phase = ?
                    AND expected_generation IS ?`,
                )
                .run(
                    now,
                    proof.runwieldSessionId,
                    proof.projectId,
                    proof.ownerInstanceId,
                    proof.ownerProcessKind,
                    proof.operationId,
                    proof.fence,
                    proof.phase,
                    proof.expectedGeneration ?? null,
                );
            return { expired: true };
        }
        const result = ownerDb.handle
            .prepare(
                `UPDATE session_activation_state
                SET heartbeat_at = ?, heartbeat_deadline_at = ?, updated_at = ?
              WHERE runwield_session_id = ? AND project_id = ? AND state = 'active'
                AND owner_instance_id = ? AND owner_process_kind = ? AND operation_id = ? AND fence = ? AND phase = ?
                AND expected_generation IS ?`,
            )
            .run(
                now,
                deadlineFrom(now),
                now,
                proof.runwieldSessionId,
                proof.projectId,
                proof.ownerInstanceId,
                proof.ownerProcessKind,
                proof.operationId,
                proof.fence,
                proof.phase,
                proof.expectedGeneration ?? null,
            );
        if (result.changes !== 1) throw new Error("Activation heartbeat proof was rejected");
        return {
            expired: false,
            activation: activationFromRow(
                ownerDb.handle
                    .prepare("SELECT * FROM session_activation_state WHERE runwield_session_id = ?")
                    .get(proof.runwieldSessionId),
            ),
        };
    });
    if (transactionResult.expired) throw new Error("Activation heartbeat expired");
    return transactionResult.activation!;
}

function deadlineFrom(iso: string) {
    return new Date(Date.parse(iso) + 30_000).toISOString();
}

function isDeadlineExpired(timestamp: string | null | undefined, now: string) {
    if (!timestamp) return false;
    return Date.parse(timestamp) <= Date.parse(now);
}

export function acquireSessionActivation(
    database: OwnerCoordinationDatabase,
    options: AcquireActivationOptions,
): ActivationProof {
    const ownerDb = requireDatabase(database);
    const now = isoNow(options.now);
    const operationId = options.operationId || newId(options.idFactory);
    const phase = options.phase || "preparing";
    return ownerDb.transaction(() => {
        const current = activationFromRow(
            ownerDb.handle
                .prepare("SELECT * FROM session_activation_state WHERE runwield_session_id = ? AND project_id = ?")
                .get(options.runwieldSessionId, options.projectId),
        );
        if (!current) throw new Error(`Activation state not found: ${options.runwieldSessionId}`);
        const expectedGeneration = options.expectedGeneration ?? current.latestGeneration;
        const expectedCurrentSegmentId =
            options.expectedCurrentSegmentId === undefined
                ? (current.currentSegmentId ?? null)
                : options.expectedCurrentSegmentId;
        if (expectedCurrentSegmentId !== (current.currentSegmentId ?? null)) {
            throw new Error("Session activation current segment expectation does not match stored state");
        }
        const isBootstrap = current.state === "uninitialized" && phase === "bootstrap" && expectedGeneration === null;
        const isPreparing = current.state === "uninitialized" && phase === "preparing" && expectedGeneration === null;
        const isNormal = current.state === "idle" && current.latestGeneration === expectedGeneration;
        if (!isBootstrap && !isPreparing && !isNormal) {
            throw new Error(`Session activation is not available: ${current.state}`);
        }
        const nextFence = current.fence + 1;
        const result = ownerDb.handle
            .prepare(
                `UPDATE session_activation_state
                SET state = 'active', phase = ?, fence = ?, owner_instance_id = ?, owner_process_kind = ?,
                    operation_id = ?, expected_generation = ?, expected_current_segment_id = ?, acquired_at = ?, heartbeat_at = ?,
                    heartbeat_deadline_at = ?, updated_at = ?, blocked_reason = NULL
              WHERE runwield_session_id = ? AND project_id = ? AND state = ? AND fence = ?`,
            )
            .run(
                phase,
                nextFence,
                options.ownerInstanceId,
                options.ownerProcessKind,
                operationId,
                expectedGeneration,
                expectedCurrentSegmentId,
                now,
                now,
                deadlineFrom(now),
                now,
                options.runwieldSessionId,
                options.projectId,
                current.state,
                current.fence,
            );
        if (result.changes !== 1) throw new Error("Session activation race lost");
        return {
            runwieldSessionId: options.runwieldSessionId,
            projectId: options.projectId,
            ownerInstanceId: options.ownerInstanceId,
            ownerProcessKind: options.ownerProcessKind,
            operationId,
            fence: nextFence,
            phase,
            expectedGeneration,
            expectedCurrentSegmentId,
        };
    });
}

export function changeSessionActivationPhase(
    database: OwnerCoordinationDatabase,
    proof: ActivationProof,
    nextPhase: SessionActivationPhase,
    options: ClockOptions = {},
) {
    requireProof(proof);
    const ownerDb = requireDatabase(database);
    const now = isoNow(options.now);
    return ownerDb.transaction(() => {
        const current = activationFromRow(
            ownerDb.handle
                .prepare("SELECT * FROM session_activation_state WHERE runwield_session_id = ? AND project_id = ?")
                .get(proof.runwieldSessionId, proof.projectId),
        );
        if (!current) throw new Error("Activation is not active");
        assertActiveProofFresh(ownerDb, current, proof, now);
        if (!LEGAL_PHASE_TRANSITIONS.get(proof.phase)?.has(nextPhase)) {
            throw new Error(`Illegal activation phase transition: ${proof.phase} -> ${nextPhase}`);
        }
        const result = ownerDb.handle
            .prepare(
                `UPDATE session_activation_state SET phase = ?, updated_at = ?, heartbeat_at = ?, heartbeat_deadline_at = ?
              WHERE runwield_session_id = ? AND project_id = ? AND state = 'active'
                AND owner_instance_id = ? AND owner_process_kind = ? AND operation_id = ? AND fence = ? AND phase = ?
                AND expected_generation IS ?`,
            )
            .run(
                nextPhase,
                now,
                now,
                deadlineFrom(now),
                proof.runwieldSessionId,
                proof.projectId,
                proof.ownerInstanceId,
                proof.ownerProcessKind,
                proof.operationId,
                proof.fence,
                proof.phase,
                proof.expectedGeneration ?? null,
            );
        if (result.changes !== 1) throw new Error("Activation phase proof was rejected");
        return { ...proof, phase: nextPhase };
    });
}

function loadActiveActivation(ownerDb: OwnerCoordinationDatabase, proof: ActivationProof) {
    const current = activationFromRow(
        ownerDb.handle
            .prepare("SELECT * FROM session_activation_state WHERE runwield_session_id = ? AND project_id = ?")
            .get(proof.runwieldSessionId, proof.projectId),
    );
    if (!current) throw new Error("Activation is not active");
    return current;
}

function assertPublicationPhase(
    ownerDb: OwnerCoordinationDatabase,
    current: SessionActivation,
    proof: ActivationProof,
    now: string,
) {
    assertActiveProofFresh(ownerDb, current, proof, now);
    if (proof.phase !== "checkpointing") throw new Error("Generation publication requires checkpointing phase");
}

function assertGenerationAdvances(current: SessionActivation, evidence: GenerationEvidence) {
    const previous = current.latestGeneration;
    const expectedNext = previous === null ? 0 : previous + 1;
    if (evidence.generation !== expectedNext) throw new Error(`Generation must advance to ${expectedNext}`);
}

function insertCommittedGenerationRow(
    ownerDb: OwnerCoordinationDatabase,
    proof: ActivationProof,
    evidence: GenerationEvidence,
    currentSegmentId: string | null,
    now: string,
) {
    ownerDb.handle
        .prepare(
            `INSERT INTO session_committed_generations(runwield_session_id, project_id, generation, evidence_version,
            digest_algorithm, byte_length, terminal_entry_id, digest_hex, operation_id, fence, committed_at, current_segment_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
            proof.runwieldSessionId,
            proof.projectId,
            evidence.generation,
            evidence.evidenceVersion || 1,
            evidence.digestAlgorithm || "sha256",
            evidence.byteLength,
            evidence.terminalEntryId ?? null,
            evidence.digestHex,
            proof.operationId,
            proof.fence,
            now,
            currentSegmentId,
        );
}

function releaseActivationAfterGeneration(
    ownerDb: OwnerCoordinationDatabase,
    proof: ActivationProof,
    generation: number,
    now: string,
) {
    const result = ownerDb.handle
        .prepare(
            `UPDATE session_activation_state
            SET state = 'idle', phase = NULL, latest_generation = ?, owner_instance_id = NULL,
                owner_process_kind = NULL, operation_id = NULL, expected_generation = NULL, expected_current_segment_id = NULL, acquired_at = NULL,
                heartbeat_at = NULL, heartbeat_deadline_at = NULL, updated_at = ?, blocked_reason = NULL
          WHERE runwield_session_id = ? AND project_id = ? AND state = 'active'
            AND owner_instance_id = ? AND owner_process_kind = ? AND operation_id = ? AND fence = ? AND phase = ?
            AND expected_generation IS ?`,
        )
        .run(
            generation,
            now,
            proof.runwieldSessionId,
            proof.projectId,
            proof.ownerInstanceId,
            proof.ownerProcessKind,
            proof.operationId,
            proof.fence,
            proof.phase,
            proof.expectedGeneration ?? null,
        );
    if (result.changes !== 1) throw new Error("Activation release proof was rejected");
}

export function publishGenerationAndRelease(
    database: OwnerCoordinationDatabase,
    proof: ActivationProof,
    evidence: GenerationEvidence,
    options: ClockOptions = {},
) {
    requireProof(proof);
    const ownerDb = requireDatabase(database);
    const now = isoNow(options.now);
    return ownerDb.transaction(() => {
        const current = loadActiveActivation(ownerDb, proof);
        assertPublicationPhase(ownerDb, current, proof, now);
        assertGenerationAdvances(current, evidence);
        const currentSegmentId = evidence.currentSegmentId ?? proof.expectedCurrentSegmentId ?? null;
        if (currentSegmentId !== current.currentSegmentId) throw new Error("Current segment proof was rejected");
        insertCommittedGenerationRow(ownerDb, proof, evidence, currentSegmentId, now);
        releaseActivationAfterGeneration(ownerDb, proof, evidence.generation, now);
        return inspectSessionActivation(ownerDb, proof.runwieldSessionId);
    });
}

export function recoverExpiredSessionControl(database: OwnerCoordinationDatabase, options: RecoverSessionOptions) {
    const ownerDb = requireDatabase(database);
    const now = isoNow(options.now);
    return ownerDb.transaction(() => {
        const current = activationFromRow(
            ownerDb.handle
                .prepare("SELECT * FROM session_activation_state WHERE runwield_session_id = ? AND project_id = ?")
                .get(options.runwieldSessionId, options.projectId),
        );
        if (!current) throw new Error("Activation state not found");
        if (current.fence !== options.expectedFence) throw new Error("Session control recovery fence was stale");
        if (current.latestGeneration !== options.expectedGeneration) {
            throw new Error("Session control recovery generation was stale");
        }
        const expectedCurrentSegmentId =
            options.expectedCurrentSegmentId === undefined
                ? (current.currentSegmentId ?? null)
                : options.expectedCurrentSegmentId;
        if (expectedCurrentSegmentId !== (current.currentSegmentId ?? null)) {
            throw new Error("Session control recovery current segment was stale");
        }
        if (current.state === "active" && !isDeadlineExpired(current.heartbeatDeadlineAt, now)) {
            throw new Error("Session control is still renewing");
        }
        if (current.state !== "active" && current.state !== "uncertain") {
            throw new Error(`Session control recovery is not available: ${current.state}`);
        }
        const evidence = options.transcriptEvidence;
        const latestGeneration = current.latestGeneration;
        const exactGeneration = latestGeneration ?? 0;
        const transcriptAheadGeneration = latestGeneration === null ? 0 : latestGeneration + 1;
        const adoptsTranscriptAhead =
            evidence.generation === transcriptAheadGeneration && evidence.generation !== latestGeneration;
        const acceptsExact =
            evidence.generation === latestGeneration ||
            (latestGeneration === null && evidence.generation === exactGeneration);
        if (!acceptsExact && !adoptsTranscriptAhead) {
            throw new Error("Session control recovery transcript generation is not the next valid generation");
        }
        const nextFence = current.fence + 1;
        const proof: ActivationProof = {
            runwieldSessionId: options.runwieldSessionId,
            projectId: options.projectId,
            ownerInstanceId: options.ownerInstanceId,
            ownerProcessKind: options.ownerProcessKind,
            operationId: options.operationId || newId(options.idFactory),
            fence: nextFence,
            phase: "checkpointing",
            expectedGeneration: current.latestGeneration,
            expectedCurrentSegmentId,
        };
        if (adoptsTranscriptAhead) {
            insertCommittedGenerationRow(ownerDb, proof, evidence, expectedCurrentSegmentId, now);
        }
        const result = ownerDb.handle
            .prepare(
                `UPDATE session_activation_state
                SET state = 'idle', phase = NULL, latest_generation = ?, fence = ?, owner_instance_id = NULL,
                    owner_process_kind = NULL, operation_id = NULL, expected_generation = NULL,
                    expected_current_segment_id = NULL, acquired_at = NULL, heartbeat_at = NULL,
                    heartbeat_deadline_at = NULL, updated_at = ?, blocked_reason = NULL
              WHERE runwield_session_id = ? AND project_id = ? AND fence = ? AND state IN ('active', 'uncertain')`,
            )
            .run(
                adoptsTranscriptAhead || acceptsExact ? evidence.generation : current.latestGeneration,
                nextFence,
                now,
                options.runwieldSessionId,
                options.projectId,
                current.fence,
            );
        if (result.changes !== 1) throw new Error("Session control recovery race lost");
        return inspectSessionActivation(ownerDb, options.runwieldSessionId);
    });
}

export function commitSegmentRolloverAndPublish(
    database: OwnerCoordinationDatabase,
    proof: ActivationProof,
    options: RolloverOptions,
) {
    requireProof(proof);
    const ownerDb = requireDatabase(database);
    const now = isoNow(options.now);
    return ownerDb.transaction(() => {
        const current = loadActiveActivation(ownerDb, proof);
        assertPublicationPhase(ownerDb, current, proof, now);
        if ((proof.expectedCurrentSegmentId ?? null) !== options.predecessorSegmentId) {
            throw new Error("Rollover predecessor proof was rejected");
        }
        if (current.currentSegmentId !== options.predecessorSegmentId) {
            throw new Error("Rollover predecessor proof was rejected");
        }
        sealSessionTranscriptSegmentRow(ownerDb, {
            runwieldSessionId: proof.runwieldSessionId,
            segmentId: options.predecessorSegmentId,
            evidence: options.predecessorEvidence,
            now: () => now,
        });
        const successor = insertSessionTranscriptSegmentRow(ownerDb, options.successor, options.successorSafeLocator);
        const expectedSuccessorId = options.generationEvidence.currentSegmentId ?? successor.segmentId;
        if (expectedSuccessorId !== successor.segmentId) throw new Error("Current segment proof was rejected");
        const pointerUpdate = ownerDb.handle
            .prepare(
                `UPDATE session_activation_state
                SET current_segment_id = ?, expected_current_segment_id = ?, updated_at = ?
              WHERE runwield_session_id = ? AND project_id = ? AND state = 'active'
                AND owner_instance_id = ? AND owner_process_kind = ? AND operation_id = ? AND fence = ? AND phase = ?
                AND expected_generation IS ? AND expected_current_segment_id IS ?`,
            )
            .run(
                successor.segmentId,
                successor.segmentId,
                now,
                proof.runwieldSessionId,
                proof.projectId,
                proof.ownerInstanceId,
                proof.ownerProcessKind,
                proof.operationId,
                proof.fence,
                proof.phase,
                proof.expectedGeneration ?? null,
                options.predecessorSegmentId,
            );
        if (pointerUpdate.changes !== 1) throw new Error("Current segment proof was rejected");
        insertCommittedGenerationRow(ownerDb, proof, options.generationEvidence, successor.segmentId, now);
        releaseActivationAfterGeneration(ownerDb, proof, options.generationEvidence.generation, now);
        return { ...inspectSessionActivation(ownerDb, proof.runwieldSessionId), successor };
    });
}

export function releaseUnchangedActivation(
    database: OwnerCoordinationDatabase,
    proof: ActivationProof,
    options: ClockOptions = {},
) {
    requireProof(proof);
    const ownerDb = requireDatabase(database);
    const now = isoNow(options.now);
    return ownerDb.transaction(() => {
        const current = activationFromRow(
            ownerDb.handle
                .prepare("SELECT * FROM session_activation_state WHERE runwield_session_id = ? AND project_id = ?")
                .get(proof.runwieldSessionId, proof.projectId),
        );
        if (!current) throw new Error("Activation is not active");
        assertActiveProofFresh(ownerDb, current, proof, now);
        if (proof.phase !== "bootstrap" && proof.phase !== "preparing") {
            throw new Error("Unchanged release is only allowed before hydration");
        }
        const result = ownerDb.handle
            .prepare(
                `UPDATE session_activation_state
                SET state = CASE WHEN latest_generation IS NULL THEN 'uninitialized' ELSE 'idle' END,
                    phase = NULL, owner_instance_id = NULL, owner_process_kind = NULL, operation_id = NULL,
                    expected_generation = NULL, expected_current_segment_id = NULL, acquired_at = NULL, heartbeat_at = NULL, heartbeat_deadline_at = NULL,
                    updated_at = ?, blocked_reason = NULL
              WHERE runwield_session_id = ? AND project_id = ? AND state = 'active'
                AND owner_instance_id = ? AND owner_process_kind = ? AND operation_id = ? AND fence = ? AND phase = ?
                AND expected_generation IS ?`,
            )
            .run(
                now,
                proof.runwieldSessionId,
                proof.projectId,
                proof.ownerInstanceId,
                proof.ownerProcessKind,
                proof.operationId,
                proof.fence,
                proof.phase,
                proof.expectedGeneration ?? null,
            );
        if (result.changes !== 1) throw new Error("Activation unchanged release proof was rejected");
        return inspectSessionActivation(ownerDb, proof.runwieldSessionId);
    });
}

export function markSessionUncertain(
    database: OwnerCoordinationDatabase,
    proof: ActivationProof | SessionIdentity,
    options: ActivationReasonOptions = {},
) {
    const ownerDb = requireDatabase(database);
    const now = isoNow(options.now);
    if ("operationId" in proof) {
        requireProof(proof);
        return ownerDb.transaction(() => {
            const current = activationFromRow(
                ownerDb.handle
                    .prepare("SELECT * FROM session_activation_state WHERE runwield_session_id = ? AND project_id = ?")
                    .get(proof.runwieldSessionId, proof.projectId),
            );
            if (!current) throw new Error("Activation is not active");
            assertActiveProofFresh(ownerDb, current, proof, now);
            const result = ownerDb.handle
                .prepare(
                    `UPDATE session_activation_state
                    SET state = 'uncertain', phase = NULL, owner_instance_id = NULL, owner_process_kind = NULL,
                        operation_id = NULL, expected_generation = NULL, expected_current_segment_id = NULL, heartbeat_deadline_at = NULL, updated_at = ?,
                        blocked_reason = ?
                  WHERE runwield_session_id = ? AND project_id = ? AND state = 'active'
                    AND owner_instance_id = ? AND owner_process_kind = ? AND operation_id = ? AND fence = ? AND phase = ?
                    AND expected_generation IS ?`,
                )
                .run(
                    now,
                    options.reason || "uncertain",
                    proof.runwieldSessionId,
                    proof.projectId,
                    proof.ownerInstanceId,
                    proof.ownerProcessKind,
                    proof.operationId,
                    proof.fence,
                    proof.phase,
                    proof.expectedGeneration ?? null,
                );
            if (result.changes !== 1) throw new Error("Uncertain proof was rejected");
            return inspectSessionActivation(ownerDb, proof.runwieldSessionId);
        });
    }
    const result = ownerDb.handle
        .prepare(
            `UPDATE session_activation_state
            SET state = 'uncertain', phase = NULL, owner_instance_id = NULL, owner_process_kind = NULL,
                operation_id = NULL, expected_generation = NULL, expected_current_segment_id = NULL, heartbeat_deadline_at = NULL, updated_at = ?,
                blocked_reason = ?
          WHERE runwield_session_id = ? AND project_id = ?`,
        )
        .run(now, options.reason || "uncertain", proof.runwieldSessionId, proof.projectId);
    if (result.changes !== 1) throw new Error("Unable to mark Session uncertain");
    return inspectSessionActivation(ownerDb, proof.runwieldSessionId);
}

export function markSessionReconcileRequired(
    database: OwnerCoordinationDatabase,
    session: SessionIdentity,
    options: ActivationReasonOptions = {},
) {
    const ownerDb = requireDatabase(database);
    const now = isoNow(options.now);
    const result = ownerDb.handle
        .prepare(
            `UPDATE session_activation_state
            SET state = 'reconcile_required', phase = NULL, owner_instance_id = NULL, owner_process_kind = NULL,
                operation_id = NULL, expected_generation = NULL, expected_current_segment_id = NULL, heartbeat_deadline_at = NULL, updated_at = ?,
                blocked_reason = ?
          WHERE runwield_session_id = ? AND project_id = ?`,
        )
        .run(now, options.reason || "reconcile_required", session.runwieldSessionId, session.projectId);
    if (result.changes !== 1) throw new Error("Unable to mark Session reconcile_required");
    return inspectSessionActivation(ownerDb, session.runwieldSessionId);
}

export function markSessionReconcileRequiredWithProof(
    database: OwnerCoordinationDatabase,
    proof: ActivationProof,
    options: ActivationReasonOptions = {},
) {
    requireProof(proof);
    const ownerDb = requireDatabase(database);
    const now = isoNow(options.now);
    return ownerDb.transaction(() => {
        const current = activationFromRow(
            ownerDb.handle
                .prepare("SELECT * FROM session_activation_state WHERE runwield_session_id = ? AND project_id = ?")
                .get(proof.runwieldSessionId, proof.projectId),
        );
        if (!current) throw new Error("Activation is not active");
        assertActiveProofFresh(ownerDb, current, proof, now);
        const result = ownerDb.handle
            .prepare(
                `UPDATE session_activation_state
                SET state = 'reconcile_required', phase = NULL, owner_instance_id = NULL, owner_process_kind = NULL,
                    operation_id = NULL, expected_generation = NULL, expected_current_segment_id = NULL, heartbeat_deadline_at = NULL, updated_at = ?,
                    blocked_reason = ?
              WHERE runwield_session_id = ? AND project_id = ? AND state = 'active'
                AND owner_instance_id = ? AND owner_process_kind = ? AND operation_id = ? AND fence = ? AND phase = ?
                AND expected_generation IS ?`,
            )
            .run(
                now,
                options.reason || "reconcile_required",
                proof.runwieldSessionId,
                proof.projectId,
                proof.ownerInstanceId,
                proof.ownerProcessKind,
                proof.operationId,
                proof.fence,
                proof.phase,
                proof.expectedGeneration ?? null,
            );
        if (result.changes !== 1) throw new Error("Reconcile proof was rejected");
        return inspectSessionActivation(ownerDb, proof.runwieldSessionId);
    });
}

export function createOrGetOperationReceipt(database: OwnerCoordinationDatabase, options: CreateReceiptOptions) {
    const ownerDb = requireDatabase(database);
    const now = isoNow(options.now);
    return ownerDb.transaction(() => {
        const existing = ownerDb.handle
            .prepare(
                "SELECT * FROM owner_session_operations WHERE device_id IS ? AND runwield_session_id = ? AND request_id = ?",
            )
            .get(options.deviceId ?? null, options.runwieldSessionId, options.requestId);
        if (existing) {
            if (existing.request_hash !== options.requestHash) {
                throw new Error("Operation request id was reused with different input");
            }
            return { ...operationFromRow(existing)!, wasCreated: false };
        }
        const id = newId(options.idFactory);
        const operationId = options.operationId || newId(options.idFactory);
        ownerDb.handle
            .prepare(
                `INSERT INTO owner_session_operations(id, device_id, request_id, request_hash, runwield_session_id,
                project_id, expected_generation, kind, status, operation_id, started_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'accepted', ?, ?, ?)`,
            )
            .run(
                id,
                options.deviceId ?? null,
                options.requestId,
                options.requestHash,
                options.runwieldSessionId,
                options.projectId,
                options.expectedGeneration ?? null,
                options.kind,
                operationId,
                now,
                now,
            );
        const created = operationFromRow(
            ownerDb.handle.prepare("SELECT * FROM owner_session_operations WHERE id = ?").get(id),
        );
        return { ...created!, wasCreated: true };
    });
}

export function findOperationReceiptByRequest(database: OwnerCoordinationDatabase, options: FindReceiptOptions) {
    const ownerDb = requireDatabase(database);
    if (!options.runwieldSessionId && !options.projectId) {
        throw new Error("Operation lookup requires a Session or Project.");
    }
    const existing = options.runwieldSessionId
        ? ownerDb.handle
              .prepare(
                  "SELECT * FROM owner_session_operations WHERE device_id IS ? AND runwield_session_id = ? AND request_id = ?",
              )
              .get(options.deviceId ?? null, options.runwieldSessionId, options.requestId)
        : ownerDb.handle
              .prepare(
                  "SELECT * FROM owner_session_operations WHERE device_id IS ? AND project_id = ? AND request_id = ?",
              )
              .get(options.deviceId ?? null, options.projectId ?? null, options.requestId);
    if (!existing) return null;
    if (existing.request_hash !== options.requestHash) {
        throw new Error("Operation request id was reused with different input");
    }
    return operationFromRow(existing);
}

export function updateOperationReceipt(
    database: OwnerCoordinationDatabase,
    operationId: string,
    updates: UpdateReceiptOptions,
) {
    const ownerDb = requireDatabase(database);
    const now = isoNow(updates.now);
    const completedAt =
        updates.status === "completed" || updates.status === "failed" || updates.status === "conflict" ? now : null;
    if (updates.resultHttpStatus !== undefined && updates.resultHttpStatus !== null) {
        const status = Number(updates.resultHttpStatus);
        if (!Number.isInteger(status) || status < 100 || status > 599) {
            throw new Error("Operation receipt result HTTP status is invalid");
        }
    }
    const resultJson = encodeOperationResult(updates.resultBody);
    const result = ownerDb.handle
        .prepare(
            `UPDATE owner_session_operations
            SET status = ?, updated_at = ?, completed_at = COALESCE(?, completed_at), result_generation = ?,
                result_http_status = ?, result_json = COALESCE(?, result_json), error_code = ?, error_message = ?
          WHERE operation_id = ?`,
        )
        .run(
            updates.status,
            now,
            completedAt,
            updates.resultGeneration ?? null,
            updates.resultHttpStatus ?? null,
            resultJson,
            updates.errorCode ?? null,
            updates.errorMessage ?? null,
            operationId,
        );
    if (result.changes !== 1) throw new Error("Operation receipt not found");
    return getOperationReceipt(database, operationId);
}

export function getOperationReceipt(database: OwnerCoordinationDatabase, operationId: string) {
    const ownerDb = requireDatabase(database);
    return operationFromRow(
        ownerDb.handle.prepare("SELECT * FROM owner_session_operations WHERE operation_id = ?").get(operationId),
    );
}

function operationFromRow(row: SqlRow | undefined) {
    if (!row) return null;
    const stored = row as OperationRow;
    return {
        id: stored.id,
        deviceId: stored.device_id,
        requestId: stored.request_id,
        requestHash: stored.request_hash,
        runwieldSessionId: stored.runwield_session_id,
        projectId: stored.project_id,
        expectedGeneration:
            stored.expected_generation === null || stored.expected_generation === undefined
                ? null
                : Number(stored.expected_generation),
        kind: stored.kind,
        status: stored.status,
        operationId: stored.operation_id,
        startedAt: stored.started_at,
        updatedAt: stored.updated_at,
        completedAt: stored.completed_at,
        resultGeneration:
            stored.result_generation === null || stored.result_generation === undefined
                ? null
                : Number(stored.result_generation),
        resultHttpStatus:
            stored.result_http_status === null || stored.result_http_status === undefined
                ? null
                : Number(stored.result_http_status),
        resultBody: decodeOperationResult(stored.result_json),
        errorCode: stored.error_code,
        errorMessage: stored.error_message,
    };
}
