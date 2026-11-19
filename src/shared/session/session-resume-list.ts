/**
 * @module shared/session/session-resume-list
 * Builds the bounded, newest-first list used by the interactive resume picker.
 */

import { listCatalogSafeRootSessionLocators } from "./root-session.ts";
import {
    buildProjectedSessionInfo,
    captureTranscriptEvidence,
    summarizeResumableTranscript,
} from "./session-transcript-projection.ts";
import type { FileSessionStore } from "./file-session-store-types.ts";

export const RECENT_SESSION_LIMIT = 30;
const RESUME_READ_CONCURRENCY = 4;

export interface ResumableSessionSummary {
    id: string;
    path: string;
    cwd: string;
    modified?: Date | string | number;
    messageCount?: number;
    firstMessage?: string;
    name?: string;
}

function modifiedTime(value: Date | string | number | undefined): number {
    if (value instanceof Date) return value.getTime();
    if (typeof value === "number") return Number.isFinite(value) ? value : 0;
    if (typeof value !== "string") return 0;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : 0;
}

async function mapWithConcurrency<Value, Result>(
    values: Value[],
    concurrency: number,
    mapper: (value: Value, index: number) => Promise<Result>,
): Promise<Result[]> {
    const results: Result[] = new Array(values.length);
    let nextIndex = 0;
    async function worker(): Promise<void> {
        while (nextIndex < values.length) {
            const index = nextIndex++;
            results[index] = await mapper(values[index], index);
        }
    }
    const workerCount = Math.min(Math.max(1, concurrency), values.length);
    await Promise.all(Array.from({ length: workerCount }, () => worker()));
    return results;
}

export async function listRecentResumableSessions(
    cwd: string,
    sessionStore: FileSessionStore,
): Promise<ResumableSessionSummary[]> {
    const listed = await listCatalogSafeRootSessionLocators(cwd, { recentLimit: RECENT_SESSION_LIMIT });
    const recentLocators = listed.locators.toSorted((left, right) => {
        const timeDifference = modifiedTime(right.modified || right.headerTimestamp || undefined) -
            modifiedTime(left.modified || left.headerTimestamp || undefined);
        return timeDifference || right.sessionPath.localeCompare(left.sessionPath);
    }).filter((locator) => {
        const session = sessionStore.findSessionByLocator({ transcriptPath: locator.sessionPath });
        if (!session) return true;
        if (session.archivedAt) return false;
        const isRepairSegment = sessionStore.listSessionTranscriptSegments(session.runwieldSessionId).some(
            (segment) => segment.transcriptPath === locator.sessionPath && segment.kind === "semantic_repair",
        );
        if (isRepairSegment) return false;
        return sessionStore.inspectSessionActivation(session.runwieldSessionId).activation?.state !== "active";
    }).slice(0, RECENT_SESSION_LIMIT);
    const summaries = await mapWithConcurrency(
        recentLocators,
        RESUME_READ_CONCURRENCY,
        async (locator): Promise<ResumableSessionSummary | null> => {
            try {
                const evidence = await captureTranscriptEvidence({
                    transcriptPath: locator.sessionPath,
                    transcriptCwd: locator.headerCwd,
                });
                const info = buildProjectedSessionInfo(evidence.entries, {
                    sessionId: locator.piSessionId,
                    cwd: locator.headerCwd,
                    transcriptPath: locator.sessionPath,
                });
                const summary = summarizeResumableTranscript(evidence.entries);
                if (!info.name?.trim() && !summary.firstMessage?.trim()) return null;
                return {
                    id: locator.piSessionId,
                    path: locator.sessionPath,
                    cwd: locator.headerCwd,
                    modified: locator.modified || locator.headerTimestamp || undefined,
                    messageCount: summary.messageCount,
                    firstMessage: summary.firstMessage,
                    name: info.name || undefined,
                };
            } catch {
                return null;
            }
        },
    );
    return summaries.filter((summary): summary is ResumableSessionSummary => summary !== null);
}
