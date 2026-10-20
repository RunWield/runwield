import { test } from "node:test";
import { writeFile as fsWriteFile } from "node:fs/promises";
import { join } from "node:path";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import type { SessionManager } from "@earendil-works/pi-coding-agent";
import { assertEquals, assertStringIncludes } from "../../testing/assertions.ts";
import { withRuntimeCommandFixture } from "../../cmd/testing/runtime-command-fixture.ts";
import { setCustomSetting } from "../settings.js";
import { createGitPort } from "../git-port.ts";
import { git as runGit, makeRepo } from "../worktree-test-helpers.ts";
import { createWorkRecordMnemotecaFixture } from "../work-records/test-fixtures/mnemoteca-port.ts";
import { HostedSession } from "../session/hosted-session.js";
import { LOOP_GUARD_MAX_MODEL_TURNS } from "../session/runaway-loop-guard.ts";
import { createLedger } from "./review-ledger.ts";
import { createValidationSessionPort } from "./validation-session-adapter.ts";
import { runReviewerRound } from "./validation-semantic.ts";
import type { PhaseContext, SemanticRoundState, ValidationLoopArgs } from "./validation-types.ts";

type ReviewerAttempt = {
    requestId: string;
    attemptId: string;
    phase: string;
};

type GuardTurn = {
    requestId?: string;
    turnCount?: number;
};

/**
 * A review checkout whose last commit changes one file, so the reviewer's diff
 * tools see a real patch.
 */
async function makeReviewCheckout() {
    const cwd = await makeRepo();
    await fsWriteFile(
        join(cwd, "probe.txt"),
        Array.from({ length: 4 }, (_, index) => `probe line ${index + 1}`).join("\n"),
    );
    await runGit(cwd, ["add", "probe.txt"]);
    await runGit(cwd, ["commit", "-m", "probe file"]);
    await fsWriteFile(join(cwd, "example.ts"), "export const value = 2;\n");
    await runGit(cwd, ["add", "example.ts"]);
    await runGit(cwd, ["commit", "-m", "reviewed change"]);
    const diffText = await runGit(cwd, ["diff", "--no-color", "HEAD~1", "HEAD"]);
    return { cwd, diffText };
}

function attemptEntries(manager: SessionManager): ReviewerAttempt[] {
    return manager
        .getBranch()
        .filter((entry) => entry.type === "custom" && entry.customType === "runwield.request_attempt")
        .map((entry) => (entry as { data?: ReviewerAttempt }).data)
        .filter((entry): entry is ReviewerAttempt => Boolean(entry));
}

function guardEntries<T>(manager: SessionManager, customType: string): T[] {
    return manager
        .getBranch()
        .filter((entry) => entry.type === "custom" && entry.customType === customType)
        .map((entry) => (entry as { data?: T }).data)
        .filter((entry): entry is T => Boolean(entry));
}

function transcriptText(manager: SessionManager): string {
    return manager
        .getBranch()
        .filter((entry) => entry.type === "message")
        .flatMap((entry) => {
            const message = (entry as { message?: { content?: Array<{ type?: string; text?: string }> } }).message;
            return (message?.content || []).flatMap((block) => (block.type === "text" ? [block.text || ""] : []));
        })
        .join("\n");
}

type ReviewFixture = {
    args: ValidationLoopArgs;
    context: PhaseContext;
    state: SemanticRoundState;
    diffText: string;
};

function makeRoundFixture(cwd: string, diffText: string, session: ValidationLoopArgs["session"]): ReviewFixture {
    const args = {
        planName: "budget-review",
        planContent: "# Budget review\n",
        triageMeta: { classification: "QUICK_FIX", status: "validated_ci" },
        session,
        git: createGitPort(),
        localCI: { run: () => Promise.reject(new Error("Unexpected Local CI run")) },
        workRecordMnemotecaPort: createWorkRecordMnemotecaFixture(),
    } as unknown as ValidationLoopArgs;
    const context = {
        args,
        projectRoot: cwd,
        executionContext: {},
        executionCwd: cwd,
        executionAgent: "engineer",
        nonGitInPlace: false,
        workflowBase: {
            planName: "budget-review",
            projectRoot: cwd,
            executionCwd: cwd,
            executionAgent: "engineer",
            executionMode: "non_git_in_place",
            triageMeta: { classification: "QUICK_FIX", status: "validated_ci" },
        },
    } as unknown as PhaseContext;
    const state: SemanticRoundState = {
        semanticRound: 1,
        reviewLedger: createLedger(),
        repairBaselineTree: "",
        lastRepairReport: "",
    };
    return { args, context, state, diffText };
}

