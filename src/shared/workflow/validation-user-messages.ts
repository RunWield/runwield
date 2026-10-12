/**
 * Plain user messages for validation and recovery.
 * Raw errors belong in logs, not in these messages.
 */

export type ValidationUserMessageKey =
    | "running_tests"
    | "plan_fixed"
    | "publication_note_failed"
    | "merge_failed"
    | "retry_pause"
    | "already_running"
    | "completion_already_used"
    | "lost_attempt";

const MESSAGES: Record<ValidationUserMessageKey, string> = {
    running_tests: "Running tests and CI now.",
    plan_fixed: "The Plan copy is fixed. We will go on.",
    publication_note_failed:
        "Tests and CI passed. RunWield could not save the test note. Your work is safe. Try again.",
    merge_failed: "The merge did not work. Your work is safe. RunWield will try to fix it.",
    retry_pause: "The check stopped. Your work is safe. Try again.",
    already_running: "The check is still on.",
    completion_already_used: "This work note was used. The check will not run twice.",
    lost_attempt: "The worktree and branch are gone. The Plan says they should be here. What do you want to do?",
};

export type ValidationMessageRequest =
    | { kind: "ci_running"; cwd: string }
    | { kind: "checks_passed" }
    | { kind: "repair_waiting"; agent: string }
    | { kind: "repair_blocked"; agent: string; blockerText?: string }
    | { kind: "engineer_follow_up"; agent: string }
    | { kind: "ci_repair"; agent: string }
    | { kind: "semantic_round"; round: number; maxRounds: number; mode: "discovery" | "verify" }
    | { kind: "semantic_diff_missing"; planOnly: boolean }
    | { kind: "semantic_skipped"; reason: "non_git" | "empty_diff" }
    | { kind: "semantic_approved"; round: number }
    | { kind: "review_repair"; repairKind: "semantic" | "human_feedback" }
    | { kind: "repair_feedback_prompt" }
    | { kind: "repair_feedback_default" }
    | { kind: "reviewer_nudge"; round: number; attempt: number }
    | { kind: "integration_notes_saved"; count: number; epicPlanName: string }
    | { kind: "semantic_limit"; planName: string; rounds: number; openCount: number; testsPass: boolean }
    | { kind: "human_review_offer" }
    | { kind: "human_review_wait"; reviewUrl?: string }
    | { kind: "human_review_prompt"; planName: string }
    | { kind: "human_review_approved" }
    | { kind: "human_review_skipped" }
    | { kind: "human_review_pending"; planName: string }
    | { kind: "qa_prepare"; planName: string }
    | { kind: "qa_ready"; path?: string; existed?: boolean }
    | {
        kind: "publication_progress";
        phase:
            | "preparing"
            | "reading_target"
            | "using_local_target"
            | "updating_target"
            | "combining_work"
            | "publishing"
            | "verifying"
            | "cleanup";
        targetBranch: string;
    }
    | { kind: "merge_dispatch" }
    | { kind: "publication_target_changed"; targetBranch: string; savedTargetBranch: string }
    | { kind: "publication_files_preserved"; path: string }
    | {
        kind: "publication_blocked";
        planName: string;
        blockedByPlanLock?: boolean;
        stage:
            | "artifact_preparation"
            | "candidate_checkpoint"
            | "lifecycle_staging"
            | "candidate_sealing"
            | "git_publication";
    }
    | {
        kind: "publication_cleanup_incomplete";
        targetBranch: string;
        worktreePath?: string;
        worktreeBranch?: string;
        details: string[];
    }
    | { kind: "verified"; planName: string; targetBranch?: string }
    | { kind: "context_blocked"; planName: string }
    | { kind: "validation_command_missing" }
    | { kind: "validation_command_prompt" }
    | { kind: "validation_command_saved"; command: string }
    | { kind: "work_record_prompt"; recordId: string; reason: string }
    | { kind: "work_record_notice"; message: string }
    | { kind: "manual_qa_failed" }
    | { kind: "manual_qa_start" }
    | { kind: "work_record_start" }
    | {
        kind: "work_record_result";
        status: "disabled" | "skipped" | "generated" | "linked" | "failed";
        reason?: string;
    }
    | { kind: "quick_fix_start" }
    | { kind: "quick_fix_running"; attempt: number; maxAttempts: number }
    | { kind: "quick_fix_canceled" }
    | { kind: "quick_fix_ci_passed" }
    | { kind: "quick_fix_qa" }
    | { kind: "quick_fix_passed" }
    | { kind: "quick_fix_failed"; maxAttempts: number }
    | { kind: "quick_fix_repair"; agent: string; attempt: number; maxAttempts: number }
    | { kind: "quick_fix_waiting"; agent: string }
    | { kind: "recovery_repair_failed" }
    | { kind: "implementation_checkpoint_failed" }
    | { kind: "user_action"; whatHappened: string; doThis: string; details?: string[] };

