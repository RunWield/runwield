import { AGENTS, SUBAGENTS, getCwd } from "../../constants.js";
import { createGitPort } from "../git-port.ts";
import { loadSubAgentDefinition } from "../session/subagent-definitions.ts";
import { HostedSession } from "../session/hosted-session.js";
import {
    abortActiveSession,
    getConfiguredAgentTemperature,
    resolveExecutionThinkingLevel,
    resolveModel,
} from "../session/session.js";
import { setExactProjectCustomSetting } from "../settings.js";
import { SYSTEM_WORK_RECORD_MNEMOTECA_PORT } from "../work-records/mnemoteca-port.ts";
import { createLedger } from "./review-ledger.ts";
import { systemLocalCIPort } from "./validation-local-ci.ts";
import { runReviewerRound } from "./validation-semantic.ts";
import { createValidationSessionPort } from "./validation-session-adapter.ts";
import type { ValidationReviewOutcome } from "./validation-ports.ts";
import type { PhaseContext, ValidationLoopArgs } from "./validation-types.ts";
import { buildValidationUserMessage } from "./validation-user-messages.ts";

/** Model selection is resolved against the caller's project, not the review project. */
export interface ReviewerConfigurationOptions {
    model?: string;
    configurationRoot?: string;
}

export interface StandaloneReviewerRequest extends ReviewerConfigurationOptions {
    cwd: string;
    planName: string;
    planContent: string;
    diffText: string;
    timeoutMs: number;
}

export interface StandaloneReviewerResult {
    kind: "complete" | "paused" | "failed" | "timeout";
    outcome?: ValidationReviewOutcome;
    reason?: string;
    nudgeAttempts: number;
}

/** Resolve the production model and credentials without spending a model turn. */
export async function getReviewerConfiguration(options: ReviewerConfigurationOptions = {}) {
    const configurationRoot = options.configurationRoot ?? getCwd();
    // Production selection performs model and authentication checks without dispatching a model turn.
    // Resolve against the source project, not the intentionally neutral fixture project.
    const definition = await loadSubAgentDefinition(SUBAGENTS.REVIEWER, { reviewerMode: "discovery" });
    const selected = await resolveModel(
        options.model,
        definition,
        AGENTS.REVIEWER,
        undefined,
        undefined,
        configurationRoot,
    );
    const { resolvedThinkingLevel: thinkingLevel } = resolveExecutionThinkingLevel({
        agentName: AGENTS.REVIEWER,
        cwd: configurationRoot,
        agentDef: definition,
    });
    const temperature = getConfiguredAgentTemperature(AGENTS.REVIEWER, configurationRoot);
    return { model: selected.id, provider: selected.provider, thinkingLevel, temperature };
}

/** Own the Session lifecycle for one standalone production discovery round. */
export async function runStandaloneReviewerRound(
    options: StandaloneReviewerRequest,
): Promise<StandaloneReviewerResult> {
    const selected = await getReviewerConfiguration(options);
    setExactProjectCustomSetting("workflowMetrics", true, options.cwd);
    // Disable any inherited preset so it cannot replace the captured selection or explicit override.
    setExactProjectCustomSetting("activeModelPreset", "", options.cwd);
    setExactProjectCustomSetting(
        "agents",
        {
            reviewer: {
                model: `${selected.provider}/${selected.model}`,
                ...(selected.thinkingLevel ? { thinkingLevel: selected.thinkingLevel } : {}),
                ...(selected.temperature !== undefined ? { temperature: selected.temperature } : {}),
            },
        },
        options.cwd,
    );
    const hosted = new HostedSession({ id: `reviewer-benchmark:${crypto.randomUUID()}`, cwd: options.cwd });
    let nudgeAttempts = 0;
    hosted.subscribeRuntimeEvents((event) => {
        if (
            event.type === "system_status" &&
            "message" in event &&
            typeof event.message === "string" &&
            event.message ===
                buildValidationUserMessage({ kind: "reviewer_nudge", round: 1, attempt: nudgeAttempts + 2 })
        )
            nudgeAttempts += 1;
    });
    const args: ValidationLoopArgs = {
        planName: options.planName,
        planContent: options.planContent,
        triageMeta: {},
        session: createValidationSessionPort(hosted),
        git: createGitPort(),
        localCI: { run: ({ cwd }) => systemLocalCIPort.run({ hostedSession: hosted, cwd }) },
        workRecordMnemotecaPort: SYSTEM_WORK_RECORD_MNEMOTECA_PORT,
    };
    const context: PhaseContext = {
        args,
        projectRoot: options.cwd,
        executionCwd: options.cwd,
        executionAgent: "engineer",
        nonGitInPlace: false,
        executionContext: {
            executionMode: "worktree",
            planName: options.planName,
            projectRoot: options.cwd,
            executionCwd: options.cwd,
            source: "explicit",
        },
        workflowBase: {
            planName: options.planName,
            triageMeta: {},
            executionAgent: "engineer",
            projectRoot: options.cwd,
            executionCwd: options.cwd,
        },
    };
    let timedOut = false;
    let cancellation: Promise<void> | undefined;
    const timer = setTimeout(() => {
        timedOut = true;
        abortActiveSession(hosted);
        hosted.cancelActiveInteractions();
        // Disposal also closes the build-to-registration race: a late child cannot start a turn.
        cancellation = hosted.dispose();
    }, options.timeoutMs);
    let result: Pick<StandaloneReviewerResult, "kind" | "outcome" | "reason">;
    try {
        const round = await runReviewerRound(
            args,
            context,
            {
                semanticRound: 1,
                reviewLedger: createLedger(),
                repairBaselineTree: "",
                lastRepairReport: "",
            },
            "discovery",
            options.diffText,
        );
        result =
            round.kind === "complete"
                ? { kind: "complete", outcome: round.outcome }
                : round.kind === "failed"
                  ? { kind: "failed", reason: round.reason }
                  : { kind: round.result.kind === "failed" ? "failed" : "paused", reason: round.result.reason };
    } catch (error) {
        result = { kind: "failed", reason: error instanceof Error ? error.message : String(error) };
    } finally {
        clearTimeout(timer);
        await cancellation;
        await hosted.dispose();
    }
    return {
        ...(timedOut ? ({ kind: "timeout", reason: `Reviewer exceeded ${options.timeoutMs} ms` } as const) : result),
        nudgeAttempts,
    };
}