test("one unfinished review keeps one cumulative model-turn budget across a retry and a nudge", async () => {
    await withRuntimeCommandFixture("review-budget-", async (fixture) => {
        const { cwd, diffText } = await makeReviewCheckout();
        await setCustomSetting("retry.baseDelayMs", 1, "project", cwd);
        await setCustomSetting("retry.validation.maxDelayMs", 1, "project", cwd);
        const hostedSession = new HostedSession({ id: crypto.randomUUID(), cwd });
        const statusMessages: string[] = [];
        hostedSession.setEventSink((event: { type?: string; message?: string }) => {
            if (event.type !== "system_status") return;
            statusMessages.push(String(event.message || ""));
        });
        let reviewerManager: SessionManager | null = null;
        const port = createValidationSessionPort(hostedSession);
        const session: ValidationLoopArgs["session"] = {
            ...port,
            createInMemorySessionManager: (managerCwd) => {
                const manager = port.createInMemorySessionManager(managerCwd);
                reviewerManager = manager as unknown as SessionManager;
                return manager;
            },
        };
        const round = makeRoundFixture(cwd, diffText, session);

        let providerCalls = 0;
        const providerFailure = new Error("Synthetic provider outage");
        providerFailure.name = "RateLimitError";
        const respond = () => {
            providerCalls += 1;
            const call = providerCalls;
            // One controller-owned operational retry, then enough distinct tool pairs to
            // exhaust the model-turn budget without a repeated-cycle stop.
            if (call === 3) throw providerFailure;
            if (call === LOOP_GUARD_MAX_MODEL_TURNS) return fauxAssistantMessage(fauxText("Review not finished."));
            // A distinct tool call each turn, so the cycle guard cannot stop the run first.
            return fauxAssistantMessage(fauxToolCall("read", { path: "probe.txt", offset: call, limit: 1 }));
        };
        fixture.setModelResponseFactories(Array.from({ length: LOOP_GUARD_MAX_MODEL_TURNS + 1 }, () => respond));

        try {
            const result = await runReviewerRound(round.args, round.context, round.state, "discovery", diffText);
            assertEquals(result.kind === "complete", false);
            assertEquals(providerCalls, LOOP_GUARD_MAX_MODEL_TURNS);

            if (!reviewerManager) throw new Error("The reviewer round created no Session manager");
            const manager: SessionManager = reviewerManager;
            const stops = guardEntries<{ reason?: string }>(manager, "runwield.loop_guard_stop");
            assertEquals(stops.at(-1)?.reason, "model_turn_limit");

            const turns = guardEntries<GuardTurn>(manager, "runwield.loop_guard_turn");
            const requestIds = new Set(turns.map((turn) => turn.requestId));
            assertEquals(requestIds.size, 1);
            assertEquals(
                turns.map((turn) => turn.turnCount),
                Array.from({ length: LOOP_GUARD_MAX_MODEL_TURNS }, (_, index) => index + 1),
            );

            const attempts = attemptEntries(manager);
            const attemptRequestIds = new Set(attempts.map((attempt) => attempt.requestId));
            assertEquals(attemptRequestIds.size, 1);
            assertEquals(attempts[0]?.requestId, turns[0]?.requestId);
            const startedAttempts = attempts.filter((attempt) => attempt.phase === "started");
            assertEquals(startedAttempts.length, 3);
            assertEquals(new Set(startedAttempts.map((attempt) => attempt.attemptId)).size, startedAttempts.length);
            assertEquals(attempts.at(-1)?.phase, "failed");

            // The corrective nudge reached the model as changed text, not a generic continuation.
            assertStringIncludes(transcriptText(manager), "No review_complete was accepted");
            // The same request also survived one controller-owned operational retry.
            assertEquals(
                statusMessages.some((message) => message.includes("Retrying semantic_review")),
                true,
            );
        } finally {
            hostedSession.dispose();
        }
    });
});

test("a review below the budget still completes and records its accepted outcome", async () => {
    await withRuntimeCommandFixture("review-budget-fresh-", async (fixture) => {
        const { cwd, diffText } = await makeReviewCheckout();
        const hostedSession = new HostedSession({ id: crypto.randomUUID(), cwd });
        const port = createValidationSessionPort(hostedSession);
        const managers: SessionManager[] = [];
        const session: ValidationLoopArgs["session"] = {
            ...port,
            createInMemorySessionManager: (managerCwd) => {
                const manager = port.createInMemorySessionManager(managerCwd);
                managers.push(manager as unknown as SessionManager);
                return manager;
            },
        };
        const acceptedDecision = {
            outcome: "approved",
            approved: true,
            feedback: "",
            findings: [],
            advisories: [],
        };
        const accepted = [
            fauxAssistantMessage(fauxToolCall("review_diff", { command: "list" })),
            fauxAssistantMessage(
                fauxToolCall("review_diff", { command: "show", scope: "full", path: "example.ts", offsetBytes: 0 }),
            ),
            fauxAssistantMessage(fauxToolCall("review_complete", acceptedDecision)),
        ];
        let providerCalls = 0;
        fixture.setModelResponseFactories(
            accepted.map((message) => () => {
                providerCalls += 1;
                return message;
            }),
        );
        const round = makeRoundFixture(cwd, diffText, session);

        try {
            const result = await runReviewerRound(round.args, round.context, round.state, "discovery", diffText);
            assertEquals(result.kind, "complete");
            assertEquals(providerCalls, accepted.length);
            assertEquals(managers.length, 1);

            const attempts = attemptEntries(managers[0]);
            const requestId = attempts[0]?.requestId;
            assertEquals(attempts.at(-1)?.phase, "completed");
            assertEquals(
                attempts.every((attempt) => attempt.requestId === requestId),
                true,
            );
            const turns = guardEntries<GuardTurn>(managers[0], "runwield.loop_guard_turn");
            assertEquals(
                turns.map((turn) => turn.turnCount),
                [1, 2, 3],
            );
            assertEquals(guardEntries(managers[0], "runwield.loop_guard_stop").length, 0);
        } finally {
            hostedSession.dispose();
        }
    });
});
