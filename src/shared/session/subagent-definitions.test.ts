import { test } from "node:test";
import { assertExists, assertThrows } from "../../testing/assertions.ts";
import { checkBashCommand, intersectBashAllowedCommands } from "../bash-command-policy.ts";
import { SUBAGENTS, agentRegistry } from "./agent-registry.ts";

test("read delegates can inspect GitHub and GitLab without forge mutation commands", async () => {
    const definition = await agentRegistry.isolated.load(SUBAGENTS.DELEGATED_READ);
    for (const command of [
        "gh pr list",
        "gh pr view 123",
        "gh pr diff 123",
        "gh pr checks 123",
        "gh pr status",
        "gh issue list",
        "gh issue view 123",
        "gh issue status",
        "gh repo view owner/repo",
        "glab mr list",
        "glab mr view 123",
        "glab mr diff 123",
        "glab issue list",
        "glab issue view 123",
        "glab repo view group/repo",
    ])
        checkBashCommand(command, definition.bashAllowedCommands);
    for (const command of [
        "gh pr create",
        "gh pr merge 123",
        "gh pr checkout 123",
        "gh pr comment 123 --body text",
        "gh issue edit 123",
        "gh issue delete 123",
        "gh repo delete owner/repo",
        "gh api repos/owner/repo",
        "glab mr create",
        "glab mr merge 123",
        "glab mr checkout 123",
        "glab mr note 123 --message text",
        "glab issue update 123",
        "glab issue close 123",
        "glab repo delete group/repo",
        "glab api projects",
    ])
        assertThrows(() => checkBashCommand(command, definition.bashAllowedCommands));
});

test("read-delegate forge inspection cannot remove a parent shell restriction", async () => {
    const definition = await agentRegistry.isolated.load(SUBAGENTS.DELEGATED_READ);
    const effective = intersectBashAllowedCommands(["git status"], definition.bashAllowedCommands);
    assertThrows(() => checkBashCommand("gh pr list", effective));
    assertThrows(() => checkBashCommand("glab mr list", effective));
});

test("Verification Adversary cannot commit after a parent requests write delegation", async () => {
    const delegation = agentRegistry.delegation.resolve("write", "verification-adversary");
    assertExists(delegation);
    const definition = await agentRegistry.isolated.load(delegation.definitionId, {
        delegatedRole: delegation.role.id,
    });
    assertThrows(() => checkBashCommand("git commit", definition.bashAllowedCommands));
});
