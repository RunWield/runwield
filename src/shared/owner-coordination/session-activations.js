/*
 * @module shared/owner-coordination/session-activations
 * Fenced Session Activation Lease and committed generation APIs.
 */

/** @typedef {'uninitialized' | 'idle' | 'active' | 'uncertain' | 'reconcile_required'} SessionActivationState */
/** @typedef {'bootstrap' | 'preparing' | 'hydrated' | 'turning' | 'checkpointing'} SessionActivationPhase */

/**
 * @typedef {Object} ActivationProof
 * @property {string} runwieldSessionId
 * @property {string} projectId
 * @property {string} ownerInstanceId
 * @property {'workspace' | 'tui' | 'acp' | 'test'} ownerProcessKind
 * @property {string} operationId
 * @property {number} fence
 * @property {SessionActivationPhase} phase
 * @property {number | null} expectedGeneration
 * @property {string | null} [expectedCurrentSegmentId]
 */

/**
 * @typedef {Object} GenerationEvidence
 * @property {number} generation
 * @property {number} byteLength
 * @property {string | null} terminalEntryId
 * @property {string} digestHex
 * @property {string} [digestAlgorithm]
 * @property {number} [evidenceVersion]
 * @property {string | null} [currentSegmentId]
 */

import { insertSessionTranscriptSegmentRow, sealSessionTranscriptSegmentRow } from "./sessions.js";

/** @param {unknown} value */
function requireDatabase(value) {
    if (!value || typeof value !== "object" || !("handle" in value)) throw new Error("Owner database is required");
    return /** @type {import('./database.ts').OwnerCoordinationDatabase} */ (value);
}

/** @param {() => string} [now] */
function isoNow(now) {
    return now ? now() : new Date().toISOString();
}

/** @param {() => string} [idFactory] */
function newId(idFactory) {
    return idFactory ? idFactory() : crypto.randomUUID();
}

const MAX_OPERATION_RESULT_JSON_BYTES = 32 * 1024;

/** @param {unknown} result */
function encodeOperationResult(result) {
    if (result === undefined) return null;
    const text = JSON.stringify(result);
    if (new TextEncoder().encode(text).byteLength > MAX_OPERATION_RESULT_JSON_BYTES) {
        throw new Error("Operation receipt result is too large");
    }
    return text;
}

/** @param {unknown} value */
function decodeOperationResult(value) {
    if (typeof value !== "string") return null;
    if (!value) return null;
    try {
        return JSON.parse(value);
    } catch {
        return null;
    }
}

/** @param {any} row */
function activationFromRow(row) {
    if (!row) return null;
    return {
        runwieldSessionId: row.runwield_session_id,
        projectId: row.project_id,
        state: row.state,
        phase: row.phase,
        latestGeneration: row.latest_generation === null || row.latest_generation === undefined
            ? null
            : Number(row.latest_generation),
        fence: Number(row.fence),
        ownerInstanceId: row.owner_instance_id,
        ownerProcessKind: row.owner_process_kind,
        operationId: row.operation_id,
        expectedGeneration: row.expected_generation === null || row.expected_generation === undefined
            ? null
            : Number(row.expected_generation),
        currentSegmentId: row.current_segment_id,
        expectedCurrentSegmentId: row.expected_current_segment_id,
        acquiredAt: row.acquired_at,
        heartbeatAt: row.heartbeat_at,
        heartbeatDeadlineAt: row.heartbeat_deadline_at,
        updatedAt: row.updated_at,
        blockedReason: row.blocked_reason,
    };
}

/** @param {any} row */
function generationFromRow(row) {
    if (!row) return null;
    return {
        runwieldSessionId: row.runwield_session_id,
        projectId: row.project_id,
        generation: Number(row.generation),
        evidenceVersion: Number(row.evidence_version),
        digestAlgorithm: row.digest_algorithm,
        byteLength: Number(row.byte_length),
        terminalEntryId: row.terminal_entry_id,
        digestHex: row.digest_hex,
        operationId: row.operation_id,
        fence: Number(row.fence),
        currentSegmentId: row.current_segment_id,
        committedAt: row.committed_at,
    };
}

