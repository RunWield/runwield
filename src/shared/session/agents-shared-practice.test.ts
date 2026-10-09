import { assertEquals, assertMatch, assertRejects, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { _AGENT_ATTENTION_NUDGES, listAgentDefNames, loadAgentDef } from "./agents.js";

const BUNDLED_AGENT_DEFS = join("src", "agent-definitions");
const SHARED_PRACTICE_DIR = join(BUNDLED_AGENT_DEFS, "shared-practice");

Deno.test("managed engineering assigns full validation to RunWield and keeps standalone verification", async () => {
    for (const name of ["engineer", "plan-engineer", "frontend-engineer"]) {
        const { systemPrompt } = await loadAgentDef(name);
        const normalizedPrompt = systemPrompt.replaceAll(/\s+/g, " ");
        assertStringIncludes(normalizedPrompt, "Who Runs Full Validation");
        assertStringIncludes(normalizedPrompt, "mandatory Mechanical Validation");
        assertStringIncludes(
            normalizedPrompt,
            "Outside a managed workflow, run the full project validation command yourself",
        );
        assertStringIncludes(normalizedPrompt, "full validation is pending");
        assertEquals(normalizedPrompt.includes("Run the full command, not just a check"), false);
    }
});

const QUICK_FIX_FRAGMENTS = [
    "user-authority",
    "working-tree-safety",
    "engineering-practice",
    "bounded-request",
] as const;

const PLAN_EXECUTION_FRAGMENTS = [
    "user-authority",
    "working-tree-safety",
    "engineering-practice",
    "plan-execution",
] as const;

/** The two personas an approved Plan can activate. */
const PLAN_EXECUTION_PERSONAS: readonly string[] = ["plan-engineer", "frontend-engineer"];

/** Personas that compose shared practice, and the fragments each one claims. */
const SHARED_PRACTICE_CONSUMERS: ReadonlyArray<[string, readonly string[]]> = [
    ["engineer", QUICK_FIX_FRAGMENTS],
    ["plan-engineer", PLAN_EXECUTION_FRAGMENTS],
    ["frontend-engineer", PLAN_EXECUTION_FRAGMENTS],
];

/** Every persona that can run git or delete files, including the non-engineering one. */
const WORKING_TREE_CONSUMERS: readonly string[] = ["engineer", "plan-engineer", "frontend-engineer", "operator"];

const PLANNING_DOC_FRAGMENTS = [
    "user-authority",
    "show-the-work",
    "work-record-retrieval",
    "conversational-turns",
] as const;

/** The two personas that write planning documents and share their structural vocabulary. */
const PLANNING_DOC_AUTHORS: readonly string[] = ["planner", "architect"];

/** Planning personas that compose the explanation practice on top of user authority. */
const PLANNING_PRACTICE_CONSUMERS: ReadonlyArray<[string, readonly string[]]> = [
    ["planner", [
        ...PLANNING_DOC_FRAGMENTS,
        "plain-language-dialogue",
        "architecture-vocabulary",
        "domain-design",
        "planning-pending-changes",
    ]],
    ["architect", [
        ...PLANNING_DOC_FRAGMENTS,
        "plain-language-dialogue",
        "architecture-vocabulary",
        "domain-design",
        "planning-pending-changes",
    ]],
    ["ideator", [...PLANNING_DOC_FRAGMENTS]],
];

/** Every persona that reads project history. Recorder writes the records and keeps its own broader rules. */
const WORK_RECORD_CONSUMERS: readonly string[] = ["guide", "planner", "architect", "ideator"];

const USER_AUTHORITY_MARKER = "After one concern, the discussion is complete. The user decides. Continue the work.";
const PLAN_EDIT_DEFAULT_MARKER = "Never initiate or make an unrequested Plan edit";
const PLAN_EDIT_USER_OVERRIDE_MARKER = "If the user explicitly asks you to revise the active Plan";
const SHOW_THE_WORK_MARKER = "Explain the work the way you would at a whiteboard with a coworker";
const WORKING_TREE_MARKER = "`git stash` is the last resort when you genuinely cannot proceed";
const RUNWIELD_DELIVERY_MARKER = "RunWield handles delivery after validation";
const WORK_RECORD_MARKER = "do not call it ritualistically on every turn";
const CONVERSATIONAL_TURNS_MARKER = "Never end on a promise or on a statement the user has nothing to answer";

interface ProjectAgentFile {
    path: string;
    contents: string;
}

/**
 * Write agent definitions into a throwaway project root and load one from it.
 * The real loader walks the real filesystem — only the repository under it is faked.
 */
async function withProjectAgents<T>(
    files: readonly ProjectAgentFile[],
    run: (projectRoot: string) => Promise<T>,
): Promise<T> {
    const projectRoot = await Deno.makeTempDir({ prefix: "runwield-shared-practice-" });
    try {
        for (const file of files) {
            const target = join(projectRoot, ".wld", "agents", file.path);
            await Deno.mkdir(join(target, ".."), { recursive: true });
            await Deno.writeTextFile(target, file.contents);
        }
        return await run(projectRoot);
    } finally {
        await Deno.remove(projectRoot, { recursive: true });
    }
}

function agentFile(name: string, frontMatter: string, body: string): ProjectAgentFile {
    return { path: `${name}.md`, contents: `---\nname: ${name}\n${frontMatter}---\n\n${body}\n` };
}

function fragmentFile(name: string, body: string): ProjectAgentFile {
    return { path: join("shared-practice", `${name}.md`), contents: `---\nname: ${name}\n---\n\n${body}\n` };
}

Deno.test("shared practice fragments are appended after the agent's own prompt body", async () => {
    const def = await withProjectAgents([
        agentFile("temp-agent", "sharedPractice:\n    - house-rules\n", "## Process\n\nDo the process."),
        fragmentFile("house-rules", "## House Rules\n\nNever skip the rules."),
    ], (projectRoot) => loadAgentDef("temp-agent", projectRoot));

    const processIndex = def.systemPrompt.indexOf("Do the process.");
    const rulesIndex = def.systemPrompt.indexOf("Never skip the rules.");
    assertEquals(processIndex >= 0, true);
    assertEquals(rulesIndex > processIndex, true);
});

Deno.test("fragments compose in declaration order and dedupe repeats", async () => {
    const def = await withProjectAgents([
        agentFile(
            "temp-agent",
            "sharedPractice:\n    - first-fragment\n    - second-fragment\n    - first-fragment\n",
            "## Process\n\nBody.",
        ),
        fragmentFile("first-fragment", "FIRST_MARKER"),
        fragmentFile("second-fragment", "SECOND_MARKER"),
    ], (projectRoot) => loadAgentDef("temp-agent", projectRoot));

    assertEquals(def.systemPrompt.match(/FIRST_MARKER/g)?.length, 1);
    assertEquals(def.systemPrompt.indexOf("SECOND_MARKER") > def.systemPrompt.indexOf("FIRST_MARKER"), true);
});

Deno.test("a project fragment overrides the bundled fragment of the same name", async () => {
    const def = await withProjectAgents([
        agentFile("temp-agent", "sharedPractice:\n    - engineering-practice\n", "## Process\n\nBody."),
        fragmentFile("engineering-practice", "PROJECT_OVERRIDE_MARKER"),
    ], (projectRoot) => loadAgentDef("temp-agent", projectRoot));

    assertStringIncludes(def.systemPrompt, "PROJECT_OVERRIDE_MARKER");
    assertEquals(def.systemPrompt.includes("The Zero-Trust Implementation Protocol"), false);
});

Deno.test("an agent that declares no shared practice composes nothing extra", async () => {
    const def = await withProjectAgents([
        agentFile("temp-agent", "", "## Process\n\nBody."),
        fragmentFile("engineering-practice", "SHOULD_NOT_APPEAR"),
    ], (projectRoot) => loadAgentDef("temp-agent", projectRoot));

    assertEquals(def.systemPrompt.includes("SHOULD_NOT_APPEAR"), false);
});

Deno.test("a missing fragment fails loudly and names the paths it checked", async () => {
    const error = await withProjectAgents(
        [agentFile("temp-agent", "sharedPractice:\n    - no-such-fragment\n", "## Process\n\nBody.")],
        (projectRoot) =>
            assertRejects(
                () => loadAgentDef("temp-agent", projectRoot),
                Error,
                'Could not find shared practice fragment "no-such-fragment"',
            ),
    );

    assertStringIncludes(error.message, join("shared-practice", "no-such-fragment.md"));
});

Deno.test("a non-list sharedPractice field is rejected rather than silently ignored", async () => {
    await withProjectAgents(
        [agentFile("temp-agent", "sharedPractice: engineering-practice\n", "## Process\n\nBody.")],
        (projectRoot) =>
            assertRejects(
                () => loadAgentDef("temp-agent", projectRoot),
                Error,
                "non-list sharedPractice field",
            ),
    );
});

Deno.test("shared practice fragments are never offered as agents", async () => {
    const names = await listAgentDefNames();
    assertEquals(names.includes("engineering-practice"), false);
    assertEquals(names.includes("plan-execution"), false);
    assertEquals(names.includes("user-authority"), false);
    assertEquals(names.includes("shared-practice"), false);
});

Deno.test("every bundled fragment is claimed by at least one agent", async () => {
    const claimed = new Set(
        [...SHARED_PRACTICE_CONSUMERS, ...PLANNING_PRACTICE_CONSUMERS].flatMap(([, fragments]) => fragments),
    );
    // The Reviewer-Feedback Engineer is a workflow-only subagent, so it is not in
    // the loadAgentDef listing above; it claims engineering-practice on its own.
    claimed.add("engineering-practice");
    claimed.add("working-tree-safety");
    // Both delegated subagent definitions claim this fragment outside the top-level listing.
    claimed.add("delegated-session");
    // Discovery, verification, and integration Reviewers are workflow-only subagents.
    const { loadSubAgentDefinition } = await import("./subagent-definitions.ts");
    const { SUBAGENTS } = await import("../../constants.js");
    const reviewPractice = (await Deno.readTextFile(join(SHARED_PRACTICE_DIR, "review-practice.md")))
        .replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "").trim();
    for (const id of [SUBAGENTS.REVIEWER, SUBAGENTS.INTEGRATION_REVIEWER]) {
        const reviewer = await loadSubAgentDefinition(id);
        assertStringIncludes(reviewer.systemPrompt, reviewPractice);
    }
    const verifyReviewer = await loadSubAgentDefinition(SUBAGENTS.REVIEWER, { reviewerMode: "verify" });
    assertStringIncludes(verifyReviewer.systemPrompt, reviewPractice);
    claimed.add("review-practice");

    for await (const entry of Deno.readDir(SHARED_PRACTICE_DIR)) {
        if (!entry.isFile || !entry.name.endsWith(".md")) continue;
        const fragment = entry.name.replace(/\.md$/, "");
        assertEquals(claimed.has(fragment), true, `Unclaimed shared practice fragment: ${fragment}`);
    }
});

