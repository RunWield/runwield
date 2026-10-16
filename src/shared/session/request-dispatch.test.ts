import { assertEquals, assertRejects } from "../../testing/assertions.ts";
import { getCwd } from "../../constants.js";
import { test } from "node:test";
import { notDeepStrictEqual as assertNotEquals } from "node:assert/strict";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withRuntimeCommandFixture } from "../../cmd/testing/runtime-command-fixture.ts";
import { HostedSession } from "./hosted-session.js";
import { ensureRootAgentSession, runRootTurn } from "./session.js";
import { RunawayLoopGuardStoppedError } from "./runaway-loop-guard.ts";
import { createValidationSessionPort } from "../workflow/validation-session-adapter.ts";
import {
    BACKEND_CONTINUATION_REQUEST,
    completeRequestDispatch,
    failRequestDispatch,
    INTERRUPTED_CONTINUATION_REQUEST,
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
    return manager
        .getBranch()
        .filter((entry) => entry.type === "message")
        .flatMap(
            (entry) =>
                (entry as { message?: { content?: Array<{ type: string; text?: string }> } }).message?.content || [],
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
        resumePreviousRequest: true,
    });
    appendUserMessage(manager, retry.userRequest);
    completeRequestDispatch(manager, retry);

    assertEquals(retry.requestId, first.requestId);
    assertNotEquals(retry.attemptId, first.attemptId);
    assertEquals(retry.userRequest, BACKEND_CONTINUATION_REQUEST);
    assertEquals(transcriptText(manager).split(planBody).length - 1, 1);
    assertEquals(transcriptText(manager).split(BACKEND_CONTINUATION_REQUEST).length - 1, 1);
    const attempts = readRequestAttemptEntries(manager);
    assertEquals(
        attempts.map((entry) => entry.phase),
        ["started", "failed", "started", "completed"],
    );
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
        resumePreviousRequest: true,
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
        resumePreviousRequest: true,
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
        resumePreviousRequest: true,
    });

    assertEquals(retry.requestId, first.requestId);
    assertEquals(retry.userRequest, "original");
    assertEquals(retry.promptMode, "original");
});

test("explicitly resumed started request keeps identity after disk reopen and recovers stale recorded state", async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), "runwield-request-dispatch-recovery-"));
    const projectRoot = join(fixtureRoot, "project");
    const sessionDir = join(fixtureRoot, "sessions");
    await mkdir(projectRoot, { recursive: true });
    try {
        const manager = SessionManager.create(projectRoot, sessionDir, { id: "request-recovery" });
        const first = prepareRequestDispatch(manager, {
            userRequest: "Continue the interrupted task.",
            dispatchKind: "interactive",
            backend: "pi",
        });
        appendUserMessage(manager, first.userRequest);
        const transcriptPath = manager.getSessionFile();
        if (!transcriptPath) throw new Error("Missing request recovery transcript");

        const reopened = SessionManager.open(transcriptPath, sessionDir, projectRoot);
        const resumed = prepareRequestDispatch(reopened, {
            userRequest: "Continue the interrupted task.",
            dispatchKind: "interactive",
            backend: "pi",
            resumePreviousRequest: true,
        });

        assertEquals(resumed.requestId, first.requestId);
        assertNotEquals(resumed.attemptId, first.attemptId);
        assertEquals(resumed.promptMode, "continuation");
        assertEquals(resumed.userRequest, INTERRUPTED_CONTINUATION_REQUEST);
    } finally {
        await rm(fixtureRoot, { recursive: true, force: true });
    }
});

