import { assertEquals, assertStringIncludes } from "@std/assert";

import { SUBAGENTS } from "../../constants.js";
import { loadSubAgentDefinition } from "../session/subagent-definitions.ts";
import { buildSemanticReviewAttempt } from "./validation-semantic.ts";
import { loadManualQaPrompt, loadReviewerPrompt } from "./validation.ts";

Deno.test("loadManualQaPrompt returns a bare tool-free prompt", async () => {
    const promptDef = await loadManualQaPrompt();
    assertEquals(promptDef.name, "operator");
    assertEquals(promptDef.displayName, "Manual QA");
    assertEquals(promptDef.tools, ["qa_checklist_generated"]);
    assertStringIncludes(promptDef.systemPrompt, "Manual verification steps for <plan name>");
});

Deno.test("bundled Manual QA prompt requires the user checklist shape", async () => {
    const prompt = await Deno.readTextFile(
        new URL("../../agent-definitions/subagent-definitions/manual-qa-prompt.md", import.meta.url),
    );

    assertStringIncludes(prompt, "Manual verification steps for <plan name>");
    assertStringIncludes(prompt, "- [ ] step 1");
    assertStringIncludes(prompt, "automated verification has already passed");
});

Deno.test("loadReviewerPrompt returns a bare prompt with canonical review tools", async () => {
    const reviewerDef = await loadReviewerPrompt("discovery");
    assertEquals(reviewerDef.name, "reviewer");
    assertEquals(reviewerDef.displayName, "Reviewer");
    assertEquals(reviewerDef.tools, ["read", "grep", "find", "ls", "review_diff", "review_complete", "delegate_agent"]);
    assertStringIncludes(reviewerDef.systemPrompt, "Your Default Is Approval");
    assertEquals(reviewerDef.systemPrompt.includes("{{SKILLS}}"), false);
    assertEquals(reviewerDef.systemPrompt.includes("Available tools"), false);
});

Deno.test("loadReviewerPrompt loads the verification prompt for later rounds", async () => {
    const reviewerDef = await loadReviewerPrompt("verify");
    assertStringIncludes(reviewerDef.systemPrompt, "Do Not Re-Derive the Plan");
});

/** @param {string} name */
/**
 * The prompt an Agent actually receives. Reviewer prompts compose the shared
 * review practice, so their contracts hold for the composed prompt; other
 * bundled prompts are read as written.
 *
 * @param {string} name
 */
async function readBundledPrompt(name) {
    if (name === "reviewer-prompt.md" || name === "reviewer-verify-prompt.md") {
        const definition = await loadReviewerPrompt(name === "reviewer-verify-prompt.md" ? "verify" : "discovery");
        return definition.systemPrompt;
    }
    return await Deno.readTextFile(new URL(`../../agent-definitions/subagent-definitions/${name}`, import.meta.url));
}

Deno.test("Semantic review prompt includes the canonical effective Plan projection", () => {
    const config = buildSemanticReviewAttempt(
        1,
        undefined,
        { semanticRound: 1, reviewLedger: { items: [], sequence: 0 }, repairBaselineTree: "", lastRepairReport: "" },
        "discovery",
        "diff --git a/src/app.js b/src/app.js",
        "",
        `---
planDeviations:
  - id: call-1
    supersededRequirement: "Replace nav."
    replacementRequirement: "Keep nav."
    approvedAt: "2026-09-10T00:00:00.000Z"
---
# Plan

Implement the screen.
`,
    );

    assertStringIncludes(config.prompt, "### Approved Plan");
    assertStringIncludes(config.prompt, "# Plan");
    assertStringIncludes(config.prompt, "## Approved Plan Deviations");
    assertStringIncludes(config.prompt, "Replacement requirement: Keep nav.");
    assertEquals(config.prompt.includes("Plan content is supplied by the validation request"), false);
});

