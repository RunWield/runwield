import { createHash } from "node:crypto";
import type { AgentSession, AgentSessionEvent, CustomEntry, SessionEntry } from "@earendil-works/pi-coding-agent";
import type { HostedSession } from "./hosted-session.js";
import { emitSystemStatus } from "./session-runtime-events.js";

export const LOOP_GUARD_MAX_MODEL_TURNS = 100;
export const LOOP_GUARD_REPEAT_CYCLES = 3;
export const LOOP_GUARD_MAX_CYCLE_LENGTH = 3;

const LOOP_GUARD_TURN_CUSTOM_TYPE = "runwield.loop_guard_turn";
const LOOP_GUARD_TOOL_CUSTOM_TYPE = "runwield.loop_guard_tool";
const LOOP_GUARD_STOP_CUSTOM_TYPE = "runwield.loop_guard_stop";

type GuardEntryData = {
    requestId?: string;
    turnCount?: number;
    signature?: string;
    reason?: string;
};

type RunawayLoopGuardOptions = {
    session: AgentSession;
    requestId: string;
    hostedSession?: HostedSession;
};

type GuardCustomEntry = CustomEntry<GuardEntryData>;

export class RunawayLoopGuardStoppedError extends Error {
    constructor(reason: string) {
        super(`RunWield stopped this request (${reason}). Send a new instruction to continue.`);
        this.name = "RunawayLoopGuardStoppedError";
    }
}

export type RunawayLoopGuard = {
    dispose: () => void;
    throwIfStopped: () => void;
};

/**
 * Attach a persistent guard to one Pi request. Only fingerprints and counters
 * are written to the transcript; tool arguments and results are never copied.
 */
export function attachRunawayLoopGuard({
    session,
    requestId,
    hostedSession,
}: RunawayLoopGuardOptions): RunawayLoopGuard {
    const sessionManager = session.sessionManager;
    if (
        !sessionManager ||
        typeof sessionManager.getBranch !== "function" ||
        typeof sessionManager.appendCustomEntry !== "function"
    ) {
        throw new Error("Runaway loop guard requires an AgentSession with a SessionManager");
    }
    const branch = sessionManager.getBranch();

    let modelTurns = branch.reduce((count: number, entry: SessionEntry) => {
        if (!isGuardEntry(entry, LOOP_GUARD_TURN_CUSTOM_TYPE)) return count;
        return entry.data?.requestId === requestId ? Math.max(count, Number(entry.data.turnCount) || 0) : count;
    }, 0);
    const toolHistory = branch
        .filter((entry) => isGuardEntry(entry, LOOP_GUARD_TOOL_CUSTOM_TYPE))
        .map((entry) => entry.data)
        .filter(
            (entry): entry is GuardEntryData => entry?.requestId === requestId && typeof entry.signature === "string",
        )
        .slice(-LOOP_GUARD_MAX_CYCLE_LENGTH * LOOP_GUARD_REPEAT_CYCLES)
        .map((entry) => entry.signature || "");
    const priorStop = branch
        .filter((entry) => isGuardEntry(entry, LOOP_GUARD_STOP_CUSTOM_TYPE))
        .map((entry) => entry.data)
        .filter((entry) => entry?.requestId === requestId && typeof entry.reason === "string")
        .at(-1);
    let stopReason = priorStop?.reason;
    let stopped = Boolean(stopReason);
    const toolArguments = new Map<string, string>();

    const stop = (reason: string, message: string): void => {
        if (stopped) return;
        stopped = true;
        stopReason = reason;
        sessionManager.appendCustomEntry(LOOP_GUARD_STOP_CUSTOM_TYPE, {
            version: 1,
            requestId,
            reason,
            stoppedAt: new Date().toISOString(),
        });
        emitSystemStatus(hostedSession, message, { level: "warning", header: "RunWield" });
        try {
            session.abort();
        } catch (_error) {
            // The provider may already have finished the current turn.
        }
    };

    const reserveModelTurn = () => {
        if (modelTurns >= LOOP_GUARD_MAX_MODEL_TURNS) {
            stop(
                "model_turn_limit",
                `Stopped this request after ${LOOP_GUARD_MAX_MODEL_TURNS} model requests. Your Session is saved; send a new instruction to continue.`,
            );
            return;
        }
        modelTurns += 1;
        sessionManager.appendCustomEntry(LOOP_GUARD_TURN_CUSTOM_TYPE, {
            version: 1,
            requestId,
            turnCount: modelTurns,
        });
    };

    const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
        if (stopped) return;
        if (event.type === "turn_start") {
            reserveModelTurn();
            return;
        }
        if (event.type !== "tool_execution_end") return;

        const args = toolArguments.get(event.toolCallId) ?? "";
        const result = JSON.stringify(event.result, (_key, value) =>
            value && typeof value === "object" && !Array.isArray(value)
                ? Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)))
                : value,
        );
        const signature = createHash("sha256")
            .update(`${event.toolName}\u0000${args}\u0000${result ?? "undefined"}\u0000${Boolean(event.isError)}`)
            .digest("hex");
        toolHistory.push(signature);
        if (toolHistory.length > LOOP_GUARD_MAX_CYCLE_LENGTH * LOOP_GUARD_REPEAT_CYCLES) toolHistory.shift();
        sessionManager.appendCustomEntry(LOOP_GUARD_TOOL_CUSTOM_TYPE, {
            version: 1,
            requestId,
            signature,
        });

        const cycleLength = repeatedCycleLength(toolHistory);
        if (cycleLength === 1) {
            stop(
                "repeated_tool_result",
                `Stopped this request after the same tool call and result repeated ${LOOP_GUARD_REPEAT_CYCLES} times. Your Session is saved; send a new instruction to continue.`,
            );
        } else if (cycleLength > 1) {
            stop(
                "repeating_tool_cycle",
                `Stopped this request after a ${cycleLength}-step tool cycle repeated ${LOOP_GUARD_REPEAT_CYCLES} times. Your Session is saved; send a new instruction to continue.`,
            );
        }
        toolArguments.delete(event.toolCallId);
    });

    const unsubscribeToolArguments = session.subscribe((event: AgentSessionEvent) => {
        if (event.type === "tool_execution_start") {
            const args = JSON.stringify(event.args, (_key, value) =>
                value && typeof value === "object" && !Array.isArray(value)
                    ? Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)))
                    : value,
            );
            toolArguments.set(event.toolCallId, args ?? "undefined");
        }
    });

    return {
        dispose: () => {
            unsubscribe();
            unsubscribeToolArguments();
        },
        throwIfStopped: () => {
            if (stopReason) throw new RunawayLoopGuardStoppedError(stopReason);
        },
    };
}

function isGuardEntry(entry: SessionEntry, customType: string): entry is GuardCustomEntry {
    return entry.type === "custom" && entry.customType === customType;
}

function repeatedCycleLength(history: string[]): number {
    for (let cycleLength = 1; cycleLength <= LOOP_GUARD_MAX_CYCLE_LENGTH; cycleLength += 1) {
        const needed = cycleLength * LOOP_GUARD_REPEAT_CYCLES;
        if (history.length < needed) continue;
        const start = history.length - needed;
        let repeats = true;
        for (let index = cycleLength; index < needed; index += 1) {
            if (history[start + index] !== history[start + (index % cycleLength)]) {
                repeats = false;
                break;
            }
        }
        if (repeats) return cycleLength;
    }
    return 0;
}
