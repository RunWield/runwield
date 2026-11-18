import type { WorkRecordFrontMatter } from "../schema.ts";
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