Deno.test("bundled discovery reviewer prompt states an approval default", async () => {
    const prompt = await readBundledPrompt("reviewer-prompt.md");

    // Without an explicit default, the prompt's exhaustiveness pressure resolves
    // toward rejection: producing a finding is a concrete action, judging
    // "good enough" is not.
    assertStringIncludes(prompt, "Your Default Is Approval");
    assertStringIncludes(
        prompt.replace(/\s+/g, " "),
        "Approve unless you can name the specific requirement or concrete correctness, regression, or security defect, and the changed code responsible for it.",
    );
    assertStringIncludes(prompt.replace(/\s+/g, " "), "are not reasons to reject");
    assertStringIncludes(prompt, "This does not lower the bar for adherence");
});

Deno.test("bundled discovery reviewer prompt keeps code smells non-blocking", async () => {
    const prompt = await readBundledPrompt("reviewer-prompt.md");

    // Smells scale with diff size, which grows with every repair — leaving them
    // blocking is what let the review loop ratchet forever.
    assertStringIncludes(prompt, "**Review Advisories never block.**");
    assertStringIncludes(prompt, "speculative generality, duplicated logic, repeated conditionals");
    assertStringIncludes(prompt, "Report advisories alongside an approving decision");
    assertStringIncludes(
        prompt.replace(/\s+/g, " "),
        "Never convert an advisory into a rejection because several of them accumulated",
    );
});

Deno.test("bundled discovery reviewer blocks new seams over product-owned machinery", async () => {
    const prompt = (await readBundledPrompt("reviewer-prompt.md")).replace(/\s+/g, " ");

    assertStringIncludes(prompt, "A new injection seam that lets tests or callers replace product-owned machinery");
    assertStringIncludes(prompt, "Required ports are legitimate only for genuine external capabilities");
    assertStringIncludes(prompt, "renaming an override bag or making an internal collaborator required");
    assertStringIncludes(prompt, "Scan production changes for new injection seams");
});

Deno.test("bundled discovery reviewer prompt requires reading the diff before deciding", async () => {
    const prompt = await readBundledPrompt("reviewer-prompt.md");

    // The diff is never inlined, so a verdict without a review_diff call is a
    // decision made without reading the code.
    assertStringIncludes(prompt, 'Call `review_diff(command: "list")` first');
    assertStringIncludes(prompt, "You cannot review what you have not read");
});

Deno.test("bundled reviewer prompts exclude verification-completion auditing", async () => {
    for (const name of ["reviewer-prompt.md", "reviewer-verify-prompt.md"]) {
        // Collapse wrapping so these assert on wording, not on where the
        // formatter happened to break the line.
        const prompt = (await readBundledPrompt(name)).replace(/\s+/g, " ");

        assertStringIncludes(prompt, "your only concern, approve.", `${name} must approve on evidence-only concerns`);
        assertStringIncludes(prompt, "workflow context, not requirements", name);
        assertStringIncludes(prompt, "Formatter-only churn", name);
        assertStringIncludes(prompt, "a command", name);
        assertStringIncludes(prompt, "report to be filed so that you can approve", name);
    }
});

Deno.test("bundled reviewer prompts treat work in progress as normal, not as a finding", async () => {
    for (const name of ["reviewer-prompt.md", "reviewer-verify-prompt.md"]) {
        const prompt = (await readBundledPrompt(name)).replace(/\s+/g, " ");

        // General "this is unfinished/unsafe" commentary is noise inside an Epic; real defects stay findings.
        assertStringIncludes(prompt, "Work in Progress Is Not a Defect", name);
        assertStringIncludes(prompt, "Do not write general warnings that the work is unfinished", name);
        assertStringIncludes(prompt, "A real defect is still a finding", name);
    }
});

Deno.test("bundled discovery reviewer prompt scopes Epic children to their own correctness", async () => {
    const prompt = (await readBundledPrompt("reviewer-prompt.md")).replace(/\s+/g, " ");

    assertStringIncludes(prompt, "### Epic Context");
    assertStringIncludes(prompt, "a missing piece that a sibling owns is not a finding");
    assertStringIncludes(prompt, "Notes never block this child");
    assertStringIncludes(prompt, "when there is nothing to note, leave `integrationNotes` out");
});

