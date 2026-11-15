import fs, { stat as fsStat } from "node:fs/promises";
import type { FileSessionStore } from "./file-session-store.ts";
import type { SessionRuntime } from "./session-runtime.ts";
import { getRunWieldSessionDir } from "./root-session.js";
import { projectAggregateTranscript } from "./session-transcript-manifest.ts";
import { summarizeProjectedEntries, summarizeResumableTranscript } from "./session-transcript-projection.js";

export interface SessionListOptions {
    page?: number;
    pageSize?: number;
    includeEmpty?: boolean;
    includeTotal?: boolean;
    planId?: string;
    archiveState?: "active" | "archived" | "all";
    excludedPlanIds?: string[];
    excludedSessionIds?: string[];
}

type SessionHistoryStore = Pick<
    FileSessionStore,
    "listProjectSessions" | "listSessionPlanAssociations" | "listSessionTranscriptSegments" | "inspectSessionActivation"
>;

interface SessionListInfo {
    name: string;
    firstMessage: string;
}

interface SessionListInfoCacheEntry {
    size: number;
    mtime: number;
    ctime: number;
    info: SessionListInfo;
}

const sessionListInfoCache = new Map<string, SessionListInfoCacheEntry>();

function compactSessionName(value: string) {
    return value.trim().replace(/\s+/g, " ");
}

async function readSessionListInfo(transcriptPath: string) {
    try {
        const stat = await fsStat(transcriptPath);
        const cached = sessionListInfoCache.get(transcriptPath);
        if (
            cached &&
            cached.size === stat.size &&
            cached.mtime === stat.mtime?.getTime() &&
            cached.ctime === stat.ctime?.getTime()
        )
            return cached.info;
        const entries = [];
        const transcript = await fs.readFile(transcriptPath, "utf8");
        for (const line of transcript.split("\n")) {
            if (!line.trim()) continue;
            try {
                const entry = JSON.parse(line);
                entries.push(entry);
            } catch {
                // Use complete records while the active writer appends its next entry.
            }
        }
        const name = summarizeProjectedEntries(entries).name;
        const info = {
            name: typeof name === "string" ? compactSessionName(name) : "",
            firstMessage: compactSessionName(summarizeResumableTranscript(entries).firstMessage || "").slice(0, 100),
        };
        sessionListInfoCache.set(transcriptPath, {
            size: stat.size,
            mtime: stat.mtime?.getTime(),
            ctime: stat.ctime?.getTime(),
            info,
        });
        if (sessionListInfoCache.size > 512) {
            const oldest = sessionListInfoCache.keys().next().value;
            if (oldest) sessionListInfoCache.delete(oldest);
        }
        return info;
    } catch {
        return { name: "", firstMessage: "" };
    }
}

export async function readSessionName(transcriptPath: string) {
    const info = await readSessionListInfo(transcriptPath);
    return info.name || info.firstMessage;
}

export async function readSessionDisplayName(paths: string[]) {
    const infos = await Promise.all(paths.map(readSessionListInfo));
    const savedName = infos.findLast((info) => info.name)?.name || "";
    const name = savedName && !/^untitled(?: session)?$/i.test(savedName) ? savedName : "";
    return name || infos.find((info) => info.firstMessage)?.firstMessage || "";
}

