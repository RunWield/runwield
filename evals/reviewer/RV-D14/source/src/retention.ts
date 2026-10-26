import type { HistoryRecord } from "./model.ts";

export async function pruneHistory(_root: string, _now: Date): Promise<HistoryRecord[]> {
    throw new Error("History pruning is not available yet");
}
