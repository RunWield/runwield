import { readFileSync, realpathSync, statSync } from "node:fs";
import { opendir } from "node:fs/promises";
import { readFile as fsReadFile, rm as fsRm, stat as fsStat } from "node:fs/promises";
/**
 * @module shared/owner-coordination/sessions
 * Stable RunWield Session catalog APIs for owner coordination.
 */

import { isAbsolute, join, resolve } from "@std/path";
import { createHash } from "node:crypto";
import {
    getRunWieldSessionDir,
    isPathInside,
    listCatalogSafeRootSessionLocators,
    readCatalogSafeRootSessionLocator,
} from "../session/root-session.js";
import {
    normalizeSegmentLineageEvidence,
    PENDING_SEGMENT_CONTINUATION_CUSTOM_TYPE,
    SEGMENT_LINEAGE_CUSTOM_TYPE,
} from "../session/workflow-context-session.js";
import { getProjectById, listProjectRootEvidence } from "./projects.js";

/**
 * @typedef {Object} CatalogedSession
 * @property {string} runwieldSessionId
 * @property {string} projectId
 * @property {string | null} displayName
 * @property {string} source
 * @property {string} piSessionId
 * @property {string} transcriptPath
 * @property {string} transcriptCwd
 * @property {number | null} headerVersion
 * @property {string | null} headerTimestamp
 * @property {string} firstCatalogedAt
 * @property {string} lastCatalogedAt
 */

/**
 * @typedef {Object} CatalogDiagnostic
 * @property {string} sessionPath
 * @property {string} code
 * @property {string} message
 */

/**
 * @typedef {Object} ProjectRootEvidence
 * @property {string} enteredRoot
 * @property {string} canonicalRoot
 * @property {string} rootState
 */

/** @param {unknown} value */
function requireDatabase(value) {
    if (!value || typeof value !== "object" || !("handle" in value)) throw new Error("Owner database is required");
    return /** @type {import('./database.js').OwnerCoordinationDatabase} */ (value);
}

/** @param {() => string} [now] */
function isoNow(now) {
    return now ? now() : new Date().toISOString();
}

/** @param {() => string} [idFactory] */
function newId(idFactory) {
    return idFactory ? idFactory() : crypto.randomUUID();
}

/** @param {any} row */
function sessionFromRow(row) {
    return {
        runwieldSessionId: row.runwield_session_id,
        projectId: row.project_id,
        displayName: row.display_name,
        source: row.source,
        piSessionId: row.pi_session_id,
        transcriptPath: row.transcript_path,
        transcriptCwd: row.transcript_cwd,
        headerVersion: row.header_version,
        headerTimestamp: row.header_timestamp,
        firstCatalogedAt: row.first_cataloged_at,
        lastCatalogedAt: row.last_cataloged_at,
    };
}

/** @param {Record<string, string | number | bigint | Uint8Array | null>} row @returns {import('../types.js').SessionTranscriptSegment} */
function segmentFromRow(row) {
    return {
        segmentId: String(row.id),
        runwieldSessionId: String(row.runwield_session_id),
        projectId: String(row.project_id),
        piSessionId: String(row.pi_session_id),
        transcriptPath: String(row.transcript_path),
        transcriptCwd: String(row.transcript_cwd),
        ordinal: Number(row.ordinal),
        kind: String(row.kind),
        sealedAt: row.sealed_at === null ? null : String(row.sealed_at),
        headerVersion: row.header_version === null ? null : Number(row.header_version),
        headerTimestamp: row.header_timestamp === null ? null : String(row.header_timestamp),
        firstCatalogedAt: String(row.first_cataloged_at),
        lastCatalogedAt: String(row.last_cataloged_at),
        lineageParentSegmentId: row.lineage_parent_segment_id === null ? null : String(row.lineage_parent_segment_id),
        lineageParentPiSessionId: row.lineage_parent_pi_session_id === null
            ? null
            : String(row.lineage_parent_pi_session_id),
        lineageGroupKey: row.lineage_group_key === null ? null : String(row.lineage_group_key),
        lineageRecordedAt: row.lineage_recorded_at === null ? null : String(row.lineage_recorded_at),
        sealedByteLength: row.sealed_byte_length === null || row.sealed_byte_length === undefined
            ? null
            : Number(row.sealed_byte_length),
        sealedDigestHex: row.sealed_digest_hex === null || row.sealed_digest_hex === undefined
            ? null
            : String(row.sealed_digest_hex),
        sealedTerminalEntryId: row.sealed_terminal_entry_id === null || row.sealed_terminal_entry_id === undefined
            ? null
            : String(row.sealed_terminal_entry_id),
    };
}

/** @param {Uint8Array} bytes */
function sha256HexSync(bytes) {
    return createHash("sha256").update(bytes).digest("hex");
}

/** @param {unknown[]} entries */
function terminalEntryId(entries) {
    const last = entries.at(-1);
    return last && typeof last === "object" && typeof /** @type {any} */ (last).id === "string"
        ? /** @type {any} */ (last).id
        : null;
}

/** @param {string} transcriptPath @param {number} byteLength */
function captureTranscriptEvidenceSync(transcriptPath, byteLength) {
    const stat = statSync(transcriptPath);
    if (stat.size < byteLength) throw new Error("Sealed segment transcript is shorter than supplied evidence");
    const fullBytes = readFileSync(transcriptPath);
    const bytes = fullBytes.subarray(0, byteLength);
    if (bytes.byteLength !== byteLength) throw new Error("Unable to read sealed segment transcript evidence");
    const text = new TextDecoder().decode(bytes);
    if (text.length > 0 && !text.endsWith("\n")) {
        throw new Error("Sealed segment transcript evidence must end at a JSONL boundary");
    }
    const entries = text.split("\n").filter(Boolean).map((line) => JSON.parse(line));
    return {
        byteLength,
        terminalEntryId: terminalEntryId(entries),
        digestHex: sha256HexSync(bytes),
    };
}

/** @param {Date | null} value */
function mtimeMs(value) {
    return value ? Math.trunc(value.getTime()) : null;
}

/**
 * @param {import('./database.js').OwnerCoordinationDatabase} database
 * @param {string} projectId
 * @returns {Set<string>}
 */
function listKnownTranscriptPaths(database, projectId) {
    const rows = database.handle.prepare(
        `SELECT transcript_path FROM session_transcript_locators WHERE project_id = ?
         UNION
         SELECT transcript_path FROM session_transcript_segments WHERE project_id = ?`,
    ).all(projectId, projectId);
    return new Set(rows.map((row) => resolve(String(row.transcript_path))));
}