export type ValidationRecoveryNotice =
    | { kind: "session_plan_fixed"; planName: string }
    | { kind: "worktree_record_rebuilt"; planName: string }
    | { kind: "worktree_record_fixed"; planName: string }
    | { kind: "worktree_path_fixed"; planName: string }
    | { kind: "branch_restored"; branch: string }
    | { kind: "worktree_restored"; planName: string; branch: string }
    | { kind: "plan_status_restored"; planName: string; from: string; to: string }
    | { kind: "execution_plan_fixed"; planName: string }
    | { kind: "review_range_fixed"; planName: string }
    | { kind: "merge_plan_preserved"; planName: string };

export function buildValidationRecoveryNotice(notice: ValidationRecoveryNotice): string {
    switch (notice.kind) {
        case "session_plan_fixed":
            return `The saved Plan facts for ${notice.planName} are fixed.`;
        case "worktree_record_rebuilt":
            return `The saved worktree facts for ${notice.planName} are back.`;
        case "worktree_record_fixed":
            return `The saved worktree facts for ${notice.planName} are fixed.`;
        case "worktree_path_fixed":
            return `The worktree path for ${notice.planName} is fixed.`;
        case "branch_restored":
            return `Branch ${notice.branch} is back.`;
        case "worktree_restored":
            return `The worktree for ${notice.planName} is back on branch ${notice.branch}.`;
        case "plan_status_restored":
            return `The Plan is fixed. Moving on.`;
        case "execution_plan_fixed":
            return `The Plan file for ${notice.planName} is now fixed and safe to use.`;
        case "review_range_fixed":
            return "RunWield found the code and fixed its review. The review will go on.";
        case "merge_plan_preserved":
            return `The Plan for ${notice.planName} is safe.`;
    }
}