Deno.test("Semantic review request carries the Epic context before the Plan", () => {
    const config = buildSemanticReviewAttempt(
        1,
        undefined,
        { semanticRound: 1, reviewLedger: { items: [], sequence: 0 }, repairBaselineTree: "", lastRepairReport: "" },
        "discovery",
        "diff --git a/a.ts b/a.ts\n",
        "",
        "# Child Plan\n",
        undefined,
        "### Epic Context\n\nThis Plan is one child of the Epic epic.",
    );

    const epicIndex = config.prompt.indexOf("### Epic Context");
    assertEquals(epicIndex >= 0, true);
    assertEquals(epicIndex < config.prompt.indexOf("### Approved Plan"), true);
});

Deno.test("bundled discovery reviewer prompt attacks tests with a plausible wrong implementation", async () => {
    const prompt = (await readBundledPrompt("reviewer-prompt.md")).replace(/\s+/g, " ");

    // A test that passes on a counterfeit implementation is a defect the Plan-adherence
    // checks never see, so the prompt must ask the question directly and keep the
    // judgment static — execution proof stays with mechanical validation.
    assertStringIncludes(prompt, "what plausible wrong implementation would still pass this test");
    assertStringIncludes(prompt, "Check the assertions, the boundaries, and fakes that bypass real behavior");
    assertStringIncludes(prompt, "never require execution proof");
    assertStringIncludes(prompt, "a test that green-lights a fake is misleading");
    assertStringIncludes(
        prompt,
        "Observations about strengthening an honest test beyond that gate are advisories",
    );
});

Deno.test("bundled discovery reviewer prompt requires all findings in one pass", async () => {
    const prompt = (await readBundledPrompt("reviewer-prompt.md")).replace(/\s+/g, " ");

    // Later rounds are narrower and will not rediscover what a discovery round
    // misses, so holding findings back loses them.
    assertStringIncludes(prompt, "Finding one issue does not finish the round");
    assertStringIncludes(prompt, "do not hold findings back for a later round");
    assertStringIncludes(prompt, "Report the complete set now, not one representative issue");
});

Deno.test("bundled verification reviewer prompt refuses to re-derive the Plan", async () => {
    const prompt = (await readBundledPrompt("reviewer-verify-prompt.md")).replace(/\s+/g, " ");

    assertStringIncludes(prompt, "Do Not Re-Derive the Plan");
    assertStringIncludes(prompt, "open code-smell findings at all");
    assertStringIncludes(prompt, "Is each open ledger item actually fixed?");
    assertStringIncludes(prompt, "Did the repair introduce a new Plan divergence or regression?");
    assertStringIncludes(prompt, "A new injection seam in a touched production hunk");
    assertStringIncludes(prompt, "only required ports for genuine external capabilities are legitimate");
    // A repair that makes the test pass by gutting it is a regression, not a fix.
    assertStringIncludes(prompt, "resolves a finding by weakening a test");
    assertStringIncludes(prompt, "loosening or deleting assertions, dropping a boundary case");
    assertStringIncludes(prompt, "substituting a fake for the real behavior so the test passes");
});

Deno.test("bundled verification reviewer prompt treats repair claims as evidence, not resolution", async () => {
    const prompt = await readBundledPrompt("reviewer-verify-prompt.md");

    assertStringIncludes(prompt, "never proof");
    assertStringIncludes(prompt, "only after you confirm the code fix or effective Plan supersession");
    assertStringIncludes(prompt, "Omitting an item does not resolve it");
    assertStringIncludes(prompt, "Never renumber, reuse, or invent identities");
    // An empty diff is neither proof of a fix nor proof an already-satisfied item is broken.
    assertStringIncludes(
        prompt.replace(/\s+/g, " "),
        "An empty repair diff is not proof of a fix or proof that an already-satisfied item is broken",
    );
    assertStringIncludes(prompt.replace(/\s+/g, " "), "full proposed branch patch");
    assertStringIncludes(prompt.replace(/\s+/g, " "), "otherwise reject the fix with a reason");
});