/**
 * @param {import('./database.js').OwnerCoordinationDatabase} database
 * @param {string} projectId
 * @param {string} cwd
 * @param {string} sessionDir
 * @param {number | null} dirMtimeMs
 * @param {number} jsonlCount
 * @returns {boolean}
 */
function shouldIncrementallyScan(database, projectId, cwd, sessionDir, dirMtimeMs, jsonlCount) {
    const row = database.handle.prepare(
        "SELECT last_scanned_dir_mtime_ms, last_scanned_jsonl_count FROM project_session_catalog_scans WHERE project_id = ? AND cwd = ? AND session_dir = ?",
    ).get(projectId, cwd, sessionDir);
    if (!row) return true;
    return Number(row.last_scanned_dir_mtime_ms) !== Number(dirMtimeMs) ||
        Number(row.last_scanned_jsonl_count) !== jsonlCount;
}

/**
 * @param {import('./database.js').OwnerCoordinationDatabase} database
 * @param {string} projectId
 * @param {string} cwd
 * @param {string} sessionDir
 * @param {number | null} dirMtimeMs
 * @param {number} jsonlCount
 * @param {string} now
 */
function recordCatalogScan(database, projectId, cwd, sessionDir, dirMtimeMs, jsonlCount, now) {
    database.handle.prepare(
        "INSERT INTO project_session_catalog_scans(project_id, cwd, session_dir, last_scanned_dir_mtime_ms, last_scanned_jsonl_count, last_scanned_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(project_id, cwd) DO UPDATE SET session_dir = excluded.session_dir, last_scanned_dir_mtime_ms = excluded.last_scanned_dir_mtime_ms, last_scanned_jsonl_count = excluded.last_scanned_jsonl_count, last_scanned_at = excluded.last_scanned_at",
    ).run(projectId, cwd, sessionDir, dirMtimeMs, jsonlCount, now);
}

/** @param {string} path */
async function inspectSessionDirectory(path) {
    try {
        const stat = await fsStat(path);
        if (!stat.isDirectory()) return null;
        let jsonlCount = 0;
        for await (const entry of (await opendir(path))) {
            if ((entry.isFile() || entry.isSymbolicLink()) && entry.name.endsWith(".jsonl")) jsonlCount++;
        }
        return { stat, jsonlCount };
    } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
        throw error;
    }
}

/**
 * @param {string} cwd
 * @param {string} sessionDir
 * @param {Set<string>} knownTranscriptPaths
 * @returns {Promise<{ locators: import('../session/root-session.js').CatalogSafeRootSessionLocator[], diagnostics: CatalogDiagnostic[], dirMtimeMs: number | null, scanned: boolean }>}
 */
async function listIncrementalRootSessionLocators(cwd, sessionDir, knownTranscriptPaths) {
    /** @type {import('../session/root-session.js').CatalogSafeRootSessionLocator[]} */
    const locators = [];
    /** @type {CatalogDiagnostic[]} */
    const diagnostics = [];
    let stat;
    try {
        stat = await fsStat(sessionDir);
    } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") {
            return { locators, diagnostics, dirMtimeMs: null, scanned: false };
        }
        throw error;
    }
    for await (const entry of (await opendir(sessionDir))) {
        if (!(entry.isFile() || entry.isSymbolicLink()) || !entry.name.endsWith(".jsonl")) continue;
        const sessionPath = join(sessionDir, entry.name);
        if (knownTranscriptPaths.has(resolve(sessionPath))) continue;
        try {
            locators.push(await readCatalogSafeRootSessionLocator({ cwd, sessionDir, sessionPath }));
        } catch (error) {
            diagnostics.push({
                sessionPath,
                code: "invalid_locator",
                message: error instanceof Error ? error.message : String(error),
            });
        }
    }
    locators.sort((a, b) => a.sessionPath.localeCompare(b.sessionPath));
    return { locators, diagnostics, dirMtimeMs: mtimeMs(stat.mtime), scanned: true };
}

/**
 * @typedef {import('../session/root-session.js').CatalogSafeRootSessionLocator & { lineage: import('../types.js').SessionSegmentLineageEvidence | null }} LineageCatalogLocator
 */

/**
 * @param {string} sessionPath
 * @returns {Promise<import('../types.js').SessionSegmentLineageEvidence | null>}
 */
async function readSegmentLineageEvidenceFromTranscript(sessionPath) {
    const text = await fsReadFile(sessionPath, "utf8");
    const lines = text.split("\n");
    for (let index = lines.length - 1; index >= 0; index--) {
        const line = lines[index].trim();
        if (!line || !line.includes(SEGMENT_LINEAGE_CUSTOM_TYPE)) continue;
        try {
            const entry = JSON.parse(line);
            if (entry?.type !== "custom" || entry.customType !== SEGMENT_LINEAGE_CUSTOM_TYPE) continue;
            return normalizeSegmentLineageEvidence(entry.data);
        } catch {
            continue;
        }
    }
    return null;
}

/**
 * @param {LineageCatalogLocator[]} locators
 * @returns {{ groups: LineageCatalogLocator[][], ungrouped: LineageCatalogLocator[], diagnostics: CatalogDiagnostic[] }}
 */
function groupLineageCatalogLocators(locators) {
    /** @type {Map<string, LineageCatalogLocator[]>} */
    const candidates = new Map();
    /** @type {LineageCatalogLocator[]} */
    const ungrouped = [];
    /** @type {CatalogDiagnostic[]} */
    const diagnostics = [];
    for (const locator of locators) {
        if (!locator.lineage) {
            ungrouped.push(locator);
            continue;
        }
        const group = candidates.get(locator.lineage.runwieldSessionId) || [];
        group.push(locator);
        candidates.set(locator.lineage.runwieldSessionId, group);
    }
    /** @type {LineageCatalogLocator[][]} */
    const groups = [];
    for (const group of candidates.values()) {
        const ordered = orderConservativeLineageGroup(group);
        if (!ordered) {
            for (const locator of group) {
                diagnostics.push({
                    sessionPath: locator.sessionPath,
                    code: "lineage_recovery_required",
                    message: "Segment lineage is missing, ambiguous, cyclic, or orphaned; manual recovery is required.",
                });
            }
            continue;
        }
        if (ordered.length === 1) ungrouped.push(ordered[0]);
        else groups.push(ordered);
    }
    return { groups, ungrouped, diagnostics };
}

/**
 * @param {LineageCatalogLocator[]} group
 * @returns {LineageCatalogLocator[] | null}
 */
