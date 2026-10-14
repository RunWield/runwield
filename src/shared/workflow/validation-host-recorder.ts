import { getWorktreeReviewDiff } from "./git-snapshot.ts";
import { readDeliveryEvidence } from "./delivery-evidence.ts";
/** Recorder turn transport. Generation, persistence and indexing remain shared. */
import { autoGenerateWorkRecordForCompletedPlan } from "../work-records/auto-generation.ts";
import { parseRecorderSections, validateRecorderProposals } from "../work-records/generation.js";
import { sameHostIdentity, ValidationHostRejected, ValidationHostWait } from "./validation-host-contract.ts";
import { saveHostCheckpoint } from "./validation-host-state.ts";
import { emitStatus } from "./validation-emit.ts";
import type { ValidationLoopArgs } from "./validation-types.ts";

interface RecorderPlanReference {
    path: string;
}

interface RecorderPromptReference {
    successorRecordId: string;
    source: RecorderPlanReference;
}

export async function runHostRecorder(
    args: ValidationLoopArgs,
    cwd: string,
    pendingPublication: boolean,
): Promise<void> {
    const result = await autoGenerateWorkRecordForCompletedPlan({
        cwd,
        planName: args.planName,
        pendingPublication,
        mnemotecaPort: args.workRecordMnemotecaPort,
        runRecorderStep: async (prompt) => {
            let saved = args.validationCheckpoint!.hostRecorder;
            if (!saved) {
                const source: RecorderPromptReference = JSON.parse(prompt);
                const recordId = source.successorRecordId;
                const workflow = args.session.getActiveWorkflow();
                const diff = workflow?.executionMode === "worktree"
                    ? await getWorktreeReviewDiff(cwd, workflow.worktreeBaseBranch || "")
                    : "";
                const evidence = await readDeliveryEvidence(
                    args.session.cwd,
                    args.planName,
                    workflow?.worktreeId || "in-place",
                );
                const references = JSON.stringify(
                    { planPath: source.source.path, executionCwd: cwd, diff, evidence },
                    null,
                    2,
                );
                saved = {
                    recordId,
                    invalidSubmissions: 0,
                    request: {
                        kind: "recorder",
                        identity: {
                            attemptId: args.validationCheckpoint!.attemptId,
                            generation: `${args.validationCheckpoint!.generation}:recorder:${recordId}:0`,
                        },
                        cwd,
                        prompt: prompt + "\nCanonical references:\n" + references +
                            "\nUse only the canonical Plan, execution diff and validation evidence. " +
                            "Never copy the Claude conversation. Return the work_record_completed sections to the coordinator.",
                    },
                };
                await saveHostCheckpoint(args, { hostRecorder: saved });
            }
            if (saved.sections) return saved.sections;
            if (saved.failure) throw new Error(saved.failure);
            const resume = args.hostTurn?.resume;
            if (resume?.kind !== "recorder" || args.hostTurn?.consumed) throw new ValidationHostWait(saved.request);
            if (!sameHostIdentity(saved.request.identity, resume.identity)) throw new ValidationHostRejected();
            args.hostTurn!.consumed = true;
            try {
                const sections = parseRecorderSections(resume.sections);
                await validateRecorderProposals(cwd, saved.recordId, sections.supersessionProposals || []);
                await saveHostCheckpoint(args, { hostRecorder: { ...saved, sections } });
                return sections;
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                const invalidSubmissions = saved.invalidSubmissions + 1;
                const request = {
                    ...saved.request,
                    validationError: message,
                    identity: {
                        ...saved.request.identity,
                        generation: `${
                            args.validationCheckpoint!.generation
                        }:recorder:${saved.recordId}:${invalidSubmissions}`,
                    },
                };
                await saveHostCheckpoint(args, {
                    hostRecorder: {
                        ...saved,
                        request,
                        invalidSubmissions,
                        ...(invalidSubmissions >= 2 ? { failure: message } : {}),
                    },
                });
                if (invalidSubmissions < 2) throw new ValidationHostWait(request);
                throw new Error(`Recorder submission failed after two invalid submissions: ${message}`);
            }
        },
    });
    emitStatus(args, result.message, result.status === "failed" ? "warning" : "info");
}
