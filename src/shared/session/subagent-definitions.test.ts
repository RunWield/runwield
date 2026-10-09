import { assertEquals, assertRejects, assertStringIncludes, assertThrows } from "@std/assert";
import { checkBashCommand, intersectBashAllowedCommands } from "../bash-command-policy.ts";
import { join } from "@std/path";
import { AGENTS, SUBAGENTS } from "../../constants.js";
import {
    DELEGATED_ROLE_IDS,
    DELEGATED_ROLES,
    getDelegatedRole,
    loadBarePromptDefinition,
    loadSubAgentDefinition,
    SUBAGENT_DEFINITIONS,
    type SubAgentDefinitionId,
} from "./subagent-definitions.ts";

const EXPECTED_PROMPT_FILES = [
    "delegated-agent-prompt.md",
    "delegated-read-agent-prompt.md",
    "init-agent-prompt.md",
    "integration-reviewer-prompt.md",
    "manual-qa-prompt.md",
    "reviewer-feedback-engineer.md",
    "reviewer-prompt.md",
    "reviewer-verify-prompt.md",
    "slicer-prompt.md",
];

const EXPECTED_ROLE_OVERLAY_FILES = ["verification-adversary.md"];
const USER_AUTHORITY_MARKER = "After one concern, the discussion is complete. The user decides. Continue the work.";

function sourcePromptPath(fileName: string) {
    return join("src", "agent-definitions", "subagent-definitions", fileName);
}

Deno.test("subagent prompt files live only in the subagent definitions directory", async () => {
    const entries = [];
    for await (const entry of Deno.readDir(join("src", "agent-definitions", "subagent-definitions"))) {
        if (entry.isFile) entries.push(entry.name);
    }
    entries.sort();

    const roleEntries = [];
    for await (const entry of Deno.readDir(join("src", "agent-definitions", "subagent-definitions", "roles"))) {
        if (entry.isFile) roleEntries.push(entry.name);
    }
    roleEntries.sort();

    assertEquals(entries, EXPECTED_PROMPT_FILES);
    assertEquals(roleEntries, EXPECTED_ROLE_OVERLAY_FILES);
    const oldPromptDirectory = join("src", "agent-definitions", "workflow-" + "prompts");
    await assertRejects(
        () => Deno.stat(oldPromptDirectory),
        Deno.errors.NotFound,
    );
});

Deno.test("every registered subagent loads from the moved bundled prompt files", async () => {
    const loadedIds: string[] = [];
    for (const id of Object.keys(SUBAGENT_DEFINITIONS) as SubAgentDefinitionId[]) {
        const definition = SUBAGENT_DEFINITIONS[id];
        const agentDef = await loadSubAgentDefinition(id);
        const prompt = await Deno.readTextFile(sourcePromptPath(definition.file));

        loadedIds.push(id);
        assertEquals(agentDef.name, definition.agentName);
        assertEquals(prompt.trim().length > 0, true);
        const hasInteractiveUserAuthority = id === SUBAGENTS.SLICER || id === SUBAGENTS.INIT;
        assertEquals(
            agentDef.systemPrompt.includes(USER_AUTHORITY_MARKER),
            hasInteractiveUserAuthority,
            `${id} has the wrong user-authority state for an ${
                hasInteractiveUserAuthority ? "interactive" : "isolated"
            } subagent`,
        );
    }

    assertEquals(loadedIds.sort(), Object.values(SUBAGENTS).sort());
});

Deno.test("read delegates can inspect GitHub and GitLab without forge mutation commands", async () => {
    const definition = await loadSubAgentDefinition(SUBAGENTS.DELEGATED_READ);
    for (
        const command of [
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
        ]
    ) checkBashCommand(command, definition.bashAllowedCommands);
    for (
        const command of [
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
        ]
    ) assertThrows(() => checkBashCommand(command, definition.bashAllowedCommands));
});

Deno.test("read-delegate forge inspection cannot remove a parent shell restriction", async () => {
    const definition = await loadSubAgentDefinition(SUBAGENTS.DELEGATED_READ);
    const effective = intersectBashAllowedCommands(["git status"], definition.bashAllowedCommands);
    assertThrows(() => checkBashCommand("gh pr list", effective));
    assertThrows(() => checkBashCommand("glab mr list", effective));
});

