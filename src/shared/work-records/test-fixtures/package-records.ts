import type { WorkRecordFrontMatter } from "@runwield/plans/work-records";
import { makeValidationCheckpoint } from "../../workflow/validation-checkpoint.ts";
export function recordAttrs(overrides: Partial<WorkRecordFrontMatter> = {}): WorkRecordFrontMatter {
    return {
        kind: "work_record",
        recordId: crypto.randomUUID(),
        status: "approved",
        scope: "planned_change",
        origin: "internal",
        completionMode: "verified",
        createdAt: "2026-11-01T00:00:00.000Z",
        provenance: { sourcePlans: ["plan-one"] },
        ...overrides,
    };
}
export const recordBody = "# Durable outcome\n\n## Summary\n\nCanonical evidence.\n";

export function recorderCheckpoint(attemptId: string, cwd: string, recordId: string) {
    const generation = crypto.randomUUID();
    return makeValidationCheckpoint({
        attemptId,
        generation,
        status: "reviewed",
        phase: "delivery",
        state: "running",
        hostRecorder: {
            recordId,
            invalidSubmissions: 0,
            request: {
                kind: "recorder",
                identity: { attemptId, generation },
                cwd,
                prompt: "Prior Recorder request",
            },
        },
    });
}
