import { test } from "node:test";
import { createAgentRegistry, type SubAgentDefinitionId } from "@runwield/agents";
import { assertEquals, assertExists, assertRejects, assertStringIncludes } from "../../test-support/assertions.ts";

const agentRegistry = createAgentRegistry();
const { primary: AGENTS, isolated: SUBAGENTS } = agentRegistry.ids;
const USER_AUTHORITY_MARKER = "After one concern, the discussion is complete. The user decides. Continue the work.";

const runtimeNames = {
    [SUBAGENTS.DELEGATED]: AGENTS.DELEGATED,
    [SUBAGENTS.DELEGATED_READ]: AGENTS.DELEGATED,
    [SUBAGENTS.INIT]: AGENTS.INIT,
    [SUBAGENTS.INTEGRATION_REVIEWER]: AGENTS.REVIEWER,
    [SUBAGENTS.MANUAL_QA]: AGENTS.OPERATOR,
    [SUBAGENTS.REVIEWER]: AGENTS.REVIEWER,
    [SUBAGENTS.REVIEWER_FEEDBACK_ENGINEER]: AGENTS.REVIEWER_FEEDBACK_ENGINEER,
    [SUBAGENTS.SLICER]: AGENTS.SLICER,
} satisfies Record<SubAgentDefinitionId, string>;

test("every registered subagent loads a prompt for its runtime Agent", async () => {
    for (const id of Object.values(SUBAGENTS)) {
        const agentDef = await agentRegistry.isolated.load(id);
        assertEquals(agentDef.name, runtimeNames[id]);
        assertEquals(agentDef.systemPrompt.trim().length > 0, true);
        const hasInteractiveUserAuthority = id === SUBAGENTS.SLICER || id === SUBAGENTS.INIT;
        assertEquals(
            agentDef.systemPrompt.includes(USER_AUTHORITY_MARKER),
            hasInteractiveUserAuthority,
            `${id} has the wrong user-authority state for an ${
                hasInteractiveUserAuthority ? "interactive" : "isolated"
            } subagent`,
        );
    }
});

test("reviewer discovery and verify prompts load through one registry id", async () => {
    const discovery = await agentRegistry.isolated.load(SUBAGENTS.REVIEWER, { reviewerMode: "discovery" });
    const verify = await agentRegistry.isolated.load(SUBAGENTS.REVIEWER, { reviewerMode: "verify" });

    assertEquals(discovery.name, AGENTS.REVIEWER);
    assertEquals(verify.name, AGENTS.REVIEWER);
    assertStringIncludes(discovery.systemPrompt, "Your Default Is Approval");
    assertStringIncludes(verify.systemPrompt, "verification round");
    assertEquals(discovery.systemPrompt.includes(USER_AUTHORITY_MARKER), false);
    assertEquals(verify.systemPrompt.includes(USER_AUTHORITY_MARKER), false);
});

