import { assertEquals } from "../../testing/assertions.ts";
import { test } from "node:test";
import { ok as assert } from "node:assert/strict";
import { buildValidationUserMessage } from "./validation-user-messages.ts";

test("publication messages name the selected target branch", () => {
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
        buildValidationUserMessage({ kind: "publication_progress", phase, targetBranch }),
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

test("code review messages distinguish user review from AI review", () => {
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

test("saved integration notes distinguish later Epic checks from child Plan fixes", () => {
    assertEquals(
        buildValidationUserMessage({ kind: "integration_notes_saved", count: 3, epicPlanName: "demo" }),
        "AI review saved 3 integration notes for Epic demo. These are for its later check. They do not ask for a fix.",
    );
});

test("Epic child Work Record message explains that generation waits for the parent", () => {
    assertEquals(
        buildValidationUserMessage({
            kind: "work_record_result",
            status: "skipped",
            reason: "parent_not_terminal",
        }),
        "The Work Record will be made after the parent Epic is finished.",
    );
});

test("incomplete publication cleanup names the Git objects and recovery commands", () => {
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
