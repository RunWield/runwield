import { test } from "node:test";
import { readFile as fsReadFile, writeFile as fsWriteFile } from "node:fs/promises";
import { join } from "node:path";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { assertEquals } from "../../testing/assertions.ts";
import { withRuntimeCommandFixture } from "../../cmd/testing/runtime-command-fixture.ts";
import type { TriageMeta } from "../../tools/plan-written.ts";
import { setCustomSetting } from "../settings.js";
import { createGitPort } from "../git-port.ts";
import { git as runGit, makeRepo } from "../worktree-test-helpers.ts";
import { createWorkRecordMnemotecaFixture } from "../work-records/test-fixtures/mnemoteca-port.ts";
import { HostedSession } from "../session/hosted-session.js";
import { LOOP_GUARD_MAX_MODEL_TURNS } from "../session/runaway-loop-guard.ts";
import { drainWorkflowMetrics, getWorkflowMetricsFilePath } from "./metrics.js";
import { createLedger } from "./review-ledger.ts";
import { resolvePhaseContext } from "./validation-context.ts";
import { createValidationSessionPort } from "./validation-session-adapter.ts";
import { runReviewerRound } from "./validation-semantic.ts";
import type { SemanticRoundState, ValidationLoopArgs } from "./validation-types.ts";

const PLAN_NAME = "budget-review";
const REVIEW_TEXT = "# Budget review\n\nOne file changes in the reviewed commit.\n";
const CORRECTION_TEXT = "No review_complete was accepted";
const EXPECTED_PROVIDER_CALLS = LOOP_GUARD_MAX_MODEL_TURNS;

/** Metrics record shape this test reads back from the real workflow metrics file. */
type ExecutionRecord = {
    event?: string;
    requestId?: string | null;
    attemptId?: string | null;
    outcome?: string;
    callCount?: number;
};

/**
 * A review checkout whose last commit changes one file, so the reviewer's diff
 * tools see a real patch and `read` finds the probe file.
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

/**
 * A round fixture built from the real context resolver: the reviewer gets a real
 * execution context, a real session port, and real metrics persistence.
 */
async function makeReviewRound() {
    const { cwd, diffText } = await makeReviewCheckout();
    const triageMeta: TriageMeta = { classification: "QUICK_FIX", status: "validated_ci" };
    const hostedSession = new HostedSession({ id: crypto.randomUUID(), cwd });
    hostedSession.setWorkflowExecutionContext({ planName: PLAN_NAME, triageMeta });
    hostedSession.setActiveExecutionWorkflow({
        planName: PLAN_NAME,
        triageMeta,
        executionAgent: "engineer",
        projectRoot: cwd,
        executionCwd: cwd,
        executionMode: "non_git_in_place",
    });
    const args: ValidationLoopArgs = {
        planName: PLAN_NAME,
        planContent: REVIEW_TEXT,
        triageMeta,
        session: createValidationSessionPort(hostedSession),
        git: createGitPort(),
        localCI: { run: () => Promise.reject(new Error("Unexpected Local CI run")) },
        workRecordMnemotecaPort: createWorkRecordMnemotecaFixture(),
    };
    const resolved = await resolvePhaseContext(args);
    if (resolved.kind !== "ok") throw new Error(`Review fixture context blocked: ${resolved.result.reason}`);
    const state: SemanticRoundState = {
        semanticRound: 1,
        reviewLedger: createLedger(),
        repairBaselineTree: "",
        lastRepairReport: "",
    };
    return { cwd, diffText, hostedSession, args, context: resolved.context, state };
}

/** The text of one provider request, so a nudge can be read where the model sees it. */
function requestText(messages: AgentMessage[]): string {
    const texts: string[] = [];
    for (const message of messages) {
        if (message.role === "user") {
            if (typeof message.content === "string") texts.push(message.content);
            else
                for (const block of message.content) {
                    if (block.type === "text") texts.push(block.text);
                }
            continue;
        }
        if (message.role !== "assistant") continue;
        for (const block of message.content) {
            if (block.type === "text") texts.push(block.text);
        }
    }
    return texts.join("\n");
}