Deno.test("reviewer discovery and verify prompts load through one registry id", async () => {
    const discovery = await loadSubAgentDefinition(SUBAGENTS.REVIEWER, { reviewerMode: "discovery" });
    const verify = await loadSubAgentDefinition(SUBAGENTS.REVIEWER, { reviewerMode: "verify" });

    assertEquals(discovery.name, AGENTS.REVIEWER);
    assertEquals(verify.name, AGENTS.REVIEWER);
    assertStringIncludes(discovery.systemPrompt, "Your Default Is Approval");
    assertStringIncludes(verify.systemPrompt, "verification round");
    assertEquals(discovery.systemPrompt.includes(USER_AUTHORITY_MARKER), false);
    assertEquals(verify.systemPrompt.includes(USER_AUTHORITY_MARKER), false);
});

Deno.test("the Integration Reviewer is its own subagent sharing review practice with the Semantic Reviewer", async () => {
    const integration = await loadSubAgentDefinition(SUBAGENTS.INTEGRATION_REVIEWER);
    const discovery = await loadSubAgentDefinition(SUBAGENTS.REVIEWER, { reviewerMode: "discovery" });

    assertEquals(integration.name, AGENTS.REVIEWER);
    assertEquals(integration.displayName, "Integration Reviewer");
    assertStringIncludes(integration.systemPrompt, "Do the children fit together?");
    assertStringIncludes(integration.systemPrompt, "You do not read every line.");
    // One shared practice: the same approval default and work-in-progress rule reach both reviewers.
    for (const prompt of [integration.systemPrompt, discovery.systemPrompt]) {
        assertStringIncludes(prompt, "## Review Practice");
        assertStringIncludes(prompt, "Work in Progress Is Not a Defect");
    }
    assertEquals(integration.systemPrompt.includes(USER_AUTHORITY_MARKER), false);
    assertEquals(integration.tools.includes("delegate_agent"), true);
});

Deno.test("bare-prompt subagents receive canonical tool ceilings without the shared system prompt", async () => {
    const delegated = await loadSubAgentDefinition(SUBAGENTS.DELEGATED);
    const manualQa = await loadSubAgentDefinition(SUBAGENTS.MANUAL_QA);
    const reviewer = await loadSubAgentDefinition(SUBAGENTS.REVIEWER);

    assertEquals(delegated.tools, [
        "read",
        "grep",
        "find",
        "ls",
        "bash",
        "code_search",
        "code_show",
        "code_outline",
        "code_batch",
        "code_refs",
        "code_impact",
        "code_trace",
        "code_investigate",
        "code_structure",
        "code_impls",
        "code_importers",
        "web_search",
        "web_fetch",
        "web_code_search",
        "web_docs_search",
        "edit",
        "write",
        "multi_file_edit",
        "create_image",
    ]);
    assertEquals(manualQa.tools, ["qa_checklist_generated"]);
    assertEquals(reviewer.tools, ["read", "grep", "find", "ls", "review_diff", "review_complete", "delegate_agent"]);
    assertEquals(delegated.systemPrompt.includes("## Available tools"), false);
    assertEquals(manualQa.systemPrompt.includes("{{SKILLS}}"), false);
    assertEquals(reviewer.systemPrompt.includes("{{AVAILABLE_TOOLS}}"), false);
    assertEquals(manualQa.name, AGENTS.OPERATOR);
});

Deno.test("bare-prompt subagents without a tool ceiling fail closed instead of silently running tool-free", async () => {
    // A registry regression that drops `allowedTools` from a tools-carrying
    // subagent must throw at load time: the silent `tools: []` fallback once
    // let the Semantic Reviewer start with no `review_complete` (and no
    // read/grep/find/ls), stalling Workflow Validation mid-round.
    const error = await assertRejects(
        () =>
            loadBarePromptDefinition(
                {
                    id: "reviewer",
                    agentName: AGENTS.REVIEWER,
                    displayNameFallback: "Reviewer",
                    loadMode: "barePrompt",
                    file: "reviewer-prompt.md",
                    // allowedTools deliberately absent — the regression being guarded.
                },
                "reviewer-prompt.md",
            ),
        Error,
    );

    assertStringIncludes(error.message, "allowedTools");
    assertStringIncludes(error.message, "toolFree");
    assertStringIncludes(error.message, "reviewer");
});

