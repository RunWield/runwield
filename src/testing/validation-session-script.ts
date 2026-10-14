import { writeFile as fsWriteFile } from "node:fs/promises";
import { assertExists } from "./assertions.ts";
import { join } from "node:path";
import { HostedSession } from "../shared/session/hosted-session.js";
import { createGitPort } from "../shared/git-port.ts";
import { executeWorkflowTestTools, type WorkflowTestToolCall } from "./workflow-agent-tools.ts";
import { continueWorkflowValidation } from "../shared/workflow/validation.ts";
import { runLocalCI } from "../shared/workflow/validation-local-ci.ts";
import { getWorkflowDiff, getWorktreeReviewDiff } from "../shared/workflow/git-snapshot.ts";
import { parseDiffFiles } from "../shared/workflow/review-diff.ts";
import { type ReviewCompletePayload } from "../shared/workflow/review-outcome.ts";
import { type HostFixture } from "../shared/workflow/testing/validation-host-fixture.ts";
import { SYSTEM_WORK_RECORD_MNEMOTECA_PORT } from "../shared/work-records/mnemoteca-port.ts";
import {
    type RuntimeInteractionRequest,
    type RuntimeInteractionResponse,
} from "../shared/session/session-runtime-interactions.js";

export type SessionScript = {
    outcomes: Array<ReviewCompletePayload | null>;
    answer?: (request: RuntimeInteractionRequest) => RuntimeInteractionResponse;
    repairCompleted?: boolean;
};
export async function sessionScript(fixture: HostFixture, script: SessionScript) {
    const session = new HostedSession({ id: crypto.randomUUID(), cwd: fixture.root });
    let reviewerTurn = 0;
    let repairTurn = 0;
    const managers: Array<import("@earendil-works/pi-coding-agent").SessionManager | undefined> = [];
    session.setInteractionAdapter({
        requestInteraction(request) {
            return Promise.resolve(script.answer?.(request) || { outcome: "canceled" });
        },
    });
    const plan = await fixture.plan();
    session.setActiveExecutionWorkflow({
        planName: "p",
        triageMeta: plan.attrs,
        executionAgent: "engineer",
        projectRoot: fixture.root,
        executionMode: plan.attrs.executionMode || undefined,
        executionCwd: fixture.cwd,
        worktreeId: plan.attrs.worktreeId || undefined,
        worktreeBranch: plan.attrs.worktreeBranch || undefined,
        worktreeBaseBranch: plan.attrs.worktreeBaseBranch || undefined,
    });
    try {
        const result = await continueWorkflowValidation({
            hostedSession: session,
            planName: "p",
            planContent: plan.markdown,
            triageMeta: plan.attrs,
            git: createGitPort(),
            localCI: { run: runLocalCI },
            workRecordMnemotecaPort: SYSTEM_WORK_RECORD_MNEMOTECA_PORT,
            semanticReviewPort: {
                async runIsolatedAgentSession(request) {
                    if (request.agentName === "reviewer") {
                        managers.push(request.sessionManager);
                        const current = await fixture.plan();
                        const baseline = current.attrs.validationCheckpoint?.reviewState?.repairBaselineTree;
                        const scope =
                            (current.attrs.validationCheckpoint?.reviewState?.semanticRound || 0) >= 2
                                ? "repair"
                                : "full";
                        const diff =
                            scope === "repair"
                                ? await getWorkflowDiff(fixture.cwd, baseline)
                                : await getWorktreeReviewDiff(fixture.cwd, "main");
                        const calls: WorkflowTestToolCall[] = [
                            {
                                name: "review_diff",
                                arguments: { command: "list", scope },
                            },
                        ];
                        for (const file of parseDiffFiles(diff)) {
                            for (let offsetBytes = 0; offsetBytes < file.byteLength; offsetBytes += 65536) {
                                calls.push({
                                    name: "review_diff",
                                    arguments: {
                                        command: "show",
                                        scope,
                                        path: file.path,
                                        offsetBytes,
                                        maxBytes: 65536,
                                    },
                                });
                            }
                        }
                        const payload = script.outcomes[reviewerTurn++];
                        assertExists(payload === null ? {} : payload, "Unscripted external reviewer turn.");
                        if (payload) {
                            calls.push({ name: "review_complete", arguments: JSON.parse(JSON.stringify(payload)) });
                        }
                        await executeWorkflowTestTools(request, calls);
                    } else {
                        repairTurn++;
                        if (script.repairCompleted !== false) {
                            await fsWriteFile(join(fixture.cwd, "marker"), "fixed");
                            if (plan.attrs.executionMode === "worktree") {
                                await fsWriteFile(
                                    join(fixture.cwd, "implementation.ts"),
                                    `export const value = ${repairTurn + 1}; // repaired implementation\n`,
                                );
                            }
                            await executeWorkflowTestTools(request, [
                                {
                                    name: "task_completed",
                                    arguments: { message: "Fixed the finding." },
                                },
                            ]);
                        }
                    }
                    return [];
                },
            },
        });
        return { result, reviewerTurn, repairTurn, managers };
    } finally {
        session.dispose();
    }
}
