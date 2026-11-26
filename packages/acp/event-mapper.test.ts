import { deepStrictEqual } from "node:assert/strict";
import { test } from "node:test";
import type { RuntimeValidationProgress } from "@runwield/session-runtime/events";
import { mapRuntimeEventToAcpUpdate } from "./event-mapper.ts";

test("ACP event mapper forwards structured validation progress", () => {
    const progress: RuntimeValidationProgress = {
        kind: "workflow",
        outcome: "paused",
        stage: "engineer_repair",
        cycle: 1,
        maxCycles: 3,
        totalCycle: 1,
        repairAttempt: 1,
        maxRepairAttempts: 3,
        checks: { ci: "failed", semanticReview: "pending", humanReview: "pending", merge: "pending" },
        message: "Awaiting Engineer continuation.",
    };
    const update = mapRuntimeEventToAcpUpdate({
        type: "system_status",
        sessionId: "session-1",
        timestamp: "now",
        messageId: "status-1",
        message: "Validation paused.",
        level: "warning",
        validationProgress: progress,
    });
    deepStrictEqual(update?._meta, {
        runwield: { type: "system_status", level: "warning", validationProgress: progress },
    });
});