Deno.test("every coding persona composes the engineering practice it declares", async () => {
    for (const [agentName] of SHARED_PRACTICE_CONSUMERS) {
        const def = await loadAgentDef(agentName);
        assertStringIncludes(def.systemPrompt, "The Zero-Trust Implementation Protocol");
        assertStringIncludes(def.systemPrompt, "When Verification Fails, Act");
        assertStringIncludes(def.systemPrompt.replaceAll(/\s+/g, " "), RUNWIELD_DELIVERY_MARKER);
    }
});

Deno.test("only the Plan executors are told what to do with requests outside the Plan", async () => {
    // Engineer has no Plan to be outside of, so the boundary rule would be a
    // contradiction in its prompt rather than a missing rule.
    for (const agentName of PLAN_EXECUTION_PERSONAS) {
        const def = await loadAgentDef(agentName);
        assertStringIncludes(def.systemPrompt, "Requests that are not the Plan");
    }
    const engineer = await loadAgentDef("engineer");
    assertEquals(engineer.systemPrompt.includes("Requests that are not the Plan"), false);
});

Deno.test("every bundled top-level agent receives the user-authority policy", async () => {
    for (const agentName of await listAgentDefNames()) {
        const def = await loadAgentDef(agentName);
        assertStringIncludes(def.systemPrompt, USER_AUTHORITY_MARKER, `${agentName} is missing user authority`);
    }
});

