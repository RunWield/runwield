import { getCwd } from "../../constants.js";
import { test } from "node:test";
import { assertEquals, assertThrows } from "../../testing/assertions.ts";
import { HostedSession } from "./hosted-session.js";
import {
    createSessionRuntimeEvent,
    emitHostedSessionRuntimeEvent,
    normalizeRuntimeToolResult,
    normalizeRuntimeUsage,
    RuntimeEventTypes,
} from "./session-runtime-events.js";

test("Runtime normalizes one complete structured tool result for every consumer", () => {
    assertEquals(
        normalizeRuntimeToolResult({
            content: [
                { type: "text", text: "hello" },
                { type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
                { type: "text", text: " world" },
            ],
            details: { truncation: { truncated: true }, fullOutputPath: "/tmp/full.log" },
        }),
        {
            content: [
                { type: "text", text: "hello" },
                { type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
                { type: "text", text: " world" },
            ],
            output: "hello world",
            details: { truncation: { truncated: true }, fullOutputPath: "/tmp/full.log" },
        },
    );
    assertEquals(normalizeRuntimeToolResult({ internal: true }), {
        content: [],
        output: "",
        details: null,
    });
});

test("Runtime suppresses binary read output for display without dropping content", () => {
    const normalized = normalizeRuntimeToolResult({
        content: [{ type: "text", text: "DIRC\u0000\u0007binary" }],
        details: { runwieldDisplay: "binary_display_suppressed" },
    });

    assertEquals(normalized.content, [{ type: "text", text: "DIRC\u0000\u0007binary" }]);
    assertEquals(normalized.output, "");
    assertEquals(normalized.details, { runwieldDisplay: "binary_display_suppressed" });
});

test("Runtime hides model-only image omission notes when TUI display image exists", () => {
    const text = [
        "Read image file [image/png]",
        "[Image omitted: could not be resized below the inline image size limit.]",
        "[Current model does not support images. The image will be omitted from this request.]",
    ].join("\n");
    const normalized = normalizeRuntimeToolResult({
        content: [{ type: "text", text }],
        details: { runwieldDisplayImages: [{ base64: "abc", mimeType: "image/png" }] },
    });

    assertEquals(normalized.content, [{ type: "text", text }]);
    assertEquals(normalized.output, "Read image file [image/png]");
    assertEquals(normalized.details, { runwieldDisplayImages: [{ base64: "abc", mimeType: "image/png" }] });
});

test("Runtime normalizes provider usage once", () => {
    assertEquals(
        normalizeRuntimeUsage({
            input: 12,
            output: 4,
            cacheRead: 3,
            cacheWrite: 2,
            cost: { total: 0.25 },
            context_window: 128000,
        }),
        {
            inputTokens: 12,
            outputTokens: 4,
            cacheReadTokens: 3,
            cacheWriteTokens: 2,
            costUsd: 0.25,
            contextWindow: 128000,
        },
    );
});

test("Runtime event factory supplies shared identity defaults and rejects partial semantic events", () => {
    const userEvent = createSessionRuntimeEvent("session-1", {
        type: RuntimeEventTypes.USER_MESSAGE,
        text: "hello",
    });
    assertEquals(userEvent.type, RuntimeEventTypes.USER_MESSAGE);
    if (userEvent.type !== RuntimeEventTypes.USER_MESSAGE) throw new Error("unexpected event type");
    assertEquals(typeof userEvent.messageId, "string");
    assertEquals(userEvent.images, []);

    const workflowContextEvent = createSessionRuntimeEvent("session-1", {
        type: RuntimeEventTypes.WORKFLOW_CONTEXT_CHANGED,
        workflowContext: { routingIntent: "QUICK_FIX", complexity: "LOW" },
    });
    assertEquals(workflowContextEvent.type, RuntimeEventTypes.WORKFLOW_CONTEXT_CHANGED);

    const keyboardHelpEvent = createSessionRuntimeEvent("session-1", {
        type: RuntimeEventTypes.KEYBOARD_HELP,
        title: "Keyboard shortcuts",
        items: [{ key: "?", description: "show help" }],
    });
    assertEquals(keyboardHelpEvent.type, RuntimeEventTypes.KEYBOARD_HELP);
    if (keyboardHelpEvent.type !== RuntimeEventTypes.KEYBOARD_HELP) throw new Error("unexpected event type");
    assertEquals(keyboardHelpEvent.items, [{ key: "?", description: "show help" }]);

    const agentChangedEvent = createSessionRuntimeEvent("session-1", {
        type: RuntimeEventTypes.AGENT_CHANGED,
        agentName: "operator",
        displayName: "Operator",
        rootHandoff: true,
    });
    assertEquals(agentChangedEvent.type, RuntimeEventTypes.AGENT_CHANGED);
    assertEquals(/** @type {any} */ (agentChangedEvent).displayName, "Operator");
    assertEquals(/** @type {any} */ (agentChangedEvent).rootHandoff, true);

    assertThrows(
        () =>
            createSessionRuntimeEvent("session-1", {
                type: RuntimeEventTypes.TOOL_UPDATE,
                toolCallId: "tool-1",
                toolName: "bash",
                output: "partial",
            }),
        TypeError,
        "title must be a string",
    );
    assertThrows(
        () =>
            createSessionRuntimeEvent("session-1", {
                type: RuntimeEventTypes.WORKFLOW_CONTEXT_CHANGED,
                workflowContext: { routingIntent: "FEATURE" },
            }),
        TypeError,
        "routingIntent and complexity must be provided together",
    );
    assertThrows(
        () =>
            createSessionRuntimeEvent("session-1", {
                type: RuntimeEventTypes.KEYBOARD_HELP,
                title: "Keyboard shortcuts",
                items: [{ key: "", description: "show help" }],
            }),
        TypeError,
        "item.key must be non-empty",
    );
    assertThrows(
        () =>
            createSessionRuntimeEvent("session-1", {
                type: RuntimeEventTypes.KEYBOARD_HELP,
                title: "Keyboard shortcuts",
                items: [],
            }),
        TypeError,
        "items must be non-empty",
    );
    assertThrows(
        () =>
            createSessionRuntimeEvent(
                "session-1",
                /** @type {any} */ ({
                    type: RuntimeEventTypes.AGENT_CHANGED,
                    agentName: "operator",
                    rootHandoff: "yes",
                }),
            ),
        TypeError,
        "rootHandoff must be boolean",
    );
});

test("Runtime accepts complete validation progress snapshots on system status", () => {
    const event = createSessionRuntimeEvent("session-1", {
        type: RuntimeEventTypes.SYSTEM_STATUS,
        message: "Starting Validation Cycle 1/3",
        validationProgress: {
            kind: "workflow",
            outcome: "running",
            stage: "cycle",
            cycle: 1,
            maxCycles: 3,
            totalCycle: 1,
            checks: {
                ci: "pending",
                semanticReview: "pending",
                humanReview: "pending",
                merge: "pending",
            },
        },
    });
    assertEquals(event.type, RuntimeEventTypes.SYSTEM_STATUS);
    assertEquals(/** @type {any} */ (event).validationProgress?.kind, "workflow");
});

test("Runtime rejects malformed validation progress snapshots", () => {
    const base = /** @type {any} */ ({
        type: RuntimeEventTypes.SYSTEM_STATUS,
        message: "bad",
        validationProgress: {
            kind: "mechanical",
            outcome: "verified",
            stage: "terminal",
            repairAttempt: 2,
            maxRepairAttempts: 3,
            checks: {
                ci: "passed",
                semanticReview: "skipped",
                humanReview: "skipped",
                merge: "skipped",
            },
        },
    });
    assertThrows(
        () =>
            createSessionRuntimeEvent("session-1", {
                ...base,
                validationProgress: { ...base.validationProgress, outcome: "done" },
            }),
        TypeError,
        "validationProgress.outcome is invalid",
    );
    assertThrows(
        () =>
            createSessionRuntimeEvent("session-1", {
                ...base,
                validationProgress: { ...base.validationProgress, cycle: 4, maxCycles: 3 },
            }),
        TypeError,
        "validationProgress.cycle must be <= maxCycles",
    );
    assertThrows(
        () =>
            createSessionRuntimeEvent("session-1", {
                ...base,
                validationProgress: {
                    ...base.validationProgress,
                    checks: { ...base.validationProgress.checks, semanticReview: "pending" },
                },
            }),
        TypeError,
        "mechanical validation must skip non-CI checks",
    );
    assertThrows(
        () =>
            createSessionRuntimeEvent("session-1", {
                ...base,
                validationProgress: { ...base.validationProgress, maxRepairAttempts: 3, repairAttempt: undefined },
            }),
        TypeError,
        "repairAttempt and maxRepairAttempts must be provided together",
    );
    assertThrows(
        () =>
            createSessionRuntimeEvent("session-1", {
                ...base,
                validationProgress: {
                    kind: "workflow",
                    outcome: "verified",
                    stage: "terminal",
                    cycle: 1,
                    maxCycles: 3,
                    totalCycle: 1,
                    checks: { ci: "passed", semanticReview: "pending", humanReview: "skipped", merge: "skipped" },
                },
            }),
        TypeError,
        "terminal validation outcome cannot have pending checks",
    );
    assertThrows(
        () =>
            createSessionRuntimeEvent("session-1", {
                ...base,
                validationProgress: {
                    kind: "workflow",
                    outcome: "verified",
                    stage: "terminal",
                    cycle: 1,
                    maxCycles: 3,
                    totalCycle: 1,
                    checks: { ci: "passed", semanticReview: "failed", humanReview: "skipped", merge: "skipped" },
                },
            }),
        TypeError,
        "verified validation outcome cannot have failed or canceled checks",
    );
    assertThrows(
        () =>
            createSessionRuntimeEvent("session-1", {
                ...base,
                validationProgress: {
                    kind: "workflow",
                    outcome: "failed",
                    stage: "terminal",
                    cycle: 1,
                    maxCycles: 3,
                    totalCycle: 1,
                    checks: { ci: "passed", semanticReview: "passed", humanReview: "skipped", merge: "skipped" },
                },
            }),
        TypeError,
        "failed validation outcome requires a failed or canceled check",
    );
    assertThrows(
        () =>
            createSessionRuntimeEvent("session-1", {
                ...base,
                validationProgress: {
                    kind: "workflow",
                    outcome: "running",
                    stage: "semantic_review",
                    cycle: 1,
                    maxCycles: 3,
                    totalCycle: 1,
                    checks: { ci: "passed", semanticReview: "skipped", humanReview: "pending", merge: "pending" },
                },
            }),
        TypeError,
        "semantic_review stage requires active or completed semantic review",
    );
});

test("internal event sink contract failures are not swallowed as consumer failures", () => {
    const session = new HostedSession({ id: "sink-errors", cwd: getCwd() });
    session.setEventSink(() => {
        throw new TypeError("invalid producer event");
    });
    assertThrows(
        () => emitHostedSessionRuntimeEvent(session, { type: RuntimeEventTypes.BUSY_CHANGED, busy: true }),
        TypeError,
        "invalid producer event",
    );
});

test("Runtime event factory validates session replacement events", () => {
    const event = createSessionRuntimeEvent("old-session", {
        type: RuntimeEventTypes.SESSION_REPLACED,
        oldSessionId: "old-session",
        newSessionId: "new-session",
        reason: "epic_continuation",
        parentPlanName: "epic",
        completedPlanName: "epic/01-done",
        childPlanName: "epic/02-next",
        action: "execute",
    });
    assertEquals(event.type, RuntimeEventTypes.SESSION_REPLACED);
    if (event.type !== RuntimeEventTypes.SESSION_REPLACED) throw new Error("unexpected event type");
    assertEquals(event.newSessionId, "new-session");

    const followUpEvent = createSessionRuntimeEvent("old-session", {
        type: RuntimeEventTypes.SESSION_REPLACED,
        oldSessionId: "old-session",
        newSessionId: "follow-up-session",
        reason: "execution_follow_up",
        planName: "follow-up",
    });
    assertEquals(followUpEvent.type, RuntimeEventTypes.SESSION_REPLACED);
    if (followUpEvent.type !== RuntimeEventTypes.SESSION_REPLACED) throw new Error("unexpected event type");
    assertEquals(followUpEvent.newSessionId, "follow-up-session");

    assertThrows(
        () =>
            createSessionRuntimeEvent(
                "old-session",
                /** @type {any} */ ({
                    type: RuntimeEventTypes.SESSION_REPLACED,
                    oldSessionId: "old-session",
                    newSessionId: "new-session",
                    reason: "manual",
                    parentPlanName: "epic",
                    completedPlanName: "epic/01-done",
                    childPlanName: "epic/02-next",
                    action: "execute",
                }),
            ),
        TypeError,
        "reason is invalid",
    );
});

test("Runtime attention reasons use shared notification vocabulary without TUI-only compaction", () => {
    for (const reason of /** @type {const} */ (["agentStopped", "planWritten", "userInterview"])) {
        const event = createSessionRuntimeEvent("session-1", {
            type: RuntimeEventTypes.ATTENTION_REQUESTED,
            reason,
        });
        if (event.type !== RuntimeEventTypes.ATTENTION_REQUESTED) throw new Error("unexpected event type");
        assertEquals(event.reason, reason);
    }
    assertThrows(
        () =>
            createSessionRuntimeEvent(
                "session-1",
                /** @type {any} */ ({
                    type: RuntimeEventTypes.ATTENTION_REQUESTED,
                    reason: "compactionFinished",
                }),
            ),
        TypeError,
        "reason is invalid",
    );
});

test("Runtime sync state event is sanitized and validated", () => {
    const event = createSessionRuntimeEvent("session-1", {
        type: RuntimeEventTypes.MANAGED_SYNC_STATE_CHANGED,
        status: "active_elsewhere",
        localGeneration: 1,
        latestGeneration: 2,
        owningSurfaceKind: "workspace",
    });
    assertEquals(event.type, RuntimeEventTypes.MANAGED_SYNC_STATE_CHANGED);
    if (event.type !== RuntimeEventTypes.MANAGED_SYNC_STATE_CHANGED) throw new Error("unexpected event type");
    assertEquals(event.owningSurfaceKind, "workspace");
    assertThrows(
        () =>
            createSessionRuntimeEvent(
                "session-1",
                /** @type {any} */ ({
                    type: RuntimeEventTypes.MANAGED_SYNC_STATE_CHANGED,
                    status: "current",
                    localGeneration: 1,
                    latestGeneration: 1,
                    ownerInstanceId: "secret",
                }),
            ),
        TypeError,
        "ownerInstanceId",
    );
});