test("failed and completed requests stay fresh without explicit continuation intent", async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), "runwield-request-dispatch-fresh-"));
    const projectRoot = join(fixtureRoot, "project");
    const sessionDir = join(fixtureRoot, "sessions");
    await mkdir(projectRoot, { recursive: true });
    try {
        const manager = SessionManager.create(projectRoot, sessionDir, { id: "request-fresh" });
        const first = prepareRequestDispatch(manager, {
            userRequest: "Repeat this exact text.",
            dispatchKind: "interactive",
            backend: "pi",
        });
        appendUserMessage(manager, first.userRequest);
        failRequestDispatch(manager, first, true);
        const transcriptPath = manager.getSessionFile();
        if (!transcriptPath) throw new Error("Missing request recovery transcript");

        const reopened = SessionManager.open(transcriptPath, sessionDir, projectRoot);
        const intentionalRepeat = prepareRequestDispatch(reopened, {
            userRequest: "Repeat this exact text.",
            dispatchKind: "interactive",
            backend: "pi",
        });
        assertNotEquals(intentionalRepeat.requestId, first.requestId);

        completeRequestDispatch(reopened, intentionalRepeat);
        const afterCompletion = prepareRequestDispatch(reopened, {
            userRequest: "Repeat this exact text.",
            dispatchKind: "interactive",
            backend: "pi",
            resumePreviousRequest: true,
        });
        assertNotEquals(afterCompletion.requestId, intentionalRepeat.requestId);
    } finally {
        await rm(fixtureRoot, { recursive: true, force: true });
    }
});

test("resuming a Plan is scoped to the same Plan identity", () => {
    const manager = SessionManager.inMemory(getCwd());
    const first = prepareRequestDispatch(manager, {
        userRequest: "Execute the saved plan.",
        dispatchKind: "plan_execution",
        taskId: "plan-a",
        backend: "pi",
    });
    appendUserMessage(manager, first.userRequest);
    failRequestDispatch(manager, first, true);

    const otherPlan = prepareRequestDispatch(manager, {
        userRequest: "Execute the saved plan.",
        dispatchKind: "plan_execution",
        taskId: "plan-b",
        backend: "pi",
        resumePreviousRequest: true,
    });
    assertNotEquals(otherPlan.requestId, first.requestId);

    const samePlanManager = SessionManager.inMemory(getCwd());
    const samePlanFirst = prepareRequestDispatch(samePlanManager, {
        userRequest: "Execute the saved plan.",
        dispatchKind: "plan_execution",
        taskId: "plan-a",
        backend: "pi",
    });
    appendUserMessage(samePlanManager, samePlanFirst.userRequest);
    failRequestDispatch(samePlanManager, samePlanFirst, true);
    const samePlan = prepareRequestDispatch(samePlanManager, {
        userRequest: "Regenerated plan prompt with fresh router context.",
        dispatchKind: "plan_execution",
        taskId: "plan-a",
        backend: "pi",
        resumePreviousRequest: true,
    });
    assertEquals(samePlan.requestId, samePlanFirst.requestId);
});

test("resuming without a task identity requires the original request hash", () => {
    const manager = SessionManager.inMemory(getCwd());
    const first = prepareRequestDispatch(manager, {
        userRequest: "Repair this exact request.",
        dispatchKind: "interactive",
        backend: "pi",
    });
    appendUserMessage(manager, first.userRequest);
    failRequestDispatch(manager, first, true);

    const changedRequest = prepareRequestDispatch(manager, {
        userRequest: "Actually, do this different request.",
        dispatchKind: "interactive",
        backend: "pi",
        resumePreviousRequest: true,
    });
    assertNotEquals(changedRequest.requestId, first.requestId);
});

test("validation repair retries opt into continuation only through the reused repair manager", async () => {
    const hostedSession = new HostedSession({ id: crypto.randomUUID(), cwd: getCwd() });
    const observed: Array<{ resume: boolean; requestId: string }> = [];
    const port = createValidationSessionPort(hostedSession, {
        semanticReviewPort: {
            runIsolatedAgentSession: async (options) => {
                const manager = options.sessionManager as SessionManager;
                const prepared = prepareRequestDispatch(manager, {
                    userRequest: options.userRequest,
                    dispatchKind: "validation_repair",
                    backend: "pi",
                    resumePreviousRequest: options.resumePreviousRequest,
                });
                observed.push({ resume: options.resumePreviousRequest === true, requestId: prepared.requestId });
                if (!options.resumePreviousRequest) appendUserMessage(manager, prepared.userRequest);
                failRequestDispatch(manager, prepared, true);
                return [];
            },
        },
    });
    try {
        const input = {
            kind: "validation" as const,
            agentName: "engineer",
            cwd: getCwd(),
            userRequest: "Repair the failed validation check.",
        };
        await port.runIndependentRepairTurn(input);
        await port.runIndependentRepairTurn(input);
        assertEquals(
            observed.map((entry) => entry.resume),
            [false, true],
        );
        assertEquals(observed[1].requestId, observed[0].requestId);
    } finally {
        hostedSession.dispose();
    }
});

