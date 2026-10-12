import { assertEquals } from "../../testing/assertions.ts";
import { getCwd } from "../../constants.js";
import { test } from "node:test";
import { notDeepStrictEqual as assertNotEquals } from "node:assert/strict";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
    BACKEND_CONTINUATION_REQUEST,
    completeRequestDispatch,
    failRequestDispatch,
    prepareRequestDispatch,
    readRequestAttemptEntries,
} from "./request-dispatch.ts";

function appendUserMessage(manager: SessionManager, text: string): void {
    manager.appendMessage({
        role: "user",
        timestamp: Date.now(),
        content: [{ type: "text", text }],
    });
}

function transcriptText(manager: SessionManager): string {
    return manager.getBranch()
        .filter((entry) => entry.type === "message")
        .flatMap((entry) =>
            (entry as { message?: { content?: Array<{ type: string; text?: string }> } }).message?.content || []
        )
        .filter((block) => block.type === "text")
        .map((block) => block.text || "")
        .join("\n");
}

test("Plan backend retry keeps one Plan body and uses a stable request ID", () => {
    const manager = SessionManager.inMemory(getCwd());
    const planBody = "# Plan body\n\nImplement the approved change.";
    const first = prepareRequestDispatch(manager, {
        userRequest: planBody,
        dispatchKind: "plan_execution",
        backend: "claude-cli",
    });
    appendUserMessage(manager, first.userRequest);
    failRequestDispatch(manager, first, true);

    const retry = prepareRequestDispatch(manager, {
        userRequest: planBody,
        dispatchKind: "plan_execution",
        backend: "pi",
    });
    appendUserMessage(manager, retry.userRequest);
    completeRequestDispatch(manager, retry);

    assertEquals(retry.requestId, first.requestId);
    assertNotEquals(retry.attemptId, first.attemptId);
    assertEquals(retry.userRequest, BACKEND_CONTINUATION_REQUEST);
    assertEquals(transcriptText(manager).split(planBody).length - 1, 1);
    assertEquals(transcriptText(manager).split(BACKEND_CONTINUATION_REQUEST).length - 1, 1);
    const attempts = readRequestAttemptEntries(manager);
    assertEquals(attempts.map((entry) => entry.phase), ["started", "failed", "started", "completed"]);
    assertEquals(attempts[1].backend, "claude-cli");
    assertEquals(attempts[2].backend, "pi");
});

test("backend retry continuation does not name a specific active agent", () => {
    const manager = SessionManager.inMemory(getCwd());
    const userRequest = "Design the implementation boundary.";
    const first = prepareRequestDispatch(manager, {
        userRequest,
        dispatchKind: "interactive",
        backend: "claude-cli",
    });
    appendUserMessage(manager, first.userRequest);
    failRequestDispatch(manager, first, true);

    const retry = prepareRequestDispatch(manager, {
        userRequest,
        dispatchKind: "interactive",
        backend: "pi",
    });

    assertEquals(retry.promptMode, "continuation");
    assertEquals(retry.userRequest.includes("Engineer"), false);
    assertEquals(retry.userRequest.includes("Architect"), false);
});

test("validation repair retry keeps one original repair packet", () => {
    const manager = SessionManager.inMemory(getCwd());
    const repairPacket = "Validation repair packet\nFailure: expected 1, got 2";
    const first = prepareRequestDispatch(manager, {
        userRequest: repairPacket,
        dispatchKind: "validation_repair",
        backend: "claude-cli",
    });
    appendUserMessage(manager, first.userRequest);
    failRequestDispatch(manager, first, true);

    const retry = prepareRequestDispatch(manager, {
        userRequest: repairPacket,
        dispatchKind: "validation_repair",
        backend: "claude-cli",
    });
    appendUserMessage(manager, retry.userRequest);
    completeRequestDispatch(manager, retry);

    assertEquals(retry.requestId, first.requestId);
    assertEquals(transcriptText(manager).split(repairPacket).length - 1, 1);
    assertEquals(retry.promptMode, "continuation");
});

test("failure before transcript recording safely resends the original request", () => {
    const manager = SessionManager.inMemory(getCwd());
    const first = prepareRequestDispatch(manager, {
        userRequest: "original",
        dispatchKind: "quick_fix",
        backend: "claude-cli",
    });
    failRequestDispatch(manager, first, false);

    const retry = prepareRequestDispatch(manager, {
        userRequest: "original",
        dispatchKind: "quick_fix",
        backend: "pi",
    });

    assertEquals(retry.requestId, first.requestId);
    assertEquals(retry.userRequest, "original");
    assertEquals(retry.promptMode, "original");
});