/** Build text only at a user display edge. */
export function buildValidationUserMessage(request: ValidationMessageRequest): string {
    switch (request.kind) {
        case "ci_running":
            return `Running the tests in ${request.cwd}.`;
        case "checks_passed":
            return "Tests and CI passed.";
        case "repair_waiting":
            return `${request.agent} stopped. The repair is not done. The check will start when the work note comes.`;
        case "repair_blocked":
            return `${request.agent} stopped on a blocker. The repair is not done.${
                request.blockerText ? `\n\n${request.blockerText}` : ""
            }`;
        case "engineer_follow_up":
            return `The check is on hold. Send a note to ${request.agent} when you are ready.`;
        case "ci_repair":
            return `Tests and CI failed. ${request.agent} will fix it now.`;
        case "semantic_round":
            return request.mode === "discovery"
                ? `AI review ${request.round} of ${request.maxRounds} has begun. It will check all the work.`
                : `AI review ${request.round} of ${request.maxRounds} has begun. It will check the last fixes.`;
        case "semantic_diff_missing":
            return request.planOnly
                ? "RunWield found Plan edits but no code. Ask the Engineer to restore the code, then try again."
                : "RunWield found no code. Ask the Engineer to restore the code, then try again.";
        case "semantic_skipped":
            return request.reason === "non_git"
                ? "AI review skipped: this work is not in Git."
                : "AI review skipped: there are no code changes to read.";
        case "semantic_approved":
            return `AI review ${request.round} is done. It found no need for a fix.`;
        case "review_repair":
            return request.repairKind === "human_feedback"
                ? "Your code review found issues. A repair will start now."
                : "AI review found issues. A repair will start now.";
        case "repair_feedback_prompt":
            return "Tell the Repair Engineer what to try next.";
        case "repair_feedback_default":
            return "Revisit the remaining findings using my guidance, verify the repair, and report again.";
        case "reviewer_nudge":
            return `AI review needs more time for round ${request.round}. Try ${request.attempt} of 3.`;
        case "integration_notes_saved":
            return `AI review left ${request.count} note(s) for ${request.epicPlanName}.`;
        case "semantic_limit":
            return `AI review checked ${request.planName} ${request.rounds} times. ${request.openCount} item(s) stay open. Tests and CI ${
                request.testsPass ? "pass" : "do not pass"
            }. Look once more, read it, or stop.`;
        case "human_review_offer":
            return "AI review passed. Do you want code review before merge?";
        case "human_review_wait":
            return request.reviewUrl ? `Need your review: ${request.reviewUrl}` : "Need your review.";
        case "human_review_prompt":
            return `Read the changes for ${request.planName}.`;
        case "human_review_skipped":
            return "Code Review skipped";
        case "human_review_pending":
            return `Code Review is still pending. No choice was saved. Use /load-plan ${request.planName} to return.`;
        case "human_review_approved":
            return "Code review is done. You approved the work.";
        case "qa_prepare":
            return `Making the test list for ${request.planName}.`;
        case "qa_ready":
            if (!request.path) return "The test list is ready.";
            return request.existed
                ? `The test list is at ${request.path}.`
                : `The test list was saved at ${request.path}.`;
        case "publication_progress":
            switch (request.phase) {
                case "preparing":
                    return "The commits are ready.";
                case "reading_target":
                    return `Checking ${request.targetBranch} for new commits.`;
                case "using_local_target":
                    return `No remote is configured. Adding the commits to the local ${request.targetBranch} branch.`;
                case "updating_target":
                    return `Adding new commits from ${request.targetBranch}.`;
                case "combining_work":
                    return `Merging work into ${request.targetBranch}.`;
                case "publishing":
                    return `Sending the new commits to ${request.targetBranch}.`;
                case "verifying":
                    return `Checking the new commits on ${request.targetBranch}.`;
                case "cleanup":
                    return `The new commits are on ${request.targetBranch}. Cleaning up the worktree and source branch.`;
                default: {
                    const exhaustivePhase: never = request.phase;
                    return exhaustivePhase;
                }
            }
        case "publication_target_changed":
            return `The Plan now targets ${request.targetBranch}. The saved merge targets ${request.savedTargetBranch}. Work is paused. Your commits are safe.`;
        case "merge_dispatch":
            return "The repair Engineer is fixing the file clashes. The fix will be checked next.";
        case "publication_blocked":
            if (request.blockedByPlanLock) {
                return `Publishing ${request.planName} is paused because another RunWield operation is still using the project's Plans. Your checked changes and review decision are saved. Let that operation finish, then retry publication. Reloading this Plan alone will not release it.`;
            }
            switch (request.stage) {
                case "artifact_preparation":
                    return `Publishing ${request.planName} is paused because RunWield could not save its completion records, even after retrying. Your checked changes and review decision are saved. Report this RunWield error before retrying publication; reloading the Plan alone will not fix it.`;
                case "candidate_checkpoint":
                    return `Git could not save the final validation files for ${request.planName}, so publication is paused. Your changes and review decision are saved in the worktree. Fix the Git hook or commit error reported in the console, then retry publication.`;
                case "lifecycle_staging":
                    return `Publishing ${request.planName} is paused because RunWield could not save the Plan's completed validation, even after retrying. Your checked changes and review decision are saved. Report this RunWield error before retrying publication; reloading the Plan alone will not fix it.`;
                case "candidate_sealing":
                    return `Git could not seal the final commits for ${request.planName}. The validated commits are safe. Fix the Git hook or commit error reported in the console, then load this Plan and run validation again.`;
                case "git_publication":
                    return `RunWield could not finish adding ${request.planName} to its target branch. The validated commits are safe on the source branch. Load this Plan and run validation again to resume publication.`;
                default: {
                    const exhaustiveStage: never = request.stage;
                    return exhaustiveStage;
                }
            }
        case "publication_files_preserved":
            return `Leftover files were saved at ${request.path}.`;
        case "publication_cleanup_incomplete": {
            const facts = request.details.map((detail) => `- ${detail}`).join("\n");
            const checks = [
                request.worktreePath
                    ? `Inspect remaining files with \`git -C "${
                        request.worktreePath.replaceAll('"', '\\"')
                    }" status --short\`.`
                    : "",
                request.worktreeBranch
                    ? `After saving anything you need, verify and delete the source branch with \`git branch -d ${request.worktreeBranch}\`.`
                    : "",
                "Run `wld plans doctor` to confirm no recovery record remains.",
            ].filter(Boolean).join(" ");
            return `The commits are on ${request.targetBranch}, but Git cleanup is incomplete.\n${facts}\n\n${checks}`;
        }
        case "verified":
            return request.targetBranch
                ? `${request.planName} is on ${request.targetBranch}.`
                : `${request.planName} is done.`;
        case "context_blocked":
            return `RunWield cannot check ${request.planName} now. Inspect the work, then try again.`;
        case "validation_command_missing":
            return "This project has no test command yet.";
        case "validation_command_prompt":
            return "Enter the command that runs this project's tests:";
        case "validation_command_saved":
            return `The test command is saved: ${request.command}`;
        case "work_record_prompt":
            return `Should the new Work Record replace ${request.recordId}?\n\nReason: ${request.reason}`;
        case "work_record_notice":
            return request.message;
        case "manual_qa_failed":
            return "The checks passed. RunWield could not make the test list. Try again later.";
        case "manual_qa_start":
            return "Generating the manual QA test list...";
        case "work_record_start":
            return "Generating the Work Record for the current plan...";
        case "work_record_result":
            if (request.status === "generated" || request.status === "linked") return "The Work Record is ready.";
            if (request.status === "failed") {
                return "Work Record failed. Code is safe. Choose Retry Work Record. wld wr backfill makes missing or failed records again.";
            }
            if (request.reason === "parent_not_terminal") {
                return "The Work Record will be made after the parent Epic is finished.";
            }
            return "No Work Record was made.";
        case "quick_fix_start":
            return "The quick fix checks have begun.";
        case "quick_fix_running":
            return `Running the quick fix tests. Fix try ${request.attempt} of ${request.maxAttempts}.`;
        case "quick_fix_canceled":
            return "The quick fix tests were stopped. You can keep work with the Engineer.";
        case "quick_fix_ci_passed":
            return "Quick fix tests and CI passed.";
        case "quick_fix_qa":
            return "Making the quick fix test list.";
        case "quick_fix_passed":
            return "The quick fix checks passed.";
        case "quick_fix_failed":
            return `The quick fix tests still fail after ${request.maxAttempts} tries.`;
        case "quick_fix_repair":
            return `The quick fix tests failed. ${request.agent} will fix them. Try ${request.attempt} of ${request.maxAttempts}.`;
        case "quick_fix_waiting":
            return `${request.agent} stopped. The fix is not done. Send a work note when it is done.`;
        case "recovery_repair_failed":
            return "RunWield could not check for safe fixes. Your work is safe. Try again.";
        case "implementation_checkpoint_failed":
            return "RunWield could not verify the saved implementation. Your work is unchanged. Inspect it or try validation again.";
        case "user_action": {
            const details = request.details?.length
                ? `\n\n${request.details.map((detail) => `  ${detail}`).join("\n")}`
                : "";
            return `${request.whatHappened}${details}\n\n${request.doThis}`;
        }
    }
}