Deno.test("Plan executors keep a strict no-self-edit boundary while explicit user authority wins", async () => {
    for (const agentName of PLAN_EXECUTION_PERSONAS) {
        const { systemPrompt } = await loadAgentDef(agentName);
        const normalizedPrompt = systemPrompt.replaceAll(/\s+/g, " ");
        const defaultIndex = normalizedPrompt.indexOf(PLAN_EDIT_DEFAULT_MARKER);
        const overrideIndex = normalizedPrompt.indexOf(PLAN_EDIT_USER_OVERRIDE_MARKER);

        assertEquals(defaultIndex >= 0, true, `${agentName} lost the strict unrequested Plan-edit boundary`);
        assertEquals(
            overrideIndex > defaultIndex,
            true,
            `${agentName} does not resolve the boundary for user authority`,
        );
        assertStringIncludes(
            normalizedPrompt,
            "Do not send the user to Planner, repeat the boundary, or call the request a blocker",
        );
        assertStringIncludes(
            normalizedPrompt,
            "call `task_completed` only when its revised requirements are actually complete",
        );
    }

    for (const agentName of PLAN_EXECUTION_PERSONAS) {
        const nudge = _AGENT_ATTENTION_NUDGES[agentName];
        assertStringIncludes(nudge, "never edit the Plan on your own or to match what you built");
        assertStringIncludes(nudge, "raise at most one concern, then make the exact edit and continue");
    }
});

