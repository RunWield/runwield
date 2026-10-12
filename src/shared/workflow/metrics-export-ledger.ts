/** Durable delivery fences, not a payload queue. */
import { join } from "@std/path";
import { exportDestinationDirectory, metricsExportDirectory, writeExportFile } from "./metrics-export-storage.ts";
import { metricsExportReference } from "./metrics-export-record.ts";
import type { MetricsExportHostIdentity } from "./metrics-export-grants.ts";

export type MetricsDeliveryState = "sending" | "pending" | "accepted" | "confirmed" | "unconfirmed" | "rejected";
export interface MetricsDeliveryItem {
    eventId: string;
    attemptId: string;
    grantId: string;
    projectRef: string;
    journalRef: string;
    historyEpoch: string;
    offset: number;
    state: MetricsDeliveryState;
    at: string;
    code?: string;
    retry?: "retryable" | "needs_correction" | "permanent";
    credentialsRevision: string;
    attempts: number;
    nextAttemptAt?: number;
    confirmations: number;
    confirming?: boolean;
}

export function readMetricsExportLedger(destinationId: string): Map<string, MetricsDeliveryItem> {
    const items = new Map<string, MetricsDeliveryItem>();
    let text;
    try {
        text = Deno.readTextFileSync(join(exportDestinationDirectory(destinationId), "ledger.jsonl"));
    } catch (error) {
        if (error instanceof Deno.errors.NotFound) return items;
        throw error;
    }
    for (const line of text.split("\n").slice(0, -1)) {
        const item: MetricsDeliveryItem = JSON.parse(line);
        items.set(`${item.projectRef}:${item.historyEpoch}:${item.eventId}`, item);
    }
    return items;
}

export function appendMetricsExportLedger(destinationId: string, item: MetricsDeliveryItem): void {
    const path = join(exportDestinationDirectory(destinationId), "ledger.jsonl");
    // A crash may leave only the final append incomplete. Keep all preceding fences.
    try {
        const bytes = Deno.readFileSync(path);
        const end = bytes.lastIndexOf(10) + 1;
        if (end !== bytes.length) Deno.truncateSync(path, end);
    } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
    writeExportFile(path, JSON.stringify(item) + "\n", true);
}

export async function metricsDeliveryInFlightForJournal(path: string): Promise<boolean> {
    let identity: MetricsExportHostIdentity;
    try {
        identity = JSON.parse(Deno.readTextFileSync(join(metricsExportDirectory(), "host.json")));
    } catch (error) {
        if (error instanceof Deno.errors.NotFound) return false;
        throw error;
    }
    const reference = await metricsExportReference(identity, "journal", path);
    let entries;
    try {
        entries = [...Deno.readDirSync(join(metricsExportDirectory(), "destinations"))];
    } catch (error) {
        if (error instanceof Deno.errors.NotFound) return false;
        throw error;
    }
    return entries.filter((e) => e.isDirectory).some((e) =>
        [...readMetricsExportLedger(e.name).values()].some((item) =>
            item.journalRef === reference && (item.state === "sending" || item.confirming)
        )
    );
}

export function metricsDeliveryInFlight(destinationId: string): boolean {
    return [...readMetricsExportLedger(destinationId).values()].some((item) =>
        item.state === "sending" || item.confirming === true
    );
}