export function validationUserMessage(key: ValidationUserMessageKey): string {
    return MESSAGES[key];
}

export function validationPhasePauseMessage(phase?: "mechanical" | "semantic" | "delivery"): string {
    if (!phase) return "The check is on hold. Your work is safe.";
    const names = { mechanical: "tests and CI", semantic: "AI review", delivery: "combining commits" } as const;
    return `The check stopped before the ${names[phase]}. Your work is safe.`;
}

export function validationMergeRepairMessage(
    planName: string,
    problem: "target_update" | "work_combination",
): string {
    return problem === "target_update"
        ? `The latest target branch changed in the same files as ${planName}. The commits are safe.`
        : `The source and target branches changed the same files in ${planName}. The commits are safe.`;
}

export function validationReviewerPauseMessage(planName: string): string {
    return `AI review for ${planName} stopped. Your work is safe. Try again.`;
}

export type PlanRecoveryMessageKey =
    | "merge_cleanup_failed"
    | "handoff_failed"
    | "merge_failed"
    | "baseline_reset_failed"
    | "worktree_recreate_failed"
    | "action_blocked";

export type PlanRecoveryMessageRequest =
    | { kind: "manual_merge_unavailable" }
    | { kind: "missing_worktree" }
    | { kind: "missing_plan_pointer" }
    | { kind: "missing_target" }
    | { kind: "proof_failed" }
    | { kind: "plan_restored"; path: string }
    | { kind: "not_worktree" }
    | { kind: "incomplete_worktree" }
    | { kind: "snapshot_restore_failed" }
    | { kind: "registry_update_failed" }
    | { kind: "merged" }
    | { kind: "result_record_failed" }
    | { kind: "conflict_state_save_failed" }
    | { kind: "invalid_policy"; action: string; planName: string }
    | { kind: "git_blocked" }
    | { kind: "recreate_warning"; planName: string; path?: string }
    | { kind: "worktree_abandoned"; planName: string }
    | { kind: "worktree_path_missing"; planName: string }
    | { kind: "worktree_missing"; planName: string; path?: string }
    | { kind: "worktree_branch_changed"; planName: string }
    | { kind: "worktree_inspection_failed"; planName: string }
    | { kind: "reset_baseline_missing" }
    | { kind: "reset_done" }
    | { kind: "recreate_base_missing" }
    | { kind: "stopped" }
    | { kind: "record_incomplete" }
    | { kind: "record_restore_failed" }
    | { kind: "record_restored"; planName: string }
    | { kind: "records_settled"; count: number }
    | { kind: "record_unfinished"; planName: string }
    | { kind: "records_attested"; planName: string }
    | { kind: "deleting_worktree"; planName: string }
    | { kind: "git_delete_skipped" }
    | { kind: "record_already_gone" }
    | { kind: "abandon_done"; removed: boolean }
    | { kind: "worktree_cleanup_result"; detail: string; failed?: boolean }
    | { kind: "abandon_definition_missing" }
    | {
        kind: "publication_cleanup_resumed";
        planName: string;
        targetBranch: string;
        complete: boolean;
        details: string[];
        preservedFiles?: string;
    }
    | {
        kind: "recovery_report";
        summary: string;
        lastRunStopped: boolean;
        worktree?: { status?: string; path?: string; branch?: string; target?: string };
        gitStatus?: string;
        diff?: string;
        inspectionFailed?: boolean;
        noBaseline?: boolean;
    };