Deno.test("every persona that can run git is told not to destroy pending changes", async () => {
    // Operator is not an engineering persona and does not compose engineering-practice,
    // but its prompt lists git operations — the rule has to reach it by its own claim.
    for (const agentName of WORKING_TREE_CONSUMERS) {
        const { systemPrompt } = await loadAgentDef(agentName);
        assertStringIncludes(systemPrompt, WORKING_TREE_MARKER, `${agentName} may destroy uncommitted work`);
    }
});

Deno.test("planning personas receive the show-the-work practice", async () => {
    for (const [agentName] of PLANNING_PRACTICE_CONSUMERS) {
        const def = await loadAgentDef(agentName);
        assertStringIncludes(def.systemPrompt, SHOW_THE_WORK_MARKER, `${agentName} is missing show-the-work`);
    }
});

/** Plan Review recognizes an alert only when its marker is alone on the quoted line. */
const MARKER_ONLY_CALLOUT = /^> \[!(WARNING|NOTE|TIP)\]$/m;

Deno.test("the Planner writes point-first Plans with optional callouts and exact steps", async () => {
    const { systemPrompt } = await loadAgentDef("planner");
    const normalized = systemPrompt.replaceAll(/\s+/g, " ");
    assertStringIncludes(normalized, "Open with the main point");
    assertStringIncludes(normalized, "Remove repetition, but never a requirement.");
    assertStringIncludes(normalized, "Keep Implementation Steps and the Verification Plan exact.");
    assertStringIncludes(normalized, "Callouts are optional.");
    assertMatch(systemPrompt, MARKER_ONLY_CALLOUT);
});

Deno.test("the Plan format keeps its sections and shows callout syntax Plan Review renders", async () => {
    const format = await Deno.readTextFile(join(BUNDLED_AGENT_DEFS, "document-formats", "planner-plan-format.md"));
    for (
        const heading of [
            "Context",
            "Objective",
            "Approach",
            "Expected Change Surface",
            "Reuse Opportunities",
            "Implementation Steps",
            "Approval Confirmation",
            "Verification Plan",
            "Edge Cases & Considerations",
        ]
    ) {
        assertStringIncludes(format, `\n## ${heading}\n`);
    }
    assertMatch(format, MARKER_ONLY_CALLOUT);
});

Deno.test("conversational planning personas end each turn with a question or finished work", async () => {
    for (const [agentName] of PLANNING_PRACTICE_CONSUMERS) {
        const { systemPrompt } = await loadAgentDef(agentName);
        const normalized = systemPrompt.replaceAll(/\s+/g, " ");
        assertStringIncludes(normalized, CONVERSATIONAL_TURNS_MARKER, `${agentName} is missing conversational-turns`);
    }
});

Deno.test("history-reading personas share one Work Record retrieval practice", async () => {
    // These four carried byte-identical copies of this section before it was
    // extracted; the fragment is what keeps them from drifting apart again.
    for (const agentName of WORK_RECORD_CONSUMERS) {
        const { systemPrompt } = await loadAgentDef(agentName);
        const normalized = systemPrompt.replaceAll(/\s+/g, " ");
        assertStringIncludes(normalized, WORK_RECORD_MARKER, `${agentName} is missing work-record-retrieval`);
    }

    // Recorder generates Work Records, so it keeps its own broader access rules.
    const recorder = await loadAgentDef("recorder");
    assertEquals(recorder.systemPrompt.replaceAll(/\s+/g, " ").includes(WORK_RECORD_MARKER), false);
    assertStringIncludes(recorder.systemPrompt, "broad access for generation/maintenance context");
});

Deno.test("planning personas reference an available PRD format without embedding it", async () => {
    const format = await Deno.readTextFile(join(BUNDLED_AGENT_DEFS, "document-formats", "PRD-FORMAT.md"));
    assertStringIncludes(format, "A PRD defines what users need, why it matters, and how success will be judged.");
    for (const agentName of ["ideator", "planner", "architect"]) {
        const { systemPrompt } = await loadAgentDef(agentName);
        assertStringIncludes(systemPrompt, "/document-formats/PRD-FORMAT.md");
        assertStringIncludes(
            systemPrompt.replaceAll(/\s+/g, " "),
            "Before writing, revising, or deriving an Epic or Plan from a PRD, read",
        );
        assertEquals(
            systemPrompt.includes("A PRD defines what users need, why it matters, and how success will be judged."),
            false,
        );
    }
});