Deno.test("full-agent subagents keep shared system-prompt composition and runtime names", async () => {
    const slicer = await loadSubAgentDefinition(SUBAGENTS.SLICER);
    const init = await loadSubAgentDefinition(SUBAGENTS.INIT);
    const feedbackEngineer = await loadSubAgentDefinition(SUBAGENTS.REVIEWER_FEEDBACK_ENGINEER);

    assertEquals(slicer.name, AGENTS.SLICER);
    assertEquals(init.name, AGENTS.INIT);
    assertEquals(feedbackEngineer.name, AGENTS.REVIEWER_FEEDBACK_ENGINEER);
    assertStringIncludes(slicer.systemPrompt, "## Available tools");
    assertStringIncludes(init.systemPrompt, "## Skills");
    assertStringIncludes(feedbackEngineer.systemPrompt, "## Memory System");
    assertEquals(init.tools.includes("user_interview"), true);
    assertEquals(init.tools.includes("init_save_verification_command"), true);
    assertStringIncludes(init.systemPrompt, "existing project `verification_command` first");
    assertStringIncludes(init.systemPrompt, "No verification command");
    assertStringIncludes(init.systemPrompt, "Other");
    assertStringIncludes(init.systemPrompt, "cancels");
    assertStringIncludes(init.systemPrompt, 'echo "verification not implemented yet"');
});

Deno.test("Init prompt focuses on project setup without a test-seam audit", async () => {
    const init = await loadSubAgentDefinition(SUBAGENTS.INIT);

    for (
        const phrase of [
            "Possible test-seam risks",
            "Test-seam risk discovery",
            "evaluate test seams",
            "fixture-based refactor",
        ]
    ) {
        assertEquals(init.systemPrompt.includes(phrase), false, `${phrase} should belong to the opt-in prompt`);
    }
    assertStringIncludes(init.systemPrompt, "Confirm the project verification command");
    assertStringIncludes(init.systemPrompt, "docs/domain-language.md");
    assertStringIncludes(init.systemPrompt, "Seed the memory system");
});

Deno.test("loadSubAgentDefinition composes delegated role overlays", async () => {
    const general = await loadSubAgentDefinition(SUBAGENTS.DELEGATED);
    const adversary = await loadSubAgentDefinition(SUBAGENTS.DELEGATED, {
        delegatedRole: "verification-adversary",
    });

    // The base prompt stays the source of universal delegated-session rules.
    assertStringIncludes(general.systemPrompt, "Complete only the supplied brief.");
    assertStringIncludes(adversary.systemPrompt, "Complete only the supplied brief.");
    // The overlay adds only the role-specific adversarial task and handoff contract.
    assertStringIncludes(adversary.systemPrompt, "Role: Verification Adversary");
    assertStringIncludes(adversary.systemPrompt, "not-discriminating");
    assertEquals(adversary.systemPrompt.includes(USER_AUTHORITY_MARKER), false);
    assertEquals(general.systemPrompt.includes("not-discriminating"), false);
    assertEquals(adversary.systemPrompt.startsWith(general.systemPrompt), true);
    assertEquals(adversary.name, AGENTS.DELEGATED);
    assertEquals(adversary.displayName, "Verification Adversary");
});

Deno.test("explicit general role reproduces the unspecialized delegated prompt", async () => {
    const implicit = await loadSubAgentDefinition(SUBAGENTS.DELEGATED);
    const explicit = await loadSubAgentDefinition(SUBAGENTS.DELEGATED, { delegatedRole: "general" });

    assertEquals(explicit.systemPrompt, implicit.systemPrompt);
    assertEquals(explicit.displayName, implicit.displayName);
});

Deno.test("every registered delegated role resolves and declares an authority ceiling", async () => {
    assertEquals([...DELEGATED_ROLE_IDS], ["general", "verification-adversary"]);
    assertEquals(getDelegatedRole("general")?.authorityCeiling, "write");
    assertEquals(getDelegatedRole("verification-adversary")?.authorityCeiling, "read");
    assertEquals(getDelegatedRole(undefined)?.id, "general");
    assertEquals(getDelegatedRole("researcher"), null);

    for (const id of DELEGATED_ROLE_IDS) {
        const role = DELEGATED_ROLES[id];
        if (!role.overlayFile) continue;
        const overlay = await Deno.readTextFile(sourcePromptPath(join("roles", role.overlayFile)));
        assertEquals(overlay.trim().length > 0, true);
    }
});

Deno.test("an unregistered delegated role fails the load and names the valid roles", async () => {
    const error = await assertRejects(
        () =>
            loadSubAgentDefinition(SUBAGENTS.DELEGATED, {
                delegatedRole: "researcher" as never,
            }),
        Error,
    );

    assertStringIncludes(error.message, "Unknown delegated role: researcher");
    assertStringIncludes(error.message, "verification-adversary");
});
