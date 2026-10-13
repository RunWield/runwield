import { test } from "node:test";
import { assertEquals, assertStringIncludes } from "../../testing/assertions.ts";
import { buildValidationRepairPrompt } from "./validation-repair-prompt.ts";

test("focused validation repair packet carries worktree and failure context without a Plan", () => {
    const prompt = buildValidationRepairPrompt({
        executionCwd: "/worktrees/child",
        repairCwd: "/worktrees/child",
        repairsNeeded: "CI failed with TS2741.",
        worktreeId: "wt-123",
        worktreeBranch: "worktree/child",
        worktreeBaseBranch: "main",
    });

    assertStringIncludes(prompt, "This is a focused repair session.");
    assertStringIncludes(prompt, "Repair checkout: `/worktrees/child`");
    assertStringIncludes(prompt, "Worktree ID: `wt-123`");
    assertStringIncludes(prompt, "Worktree branch: `worktree/child`");
    assertStringIncludes(prompt, "Target branch: `main`");
    assertStringIncludes(prompt, "CI failed with TS2741.");
    assertStringIncludes(prompt, "call task_completed");
    assertEquals(prompt.includes("Plan"), false);
});

test("focused validation repair packet preserves repair-specific authority and completion rules", () => {
    const prompt = buildValidationRepairPrompt({
        executionCwd: "/execution",
        repairCwd: "/merge-repair",
        repairsNeeded: "Resolve the content conflict.",
        authorityNote: "Human feedback is authoritative.",
        completionInstruction: "Report one disposition per finding, then call task_completed.",
    });

    assertStringIncludes(prompt, "Original execution worktree: `/execution`");
    assertStringIncludes(prompt, "Human feedback is authoritative.");
    assertStringIncludes(prompt, "Report one disposition per finding, then call task_completed.");
    assertEquals(prompt.includes("Plan"), false);
});

test("focused validation repair packet never adds general implementation ceremony", () => {
    const prompt = buildValidationRepairPrompt({
        executionCwd: "/project",
        repairCwd: "/project",
        repairsNeeded: "Fix the failing check.",
    });

    assertEquals(prompt.includes("Plan"), false);
    assertEquals(prompt.includes("original implementation conversation"), false);
    assertEquals(prompt.includes("implement the requested change"), false);
    assertEquals(prompt.includes(".wld/settings.json"), false);
    assertEquals(prompt.includes("verification_command"), false);
});