Deno.test("Plan and Epic authors share one architecture vocabulary", async () => {
    // Planner and Architect defined these terms separately until `Port` drifted
    // apart; one fragment is what keeps the two documents speaking the same language.
    for (const agentName of PLANNING_DOC_AUTHORS) {
        const { systemPrompt } = await loadAgentDef(agentName);
        const normalized = systemPrompt.replaceAll(/\s+/g, " ");
        for (
            const term of ["Module", "Interface", "Seam", "Port", "Owner / source of truth", "Invariant", "Projection"]
        ) {
            assertStringIncludes(normalized, `**${term}**`, `${agentName} is missing the ${term} definition`);
        }
        assertStringIncludes(
            normalized,
            "dependency injection is not a reason to substitute an owned invariant",
            `${agentName} lost the stronger Port wording`,
        );
        assertStringIncludes(
            normalized,
            "Expand acronyms on first use",
            `${agentName} is missing plain-language-dialogue`,
        );
    }
});

Deno.test("the Slicer receives the show-the-work practice through the subagent registry", async () => {
    // Slicer is a workflow-only subagent, so it never appears in the agent listing.
    // It shapes the child Plans a person reads, so the practice must reach it too.
    const { loadSubAgentDefinition } = await import("./subagent-definitions.ts");
    const { SUBAGENTS } = await import("../../constants.js");
    const slicer = await loadSubAgentDefinition(SUBAGENTS.SLICER);

    assertStringIncludes(slicer.systemPrompt, SHOW_THE_WORK_MARKER);
});

Deno.test("quick fix Engineer receives the bounded-request contract", async () => {
    const { systemPrompt } = await loadAgentDef("engineer");
    const normalizedPrompt = systemPrompt.replaceAll(/\s+/g, " ");
    assertStringIncludes(systemPrompt, "Quick Fix Checklist");
    assertStringIncludes(
        normalizedPrompt,
        "Multi-step design, architectural decisions, and open-ended exploration belong to the Planner",
    );
    assertStringIncludes(
        normalizedPrompt,
        "Multiple sequential `task_completed` calls in one QUICK_FIX session are normal",
    );
});

Deno.test("plan execution personas receive validation continuation and pair ceremony", async () => {
    for (const agentName of PLAN_EXECUTION_PERSONAS) {
        const { systemPrompt } = await loadAgentDef(agentName);
        assertStringIncludes(systemPrompt, "A Validation Continuation");
        assertStringIncludes(systemPrompt, "one bullet per feedback item");
    }
});

Deno.test("plan execution personas can run a Pair checkpoint", async () => {
    for (const agentName of PLAN_EXECUTION_PERSONAS) {
        const { systemPrompt } = await loadAgentDef(agentName);
        assertStringIncludes(systemPrompt, "Runtime Collaboration Style");
        assertStringIncludes(systemPrompt, "`pair_checkpoint` is supplied");
        // Reporting ends the turn; authority comes only from a later user turn.
        assertStringIncludes(systemPrompt, "action `report`");
        assertStringIncludes(systemPrompt, "action `resolve`");
        assertStringIncludes(systemPrompt, "later user turn");
        const compactPrompt = systemPrompt.replace(/\s+/g, " ");
        assertStringIncludes(compactPrompt, "In every Plan execution style");
        assertStringIncludes(compactPrompt, "Use `record_plan_deviation` first");
        assertStringIncludes(compactPrompt, "Never create a Plan Deviation by editing the Plan file directly");
    }
});

Deno.test("the shared pair ceremony stays medium-neutral", async () => {
    // The browser-specific half belongs to Frontend Engineer's own contract; if it
    // leaks into the shared fragment, Engineer is told to inspect a browser it has
    // no dev server for.
    const shared = await Deno.readTextFile(join(SHARED_PRACTICE_DIR, "plan-execution.md"));

    for (const browserTerm of ["headed browser", "viewport", "dev server", "route", "screenshot"]) {
        assertEquals(
            new RegExp(`\\b${browserTerm}s?\\b`, "i").test(shared),
            false,
            `shared plan-execution fragment must stay medium-neutral, found: ${browserTerm}`,
        );
    }
});

Deno.test("Planner and Architect use pending work as evidence without dirty-file warnings", async () => {
    for (const name of ["planner", "architect"]) {
        const { systemPrompt } = await loadAgentDef(name);
        for (
            const text of [
                "Inspect staged, unstaged, and relevant untracked changes",
                "Use task-relevant changes as evidence",
                "Silently ignore unrelated changes",
                "Preserve all existing work",
                "A dirty checkout alone is neither a blocker nor a risk",
            ]
        ) assertStringIncludes(systemPrompt, text);
    }
});