function orderConservativeLineageGroup(group) {
    const bySegmentId = new Map(group.map((locator) => [locator.lineage?.segmentId || "", locator]));
    if (bySegmentId.has("") || bySegmentId.size !== group.length) return null;
    /** @type {Map<string, string[]>} */
    const children = new Map();
    let root = null;
    for (const locator of group) {
        const lineage = locator.lineage;
        if (!lineage) return null;
        const parentId = lineage.parentSegmentId;
        if (!parentId) {
            if (root) return null;
            root = locator;
            continue;
        }
        if (!bySegmentId.has(parentId)) return null;
        const childIds = children.get(parentId) || [];
        childIds.push(lineage.segmentId);
        children.set(parentId, childIds);
        if (childIds.length > 1) return null;
    }
    if (!root) return null;
    /** @type {LineageCatalogLocator[]} */
    const ordered = [];
    const seen = new Set();
    /** @type {LineageCatalogLocator | null} */
    let cursor = root;
    while (cursor) {
        const segmentId = String(cursor.lineage?.segmentId || "");
        if (!segmentId || seen.has(segmentId)) return null;
        ordered.push(cursor);
        seen.add(segmentId);
        const childIds = /** @type {string[]} */ (children.get(segmentId) || []);
        cursor = childIds.length === 1 ? bySegmentId.get(childIds[0]) || null : null;
    }
    return ordered.length === group.length ? ordered : null;
}

/**
 * @param {import('./database.js').OwnerCoordinationDatabase} database
 * @param {string} projectId
 * @param {LineageCatalogLocator[]} group
 * @param {{ idFactory?: () => string, now?: () => string }} options
 * @returns {CatalogedSession}
 */