test("the Integration Reviewer is its own subagent sharing review practice with the Semantic Reviewer", async () => {
    const integration = await agentRegistry.isolated.load(SUBAGENTS.INTEGRATION_REVIEWER);
    const discovery = await agentRegistry.isolated.load(SUBAGENTS.REVIEWER, { reviewerMode: "discovery" });

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

test("bare-prompt subagents receive canonical tool ceilings without the shared system prompt", async () => {
    const delegated = await agentRegistry.isolated.load(SUBAGENTS.DELEGATED);
    const manualQa = await agentRegistry.isolated.load(SUBAGENTS.MANUAL_QA);
    const reviewer = await agentRegistry.isolated.load(SUBAGENTS.REVIEWER);

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

test("full-agent subagents keep shared system-prompt composition and runtime names", async () => {
    const slicer = await agentRegistry.isolated.load(SUBAGENTS.SLICER);
    const init = await agentRegistry.isolated.load(SUBAGENTS.INIT);
    const feedbackEngineer = await agentRegistry.isolated.load(SUBAGENTS.REVIEWER_FEEDBACK_ENGINEER);

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

test("Init prompt focuses on project setup without a test-seam audit", async () => {
    const init = await agentRegistry.isolated.load(SUBAGENTS.INIT);

    for (const phrase of [
        "Possible test-seam risks",
        "Test-seam risk discovery",
        "evaluate test seams",
        "fixture-based refactor",
    ]) {
        assertEquals(init.systemPrompt.includes(phrase), false, `${phrase} should belong to the opt-in prompt`);
    }
    assertStringIncludes(init.systemPrompt, "Confirm the project verification command");
    assertStringIncludes(init.systemPrompt, "docs/domain-language.md");
    assertStringIncludes(init.systemPrompt, "Seed the memory system");
});

test("isolated Agent loading composes delegated role overlays", async () => {
    const general = await agentRegistry.isolated.load(SUBAGENTS.DELEGATED);
    const adversary = await agentRegistry.isolated.load(SUBAGENTS.DELEGATED, {
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

test("explicit general role reproduces the unspecialized delegated prompt", async () => {
    const implicit = await agentRegistry.isolated.load(SUBAGENTS.DELEGATED);
    const explicit = await agentRegistry.isolated.load(SUBAGENTS.DELEGATED, { delegatedRole: "general" });

    assertEquals(explicit.systemPrompt, implicit.systemPrompt);
    assertEquals(explicit.displayName, implicit.displayName);
});

test("every registered delegated role resolves and declares an authority ceiling", () => {
    const roleIds = agentRegistry.delegation.listRoles();
    assertEquals([...roleIds], ["general", "verification-adversary"]);
    assertEquals(agentRegistry.delegation.resolve("write", "general"), {
        role: { id: "general", authorityCeiling: "write" },
        effectiveAuthority: "write",
        definitionId: SUBAGENTS.DELEGATED,
    });
    assertEquals(agentRegistry.delegation.resolve("write", "verification-adversary"), {
        role: { id: "verification-adversary", authorityCeiling: "read" },
        effectiveAuthority: "read",
        definitionId: SUBAGENTS.DELEGATED_READ,
    });
    assertEquals(agentRegistry.delegation.resolve("read")?.role.id, "general");
    assertEquals(agentRegistry.delegation.resolve("read")?.effectiveAuthority, "read");
    assertEquals(agentRegistry.delegation.resolve("read", "researcher"), null);
});

test("resolving a write request for Verification Adversary loads the read base and role overlay", async () => {
    const delegation = agentRegistry.delegation.resolve("write", "verification-adversary");
    assertExists(delegation);
    const definition = await agentRegistry.isolated.load(delegation.definitionId, {
        delegatedRole: delegation.role.id,
    });

    assertStringIncludes(definition.description, "Read-only context-isolated helper");
    assertStringIncludes(definition.systemPrompt, "Complete only the supplied brief.");
    assertStringIncludes(definition.systemPrompt, "Role: Verification Adversary");
    assertEquals(definition.tools.includes("write"), false);
});

test("an unregistered delegated role fails the load and names the valid roles", async () => {
    const error = await assertRejects(
        () =>
            agentRegistry.isolated.load(SUBAGENTS.DELEGATED, {
                delegatedRole: "researcher" as never,
            }),
        Error,
    );

    assertStringIncludes(error.message, "Unknown delegated role: researcher");
    assertStringIncludes(error.message, "verification-adversary");
});

test("Slicer dependencies use descriptive names and retain exact legacy references", async () => {
    const { systemPrompt } = await agentRegistry.isolated.load(SUBAGENTS.SLICER);
    const prompt = systemPrompt.replaceAll(/\s+/g, " ");
    assertStringIncludes(prompt, "descriptive slugs without ordinal prefixes");
    assertStringIncludes(prompt, "Reordering changes `order`, not names or dependency references");
    assertEquals(prompt.includes("including the two-digit `order` prefix"), false);
});