test("explicitly resumed started request resends original when no user message was recorded", () => {
    const manager = SessionManager.inMemory(getCwd());
    const first = prepareRequestDispatch(manager, {
        userRequest: "Not yet recorded",
        dispatchKind: "interactive",
        backend: "pi",
    });

    const resumed = prepareRequestDispatch(manager, {
        userRequest: "Not yet recorded",
        dispatchKind: "interactive",
        backend: "pi",
        resumePreviousRequest: true,
    });

    assertEquals(resumed.requestId, first.requestId);
    assertEquals(resumed.promptMode, "original");
    assertEquals(resumed.userRequest, "Not yet recorded");
});

test("runRootTurn blocks resumed count-100 and saved-stop requests after disk reopen", async () => {
    await withRuntimeCommandFixture(
        "request-dispatch-root-recovery-",
        async ({ projectRoot, homeDir, setModelResponseFactory }) => {
            let modelCalls = 0;
            setModelResponseFactory(() => {
                modelCalls += 1;
                return fauxAssistantMessage(fauxText("Unexpected provider response"));
            });
            const sessionDir = join(homeDir, "sessions");
            const createInterruptedTranscript = (
                id: string,
                withStop: boolean,
                savedTurnCount = 100,
                includeTaskId = true,
            ) => {
                const manager = SessionManager.create(projectRoot, sessionDir, { id });
                const started = prepareRequestDispatch(manager, {
                    userRequest: "Finish the saved Plan execution.",
                    dispatchKind: "plan_execution",
                    ...(includeTaskId ? { taskId: "saved-plan" } : {}),
                    backend: "pi",
                });
                appendUserMessage(manager, started.userRequest);
                if (withStop) {
                    manager.appendCustomEntry("runwield.loop_guard_stop", {
                        version: 1,
                        requestId: started.requestId,
                        reason: "repeated_tool_result",
                    });
                } else {
                    for (let turnCount = 1; turnCount <= savedTurnCount; turnCount += 1) {
                        manager.appendCustomEntry("runwield.loop_guard_turn", {
                            version: 1,
                            requestId: started.requestId,
                            turnCount,
                        });
                    }
                }
                const transcriptPath = manager.getSessionFile();
                if (!transcriptPath) throw new Error("Missing interrupted root transcript");
                return { transcriptPath, requestId: started.requestId };
            };

            const resumeRoot = async (id: string, transcriptPath: string) => {
                const manager = SessionManager.open(transcriptPath, sessionDir, projectRoot);
                const hostedSession = new HostedSession({ id, cwd: projectRoot, sessionManager: manager });
                const root = await ensureRootAgentSession({ hostedSession, agentName: "guide" });
                return { manager, hostedSession, root };
            };

            const countLimit = createInterruptedTranscript("count-100-recovery", false);
            const firstResume = await resumeRoot("count-100-recovery-resumed", countLimit.transcriptPath);
            try {
                await assertRejects(
                    () =>
                        runRootTurn({
                            hostedSession: firstResume.hostedSession,
                            agentName: "guide",
                            userRequest: "Continue the saved execution after restart.",
                            dispatchKind: "plan_execution",
                            taskId: "saved-plan",
                            resumePreviousRequest: true,
                        }),
                    RunawayLoopGuardStoppedError,
                    "model_turn_limit",
                );
                assertEquals(modelCalls, 0);
                const settled = readRequestAttemptEntries(firstResume.manager);
                assertEquals(settled.at(-1)?.requestId, countLimit.requestId);
                assertEquals(settled.at(-1)?.phase, "failed");
                assertEquals(settled.at(-1)?.requestRecorded, true);
            } finally {
                firstResume.hostedSession.dispose();
            }

            const secondResume = await resumeRoot("count-100-recovery-twice", countLimit.transcriptPath);
            try {
                await assertRejects(
                    () =>
                        runRootTurn({
                            hostedSession: secondResume.hostedSession,
                            agentName: "guide",
                            userRequest: "Continue the saved execution after restart.",
                            dispatchKind: "plan_execution",
                            taskId: "saved-plan",
                            resumePreviousRequest: true,
                        }),
                    RunawayLoopGuardStoppedError,
                    "model_turn_limit",
                );
                assertEquals(modelCalls, 0);
                const attempts = readRequestAttemptEntries(secondResume.manager);
                assertEquals(attempts.at(-1)?.requestId, countLimit.requestId);
                assertEquals(attempts.at(-1)?.phase, "failed");
                assertEquals(attempts.at(-1)?.requestRecorded, true);
                assertEquals(attempts.filter((attempt) => attempt.phase === "completed").length, 0);
            } finally {
                secondResume.hostedSession.dispose();
            }

            const belowLimit = createInterruptedTranscript("below-limit-recovery", false, 4);
            const belowLimitResume = await resumeRoot("below-limit-recovery-resumed", belowLimit.transcriptPath);
            try {
                await runRootTurn({
                    hostedSession: belowLimitResume.hostedSession,
                    agentName: "guide",
                    userRequest: "Continue the saved execution after restart.",
                    dispatchKind: "plan_execution",
                    taskId: "saved-plan",
                    resumePreviousRequest: true,
                });
                assertEquals(modelCalls, 1);
                const attempts = readRequestAttemptEntries(belowLimitResume.manager);
                assertEquals(attempts.at(-1)?.requestId, belowLimit.requestId);
                assertEquals(attempts.at(-1)?.phase, "completed");
                const turnCounts = belowLimitResume.manager
                    .getBranch()
                    .filter((entry) => entry.type === "custom" && entry.customType === "runwield.loop_guard_turn")
                    .map((entry) => (entry as { data?: { requestId?: string; turnCount?: number } }).data)
                    .filter((entry) => entry?.requestId === belowLimit.requestId)
                    .map((entry) => entry?.turnCount);
                assertEquals(turnCounts, [1, 2, 3, 4, 5]);
            } finally {
                belowLimitResume.hostedSession.dispose();
            }

            const stopped = createInterruptedTranscript("saved-stop-recovery", true);
            const stoppedResume = await resumeRoot("saved-stop-recovery-resumed", stopped.transcriptPath);
            try {
                await assertRejects(
                    () =>
                        runRootTurn({
                            hostedSession: stoppedResume.hostedSession,
                            agentName: "guide",
                            userRequest: "Continue the saved execution after restart.",
                            dispatchKind: "plan_execution",
                            taskId: "saved-plan",
                            resumePreviousRequest: true,
                        }),
                    RunawayLoopGuardStoppedError,
                    "repeated_tool_result",
                );
                assertEquals(modelCalls, 1);
                const attempts = readRequestAttemptEntries(stoppedResume.manager);
                assertEquals(attempts.at(-1)?.requestId, stopped.requestId);
                assertEquals(attempts.at(-1)?.phase, "failed");
                assertEquals(attempts.filter((attempt) => attempt.phase === "completed").length, 0);
            } finally {
                stoppedResume.hostedSession.dispose();
            }

            const legacyStopped = createInterruptedTranscript("legacy-stop-recovery", true, 100, false);
            const legacyResume = await resumeRoot("legacy-stop-recovery-resumed", legacyStopped.transcriptPath);
            try {
                await assertRejects(
                    () =>
                        runRootTurn({
                            hostedSession: legacyResume.hostedSession,
                            agentName: "guide",
                            userRequest: "Finish the saved Plan execution.",
                            dispatchKind: "plan_execution",
                            taskId: "saved-plan",
                            resumePreviousRequest: true,
                        }),
                    RunawayLoopGuardStoppedError,
                    "repeated_tool_result",
                );
                assertEquals(modelCalls, 1);
                const resumedAttempt = readRequestAttemptEntries(legacyResume.manager).at(-1);
                assertEquals(resumedAttempt?.requestId, legacyStopped.requestId);
                assertEquals(resumedAttempt?.taskId, "saved-plan");
                assertEquals(resumedAttempt?.phase, "failed");
            } finally {
                legacyResume.hostedSession.dispose();
            }
        },
    );
});