/**
 * @param {import('./database.ts').OwnerCoordinationDatabase} database
 * @param {string} runwieldSessionId
 */
export function inspectSessionActivation(database, runwieldSessionId) {
    const db = requireDatabase(database).handle;
    const activation = activationFromRow(
        db.prepare("SELECT * FROM session_activation_state WHERE runwield_session_id = ?").get(runwieldSessionId),
    );
    const generation = generationFromRow(
        db.prepare(
            "SELECT * FROM session_committed_generations WHERE runwield_session_id = ? ORDER BY generation DESC LIMIT 1",
        ).get(runwieldSessionId),
    );
    return { activation, generation };
}

/**
 * @param {ActivationProof} proof
 */
function requireProof(proof) {
    const value = /** @type {Record<string, unknown>} */ (proof || {});
    for (const field of ["runwieldSessionId", "projectId", "ownerInstanceId", "ownerProcessKind", "operationId"]) {
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

/** @param {NonNullable<ReturnType<typeof activationFromRow>>} current @param {ActivationProof} proof */
function proofMatches(current, proof) {
    return current.ownerInstanceId === proof.ownerInstanceId &&
        current.ownerProcessKind === proof.ownerProcessKind &&
        current.operationId === proof.operationId &&
        current.fence === proof.fence &&
        current.phase === proof.phase &&
        current.expectedGeneration === proof.expectedGeneration &&
        current.expectedCurrentSegmentId === (proof.expectedCurrentSegmentId ?? null);
}

/**
 * @param {import('./database.ts').OwnerCoordinationDatabase} ownerDb
 * @param {NonNullable<ReturnType<typeof activationFromRow>>} current
 * @param {ActivationProof} proof
 * @param {string} now
 */
function assertActiveProofFresh(ownerDb, current, proof, now) {
    if (current.state !== "active") throw new Error("Activation is not active");
    if (!proofMatches(current, proof)) throw new Error("Activation proof was rejected");
    if (current.heartbeatDeadlineAt && current.heartbeatDeadlineAt <= now) {
        ownerDb.handle.prepare(
            `UPDATE session_activation_state
                SET state = 'uncertain', phase = NULL, owner_instance_id = NULL, owner_process_kind = NULL,
                    operation_id = NULL, expected_generation = NULL, expected_current_segment_id = NULL, heartbeat_deadline_at = NULL,
                    updated_at = ?, blocked_reason = 'heartbeat_expired'
              WHERE runwield_session_id = ? AND project_id = ? AND state = 'active'
                AND owner_instance_id = ? AND owner_process_kind = ? AND operation_id = ? AND fence = ? AND phase = ?
                AND expected_generation IS ?`,
        ).run(
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

/**
 * @param {import('./database.ts').OwnerCoordinationDatabase} database
 * @param {ActivationProof} proof
 * @param {{ now?: () => string }} [options]
 */
export function heartbeatSessionActivation(database, proof, options = {}) {
    requireProof(proof);
    const ownerDb = requireDatabase(database);
    const now = isoNow(options.now);
    const transactionResult = ownerDb.transaction(() => {
        const current = activationFromRow(
            ownerDb.handle.prepare(
                "SELECT * FROM session_activation_state WHERE runwield_session_id = ? AND project_id = ?",
            ).get(proof.runwieldSessionId, proof.projectId),
        );
        if (!current || current.state !== "active") throw new Error("Activation is not active");
        if (!proofMatches(current, proof)) throw new Error("Activation proof was rejected");
        if (current.heartbeatDeadlineAt && current.heartbeatDeadlineAt <= now) {
            ownerDb.handle.prepare(
                `UPDATE session_activation_state
                    SET state = 'uncertain', phase = NULL, owner_instance_id = NULL, owner_process_kind = NULL,
                        operation_id = NULL, expected_generation = NULL, expected_current_segment_id = NULL, heartbeat_deadline_at = NULL,
                        updated_at = ?, blocked_reason = 'heartbeat_expired'
                  WHERE runwield_session_id = ? AND project_id = ? AND state = 'active'
                    AND owner_instance_id = ? AND owner_process_kind = ? AND operation_id = ? AND fence = ? AND phase = ?
                    AND expected_generation IS ?`,
            ).run(
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
        const result = ownerDb.handle.prepare(
            `UPDATE session_activation_state
                SET heartbeat_at = ?, heartbeat_deadline_at = ?, updated_at = ?
              WHERE runwield_session_id = ? AND project_id = ? AND state = 'active'
                AND owner_instance_id = ? AND owner_process_kind = ? AND operation_id = ? AND fence = ? AND phase = ?
                AND expected_generation IS ?`,
        ).run(
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
                ownerDb.handle.prepare(
                    "SELECT * FROM session_activation_state WHERE runwield_session_id = ?",
                ).get(proof.runwieldSessionId),
            ),
        };
    });
    if (transactionResult.expired) throw new Error("Activation heartbeat expired");
    return /** @type {NonNullable<ReturnType<typeof activationFromRow>>} */ (transactionResult.activation);
}

/** @param {string} iso */
function deadlineFrom(iso) {
    return new Date(Date.parse(iso) + 30_000).toISOString();
}

/** @param {string | null | undefined} timestamp @param {string} now */
function isDeadlineExpired(timestamp, now) {
    if (!timestamp) return false;
    return Date.parse(timestamp) <= Date.parse(now);
}

/**
 * @param {import('./database.ts').OwnerCoordinationDatabase} database
 * @param {{ runwieldSessionId: string, projectId: string, ownerInstanceId: string, ownerProcessKind: 'workspace' | 'tui' | 'acp' | 'test', operationId?: string, expectedGeneration?: number | null, expectedCurrentSegmentId?: string | null, phase?: SessionActivationPhase, idFactory?: () => string, now?: () => string }} options
 * @returns {ActivationProof}
 */
export function acquireSessionActivation(database, options) {
    const ownerDb = requireDatabase(database);
    const now = isoNow(options.now);
    const operationId = options.operationId || newId(options.idFactory);
    const phase = options.phase || "preparing";
    return ownerDb.transaction(() => {
        const current = activationFromRow(
            ownerDb.handle.prepare(
                "SELECT * FROM session_activation_state WHERE runwield_session_id = ? AND project_id = ?",
            ).get(options.runwieldSessionId, options.projectId),
        );
        if (!current) throw new Error(`Activation state not found: ${options.runwieldSessionId}`);
        const expectedGeneration = options.expectedGeneration ?? current.latestGeneration;
        const expectedCurrentSegmentId = options.expectedCurrentSegmentId === undefined
            ? current.currentSegmentId ?? null
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
        const result = ownerDb.handle.prepare(
            `UPDATE session_activation_state
                SET state = 'active', phase = ?, fence = ?, owner_instance_id = ?, owner_process_kind = ?,
                    operation_id = ?, expected_generation = ?, expected_current_segment_id = ?, acquired_at = ?, heartbeat_at = ?,
                    heartbeat_deadline_at = ?, updated_at = ?, blocked_reason = NULL
              WHERE runwield_session_id = ? AND project_id = ? AND state = ? AND fence = ?`,
        ).run(
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

/**
 * @param {import('./database.ts').OwnerCoordinationDatabase} database
 * @param {ActivationProof} proof
 * @param {SessionActivationPhase} nextPhase
 * @param {{ now?: () => string }} [options]
 */
export function changeSessionActivationPhase(database, proof, nextPhase, options = {}) {
    requireProof(proof);
    const ownerDb = requireDatabase(database);
    const now = isoNow(options.now);
    return ownerDb.transaction(() => {
        const current = activationFromRow(
            ownerDb.handle.prepare(
                "SELECT * FROM session_activation_state WHERE runwield_session_id = ? AND project_id = ?",
            ).get(proof.runwieldSessionId, proof.projectId),
        );
        if (!current) throw new Error("Activation is not active");
        assertActiveProofFresh(ownerDb, current, proof, now);
        if (!LEGAL_PHASE_TRANSITIONS.get(proof.phase)?.has(nextPhase)) {
            throw new Error(`Illegal activation phase transition: ${proof.phase} -> ${nextPhase}`);
        }
        const result = ownerDb.handle.prepare(
            `UPDATE session_activation_state SET phase = ?, updated_at = ?, heartbeat_at = ?, heartbeat_deadline_at = ?
              WHERE runwield_session_id = ? AND project_id = ? AND state = 'active'
                AND owner_instance_id = ? AND owner_process_kind = ? AND operation_id = ? AND fence = ? AND phase = ?
                AND expected_generation IS ?`,
        ).run(
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

/**
 * @param {import('./database.ts').OwnerCoordinationDatabase} ownerDb
 * @param {ActivationProof} proof
 */
function loadActiveActivation(ownerDb, proof) {
    const current = activationFromRow(
        ownerDb.handle.prepare(
            "SELECT * FROM session_activation_state WHERE runwield_session_id = ? AND project_id = ?",
        ).get(proof.runwieldSessionId, proof.projectId),
    );
    if (!current) throw new Error("Activation is not active");
    return current;
}

/**
 * @param {import('./database.ts').OwnerCoordinationDatabase} ownerDb
 * @param {NonNullable<ReturnType<typeof activationFromRow>>} current
 * @param {ActivationProof} proof
 * @param {string} now
 */
function assertPublicationPhase(ownerDb, current, proof, now) {
    assertActiveProofFresh(ownerDb, current, proof, now);
    if (proof.phase !== "checkpointing") throw new Error("Generation publication requires checkpointing phase");
}

/**
 * @param {NonNullable<ReturnType<typeof activationFromRow>>} current
 * @param {GenerationEvidence} evidence
 */
function assertGenerationAdvances(current, evidence) {
    const previous = current.latestGeneration;
    const expectedNext = previous === null ? 0 : previous + 1;
    if (evidence.generation !== expectedNext) throw new Error(`Generation must advance to ${expectedNext}`);
}

/**
 * @param {import('./database.ts').OwnerCoordinationDatabase} ownerDb
 * @param {ActivationProof} proof
 * @param {GenerationEvidence} evidence
 * @param {string | null} currentSegmentId
 * @param {string} now
 */
function insertCommittedGenerationRow(ownerDb, proof, evidence, currentSegmentId, now) {
    ownerDb.handle.prepare(
        `INSERT INTO session_committed_generations(runwield_session_id, project_id, generation, evidence_version,
            digest_algorithm, byte_length, terminal_entry_id, digest_hex, operation_id, fence, committed_at, current_segment_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
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

/**
 * @param {import('./database.ts').OwnerCoordinationDatabase} ownerDb
 * @param {ActivationProof} proof
 * @param {number} generation
 * @param {string} now
 */
function releaseActivationAfterGeneration(ownerDb, proof, generation, now) {
    const result = ownerDb.handle.prepare(
        `UPDATE session_activation_state
            SET state = 'idle', phase = NULL, latest_generation = ?, owner_instance_id = NULL,
                owner_process_kind = NULL, operation_id = NULL, expected_generation = NULL, expected_current_segment_id = NULL, acquired_at = NULL,
                heartbeat_at = NULL, heartbeat_deadline_at = NULL, updated_at = ?, blocked_reason = NULL
          WHERE runwield_session_id = ? AND project_id = ? AND state = 'active'
            AND owner_instance_id = ? AND owner_process_kind = ? AND operation_id = ? AND fence = ? AND phase = ?
            AND expected_generation IS ?`,
    ).run(
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

/**
 * @param {import('./database.ts').OwnerCoordinationDatabase} database
 * @param {ActivationProof} proof
 * @param {GenerationEvidence} evidence
 * @param {{ now?: () => string }} [options]
 */
export function publishGenerationAndRelease(database, proof, evidence, options = {}) {
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

/**
 * @param {import('./database.ts').OwnerCoordinationDatabase} database
 * @param {{ runwieldSessionId: string, projectId: string, expectedFence: number, expectedGeneration: number | null, expectedCurrentSegmentId?: string | null, ownerInstanceId: string, ownerProcessKind: 'workspace' | 'tui' | 'acp' | 'test', operationId?: string, transcriptEvidence: GenerationEvidence, now?: () => string, idFactory?: () => string }} options
 */
export function recoverExpiredSessionControl(database, options) {
    const ownerDb = requireDatabase(database);
    const now = isoNow(options.now);
    return ownerDb.transaction(() => {
        const current = activationFromRow(
            ownerDb.handle.prepare(
                "SELECT * FROM session_activation_state WHERE runwield_session_id = ? AND project_id = ?",
            ).get(options.runwieldSessionId, options.projectId),
        );
        if (!current) throw new Error("Activation state not found");
        if (current.fence !== options.expectedFence) throw new Error("Session control recovery fence was stale");
        if (current.latestGeneration !== options.expectedGeneration) {
            throw new Error("Session control recovery generation was stale");
        }
        const expectedCurrentSegmentId = options.expectedCurrentSegmentId === undefined
            ? current.currentSegmentId ?? null
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
        const adoptsTranscriptAhead = evidence.generation === transcriptAheadGeneration &&
            evidence.generation !== latestGeneration;
        const acceptsExact = evidence.generation === latestGeneration ||
            (latestGeneration === null && evidence.generation === exactGeneration);
        if (!acceptsExact && !adoptsTranscriptAhead) {
            throw new Error("Session control recovery transcript generation is not the next valid generation");
        }
        const nextFence = current.fence + 1;
        /** @type {ActivationProof} */
        const proof = {
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
        const result = ownerDb.handle.prepare(
            `UPDATE session_activation_state
                SET state = 'idle', phase = NULL, latest_generation = ?, fence = ?, owner_instance_id = NULL,
                    owner_process_kind = NULL, operation_id = NULL, expected_generation = NULL,
                    expected_current_segment_id = NULL, acquired_at = NULL, heartbeat_at = NULL,
                    heartbeat_deadline_at = NULL, updated_at = ?, blocked_reason = NULL
              WHERE runwield_session_id = ? AND project_id = ? AND fence = ? AND state IN ('active', 'uncertain')`,
        ).run(
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

/**
 * @param {import('./database.ts').OwnerCoordinationDatabase} database
 * @param {ActivationProof} proof
 * @param {{ predecessorSegmentId: string, predecessorEvidence: { byteLength: number, digestHex: string, terminalEntryId: string | null }, successor: Parameters<typeof insertSessionTranscriptSegmentRow>[1], successorSafeLocator: Parameters<typeof insertSessionTranscriptSegmentRow>[2], generationEvidence: GenerationEvidence, now?: () => string }} options
 */
export function commitSegmentRolloverAndPublish(database, proof, options) {
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
        const pointerUpdate = ownerDb.handle.prepare(
            `UPDATE session_activation_state
                SET current_segment_id = ?, expected_current_segment_id = ?, updated_at = ?
              WHERE runwield_session_id = ? AND project_id = ? AND state = 'active'
                AND owner_instance_id = ? AND owner_process_kind = ? AND operation_id = ? AND fence = ? AND phase = ?
                AND expected_generation IS ? AND expected_current_segment_id IS ?`,
        ).run(
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

/**
 * @param {import('./database.ts').OwnerCoordinationDatabase} database
 * @param {ActivationProof} proof
 * @param {{ now?: () => string }} [options]
 */
export function releaseUnchangedActivation(database, proof, options = {}) {
    requireProof(proof);
    const ownerDb = requireDatabase(database);
    const now = isoNow(options.now);
    return ownerDb.transaction(() => {
        const current = activationFromRow(
            ownerDb.handle.prepare(
                "SELECT * FROM session_activation_state WHERE runwield_session_id = ? AND project_id = ?",
            ).get(proof.runwieldSessionId, proof.projectId),
        );
        if (!current) throw new Error("Activation is not active");
        assertActiveProofFresh(ownerDb, current, proof, now);
        if (proof.phase !== "bootstrap" && proof.phase !== "preparing") {
            throw new Error("Unchanged release is only allowed before hydration");
        }
        const result = ownerDb.handle.prepare(
            `UPDATE session_activation_state
                SET state = CASE WHEN latest_generation IS NULL THEN 'uninitialized' ELSE 'idle' END,
                    phase = NULL, owner_instance_id = NULL, owner_process_kind = NULL, operation_id = NULL,
                    expected_generation = NULL, expected_current_segment_id = NULL, acquired_at = NULL, heartbeat_at = NULL, heartbeat_deadline_at = NULL,
                    updated_at = ?, blocked_reason = NULL
              WHERE runwield_session_id = ? AND project_id = ? AND state = 'active'
                AND owner_instance_id = ? AND owner_process_kind = ? AND operation_id = ? AND fence = ? AND phase = ?
                AND expected_generation IS ?`,
        ).run(
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

/**
 * @param {import('./database.ts').OwnerCoordinationDatabase} database
 * @param {ActivationProof | { runwieldSessionId: string, projectId: string }} proof
 * @param {{ reason?: string, now?: () => string }} [options]
 */
export function markSessionUncertain(database, proof, options = {}) {
    const ownerDb = requireDatabase(database);
    const now = isoNow(options.now);
    if ("operationId" in proof) {
        requireProof(proof);
        return ownerDb.transaction(() => {
            const current = activationFromRow(
                ownerDb.handle.prepare(
                    "SELECT * FROM session_activation_state WHERE runwield_session_id = ? AND project_id = ?",
                ).get(proof.runwieldSessionId, proof.projectId),
            );
            if (!current) throw new Error("Activation is not active");
            assertActiveProofFresh(ownerDb, current, proof, now);
            const result = ownerDb.handle.prepare(
                `UPDATE session_activation_state
                    SET state = 'uncertain', phase = NULL, owner_instance_id = NULL, owner_process_kind = NULL,
                        operation_id = NULL, expected_generation = NULL, expected_current_segment_id = NULL, heartbeat_deadline_at = NULL, updated_at = ?,
                        blocked_reason = ?
                  WHERE runwield_session_id = ? AND project_id = ? AND state = 'active'
                    AND owner_instance_id = ? AND owner_process_kind = ? AND operation_id = ? AND fence = ? AND phase = ?
                    AND expected_generation IS ?`,
            ).run(
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
    const result = ownerDb.handle.prepare(
        `UPDATE session_activation_state
            SET state = 'uncertain', phase = NULL, owner_instance_id = NULL, owner_process_kind = NULL,
                operation_id = NULL, expected_generation = NULL, expected_current_segment_id = NULL, heartbeat_deadline_at = NULL, updated_at = ?,
                blocked_reason = ?
          WHERE runwield_session_id = ? AND project_id = ?`,
    ).run(now, options.reason || "uncertain", proof.runwieldSessionId, proof.projectId);
    if (result.changes !== 1) throw new Error("Unable to mark Session uncertain");
    return inspectSessionActivation(ownerDb, proof.runwieldSessionId);
}

/**
 * @param {import('./database.ts').OwnerCoordinationDatabase} database
 * @param {{ runwieldSessionId: string, projectId: string }} session
 * @param {{ reason?: string, now?: () => string }} [options]
 */
export function markSessionReconcileRequired(database, session, options = {}) {
    const ownerDb = requireDatabase(database);
    const now = isoNow(options.now);
    const result = ownerDb.handle.prepare(
        `UPDATE session_activation_state
            SET state = 'reconcile_required', phase = NULL, owner_instance_id = NULL, owner_process_kind = NULL,
                operation_id = NULL, expected_generation = NULL, expected_current_segment_id = NULL, heartbeat_deadline_at = NULL, updated_at = ?,
                blocked_reason = ?
          WHERE runwield_session_id = ? AND project_id = ?`,
    ).run(now, options.reason || "reconcile_required", session.runwieldSessionId, session.projectId);
    if (result.changes !== 1) throw new Error("Unable to mark Session reconcile_required");
    return inspectSessionActivation(ownerDb, session.runwieldSessionId);
}

/**
 * @param {import('./database.ts').OwnerCoordinationDatabase} database
 * @param {ActivationProof} proof
 * @param {{ reason?: string, now?: () => string }} [options]
 */
export function markSessionReconcileRequiredWithProof(database, proof, options = {}) {
    requireProof(proof);
    const ownerDb = requireDatabase(database);
    const now = isoNow(options.now);
    return ownerDb.transaction(() => {
        const current = activationFromRow(
            ownerDb.handle.prepare(
                "SELECT * FROM session_activation_state WHERE runwield_session_id = ? AND project_id = ?",
            ).get(proof.runwieldSessionId, proof.projectId),
        );
        if (!current) throw new Error("Activation is not active");
        assertActiveProofFresh(ownerDb, current, proof, now);
        const result = ownerDb.handle.prepare(
            `UPDATE session_activation_state
                SET state = 'reconcile_required', phase = NULL, owner_instance_id = NULL, owner_process_kind = NULL,
                    operation_id = NULL, expected_generation = NULL, expected_current_segment_id = NULL, heartbeat_deadline_at = NULL, updated_at = ?,
                    blocked_reason = ?
              WHERE runwield_session_id = ? AND project_id = ? AND state = 'active'
                AND owner_instance_id = ? AND owner_process_kind = ? AND operation_id = ? AND fence = ? AND phase = ?
                AND expected_generation IS ?`,
        ).run(
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

/**
 * @param {import('./database.ts').OwnerCoordinationDatabase} database
 * @param {{ deviceId?: string | null, requestId: string, requestHash: string, runwieldSessionId: string, projectId: string, expectedGeneration?: number | null, kind: 'bootstrap' | 'continuation' | 'plan_action', operationId?: string, idFactory?: () => string, now?: () => string }} options
 */
export function createOrGetOperationReceipt(database, options) {
    const ownerDb = requireDatabase(database);
    const now = isoNow(options.now);
    return ownerDb.transaction(() => {
        const existing = ownerDb.handle.prepare(
            "SELECT * FROM owner_session_operations WHERE device_id IS ? AND runwield_session_id = ? AND request_id = ?",
        ).get(options.deviceId ?? null, options.runwieldSessionId, options.requestId);
        if (existing) {
            if (existing.request_hash !== options.requestHash) {
                throw new Error("Operation request id was reused with different input");
            }
            return { ...operationFromRow(existing), wasCreated: false };
        }
        const id = newId(options.idFactory);
        const operationId = options.operationId || newId(options.idFactory);
        ownerDb.handle.prepare(
            `INSERT INTO owner_session_operations(id, device_id, request_id, request_hash, runwield_session_id,
                project_id, expected_generation, kind, status, operation_id, started_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'accepted', ?, ?, ?)`,
        ).run(
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
        return { ...created, wasCreated: true };
    });
}

/**
 * @param {import('./database.ts').OwnerCoordinationDatabase} database
 * @param {{ deviceId?: string | null, requestId: string, requestHash: string, runwieldSessionId?: string, projectId?: string }} options
 */
export function findOperationReceiptByRequest(database, options) {
    const ownerDb = requireDatabase(database);
    if (!options.runwieldSessionId && !options.projectId) {
        throw new Error("Operation lookup requires a Session or Project.");
    }
    const existing = options.runwieldSessionId
        ? ownerDb.handle.prepare(
            "SELECT * FROM owner_session_operations WHERE device_id IS ? AND runwield_session_id = ? AND request_id = ?",
        ).get(options.deviceId ?? null, options.runwieldSessionId, options.requestId)
        : ownerDb.handle.prepare(
            "SELECT * FROM owner_session_operations WHERE device_id IS ? AND project_id = ? AND request_id = ?",
        ).get(options.deviceId ?? null, options.projectId ?? null, options.requestId);
    if (!existing) return null;
    if (existing.request_hash !== options.requestHash) {
        throw new Error("Operation request id was reused with different input");
    }
    return operationFromRow(existing);
}

/**
 * @param {import('./database.ts').OwnerCoordinationDatabase} database
 * @param {string} operationId
 * @param {{ status: 'accepted' | 'running' | 'completed' | 'failed' | 'conflict', resultGeneration?: number | null, resultHttpStatus?: number | null, resultBody?: unknown, errorCode?: string | null, errorMessage?: string | null, now?: () => string }} updates
 */
export function updateOperationReceipt(database, operationId, updates) {
    const ownerDb = requireDatabase(database);
    const now = isoNow(updates.now);
    const completedAt = updates.status === "completed" || updates.status === "failed" || updates.status === "conflict"
        ? now
        : null;
    if (updates.resultHttpStatus !== undefined && updates.resultHttpStatus !== null) {
        const status = Number(updates.resultHttpStatus);
        if (!Number.isInteger(status) || status < 100 || status > 599) {
            throw new Error("Operation receipt result HTTP status is invalid");
        }
    }
    const resultJson = encodeOperationResult(updates.resultBody);
    const result = ownerDb.handle.prepare(
        `UPDATE owner_session_operations
            SET status = ?, updated_at = ?, completed_at = COALESCE(?, completed_at), result_generation = ?,
                result_http_status = ?, result_json = COALESCE(?, result_json), error_code = ?, error_message = ?
          WHERE operation_id = ?`,
    ).run(
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

/**
 * @param {import('./database.ts').OwnerCoordinationDatabase} database
 * @param {string} operationId
 */
export function getOperationReceipt(database, operationId) {
    const ownerDb = requireDatabase(database);
    return operationFromRow(
        ownerDb.handle.prepare("SELECT * FROM owner_session_operations WHERE operation_id = ?").get(operationId),
    );
}

/** @param {any} row */
function operationFromRow(row) {
    if (!row) return null;
    return {
        id: row.id,
        deviceId: row.device_id,
        requestId: row.request_id,
        requestHash: row.request_hash,
        runwieldSessionId: row.runwield_session_id,
        projectId: row.project_id,
        expectedGeneration: row.expected_generation === null || row.expected_generation === undefined
            ? null
            : Number(row.expected_generation),
        kind: row.kind,
        status: row.status,
        operationId: row.operation_id,
        startedAt: row.started_at,
        updatedAt: row.updated_at,
        completedAt: row.completed_at,
        resultGeneration: row.result_generation === null || row.result_generation === undefined
            ? null
            : Number(row.result_generation),
        resultHttpStatus: row.result_http_status === null || row.result_http_status === undefined
            ? null
            : Number(row.result_http_status),
        resultBody: decodeOperationResult(row.result_json),
        errorCode: row.error_code,
        errorMessage: row.error_message,
    };
}
