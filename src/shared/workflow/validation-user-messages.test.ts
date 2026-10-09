import { assert, assertEquals } from "@std/assert";
import {
    buildPlanRecoveryUserMessage,
    buildValidationRecoveryNotice,
    buildValidationUserMessage,
    listPlanRecoveryMessages,
    listValidationUserMessages,
    type PlanRecoveryMessageRequest,
    validationMergeRepairMessage,
    validationPhasePauseMessage,
    type ValidationRecoveryNotice,
    validationReviewerPauseMessage,
} from "./validation-user-messages.ts";
import { doctorCheckMessage, doctorCleanMessage, doctorNeedsHelpMessage } from "../../cmd/plans/doctor-messages.ts";

const FORBIDDEN = [
    "worktree registry",
    "front matter",
    "lifecycle",
    "projection",
    "checkpoint",
    "settlement",
    "execution context",
    "delivery evidence",
    "planid",
    "worktreeid",
];

function syllables(word: string): number {
    const cleaned = word.toLowerCase().replace(/[^a-z]/g, "");
    if (!cleaned) return 0;
    const groups = cleaned.replace(/e$/, "").match(/[aeiouy]+/g)?.length || 1;
    return Math.max(1, groups);
}

/** Flesch-Kincaid grade level after paths, code, ids, and allowed Git words are removed. */
function fleschKincaidGrade(message: string): number {
    const normalized = message
        .replace(/`[^`]*`/g, "")
        .replace(/(?:\.?\.?\/)?[\w.-]+(?:\/[\w.-]+)+/g, "")
        .replace(/\b(?:manual QA|Work Record)\b/gi, "")
        .replace(/\b(?:branch|commit|worktree|RunWield|Plan|Generating)\b/gi, "")
        .replace(/\b\w*[\d_-]\w*\b/g, "");
    const sentences = Math.max(1, (normalized.match(/[.!?]+/g) || []).length);
    const words = normalized.match(/[A-Za-z]+/g) || [];
    const syllableCount = words.reduce((sum, word) => sum + syllables(word), 0);
    return 0.39 * (words.length / sentences) + 11.8 * (syllableCount / Math.max(1, words.length)) - 15.59;
}

async function validationDisplaySources(): Promise<string[]> {
    const paths: string[] = [];
    for await (const entry of Deno.readDir(new URL(".", import.meta.url))) {
        if (entry.isFile && /^validation-.*\.(?:ts|js)$/.test(entry.name) && !entry.name.includes("test")) {
            paths.push(new URL(entry.name, import.meta.url).pathname);
        }
    }
    return paths;
}

function recoveryDisplaySources(): string[] {
    const directory = new URL("../../cmd/load-plan/", import.meta.url);
    const names = [
        "plan-recovery-actions.ts",
        "plan-recovery-flow.ts",
        "plan-recovery-reset.ts",
        "plan-recovery-worktree.ts",
    ];
    return names.map((name) => new URL(name, directory).pathname);
}

Deno.test("publication messages name the selected target branch", () => {
    const targetBranch = "release/next";
    const phases = [
        "preparing",
        "reading_target",
        "using_local_target",
        "updating_target",
        "combining_work",
        "publishing",
        "verifying",
        "cleanup",
    ] as const;
    const messages = phases.map((phase) =>
        buildValidationUserMessage({ kind: "publication_progress", phase, targetBranch })
    );

    assertEquals(messages, [
        "The commits are ready.",
        "Checking release/next for new commits.",
        "No remote is configured. Adding the commits to the local release/next branch.",
        "Adding new commits from release/next.",
        "Merging work into release/next.",
        "Sending the new commits to release/next.",
        "Checking the new commits on release/next.",
        "The new commits are on release/next. Cleaning up the worktree and source branch.",
    ]);
    assertEquals(
        buildValidationUserMessage({ kind: "verified", planName: "demo", targetBranch }),
        "demo is on release/next.",
    );
    assert(messages.every((message) => !message.includes("main")));
});

Deno.test("code review messages distinguish user review from AI review", () => {
    const reviewUrl = "http://127.0.0.1:4567/review/code?token=test";

    assertEquals(
        [
            buildValidationUserMessage({ kind: "human_review_offer" }),
            buildValidationUserMessage({ kind: "human_review_wait", reviewUrl }),
            buildValidationUserMessage({ kind: "human_review_approved" }),
            buildValidationUserMessage({ kind: "human_review_skipped" }),
        ],
        [
            "AI review passed. Do you want code review before merge?",
            `Need your review: ${reviewUrl}`,
            "Code review is done. You approved the work.",
            "Code Review skipped",
        ],
    );
});

Deno.test("saved integration notes name the parent Epic and note count", () => {
    assertEquals(
        buildValidationUserMessage({ kind: "integration_notes_saved", count: 2, epicPlanName: "demo" }),
        "AI review left 2 note(s) for demo.",
    );
});

Deno.test("Epic child Work Record message explains that generation waits for the parent", () => {
    assertEquals(
        buildValidationUserMessage({
            kind: "work_record_result",
            status: "skipped",
            reason: "parent_not_terminal",
        }),
        "The Work Record will be made after the parent Epic is finished.",
    );
});

Deno.test("incomplete publication cleanup names the Git objects and recovery commands", () => {
    const message = buildValidationUserMessage({
        kind: "publication_cleanup_incomplete",
        targetBranch: "release/next",
        worktreePath: "/tmp/demo-worktree",
        worktreeBranch: "runwield/demo",
        details: ["Git kept the worktree because it has an untracked file."],
    });

    assert(message.includes("commits are on release/next"));
    assert(message.includes("/tmp/demo-worktree"));
    assert(message.includes("runwield/demo"));
    assert(message.includes("git -C"));
    assert(message.includes("git branch -d"));
    assert(message.includes("wld plans doctor"));
});

Deno.test("all validation recovery and doctor messages stay plain", async () => {
    const recoveryRequests: PlanRecoveryMessageRequest[] = [
        { kind: "manual_merge_unavailable" },
        { kind: "missing_worktree" },
        { kind: "missing_plan_pointer" },
        { kind: "missing_target" },
        { kind: "proof_failed" },
        { kind: "plan_restored", path: "docs/plans/demo.md" },
        { kind: "not_worktree" },
        { kind: "incomplete_worktree" },
        { kind: "snapshot_restore_failed" },
        { kind: "registry_update_failed" },
        { kind: "merged" },
        { kind: "result_record_failed" },
        { kind: "conflict_state_save_failed" },
        { kind: "invalid_policy", action: "run", planName: "demo" },
        { kind: "git_blocked" },
        { kind: "recreate_warning", planName: "demo", path: "/tmp/work" },
        { kind: "worktree_abandoned", planName: "demo" },
        { kind: "worktree_path_missing", planName: "demo" },
        { kind: "worktree_missing", planName: "demo", path: "/tmp/work" },
        { kind: "worktree_branch_changed", planName: "demo" },
        { kind: "worktree_inspection_failed", planName: "demo" },
        { kind: "reset_baseline_missing" },
        { kind: "reset_done" },
        { kind: "recreate_base_missing" },
        { kind: "stopped" },
        { kind: "record_incomplete" },
        { kind: "record_restore_failed" },
        { kind: "record_restored", planName: "demo" },
        { kind: "records_settled", count: 2 },
        { kind: "record_unfinished", planName: "demo" },
        { kind: "records_attested", planName: "demo" },
        { kind: "deleting_worktree", planName: "demo" },
        { kind: "git_delete_skipped" },
        { kind: "record_already_gone" },
        { kind: "abandon_done", removed: true },
        { kind: "abandon_definition_missing" },
        { kind: "publication_cleanup_resumed", planName: "demo", targetBranch: "release", complete: true, details: [] },
        {
            kind: "publication_cleanup_resumed",
            planName: "demo",
            targetBranch: "release",
            complete: false,
            details: ["The target branch changed."],
        },
        { kind: "recovery_report", summary: "This is the Plan named demo.", lastRunStopped: false },
    ];
    const recoveryNotices: ValidationRecoveryNotice[] = [
        { kind: "session_plan_fixed", planName: "demo" },
        { kind: "worktree_record_rebuilt", planName: "demo" },
        { kind: "worktree_record_fixed", planName: "demo" },
        { kind: "worktree_path_fixed", planName: "demo" },
        { kind: "branch_restored", branch: "work" },
        { kind: "worktree_restored", planName: "demo", branch: "work" },
        { kind: "plan_status_restored", planName: "demo", from: "ready_for_review", to: "implemented" },
        { kind: "execution_plan_fixed", planName: "demo" },
        { kind: "review_range_fixed", planName: "demo" },
        { kind: "merge_plan_preserved", planName: "demo" },
    ];
    const messages = [
        ...listValidationUserMessages().map((entry) => entry.message),
        buildValidationUserMessage({ kind: "ci_running", cwd: "/tmp/demo" }),
        buildValidationUserMessage({ kind: "checks_passed" }),
        buildValidationUserMessage({ kind: "repair_waiting", agent: "Engineer" }),
        buildValidationUserMessage({ kind: "engineer_follow_up", agent: "Engineer" }),
        buildValidationUserMessage({ kind: "ci_repair", agent: "Engineer" }),
        buildValidationUserMessage({ kind: "semantic_round", round: 1, maxRounds: 3, mode: "discovery" }),
        buildValidationUserMessage({ kind: "semantic_skipped", reason: "non_git" }),
        buildValidationUserMessage({ kind: "semantic_skipped", reason: "empty_diff" }),
        buildValidationUserMessage({ kind: "semantic_approved", round: 1 }),
        buildValidationUserMessage({ kind: "review_repair", repairKind: "semantic" }),
        buildValidationUserMessage({ kind: "reviewer_nudge", round: 1, attempt: 2 }),
        buildValidationUserMessage({ kind: "integration_notes_saved", count: 2, epicPlanName: "demo" }),
        buildValidationUserMessage({
            kind: "semantic_limit",
            planName: "demo",
            rounds: 3,
            openCount: 1,
            testsPass: true,
        }),
        buildValidationUserMessage({ kind: "human_review_offer" }),
        buildValidationUserMessage({ kind: "human_review_wait" }),
        buildValidationUserMessage({ kind: "human_review_prompt", planName: "demo" }),
        buildValidationUserMessage({ kind: "human_review_approved" }),
        buildValidationUserMessage({ kind: "human_review_skipped" }),
        buildValidationUserMessage({ kind: "qa_prepare", planName: "demo" }),
        buildValidationUserMessage({ kind: "qa_ready", path: "docs/qa/demo.md", existed: false }),
        ...([
            "preparing",
            "reading_target",
            "updating_target",
            "combining_work",
            "publishing",
            "verifying",
            "cleanup",
        ] as const).map((phase) =>
            buildValidationUserMessage({ kind: "publication_progress", phase, targetBranch: "main" })
        ),
        buildValidationUserMessage({ kind: "merge_dispatch" }),
        buildValidationUserMessage({ kind: "verified", planName: "demo" }),
        buildValidationUserMessage({ kind: "context_blocked", planName: "demo" }),
        buildValidationUserMessage({ kind: "validation_command_missing" }),
        buildValidationUserMessage({ kind: "validation_command_prompt" }),
        buildValidationUserMessage({ kind: "validation_command_saved", command: "deno task ci" }),
        buildValidationUserMessage({
            kind: "work_record_prompt",
            recordId: "WR-1",
            reason: "The new work takes its place.",
        }),
        buildValidationUserMessage({ kind: "work_record_notice", message: "The Work Record is saved." }),
        buildValidationUserMessage({ kind: "manual_qa_failed" }),
        buildValidationUserMessage({ kind: "manual_qa_start" }),
        buildValidationUserMessage({ kind: "work_record_start" }),
        buildValidationUserMessage({ kind: "work_record_result", status: "failed" }),
        buildValidationUserMessage({ kind: "quick_fix_start" }),
        buildValidationUserMessage({ kind: "quick_fix_running", attempt: 1, maxAttempts: 3 }),
        buildValidationUserMessage({ kind: "quick_fix_canceled" }),
        buildValidationUserMessage({ kind: "quick_fix_ci_passed" }),
        buildValidationUserMessage({ kind: "quick_fix_qa" }),
        buildValidationUserMessage({ kind: "quick_fix_passed" }),
        buildValidationUserMessage({ kind: "quick_fix_failed", maxAttempts: 3 }),
        buildValidationUserMessage({ kind: "quick_fix_repair", agent: "Engineer", attempt: 1, maxAttempts: 3 }),
        buildValidationUserMessage({ kind: "quick_fix_waiting", agent: "Engineer" }),
        buildValidationUserMessage({ kind: "recovery_repair_failed" }),
        buildValidationUserMessage({ kind: "semantic_diff_missing", planOnly: true }),
        buildValidationUserMessage({ kind: "semantic_diff_missing", planOnly: false }),
        ...recoveryRequests.map(buildPlanRecoveryUserMessage),
        ...recoveryNotices.map(buildValidationRecoveryNotice),
        buildValidationUserMessage({ kind: "user_action", whatHappened: "The check stopped.", doThis: "Try again." }),
        ...listPlanRecoveryMessages(),
        validationMergeRepairMessage("demo", "target_update"),
        validationMergeRepairMessage("demo", "work_combination"),
        buildValidationUserMessage({
            kind: "publication_target_changed",
            targetBranch: "release/next",
            savedTargetBranch: "main",
        }),
        validationPhasePauseMessage("mechanical"),
        validationReviewerPauseMessage("demo"),
        doctorCleanMessage(0),
        doctorCleanMessage(2),
        doctorNeedsHelpMessage(1, 1),
        doctorCheckMessage(2),
    ];
    for (const message of messages) {
        const lower = message.toLowerCase();
        for (const term of FORBIDDEN) assert(!lower.includes(term), `${term} leaked in: ${message}`);
        assert(message.split(/\s+/).length <= 24, `message is too long: ${message}`);
        // The owner specified this exact three-word status; short labels distort reading-grade scores.
        if (message !== "Code Review skipped") {
            assert(fleschKincaidGrade(message) <= 4, `message is above grade 4: ${message}`);
        }
    }

    // Inventory each production display edge. Text literals and raw operation
    // details must not skip the typed catalog.
    let inventoriedCalls = 0;
    for (const path of await validationDisplaySources()) {
        const source = await Deno.readTextFile(path);
        inventoriedCalls += (source.match(
            /(?:emitStatus|emitProgress|emitSystemStatus|emitRunWieldSystemStatus|appendSystemMessage)\s*\(/g,
        ) || [])
            .length;
        assertEquals(
            /(?:emitStatus|emitProgress|emitSystemStatus|emitRunWieldSystemStatus)\s*\(\s*(?:args|hostedSession)\s*,\s*[`"']/s
                .test(source),
            false,
            path,
        );
        assertEquals(
            /(?:emitStatus|emitRunWieldSystemStatus)\s*\(\s*(?:args|hostedSession)\s*,\s*(?:reason|packet\.reason|summary\.)/s
                .test(source),
            false,
            path,
        );
        assertEquals(/prompt:\s*[`"']/s.test(source), false, path);
        if (!path.endsWith("validation-emit.ts")) {
            assertEquals(/\.emitStatus\s*\(/s.test(source), false, path);
        }
    }
    assert(inventoriedCalls > 30, "the display inventory did not find production calls");

    for (const path of recoveryDisplaySources()) {
        const source = await Deno.readTextFile(path);
        const calls = source.match(/appendSystemMessage\s*\(/g) || [];
        const catalogCalls = source.match(
            /appendSystemMessage\s*\(\s*(?:buildPlanRecoveryUserMessage|buildValidationRecoveryNotice|buildValidationUserMessage|planRecoveryMessage)\s*\(/g,
        ) || [];
        assertEquals(catalogCalls.length, calls.length, path);
    }
});