export async function listSavedSessions(
    store: SessionHistoryStore,
    projectId: string,
    options: SessionListOptions = {},
) {
    const page =
        typeof options.page === "number" && Number.isInteger(options.page) && options.page >= 0 ? options.page : 0;
    const pageSize =
        typeof options.pageSize === "number" && Number.isInteger(options.pageSize) && options.pageSize > 0
            ? Math.min(options.pageSize, 100)
            : 30;
    const start = page * pageSize;
    const excludedSessions = new Set(options.excludedSessionIds || []);
    const excludedPlans = new Set(options.excludedPlanIds || []);
    // Navigation needs one visible page and a lookahead, not a count of every transcript.
    const visibleLimit = options.includeTotal === false ? start + pageSize + 1 : Infinity;
    // One recovered catalog snapshot per request; paging the catalog would rescan
    // and reparse every manifest (and recovery descriptor) for each 100 rows.
    const result = await store.listProjectSessions(projectId, {
        all: true,
        catalog: false,
        archiveState: options.planId ? "all" : options.archiveState,
    });
    const visible = [];
    // Keep transcript reads bounded; never load all large histories in parallel.
    for (const session of result.sessions) {
        // Filter stable identities before opening transcript files. Sidebar expansion
        // needs only five unseen names, regardless of the Project's history size.
        if (excludedSessions.has(session.runwieldSessionId)) continue;
        if (options.planId || excludedPlans.size) {
            const associations = store
                .listSessionPlanAssociations(session.runwieldSessionId, projectId)
                .filter((entry) => entry.committedGeneration !== null);
            if (options.planId && !associations.some((entry) => entry.planId === options.planId)) continue;
            if (associations.some((entry) => excludedPlans.has(entry.planId))) continue;
        }
        const segments = store.listSessionTranscriptSegments(session.runwieldSessionId);
        const paths = segments.length
            ? [...segments].sort((a, b) => a.ordinal - b.ordinal).map((segment) => segment.transcriptPath)
            : [session.transcriptPath].filter(Boolean);
        const displayName = await readSessionDisplayName(paths);
        if (!options.includeEmpty && !displayName) continue;
        visible.push({ ...session, displayName });
        if (visible.length >= visibleLimit) break;
    }
    return {
        ...result,
        page,
        pageSize,
        total: options.includeTotal === false ? null : visible.length,
        hasNext: start + pageSize < visible.length,
        hasPrevious: page > 0,
        diagnostics: result.diagnostics || [],
        sessions: visible.slice(start, start + pageSize).map((session) => {
            const inspected = store.inspectSessionActivation(session.runwieldSessionId);
            return {
                runwieldSessionId: session.runwieldSessionId,
                projectId,
                displayName: session.displayName,
                archivedAt: session.archivedAt,
                headerTimestamp: session.headerTimestamp,
                lastCatalogedAt: session.lastCatalogedAt,
                state: inspected.activation?.state || "missing_activation",
                generation: inspected.generation?.generation ?? null,
                activeSurface: inspected.activation?.state === "active" ? inspected.activation.ownerProcessKind : null,
                recoveryCategory:
                    inspected.activation?.state === "active" ? "wait_for_owner" : inspected.activation?.state || "idle",
                bootstrapRequired: inspected.activation?.state === "uninitialized",
            };
        }),
    };
}

export interface SessionHistoryOptions {
    cursorEventId?: string;
    limit?: number;
    latest?: boolean;
    beforeEventId?: string;
}

type SessionTimelineStore = Pick<
    FileSessionStore,
    "getSessionById" | "inspectSessionActivation" | "listSessionTranscriptSegments" | "listSessionArtifacts"
>;

/** Read verified committed evidence. Only Core's existing recovery path can initialize a generation. */
export async function readCommittedSessionTimeline(
    store: SessionTimelineStore,
    runtime: SessionRuntime,
    runwieldSessionId: string,
    options: SessionHistoryOptions = {},
) {
    const session = store.getSessionById(runwieldSessionId);
    if (!session) throw new Error("Session not found.");
    let inspected = store.inspectSessionActivation(runwieldSessionId);
    if (
        ["uncertain", "reconcile_required"].includes(inspected.activation?.state || "") ||
        (!inspected.generation && inspected.activation?.state === "uninitialized")
    ) {
        await runtime.ensureInitialSessionGeneration(runwieldSessionId);
        inspected = store.inspectSessionActivation(runwieldSessionId);
    }
    const state = inspected.activation?.state || "uninitialized";
    const activeSurface = state === "active" ? inspected.activation?.ownerProcessKind || null : null;
    const facts = {
        state,
        activeSurface,
        recoveryCategory: state,
        artifacts: store.listSessionArtifacts(runwieldSessionId),
    };
    if (!inspected.generation) {
        return {
            ...facts,
            bootstrapRequired: true,
            generation: null,
            complete: true,
            events: [],
        };
    }
    const projection = await projectAggregateTranscript({
        cwd: session.transcriptCwd,
        sessionDir: getRunWieldSessionDir(session.transcriptCwd),
        runwieldSessionId,
        generation: inspected.generation,
        segments: store.listSessionTranscriptSegments(runwieldSessionId),
        cursorEventId: options.cursorEventId,
        limit: options.limit,
        latest: options.latest,
        beforeEventId: options.beforeEventId,
    });
    return { ...facts, bootstrapRequired: false, ...projection };
}
