import type { SessionManager } from "@earendil-works/pi-coding-agent";

export const BACKEND_CONTINUATION_REQUEST = "Continue the active agent task after the previous backend failed.";
export const INTERRUPTED_CONTINUATION_REQUEST = "Continue the active agent task from the saved Session context.";

export type RequestDispatchKind =
    "interactive" | "plan_execution" | "quick_fix" | "validation_repair" | "background_task_result";

export type RequestPromptMode = "original" | "continuation";
export type RequestAttemptPhase = "started" | "completed" | "failed";

export interface RequestAttemptEntry {
    version: 1;
    requestId: string;
    attemptId: string;
    requestHash: string;
    dispatchKind: RequestDispatchKind;
    backend: string;
    phase: RequestAttemptPhase;
    promptMode: RequestPromptMode;
    requestRecorded: boolean;
    taskId?: string;
}

export interface PreparedRequestDispatch {
    requestId: string;
    attemptId: string;
    userRequest: string;
    promptMode: RequestPromptMode;
    requestHash: string;
    dispatchKind: RequestDispatchKind;
    backend: string;
    requestRecorded: boolean;
    taskId?: string;
}

export interface PrepareRequestDispatchOptions {
    userRequest: string;
    dispatchKind: RequestDispatchKind;
    backend: string;
    taskId?: string;
    /** True only when the caller explicitly continues the preceding unfinished request. */
    resumePreviousRequest?: boolean;
}

interface LocatedRequestAttempt {
    attempt: RequestAttemptEntry;
    entryIndex: number;
}

interface TranscriptCustomEntry {
    type?: string;
    customType?: string;
    data?: RequestAttemptEntry;
}

/**
 * Start one backend attempt. A failed request keeps its request ID. The next
 * attempt gets a new attempt ID and sends a small continuation prompt when the
 * original user message is already in the transcript.
 */
export function prepareRequestDispatch(
    sessionManager: SessionManager,
    options: PrepareRequestDispatchOptions,
): PreparedRequestDispatch {
    const userRequestHash = hashRequest(options.userRequest);
    const previous = readLatestUnfinishedAttempt(sessionManager);
    const matchesPreviousScope =
        previous?.attempt.dispatchKind === options.dispatchKind &&
        (options.taskId
            ? previous.attempt.taskId === options.taskId ||
              (previous.attempt.taskId === undefined && previous.attempt.requestHash === userRequestHash)
            : previous.attempt.taskId === undefined && previous.attempt.requestHash === userRequestHash);
    const continuesPreviousRequest = matchesPreviousScope && options.resumePreviousRequest === true;
    const continuedAttempt = previous && continuesPreviousRequest ? previous.attempt : null;
    const requestRecorded =
        continuedAttempt && previous
            ? continuedAttempt.requestRecorded || hasUserMessageAfter(sessionManager, previous.entryIndex)
            : false;
    const requestHash = continuedAttempt?.requestHash || userRequestHash;
    const requestId = continuedAttempt ? continuedAttempt.requestId : `request:${crypto.randomUUID()}`;
    const promptMode: RequestPromptMode = continuedAttempt && requestRecorded ? "continuation" : "original";
    const continuationRequest =
        continuedAttempt?.phase === "started" ? INTERRUPTED_CONTINUATION_REQUEST : BACKEND_CONTINUATION_REQUEST;
    const prepared: PreparedRequestDispatch = {
        requestId,
        attemptId: `attempt:${crypto.randomUUID()}`,
        userRequest: promptMode === "continuation" ? continuationRequest : options.userRequest,
        promptMode,
        requestRecorded,
        requestHash,
        dispatchKind: options.dispatchKind,
        backend: options.backend,
        ...(options.taskId || continuedAttempt?.taskId ? { taskId: options.taskId || continuedAttempt?.taskId } : {}),
    };
    appendAttempt(sessionManager, prepared, "started", requestRecorded);
    return prepared;
}

export function completeRequestDispatch(sessionManager: SessionManager, prepared: PreparedRequestDispatch): void {
    appendAttempt(sessionManager, prepared, "completed", true);
}

export function failRequestDispatch(
    sessionManager: SessionManager,
    prepared: PreparedRequestDispatch,
    requestRecorded: boolean,
): void {
    appendAttempt(sessionManager, prepared, "failed", requestRecorded || prepared.requestRecorded);
}

export function readRequestAttemptEntries(sessionManager: SessionManager): RequestAttemptEntry[] {
    return sessionManager
        .getBranch()
        .filter((entry) => entry.type === "custom" && entry.customType === "runwield.request_attempt")
        .map((entry) => (entry as TranscriptCustomEntry).data)
        .filter((entry): entry is RequestAttemptEntry => Boolean(entry));
}

export function recordRequestAttemptSnapshot(sessionManager: SessionManager, attempt: RequestAttemptEntry): void {
    sessionManager.appendCustomEntry("runwield.request_attempt", { ...attempt });
}

function appendAttempt(
    sessionManager: SessionManager,
    prepared: PreparedRequestDispatch,
    phase: RequestAttemptPhase,
    requestRecorded: boolean,
): void {
    sessionManager.appendCustomEntry("runwield.request_attempt", {
        version: 1,
        requestId: prepared.requestId,
        attemptId: prepared.attemptId,
        requestHash: prepared.requestHash,
        dispatchKind: prepared.dispatchKind,
        backend: prepared.backend,
        phase,
        promptMode: prepared.promptMode,
        requestRecorded,
        ...(prepared.taskId ? { taskId: prepared.taskId } : {}),
    } satisfies RequestAttemptEntry);
}

function readLatestUnfinishedAttempt(sessionManager: SessionManager): LocatedRequestAttempt | null {
    const entries = sessionManager.getBranch();
    for (let entryIndex = entries.length - 1; entryIndex >= 0; entryIndex -= 1) {
        const entry = entries[entryIndex];
        if (entry.type !== "custom" || entry.customType !== "runwield.request_attempt") continue;
        const attempt = (entry as TranscriptCustomEntry).data;
        if (!attempt || (attempt.phase !== "started" && attempt.phase !== "failed")) return null;
        return { attempt, entryIndex };
    }
    return null;
}

function hasUserMessageAfter(sessionManager: SessionManager, entryIndex: number): boolean {
    return sessionManager
        .getBranch()
        .slice(entryIndex + 1)
        .some((entry) => {
            if (entry.type !== "message") return false;
            return entry.message.role === "user";
        });
}

function hashRequest(value: string): string {
    const mask = (1n << 128n) - 1n;
    let hash = 0x6c62272e07bb014262b821756295c58dn;
    for (let index = 0; index < value.length; index += 1) {
        hash ^= BigInt(value.charCodeAt(index));
        hash = (hash * 0x1000000000000000000013bn) & mask;
    }
    return hash.toString(16).padStart(32, "0");
}
