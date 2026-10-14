import { getCwd } from "../../constants.js";
import { test } from "node:test";
import { assertEquals, assertThrows } from "../../testing/assertions.ts";

import { HostedSession } from "../session/hosted-session.js";
import { createSessionRuntimeEvent } from "../session/session-runtime-events.js";
import {
    createValidationProgress,
    emitRunWieldSystemStatus,
    getCurrentValidationProgress,
} from "./validation-progress.ts";

test("rejected validation progress is not cached for later status events", () => {
    const hostedSession = new HostedSession({ id: "rejected-validation-progress", cwd: getCwd() });
    hostedSession.setEventSink((event: Parameters<typeof createSessionRuntimeEvent>[1]) => {
        createSessionRuntimeEvent(hostedSession.id, event);
    });
    const invalid = createValidationProgress({
        kind: "workflow",
        outcome: "running",
        stage: "semantic_review",
        cycle: 1,
        maxCycles: 3,
        totalCycle: 1,
        checks: {
            ci: "passed",
            semanticReview: "pending",
            humanReview: "pending",
            merge: "pending",
        },
    });

    assertThrows(
        () => emitRunWieldSystemStatus(hostedSession, "Starting semantic review.", "info", invalid),
        TypeError,
        "semantic_review stage requires active or completed semantic review",
    );
    assertEquals(getCurrentValidationProgress(hostedSession), undefined);

    emitRunWieldSystemStatus(hostedSession, "Retrying without stale progress.");
    assertEquals(getCurrentValidationProgress(hostedSession), undefined);
});
