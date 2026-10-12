/** Failure-isolated package call. This entry is used only by the export scheduler. */
import { toFileUrl } from "@std/path";
import type { MetricsExportCredentials } from "./metrics-export-grants.ts";
import type { MetricsExportObservation } from "./metrics-export-record.ts";

export interface MetricsExportContext {
    endpoint: string;
    externalProject: string;
    credentials: MetricsExportCredentials;
    deadline: number;
}
export type MetricsExportDeliveryResult =
    | { outcome: "accepted"; code?: string }
    | { outcome: "not_accepted"; retry: "retryable" | "needs_correction" | "permanent"; code?: string }
    | { outcome: "uncertain"; code?: string };
export type MetricsExportConfirmResult = { status: "present" | "not_found_yet" | "mismatch" };
export interface MetricsExporterRequest {
    entryPath: string;
    method: "deliver" | "confirm";
    observation: MetricsExportObservation;
    context: MetricsExportContext;
}
interface ExporterModule {
    deliver(o: MetricsExportObservation, c: MetricsExportContext): Promise<MetricsExportDeliveryResult>;
    confirm?: (o: MetricsExportObservation, c: MetricsExportContext) => Promise<MetricsExportConfirmResult>;
}
interface ExportWorkerGlobal {
    onmessage: ((event: MessageEvent<MetricsExporterRequest>) => Promise<void>) | null;
    postMessage(message: MetricsExportDeliveryResult | MetricsExportConfirmResult | { status: "unsupported" }): void;
}
const scope = globalThis as typeof globalThis & ExportWorkerGlobal;
scope.onmessage = async ({ data }) => {
    try {
        const exporter: ExporterModule = await import(toFileUrl(data.entryPath).href);
        const coverage = data.observation.fields.coverage;
        if (coverage && typeof coverage === "object") Object.freeze(coverage);
        Object.freeze(data.observation.fields);
        Object.freeze(data.observation);
        if (data.method === "confirm") {
            scope.postMessage(
                exporter.confirm ? await exporter.confirm(data.observation, data.context) : { status: "unsupported" },
            );
        } else {
            scope.postMessage(await exporter.deliver(data.observation, data.context));
        }
    } catch {
        scope.postMessage({ outcome: "uncertain", code: "exporter_error" });
    }
};
