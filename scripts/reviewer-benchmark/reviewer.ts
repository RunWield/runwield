import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { AGENTS, SUBAGENTS, getCwd } from "../../src/constants.js";
import { createGitPort } from "../../src/shared/git-port.ts";
import { loadSubAgentDefinition } from "../../src/shared/session/subagent-definitions.ts";
import { HostedSession } from "../../src/shared/session/hosted-session.js";
import {
    abortActiveSession,
    getConfiguredAgentTemperature,
    resolveExecutionThinkingLevel,
    resolveModel,
} from "../../src/shared/session/session.js";
import { setExactProjectCustomSetting } from "../../src/shared/settings.js";
import { SYSTEM_WORK_RECORD_MNEMOTECA_PORT } from "../../src/shared/work-records/mnemoteca-port.ts";
import { drainWorkflowMetrics, getWorkflowMetricsFilePath } from "../../src/shared/workflow/metrics.js";
import { createLedger } from "../../src/shared/workflow/review-ledger.ts";
import { systemLocalCIPort } from "../../src/shared/workflow/validation-local-ci.ts";
import { runReviewerRound } from "../../src/shared/workflow/validation-semantic.ts";
import { createValidationSessionPort } from "../../src/shared/workflow/validation-session-adapter.ts";
import type { ValidationReviewOutcome } from "../../src/shared/workflow/validation-ports.ts";
import type { PhaseContext, ValidationLoopArgs } from "../../src/shared/workflow/validation-types.ts";
import type { ReviewerFixture } from "./fixtures.ts";
import type { MaterializedProject } from "./materialize.ts";
import { readReviewMeasurements } from "./measurements.ts";
import type { ReviewMeasurements } from "./measurements.ts";
import { buildValidationUserMessage } from "../../src/shared/workflow/validation-user-messages.ts";

export interface FixtureReviewOptions {
    model?: string;
    timeoutMs?: number;
    /** Resolve the effective Reviewer selection here, before entering the isolated project. Defaults to cwd. */
    configurationRoot?: string;
}

export interface FixtureReviewResult extends ReviewMeasurements {
    kind: "complete" | "paused" | "failed" | "timeout";
    /** The accepted production outcome, not the ledger's rewritten findings. */
    outcome?: ValidationReviewOutcome;
    reason?: string;
    nudgeAttempts: number;
    elapsedMs: number;
}

async function readJournal(cwd: string): Promise<string> {
    try {
        return await readFile(getWorkflowMetricsFilePath(cwd), "utf8");
    } catch {
        return "";
    }
}

/** Resolve the production model and credentials without spending a model turn. */
export async function getReviewerConfiguration(options: FixtureReviewOptions = {}) {
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

/** One production discovery round. Admission and project cleanup remain the caller's responsibility. */
export async function runFixtureReview(
    project: MaterializedProject,
    fixture: ReviewerFixture,
    options: FixtureReviewOptions = {},
): Promise<FixtureReviewResult> {
    const startedAt = performance.now();
    const timeoutMs = options.timeoutMs ?? fixture.manifest.timeoutMs;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("Reviewer timeout must be positive");
    const selected = await getReviewerConfiguration(options);
    setExactProjectCustomSetting("workflowMetrics", true, project.cwd);
    // Disable any inherited preset so it cannot replace the captured selection or explicit override.
    setExactProjectCustomSetting("activeModelPreset", "", project.cwd);
    setExactProjectCustomSetting(
        "agents",
        {
            reviewer: {
                model: `${selected.provider}/${selected.model}`,
                ...(selected.thinkingLevel ? { thinkingLevel: selected.thinkingLevel } : {}),
                ...(selected.temperature !== undefined ? { temperature: selected.temperature } : {}),
            },
        },
        project.cwd,
    );
    await drainWorkflowMetrics();
    const journalBefore = await readJournal(project.cwd);
    const hosted = new HostedSession({ id: `reviewer-benchmark:${crypto.randomUUID()}`, cwd: project.cwd });
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
    const planName = basename(fixture.manifest.planPath, ".md");
    const args: ValidationLoopArgs = {
        planName,
        planContent: project.planContent,
        triageMeta: {},
        session: createValidationSessionPort(hosted),
        git: createGitPort(),
        localCI: { run: ({ cwd }) => systemLocalCIPort.run({ hostedSession: hosted, cwd }) },
        workRecordMnemotecaPort: SYSTEM_WORK_RECORD_MNEMOTECA_PORT,
    };
    const context: PhaseContext = {
        args,
        projectRoot: project.cwd,
        executionCwd: project.cwd,
        executionAgent: "engineer",
        nonGitInPlace: false,
        executionContext: {
            executionMode: "worktree",
            planName,
            projectRoot: project.cwd,
            executionCwd: project.cwd,
            source: "explicit",
        },
        workflowBase: {
            planName,
            triageMeta: {},
            executionAgent: "engineer",
            projectRoot: project.cwd,
            executionCwd: project.cwd,
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
    }, timeoutMs);
    let result: Pick<FixtureReviewResult, "kind" | "outcome" | "reason">;
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
            project.diffText,
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
    await drainWorkflowMetrics();
    const journal = await readJournal(project.cwd);
    return {
        ...(timedOut ? ({ kind: "timeout", reason: `Reviewer exceeded ${timeoutMs} ms` } as const) : result),
        nudgeAttempts,
        ...readReviewMeasurements(journal.startsWith(journalBefore) ? journal.slice(journalBefore.length) : ""),
        elapsedMs: performance.now() - startedAt,
    };
}