async function readExecutionRecords(projectRoot: string): Promise<ExecutionRecord[]> {
    // Metrics writes queue in-process; flush before reading the real file.
    await drainWorkflowMetrics();
    const text = await fsReadFile(getWorkflowMetricsFilePath(projectRoot), "utf8");
    return text
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as ExecutionRecord);
}

test("one unfinished review keeps one cumulative model-turn budget across a retry and a nudge", async () => {
    await withRuntimeCommandFixture("review-budget-", async (fixture) => {
        const round = await makeReviewRound();
        const { cwd, diffText, hostedSession, args, context, state } = round;
        await setCustomSetting("retry.baseDelayMs", 1, "project", cwd);
        await setCustomSetting("retry.validation.maxDelayMs", 1, "project", cwd);
        await setCustomSetting("workflowMetrics", true, "project", cwd);
        const providerRequests: string[] = [];
        let providerCalls = 0;
        const providerFailure = new Error("Synthetic provider outage");
        providerFailure.name = "RateLimitError";
        const respond = () => {
            providerCalls += 1;
            const call = providerCalls;
            // One controller-owned operational retry, an ordinary return before the
            // budget is spent, then distinct tool pairs up to the cumulative limit.
            if (call === 3) throw providerFailure;
            if (call === 60) return fauxAssistantMessage(fauxText("The review is not finished."));
            // A distinct tool call each turn, so the cycle guard cannot stop the run first.
            return fauxAssistantMessage(fauxToolCall("read", { path: "probe.txt", offset: call, limit: 1 }));
        };
        fixture.setModelResponseFactories(
            Array.from({ length: EXPECTED_PROVIDER_CALLS + 1 }, () => (providerContext) => {
                providerRequests.push(requestText(providerContext.messages));
                return respond();
            }),
        );

        try {
            const result = await runReviewerRound(args, context, state, "discovery", diffText);
            assertEquals(result.kind === "complete", false);
            // The budget is cumulative: no request 101 exists at all.
            assertEquals(providerCalls, EXPECTED_PROVIDER_CALLS);

            // The corrective nudge reached the model as its own request context.
            assertEquals(providerRequests.length, EXPECTED_PROVIDER_CALLS);
            assertEquals(providerRequests[0]?.includes(CORRECTION_TEXT), false);
            assertEquals(providerRequests[60]?.includes(CORRECTION_TEXT), true);

            // Real metrics persistence: one request identity, three backend attempts, and
            // the turns each attempt actually received before the cumulative stop.
            const executions = (await readExecutionRecords(cwd)).filter(
                (record) => record.event === "execution_finished",
            );
            assertEquals(executions.length, 3);
            const requestIds = new Set(executions.map((record) => record.requestId));
            assertEquals(requestIds.size, 1);
            assertEquals(typeof [...requestIds][0], "string");
            assertEquals(new Set(executions.map((record) => record.attemptId)).size, executions.length);
            assertEquals(
                executions.map((record) => record.outcome),
                ["succeeded", "succeeded", "failed"],
            );
            assertEquals(
                executions.map((record) => record.callCount),
                [2, 56, 40],
            );
        } finally {
            hostedSession.dispose();
        }
    });
});

test("a review below the budget still completes and records its accepted outcome", async () => {
    await withRuntimeCommandFixture("review-budget-fresh-", async (fixture) => {
        const round = await makeReviewRound();
        const { cwd, diffText, hostedSession, args, context, state } = round;
        await setCustomSetting("workflowMetrics", true, "project", cwd);
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

        try {
            const result = await runReviewerRound(args, context, state, "discovery", diffText);
            assertEquals(result.kind, "complete");
            assertEquals(providerCalls, accepted.length);

            const executions = (await readExecutionRecords(cwd)).filter(
                (record) => record.event === "execution_finished",
            );
            assertEquals(executions.length, 1);
            assertEquals(executions[0]?.outcome, "succeeded");
            assertEquals(executions[0]?.requestId?.startsWith("request:"), true);
            assertEquals(executions[0]?.callCount, 3);
        } finally {
            hostedSession.dispose();
        }
    });
});