Deno.test("bundled validation repair engineer prompt is repair-scoped without Plan content or general Engineer context", async () => {
    const prompt = await readBundledPrompt("reviewer-feedback-engineer.md");
    const compact = prompt.replace(/\s+/g, " ");

    assertStringIncludes(prompt, "repair the validation problem you were given and report what you did");
    assertStringIncludes(compact, "the general Engineer prompt");
    assertStringIncludes(prompt, "one bounded repair packet");
    assertStringIncludes(prompt, "supplied full review diff");
    assertStringIncludes(prompt, "`already satisfied`");
    assertStringIncludes(prompt, "CI diagnostics");
    assertStringIncludes(compact, "semantic review findings");
    // The prompt may describe how to record an authorized Plan change, but it must not receive Plan content.
    assertEquals(prompt.includes("### Approved Plan"), false);
    assertStringIncludes(prompt, "**Your claims are evidence, not resolution.**");
});

Deno.test("validation repair engineer keeps working-tree safety and engineering practice, but not user authority", async () => {
    // These rules arrive through `sharedPractice`, so the assertion follows them to
    // the composed prompt — this agent cannot rely on a skill being loaded at the
    // model's discretion, and a fragment that stops composing would be invisible.
    // User authority is deliberately absent: this prompt states "You have no user
    // turn", so a policy built on the user confirming and repeating an instruction
    // describes a dialogue that can never happen here.
    const { systemPrompt } = await loadSubAgentDefinition(SUBAGENTS.REVIEWER_FEEDBACK_ENGINEER);

    assertEquals(systemPrompt.includes("After one concern, the discussion is complete. The user decides."), false);
    assertStringIncludes(systemPrompt, "You have no user turn");
    assertStringIncludes(systemPrompt, "`git stash` is the last resort");
    assertStringIncludes(systemPrompt, "The Zero-Trust Implementation Protocol");
    assertStringIncludes(systemPrompt, "No Rogue Commits");
    assertStringIncludes(systemPrompt.replace(/\s+/g, " "), "RunWield handles delivery after validation");
    assertStringIncludes(systemPrompt, "bundled `write-tests` skill");
    assertStringIncludes(systemPrompt, 'Do **NOT** dismiss errors as "pre-existing"');
    // Reached the repair agent for the first time via the shared layer.
    assertStringIncludes(systemPrompt, "report the test-count delta");
});

Deno.test("bundled workflow-only agents cannot name the removed router handoff tool", async () => {
    const removedToolName = ["return", "to", "router"].join("_");
    for (const name of ["reviewer-prompt.md", "reviewer-verify-prompt.md", "reviewer-feedback-engineer.md"]) {
        const prompt = await readBundledPrompt(name);
        assertEquals(prompt.includes(removedToolName), false, `${name} must not reference removed handoff tool`);
    }

    const { systemPrompt } = await loadSubAgentDefinition(SUBAGENTS.REVIEWER_FEEDBACK_ENGINEER);
    assertEquals(
        systemPrompt.includes(removedToolName),
        false,
        "composed reviewer-feedback engineer prompt must not reference removed handoff tool",
    );
});

Deno.test("bundled reviewer-feedback engineer stops in prose on an unreachable finding", async () => {
    const prompt = (await readBundledPrompt("reviewer-feedback-engineer.md")).replace(/\s+/g, " ");

    assertStringIncludes(prompt, "do not route around them");
    assertStringIncludes(prompt, "Do not call `task_completed`");
    assertStringIncludes(prompt, "end your turn in plain text");
    assertStringIncludes(prompt, "When every supplied item is settled, get one accepted `task_completed` call");
});