export function buildPlanRecoveryUserMessage(request: PlanRecoveryMessageRequest): string {
    switch (request.kind) {
        case "manual_merge_unavailable":
            return "Manual worktree merge is not ready. Run the checks again.";
        case "missing_worktree":
            return "RunWield cannot find the saved worktree. Inspect the Plan and Git, then try again.";
        case "missing_plan_pointer":
            return "The Plan does not point to this worktree. Run the checks again.";
        case "missing_target":
            return "The Plan has no target branch. Run the checks again.";
        case "proof_failed":
            return "RunWield could not prove this merge is safe. Your work is safe.";
        case "plan_restored":
            return `The Plan copy is back at ${request.path}.`;
        case "not_worktree":
            return "This Plan does not use a worktree merge.";
        case "incomplete_worktree":
            return "Saved worktree info is missing. Check Git, then try again.";
        case "snapshot_restore_failed":
            return "The merge is done. RunWield could not restore the local Plan copy.";
        case "registry_update_failed":
            return "The merge is done. RunWield could not save the worktree result. Run Plans Doctor.";
        case "merged":
            return "The worktree changes are merged. The Plan is done.";
        case "result_record_failed":
            return "The merge is done. RunWield could not save the final note.";
        case "conflict_state_save_failed":
            return "The merge stopped. RunWield could not save the recovery state.";
        case "invalid_policy":
            return `RunWield cannot ${request.action} ${request.planName}. Send the Plan back for review.`;
        case "git_blocked":
            return "Git is not ready. Clear the saved attempt or set up Git, then try again.";
        case "recreate_warning":
            return request.path
                ? `The worktree for ${request.planName} is gone from ${request.path}. A new try will start fresh.`
                : `The worktree for ${request.planName} has no saved path. A new try will start fresh.`;
        case "worktree_abandoned":
            return `The worktree for ${request.planName} was stopped. Start a new try to go on.`;
        case "worktree_path_missing":
            return `The worktree for ${request.planName} has no saved path. Start a new try.`;
        case "worktree_missing":
            return request.path
                ? `The worktree for ${request.planName} is not at ${request.path}. Start a new try.`
                : `The worktree for ${request.planName} is gone. Start a new try.`;
        case "worktree_branch_changed":
            return `The worktree for ${request.planName} is on a new branch. Start a new try.`;
        case "worktree_inspection_failed":
            return `RunWield could not check the worktree for ${request.planName}. Your work is safe.`;
        case "reset_baseline_missing":
            return "No test base is saved. RunWield cannot reset this Plan.";
        case "reset_done":
            return "The old Git details are clear. No project files changed. The Plan is ready.";
        case "recreate_base_missing":
            return "RunWield cannot make the worktree because no start point is saved.";
        case "stopped":
            return "Stopped here. The Plan is ready for work.";
        case "record_incomplete":
            return "Saved worktree info is missing. RunWield cannot put it back.";
        case "record_restore_failed":
            return "RunWield could not restore the saved worktree details. Your work is safe.";
        case "record_restored":
            return `The saved worktree details for ${request.planName} are back.`;
        case "records_settled":
            return `Fixed ${request.count} old Plan stop${request.count === 1 ? "" : "s"}.`;
        case "record_unfinished":
            return `An old Plan update for ${request.planName} is not closed.`;
        case "records_attested":
            return `Closed on your word. The old Plan updates for ${request.planName} were kept.`;
        case "deleting_worktree":
            return `RunWield will now take out the worktree for ${request.planName}.`;
        case "git_delete_skipped":
            return "Git is not ready. RunWield will clear only the saved details.";
        case "record_already_gone":
            return "The saved worktree details were already gone. RunWield will go on.";
        case "worktree_cleanup_result":
            return request.failed ? `Cleanup stopped. ${request.detail}` : request.detail;
        case "abandon_done":
            return request.removed
                ? "The worktree is gone. The work is stopped."
                : "The saved worktree details are clear. The files were left in place.";
        case "abandon_definition_missing":
            return "The worktree is gone. No saved Plan file is left. Restore the Plan from Git or a backup, then load it again.";
        case "publication_cleanup_resumed": {
            const message = request.complete
                ? `Cleanup is done for ${request.planName}. The commits are on ${request.targetBranch}.`
                : `Cleanup stopped for ${request.planName}. ${
                    request.details.join(" ")
                } Your files are kept. Load the Plan to check again.`;
            return request.preservedFiles
                ? `${message} Leftover files were saved at ${request.preservedFiles}.`
                : message;
        }
        case "recovery_report": {
            const parts = [request.summary];
            if (request.lastRunStopped) parts.push("The last run stopped before it was done.");
            if (request.worktree) {
                parts.push([
                    `Worktree status: ${request.worktree.status || "unknown"}`,
                    `Worktree path: ${request.worktree.path || "unknown"}`,
                    `Worktree branch: ${request.worktree.branch || "unknown"}`,
                    `Target branch: ${request.worktree.target || "unknown"}`,
                ].join("\n"));
            }
            if (request.inspectionFailed) parts.push("RunWield could not check the saved Git work.");
            else if (request.gitStatus !== undefined) parts.push(`Git status:\n${request.gitStatus || "clean"}`);
            if (request.diff !== undefined) {
                parts.push(request.diff ? `Changes:\n${request.diff}` : "No file changes found.");
            }
            if (request.noBaseline) parts.push("No test base is saved for this Plan.");
            return parts.join("\n\n");
        }
    }
}

const RECOVERY_MESSAGES: Record<PlanRecoveryMessageKey, string> = {
    merge_cleanup_failed: "The merge is done. Cleanup stopped. Inspect the worktree, then try again.",
    handoff_failed: "The merge is done. The next step stopped. Try again.",
    merge_failed: "The merge did not work. Inspect the source branch, then try again.",
    baseline_reset_failed: "RunWield could not clear the old test base. No files changed.",
    worktree_recreate_failed: "RunWield could not make the worktree. No files changed.",
    action_blocked: "RunWield could not do that now. No files changed.",
};

export function planRecoveryMessage(key: PlanRecoveryMessageKey): string {
    return RECOVERY_MESSAGES[key];
}

export function listPlanRecoveryMessages(): readonly string[] {
    return Object.values(RECOVERY_MESSAGES);
}

export function listValidationUserMessages(): ReadonlyArray<{ key: ValidationUserMessageKey; message: string }> {
    return Object.entries(MESSAGES).map(([key, message]) => ({ key: key as ValidationUserMessageKey, message }));
}