function catalogLineageSegmentGroup(database, projectId, group, options) {
    if (group.length < 2) throw new Error("Lineage group requires multiple segments");
    const now = isoNow(options.now);
    const first = group[0];
    const firstLineage = /** @type {import('../types.js').SessionSegmentLineageEvidence} */ (first.lineage);
    return database.transaction(() => {
        if (getSessionById(database, firstLineage.runwieldSessionId)) {
            throw new Error(`Lineage Session already exists: ${firstLineage.runwieldSessionId}`);
        }
        database.handle.prepare(
            "INSERT INTO runwield_sessions(id, project_id, source, created_at, updated_at) VALUES (?, ?, 'catalog', ?, ?)",
        ).run(firstLineage.runwieldSessionId, projectId, now, now);
        const locatorId = newId(options.idFactory);
        database.handle.prepare(
            "INSERT INTO session_transcript_locators(id, runwield_session_id, project_id, pi_session_id, transcript_path, transcript_cwd, header_version, header_timestamp, first_cataloged_at, last_cataloged_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        ).run(
            locatorId,
            firstLineage.runwieldSessionId,
            projectId,
            first.piSessionId,
            resolve(first.sessionPath),
            first.headerCwd,
            first.headerVersion,
            first.headerTimestamp,
            now,
            now,
        );
        const insertSegment = database.handle.prepare(
            `INSERT INTO session_transcript_segments(id, runwield_session_id, project_id, pi_session_id, transcript_path,
                transcript_cwd, ordinal, kind, sealed_at, header_version, header_timestamp, first_cataloged_at,
                last_cataloged_at, lineage_parent_segment_id, lineage_parent_pi_session_id, lineage_group_key,
                lineage_recorded_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, 'execution', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        );
        for (let index = 0; index < group.length; index++) {
            const locator = group[index];
            const lineage = /** @type {import('../types.js').SessionSegmentLineageEvidence} */ (locator.lineage);
            insertSegment.run(
                lineage.segmentId,
                lineage.runwieldSessionId,
                projectId,
                locator.piSessionId,
                resolve(locator.sessionPath),
                locator.headerCwd,
                index,
                index === group.length - 1 ? null : now,
                locator.headerVersion,
                locator.headerTimestamp,
                now,
                now,
                lineage.parentSegmentId ?? null,
                lineage.parentPiSessionId ?? null,
                lineage.lineageGroupKey ?? null,
                now,
            );
        }
        return /** @type {CatalogedSession} */ (getSessionById(database, firstLineage.runwieldSessionId));
    });
}

/**
 * @param {import('./database.js').OwnerCoordinationDatabase} database
 * @param {{ projectId: string, piSessionId: string, transcriptPath: string, transcriptCwd: string }} locator
 * @returns {Promise<import('../session/root-session.js').CatalogSafeRootSessionLocator>}
 */
export async function validateSuccessorSegmentLocator(database, locator) {
    const rootEvidence = listProjectRootEvidence(database, locator.projectId);
    const matchingRoot = rootEvidence.find((root) => isLocatorForRoot(locator.transcriptCwd, root));
    if (!matchingRoot) {
        throw new Error(`Transcript cwd does not match Project root evidence: ${locator.transcriptCwd}`);
    }
    const candidateSessionDirs = [
        ...new Set([
            getRunWieldSessionDir(matchingRoot.enteredRoot),
            getRunWieldSessionDir(matchingRoot.canonicalRoot),
        ]),
    ];
    const sessionDir = candidateSessionDirs.find((candidate) => isPathInside(locator.transcriptPath, candidate));
    if (!sessionDir) {
        throw new Error(`Transcript path is outside the RunWield session directory for cwd: ${locator.transcriptPath}`);
    }
    const safeLocator = await readCatalogSafeRootSessionLocator({
        cwd: locator.transcriptCwd,
        sessionDir,
        sessionPath: locator.transcriptPath,
    });
    if (safeLocator.piSessionId !== locator.piSessionId) {
        throw new Error(`Transcript header Pi session id does not match locator: ${locator.piSessionId}`);
    }
    if (!isLocatorForRoot(safeLocator.headerCwd, matchingRoot)) {
        throw new Error(`Transcript header cwd does not match Project root evidence: ${safeLocator.headerCwd}`);
    }
    return safeLocator;
}

/**
 * @param {CatalogedSession} existing
 * @param {import('../session/root-session.js').CatalogSafeRootSessionLocator} safeLocator
 */
function assertStoredHeaderEvidence(existing, safeLocator) {
    if (
        existing.transcriptCwd !== safeLocator.headerCwd ||
        existing.headerVersion !== safeLocator.headerVersion ||
        existing.headerTimestamp !== safeLocator.headerTimestamp
    ) {
        throw new Error(`Transcript header evidence conflict: ${safeLocator.sessionPath}`);
    }
}

/**
 * @param {import('./database.js').OwnerCoordinationDatabase} database
 * @param {string} runwieldSessionId
 * @returns {CatalogedSession | null}
 */
export function getSessionById(database, runwieldSessionId) {
    const db = requireDatabase(database).handle;
    const row = db.prepare(
        `SELECT runwield_sessions.id AS runwield_session_id,
                runwield_sessions.project_id,
                runwield_sessions.display_name,
                runwield_sessions.source,
                session_transcript_locators.pi_session_id,
                session_transcript_locators.transcript_path,
                session_transcript_locators.transcript_cwd,
                session_transcript_locators.header_version,
                session_transcript_locators.header_timestamp,
                session_transcript_locators.first_cataloged_at,
                session_transcript_locators.last_cataloged_at
           FROM runwield_sessions
           JOIN session_transcript_locators ON session_transcript_locators.runwield_session_id = runwield_sessions.id
          WHERE runwield_sessions.id = ?`,
    ).get(runwieldSessionId);
    return row ? sessionFromRow(row) : null;
}

/**
 * @param {import('./database.js').OwnerCoordinationDatabase} database
 * @param {{ transcriptPath?: string, projectId?: string, piSessionId?: string }} locator
 * @returns {CatalogedSession | null}
 */
export function findSessionByLocator(database, locator) {
    const db = requireDatabase(database).handle;
    let row;
    if (locator.transcriptPath) {
        row = db.prepare(
            `SELECT runwield_sessions.id AS runwield_session_id,
                    runwield_sessions.project_id,
                    runwield_sessions.display_name,
                    runwield_sessions.source,
                    session_transcript_locators.pi_session_id,
                    session_transcript_locators.transcript_path,
                    session_transcript_locators.transcript_cwd,
                    session_transcript_locators.header_version,
                    session_transcript_locators.header_timestamp,
                    session_transcript_locators.first_cataloged_at,
                    session_transcript_locators.last_cataloged_at
               FROM session_transcript_locators
               JOIN runwield_sessions ON runwield_sessions.id = session_transcript_locators.runwield_session_id
              WHERE session_transcript_locators.transcript_path = ?`,
        ).get(resolve(locator.transcriptPath));
    } else if (locator.projectId && locator.piSessionId) {
        row = db.prepare(
            `SELECT runwield_sessions.id AS runwield_session_id,
                    runwield_sessions.project_id,
                    runwield_sessions.display_name,
                    runwield_sessions.source,
                    session_transcript_locators.pi_session_id,
                    session_transcript_locators.transcript_path,
                    session_transcript_locators.transcript_cwd,
                    session_transcript_locators.header_version,
                    session_transcript_locators.header_timestamp,
                    session_transcript_locators.first_cataloged_at,
                    session_transcript_locators.last_cataloged_at
               FROM session_transcript_locators
               JOIN runwield_sessions ON runwield_sessions.id = session_transcript_locators.runwield_session_id
              WHERE session_transcript_locators.project_id = ? AND session_transcript_locators.pi_session_id = ?`,
        ).get(locator.projectId, locator.piSessionId);
    }
    return row ? sessionFromRow(row) : null;
}

/**
 * @param {import('./database.js').OwnerCoordinationDatabase} database
 * @param {{ projectId: string, piSessionId: string, transcriptPath: string, transcriptCwd: string, headerVersion?: number | null, headerTimestamp?: string | null, source?: 'catalog' | 'created' | 'imported', idFactory?: () => string, now?: () => string }} locator
 * @returns {Promise<CatalogedSession>}
 */
export async function ensureSessionCatalogRecord(database, locator) {
    const ownerDb = requireDatabase(database);
    if (!locator?.projectId) throw new Error("projectId is required");
    if (!locator.piSessionId) throw new Error("piSessionId is required");
    if (!locator.transcriptPath || !isAbsolute(locator.transcriptPath)) {
        throw new Error("transcriptPath must be absolute");
    }
    if (!locator.transcriptCwd || !isAbsolute(locator.transcriptCwd)) throw new Error("transcriptCwd must be absolute");
    const transcriptPath = resolve(locator.transcriptPath);
    const safeLocator = await validateSuccessorSegmentLocator(ownerDb, { ...locator, transcriptPath });
    return ownerDb.transaction(() => {
        const project = getProjectById(ownerDb, locator.projectId);
        if (!project) throw new Error(`Project not found: ${locator.projectId}`);
        const existingByPath = findSessionByLocator(ownerDb, { transcriptPath });
        if (existingByPath) {
            if (
                existingByPath.projectId !== locator.projectId || existingByPath.piSessionId !== safeLocator.piSessionId
            ) {
                throw new Error(`Transcript locator conflict: ${transcriptPath}`);
            }
            assertStoredHeaderEvidence(existingByPath, safeLocator);
            return existingByPath;
        }
        const existingByPi = findSessionByLocator(ownerDb, {
            projectId: locator.projectId,
            piSessionId: safeLocator.piSessionId,
        });
        if (existingByPi) {
            if (existingByPi.transcriptPath !== transcriptPath) {
                throw new Error(`Pi session locator conflict: ${safeLocator.piSessionId}`);
            }
            assertStoredHeaderEvidence(existingByPi, safeLocator);
            return existingByPi;
        }
        const now = isoNow(locator.now);
        const runwieldSessionId = newId(locator.idFactory);
        const locatorId = newId(locator.idFactory);
        const source = locator.source || "catalog";
        if (!["catalog", "created", "imported"].includes(source)) throw new Error(`Invalid Session source: ${source}`);
        ownerDb.handle.prepare(
            "INSERT INTO runwield_sessions(id, project_id, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
        ).run(runwieldSessionId, locator.projectId, source, now, now);
        ownerDb.handle.prepare(
            "INSERT INTO session_transcript_locators(id, runwield_session_id, project_id, pi_session_id, transcript_path, transcript_cwd, header_version, header_timestamp, first_cataloged_at, last_cataloged_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        ).run(
            locatorId,
            runwieldSessionId,
            locator.projectId,
            safeLocator.piSessionId,
            transcriptPath,
            safeLocator.headerCwd,
            safeLocator.headerVersion,
            safeLocator.headerTimestamp,
            now,
            now,
        );
        ownerDb.handle.prepare(
            "INSERT INTO session_transcript_segments(id, runwield_session_id, project_id, pi_session_id, transcript_path, transcript_cwd, ordinal, kind, sealed_at, header_version, header_timestamp, first_cataloged_at, last_cataloged_at) VALUES (?, ?, ?, ?, ?, ?, 0, 'planning', NULL, ?, ?, ?, ?)",
        ).run(
            `${locatorId}-segment-0`,
            runwieldSessionId,
            locator.projectId,
            safeLocator.piSessionId,
            transcriptPath,
            safeLocator.headerCwd,
            safeLocator.headerVersion,
            safeLocator.headerTimestamp,
            now,
            now,
        );
        return /** @type {CatalogedSession} */ (getSessionById(ownerDb, runwieldSessionId));
    });
}

/**
 * @param {import('./database.js').OwnerCoordinationDatabase} database
 * @param {string} projectId
 * @param {{ catalog?: boolean, fullRescan?: boolean, idFactory?: () => string, now?: () => string }} [options]
 * @returns {Promise<{ sessions: CatalogedSession[], diagnostics: CatalogDiagnostic[] }>}
 */
/**
 * @param {import('./database.js').OwnerCoordinationDatabase} database
 * @param {string} runwieldSessionId
 * @returns {import('../types.js').SessionTranscriptSegment[]}
 */
export function listSessionTranscriptSegments(database, runwieldSessionId) {
    const db = requireDatabase(database).handle;
    return db.prepare(
        `SELECT * FROM session_transcript_segments
          WHERE runwield_session_id = ?
          ORDER BY ordinal ASC`,
    ).all(runwieldSessionId).map(segmentFromRow);
}

/**
 * @param {import('./database.js').OwnerCoordinationDatabase} database
 * @param {string} runwieldSessionId
 * @returns {import('../types.js').SessionTranscriptSegment | null}
 */
export function getCurrentSessionSegment(database, runwieldSessionId) {
    const db = requireDatabase(database).handle;
    const row = db.prepare(
        `SELECT segments.*
           FROM session_transcript_segment_state state
           JOIN session_transcript_segments segments ON segments.id = state.current_segment_id
          WHERE state.runwield_session_id = ?`,
    ).get(runwieldSessionId);
    return row ? segmentFromRow(row) : null;
}

/**
 * @param {import('./database.js').OwnerCoordinationDatabase} database
 * @param {{ runwieldSessionId: string, projectId: string, piSessionId: string, transcriptPath: string, transcriptCwd: string, kind: 'planning' | 'execution' | 'semantic_repair', lineageParentSegmentId?: string | null, lineageParentPiSessionId?: string | null, lineageGroupKey?: string | null, idFactory?: () => string, now?: () => string }} segment
 * @returns {Promise<import('../types.js').SessionTranscriptSegment>}
 */
/**
 * @param {import('./database.js').OwnerCoordinationDatabase} database
 * @param {{ runwieldSessionId: string, projectId: string, piSessionId: string, transcriptPath: string, transcriptCwd: string, kind: 'planning' | 'execution' | 'semantic_repair', lineageParentSegmentId?: string | null, lineageParentPiSessionId?: string | null, lineageGroupKey?: string | null, idFactory?: () => string, now?: () => string }} segment
 * @param {import('../session/root-session.js').CatalogSafeRootSessionLocator} safeLocator
 * @returns {import('../types.js').SessionTranscriptSegment}
 */
export function insertSessionTranscriptSegmentRow(database, segment, safeLocator) {
    const ownerDb = requireDatabase(database);
    const session = ownerDb.handle.prepare(
        "SELECT id, project_id FROM runwield_sessions WHERE id = ? AND project_id = ?",
    ).get(segment.runwieldSessionId, segment.projectId);
    if (!session) throw new Error(`Session not found: ${segment.runwieldSessionId}`);
    const current = getCurrentSessionSegment(ownerDb, segment.runwieldSessionId);
    if (current) throw new Error(`Current segment is still unsealed: ${current.segmentId}`);
    const previous = ownerDb.handle.prepare(
        "SELECT COALESCE(MAX(ordinal), -1) AS max_ordinal FROM session_transcript_segments WHERE runwield_session_id = ?",
    ).get(segment.runwieldSessionId);
    if (!previous) throw new Error("Unable to read segment ordinal state");
    const ordinal = Number(previous.max_ordinal) + 1;
    const now = isoNow(segment.now);
    const segmentId = newId(segment.idFactory);
    ownerDb.handle.prepare(
        `INSERT INTO session_transcript_segments(id, runwield_session_id, project_id, pi_session_id, transcript_path,
            transcript_cwd, ordinal, kind, sealed_at, header_version, header_timestamp, first_cataloged_at,
            last_cataloged_at, lineage_parent_segment_id, lineage_parent_pi_session_id, lineage_group_key,
            lineage_recorded_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
        segmentId,
        segment.runwieldSessionId,
        segment.projectId,
        safeLocator.piSessionId,
        resolve(segment.transcriptPath),
        safeLocator.headerCwd,
        ordinal,
        segment.kind,
        safeLocator.headerVersion,
        safeLocator.headerTimestamp,
        now,
        now,
        segment.lineageParentSegmentId ?? null,
        segment.lineageParentPiSessionId ?? null,
        segment.lineageGroupKey ?? null,
        segment.lineageParentSegmentId || segment.lineageParentPiSessionId || segment.lineageGroupKey ? now : null,
    );
    return /** @type {import('../types.js').SessionTranscriptSegment} */ (getCurrentSessionSegment(
        ownerDb,
        segment.runwieldSessionId,
    ));
}

/**
 * @param {import('./database.js').OwnerCoordinationDatabase} database
 * @param {{ runwieldSessionId: string, projectId: string, piSessionId: string, transcriptPath: string, transcriptCwd: string, kind: 'planning' | 'execution' | 'semantic_repair', lineageParentSegmentId?: string | null, lineageParentPiSessionId?: string | null, lineageGroupKey?: string | null, idFactory?: () => string, now?: () => string }} segment
 * @returns {Promise<import('../types.js').SessionTranscriptSegment>}
 */
export async function appendSessionTranscriptSegment(database, segment) {
    const ownerDb = requireDatabase(database);
    if (!segment?.runwieldSessionId) throw new Error("runwieldSessionId is required");
    if (!segment.projectId) throw new Error("projectId is required");
    if (!segment.piSessionId) throw new Error("piSessionId is required");
    if (!segment.transcriptPath || !isAbsolute(segment.transcriptPath)) {
        throw new Error("transcriptPath must be absolute");
    }
    if (!segment.transcriptCwd || !isAbsolute(segment.transcriptCwd)) throw new Error("transcriptCwd must be absolute");
    if (!["planning", "execution", "semantic_repair"].includes(segment.kind)) {
        throw new Error(`Invalid segment kind: ${segment.kind}`);
    }
    const transcriptPath = resolve(segment.transcriptPath);
    const safeLocator = await validateSuccessorSegmentLocator(ownerDb, { ...segment, transcriptPath });
    return ownerDb.transaction(() =>
        insertSessionTranscriptSegmentRow(ownerDb, { ...segment, transcriptPath }, safeLocator)
    );
}

/**
 * @param {import('./database.js').OwnerCoordinationDatabase} database
 * @param {{ runwieldSessionId: string, segmentId: string, evidence?: { byteLength: number, digestHex: string, terminalEntryId: string | null }, now?: () => string }} options
 * @returns {import('../types.js').SessionTranscriptSegment}
 */
export function sealSessionTranscriptSegmentRow(database, options) {
    const ownerDb = requireDatabase(database);
    const supplied = options.evidence || null;
    if (!supplied || !Number.isInteger(supplied.byteLength) || typeof supplied.digestHex !== "string") {
        throw new Error("Sealed segment evidence is required");
    }
    const now = isoNow(options.now);
    const currentInTransaction = getCurrentSessionSegment(ownerDb, options.runwieldSessionId);
    if (!currentInTransaction || currentInTransaction.segmentId !== options.segmentId) {
        throw new Error("Segment is not current");
    }
    const actual = captureTranscriptEvidenceSync(currentInTransaction.transcriptPath, supplied.byteLength);
    if (
        actual.byteLength !== supplied.byteLength || actual.digestHex !== supplied.digestHex ||
        actual.terminalEntryId !== supplied.terminalEntryId
    ) {
        throw new Error("Sealed segment evidence does not match transcript on disk");
    }
    const result = ownerDb.handle.prepare(
        `UPDATE session_transcript_segments
            SET sealed_at = ?, last_cataloged_at = ?, sealed_byte_length = ?, sealed_digest_hex = ?, sealed_terminal_entry_id = ?
          WHERE id = ? AND runwield_session_id = ? AND sealed_at IS NULL`,
    ).run(
        now,
        now,
        supplied.byteLength,
        supplied.digestHex,
        supplied.terminalEntryId ?? null,
        options.segmentId,
        options.runwieldSessionId,
    );
    if (result.changes !== 1) throw new Error("Segment seal proof was rejected");
    return /** @type {import('../types.js').SessionTranscriptSegment} */ (listSessionTranscriptSegments(
        ownerDb,
        options.runwieldSessionId,
    ).find((item) => item.segmentId === options.segmentId));
}

/**
 * @param {import('./database.js').OwnerCoordinationDatabase} database
 * @param {{ runwieldSessionId: string, segmentId: string, evidence?: { byteLength: number, digestHex: string, terminalEntryId: string | null }, now?: () => string }} options
 * @returns {import('../types.js').SessionTranscriptSegment}
 */
export function sealSessionTranscriptSegment(database, options) {
    const ownerDb = requireDatabase(database);
    const supplied = options.evidence || null;
    if (!supplied || !Number.isInteger(supplied.byteLength) || typeof supplied.digestHex !== "string") {
        throw new Error("Sealed segment evidence is required");
    }
    return ownerDb.transaction(() => sealSessionTranscriptSegmentRow(ownerDb, options));
}

/**
 * @param {import('./database.js').OwnerCoordinationDatabase} database
 * @param {{ runwieldSessionId: string, projectId: string, transcriptCwd: string }} options
 * @returns {Promise<import('../session/segment-rollover.ts').OrphanRolloverCandidate[]>}
 */
export async function findOrphanRolloverCandidates(database, options) {
    const ownerDb = requireDatabase(database);
    const segments = listSessionTranscriptSegments(ownerDb, options.runwieldSessionId);
    const knownPaths = new Set(segments.map((segment) => resolve(segment.transcriptPath)));
    const sessionDir = getRunWieldSessionDir(options.transcriptCwd);
    const { locators } = await listCatalogSafeRootSessionLocators(options.transcriptCwd, { sessionDir });
    const candidates = [];
    for (const locator of locators) {
        if (knownPaths.has(resolve(locator.sessionPath))) continue;
        const lineage = await readSegmentLineageEvidenceFromTranscript(locator.sessionPath);
        if (!lineage || lineage.runwieldSessionId !== options.runwieldSessionId || !lineage.parentSegmentId) continue;
        const parent = segments.find((segment) => segment.segmentId === lineage.parentSegmentId);
        if (!parent) continue;
        candidates.push({
            runwieldSessionId: options.runwieldSessionId,
            projectId: options.projectId,
            transcriptPath: resolve(locator.sessionPath),
            transcriptCwd: locator.headerCwd,
            piSessionId: locator.piSessionId,
            parentSegmentId: lineage.parentSegmentId,
            parentPiSessionId: lineage.parentPiSessionId ?? null,
            lineageGroupKey: lineage.lineageGroupKey ?? null,
        });
    }
    return candidates;
}

/**
 * @typedef {'no_op_retry' | 'removable_orphan' | 'recoverable_orphan' | 'transcript_ahead_database_behind' | 'database_ahead' | 'uncertain_effects'} SegmentRolloverRecoveryState
 */

/**
 * @param {import('./database.js').OwnerCoordinationDatabase} database
 * @param {{ runwieldSessionId: string, projectId: string, transcriptCwd: string, successorTranscriptPath?: string | null, predecessorSegmentId?: string | null }} options
 * @returns {Promise<{ state: SegmentRolloverRecoveryState, transcriptPath: string | null, segmentId: string | null, reason: string }>}
 */
export async function inspectSegmentRolloverRecovery(database, options) {
    const ownerDb = requireDatabase(database);
    const transcriptPath = options.successorTranscriptPath ? resolve(options.successorTranscriptPath) : null;
    if (!transcriptPath) {
        return { state: "no_op_retry", transcriptPath: null, segmentId: null, reason: "successor_not_created" };
    }
    try {
        const stat = await fsStat(transcriptPath);
        if (!stat.isFile()) {
            return { state: "no_op_retry", transcriptPath, segmentId: null, reason: "successor_not_a_file" };
        }
    } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") {
            return { state: "no_op_retry", transcriptPath, segmentId: null, reason: "successor_not_created" };
        }
        throw error;
    }

    const segments = listSessionTranscriptSegments(ownerDb, options.runwieldSessionId);
    const segment = segments.find((item) => resolve(item.transcriptPath) === transcriptPath) || null;
    if (segment) {
        const activation = ownerDb.handle.prepare(
            "SELECT current_segment_id FROM session_activation_state WHERE runwield_session_id = ? AND project_id = ?",
        ).get(options.runwieldSessionId, options.projectId);
        const generation = ownerDb.handle.prepare(
            `SELECT current_segment_id FROM session_committed_generations
              WHERE runwield_session_id = ? AND project_id = ?
              ORDER BY generation DESC LIMIT 1`,
        ).get(options.runwieldSessionId, options.projectId);
        if (
            activation?.current_segment_id === segment.segmentId && generation?.current_segment_id === segment.segmentId
        ) {
            return {
                state: "database_ahead",
                transcriptPath,
                segmentId: segment.segmentId,
                reason: "manifest_switched",
            };
        }
        return {
            state: "uncertain_effects",
            transcriptPath,
            segmentId: segment.segmentId,
            reason: "row_without_manifest_switch",
        };
    }

    const lineage = await readSegmentLineageEvidenceFromTranscript(transcriptPath);
    if (!lineage || lineage.runwieldSessionId !== options.runwieldSessionId || !lineage.parentSegmentId) {
        return { state: "removable_orphan", transcriptPath, segmentId: null, reason: "lineage_absent_or_unrelated" };
    }
    const parent = segments.find((item) => item.segmentId === lineage.parentSegmentId) || null;
    if (!parent) {
        return { state: "removable_orphan", transcriptPath, segmentId: null, reason: "lineage_parent_absent" };
    }
    if (options.predecessorSegmentId && parent.segmentId !== options.predecessorSegmentId) {
        return { state: "uncertain_effects", transcriptPath, segmentId: null, reason: "lineage_parent_mismatch" };
    }
    if (parent.sealedAt) {
        return {
            state: "transcript_ahead_database_behind",
            transcriptPath,
            segmentId: null,
            reason: "predecessor_already_sealed",
        };
    }
    return { state: "recoverable_orphan", transcriptPath, segmentId: null, reason: "lineage_ready_without_row" };
}

/**
 * @param {import('./database.js').OwnerCoordinationDatabase} database
 * @param {{ runwieldSessionId: string, transcriptCwd: string, transcriptPath: string }} options
 */
export async function discardOrphanRolloverCandidate(database, options) {
    const ownerDb = requireDatabase(database);
    const sessionDir = getRunWieldSessionDir(options.transcriptCwd);
    const transcriptPath = resolve(options.transcriptPath);
    if (!isPathInside(transcriptPath, sessionDir)) throw new Error("Orphan candidate is outside the Session directory");
    const row = ownerDb.handle.prepare("SELECT id FROM session_transcript_segments WHERE transcript_path = ?").get(
        transcriptPath,
    );
    if (row) throw new Error("Orphan candidate already has a segment row");
    const text = await fsReadFile(transcriptPath, "utf8");
    const entries = text.split("\n").filter(Boolean).map((line) => JSON.parse(line));
    if (entries.length < 1) throw new Error("Orphan candidate is empty");
    for (let index = 1; index < entries.length; index++) {
        const entry = entries[index];
        if (!entry || typeof entry !== "object" || entry.type !== "custom") {
            throw new Error("Orphan candidate contains non-marker entries");
        }
        const customType = /** @type {{ customType?: string }} */ (entry).customType;
        if (customType !== SEGMENT_LINEAGE_CUSTOM_TYPE && customType !== PENDING_SEGMENT_CONTINUATION_CUSTOM_TYPE) {
            throw new Error("Orphan candidate contains non-marker entries");
        }
    }
    await fsRm(transcriptPath);
}

/**
 * @param {import('./database.js').OwnerCoordinationDatabase} database
 * @param {string} runwieldSessionId
 * @returns {import('../types.js').SessionLineageDiagnostic[]}
 */
export function diagnoseSessionSegmentLineage(database, runwieldSessionId) {
    const segments = listSessionTranscriptSegments(database, runwieldSessionId);
    const byId = new Map(segments.map((segment) => [segment.segmentId, segment]));
    /** @type {import('../types.js').SessionLineageDiagnostic[]} */
    const diagnostics = [];
    const children = new Map();
    for (const segment of segments) {
        if (segment.lineageParentSegmentId) {
            if (!byId.has(segment.lineageParentSegmentId)) {
                diagnostics.push({
                    code: "orphaned_lineage",
                    segmentId: segment.segmentId,
                    message: "Lineage parent segment is absent.",
                });
            } else {
                const count = children.get(segment.lineageParentSegmentId) || 0;
                children.set(segment.lineageParentSegmentId, count + 1);
            }
        } else if (segment.ordinal > 0) {
            diagnostics.push({
                code: "missing_lineage",
                segmentId: segment.segmentId,
                message: "Segment has no lineage parent.",
            });
        }
    }
    for (const [parentId, count] of children) {
        if (count > 1) {
            diagnostics.push({
                code: "ambiguous_lineage",
                segmentId: parentId,
                message: "Lineage parent has multiple children.",
            });
        }
    }
    for (const segment of segments) {
        const seen = new Set([segment.segmentId]);
        let cursor = segment.lineageParentSegmentId ? byId.get(segment.lineageParentSegmentId) : null;
        while (cursor) {
            if (seen.has(cursor.segmentId)) {
                diagnostics.push({
                    code: "cyclic_lineage",
                    segmentId: segment.segmentId,
                    message: "Segment lineage contains a cycle.",
                });
                break;
            }
            seen.add(cursor.segmentId);
            cursor = cursor.lineageParentSegmentId ? byId.get(cursor.lineageParentSegmentId) : null;
        }
    }
    if (diagnostics.length === 0) {
        diagnostics.push({
            code: "valid",
            segmentId: segments[0]?.segmentId || null,
            message: "Segment lineage is conservative and ordered.",
        });
    }
    return diagnostics;
}

/**
 * @param {import('./database.js').OwnerCoordinationDatabase} database
 * @param {string} projectId
 * @param {{ catalog?: boolean, fullRescan?: boolean, idFactory?: () => string, now?: () => string }} [options]
 * @returns {Promise<{ sessions: CatalogedSession[], diagnostics: CatalogDiagnostic[] }>}
 */
export async function listProjectSessions(database, projectId, options = {}) {
    const catalogResult = options.catalog !== false ? await catalogProjectSessions(database, projectId, options) : null;
    const db = requireDatabase(database).handle;
    const sessions = db.prepare(
        `SELECT runwield_sessions.id AS runwield_session_id,
                runwield_sessions.project_id,
                runwield_sessions.display_name,
                runwield_sessions.source,
                session_transcript_locators.pi_session_id,
                session_transcript_locators.transcript_path,
                session_transcript_locators.transcript_cwd,
                session_transcript_locators.header_version,
                session_transcript_locators.header_timestamp,
                session_transcript_locators.first_cataloged_at,
                session_transcript_locators.last_cataloged_at
           FROM runwield_sessions
           JOIN session_transcript_locators ON session_transcript_locators.runwield_session_id = runwield_sessions.id
          WHERE runwield_sessions.project_id = ?
          ORDER BY session_transcript_locators.header_timestamp DESC, session_transcript_locators.transcript_path`,
    ).all(projectId).map(sessionFromRow);
    return { sessions, diagnostics: catalogResult?.diagnostics || [] };
}

/**
 * @param {import('./database.js').OwnerCoordinationDatabase} database
 * @param {string} projectId
 * @param {{ fullRescan?: boolean, idFactory?: () => string, now?: () => string }} [options]
 * @returns {Promise<{ cataloged: CatalogedSession[], diagnostics: CatalogDiagnostic[] }>}
 */
export async function catalogProjectSessions(database, projectId, options = {}) {
    const ownerDb = requireDatabase(database);
    const project = getProjectById(ownerDb, projectId);
    if (!project) throw new Error(`Project not found: ${projectId}`);
    const rootEvidence = listProjectRootEvidence(ownerDb, projectId);
    /** @type {Map<string, ProjectRootEvidence>} */
    const roots = new Map();
    for (const root of rootEvidence) {
        roots.set(root.enteredRoot, root);
        roots.set(root.canonicalRoot, root);
    }
    /** @type {CatalogedSession[]} */
    const cataloged = [];
    /** @type {CatalogDiagnostic[]} */
    const diagnostics = [];
    const seenPaths = new Set();
    const knownTranscriptPaths = listKnownTranscriptPaths(ownerDb, projectId);
    for (const [cwd, evidence] of roots) {
        const sessionDir = getRunWieldSessionDir(cwd);
        let locatorResult;
        let scannedDirMtimeMs = null;
        let scannedJsonlCount = 0;
        let didIncrementalScan = false;
        if (options.fullRescan) {
            locatorResult = await listCatalogSafeRootSessionLocators(cwd, { sessionDir });
        } else {
            const inspection = await inspectSessionDirectory(sessionDir);
            const dirMtimeMs = mtimeMs(inspection?.stat.mtime || null);
            if (
                !inspection ||
                !shouldIncrementallyScan(ownerDb, projectId, cwd, sessionDir, dirMtimeMs, inspection.jsonlCount)
            ) continue;
            locatorResult = await listIncrementalRootSessionLocators(cwd, sessionDir, knownTranscriptPaths);
            scannedDirMtimeMs = locatorResult.dirMtimeMs;
            scannedJsonlCount = inspection.jsonlCount;
            didIncrementalScan = locatorResult.scanned;
        }
        const rootDiagnosticStart = diagnostics.length;
        diagnostics.push(...locatorResult.diagnostics);
        /** @type {LineageCatalogLocator[]} */
        const lineageLocators = [];
        for (const locator of locatorResult.locators) {
            if (!isLocatorForRoot(locator.headerCwd, evidence)) {
                diagnostics.push({
                    sessionPath: locator.sessionPath,
                    code: "wrong_cwd",
                    message: `Transcript cwd ${locator.headerCwd} does not match Project root evidence.`,
                });
                continue;
            }
            if (seenPaths.has(locator.sessionPath)) continue;
            seenPaths.add(locator.sessionPath);
            try {
                lineageLocators.push({
                    ...locator,
                    lineage: await readSegmentLineageEvidenceFromTranscript(locator.sessionPath),
                });
            } catch (error) {
                diagnostics.push({
                    sessionPath: locator.sessionPath,
                    code: "lineage_read_failed",
                    message: error instanceof Error ? error.message : String(error),
                });
            }
        }
        const grouped = groupLineageCatalogLocators(lineageLocators);
        diagnostics.push(...grouped.diagnostics);
        for (const group of grouped.groups) {
            try {
                const session = catalogLineageSegmentGroup(ownerDb, projectId, group, options);
                cataloged.push(session);
                for (const locator of group) knownTranscriptPaths.add(resolve(locator.sessionPath));
            } catch (error) {
                for (const locator of group) {
                    diagnostics.push({
                        sessionPath: locator.sessionPath,
                        code: "catalog_conflict",
                        message: error instanceof Error ? error.message : String(error),
                    });
                }
            }
        }
        for (const locator of grouped.ungrouped) {
            try {
                const session = await ensureSessionCatalogRecord(ownerDb, {
                    projectId,
                    piSessionId: locator.piSessionId,
                    transcriptPath: locator.sessionPath,
                    transcriptCwd: locator.headerCwd,
                    headerVersion: locator.headerVersion,
                    headerTimestamp: locator.headerTimestamp,
                    idFactory: options.idFactory,
                    now: options.now,
                });
                cataloged.push(session);
                knownTranscriptPaths.add(resolve(locator.sessionPath));
            } catch (error) {
                diagnostics.push({
                    sessionPath: locator.sessionPath,
                    code: "catalog_conflict",
                    message: error instanceof Error ? error.message : String(error),
                });
            }
        }
        if (!options.fullRescan && didIncrementalScan && diagnostics.length === rootDiagnosticStart) {
            recordCatalogScan(
                ownerDb,
                projectId,
                cwd,
                sessionDir,
                scannedDirMtimeMs,
                scannedJsonlCount,
                isoNow(options.now),
            );
        }
    }
    const distinctDiagnostics = diagnostics.filter((diagnostic, index) =>
        diagnostics.findIndex((candidate) =>
            candidate.sessionPath === diagnostic.sessionPath && candidate.code === diagnostic.code &&
            candidate.message === diagnostic.message
        ) === index
    );
    return { cataloged, diagnostics: distinctDiagnostics };
}

/**
 * @param {string} headerCwd
 * @param {ProjectRootEvidence} evidence
 */
function isLocatorForRoot(headerCwd, evidence) {
    const resolvedHeaderCwd = resolve(headerCwd);
    try {
        return realpathSync.native(resolvedHeaderCwd) === evidence.canonicalRoot;
    } catch {
        if (evidence.rootState !== "historical") return false;
        return resolvedHeaderCwd === resolve(evidence.enteredRoot) ||
            resolvedHeaderCwd === resolve(evidence.canonicalRoot);
    }
}
