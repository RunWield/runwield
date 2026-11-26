import { ok as assert } from "node:assert/strict";
import { mkdir as fsMkdir, mkdtemp as fsMkdtemp, rm as fsRm, writeFile as fsWriteFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { test } from "node:test";
import { createAgentRegistry } from "@runwield/agents";
import { assertEquals, assertRejects } from "../../test-support/assertions.ts";
import { withProcessGlobalTestLock } from "../../test-support/process-global-lock.ts";

const agentRegistry = createAgentRegistry();
const { primary: AGENTS, isolated: SUBAGENTS } = agentRegistry.ids;

test("the registry preserves per-agent protected tools when override narrows router to read", async () => {
    const projectRoot = await fsMkdtemp(join(tmpdir(), "runwield-router-override-"));
    const localAgentsDir = join(projectRoot, ".wld", "agents");
    const routerOverridePath = join(localAgentsDir, "router.md");
    await fsMkdir(localAgentsDir, { recursive: true });

    const override = [
        "---",
        "name: router",
        "model: opencode-anthropic/minimax-m2.5-free",
        'description: "router local override"',
        "tools:",
        "  - read",
        "---",
        "",
        "Local prompt.",
        "",
    ].join("\n");

    await fsWriteFile(routerOverridePath, override);

    try {
        const def = await agentRegistry.get("router", projectRoot);

        const expectedProtected = [
            "memory",
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
            "triage_report",
        ];

        assertEquals(def.tools, ["read", ...expectedProtected, "set_session_name"]);
        assert(!def.tools.includes("bash"), "non-protected bundled tool should be removable by override");
    } finally {
        await fsRm(projectRoot, { recursive: true });
    }
});

test("the registry keeps filename identity separate from frontmatter display name", async () => {
    const projectRoot = await fsMkdtemp(join(tmpdir(), "runwield-agent-identity-"));
    const agentDirectory = join(projectRoot, ".wld", "agents");
    await fsMkdir(agentDirectory, { recursive: true });
    await fsWriteFile(
        join(agentDirectory, "case-contract.md"),
        ["---", "name: Arbitrary Frontmatter Display Name", "tools: []", "---", "", "Fixture prompt."].join("\n"),
    );

    try {
        const definition = await agentRegistry.get("CASE-CONTRACT", projectRoot);

        assertEquals(definition.name, "case-contract");
        assertEquals(definition.displayName, "Arbitrary Frontmatter Display Name");
        assert(definition.tools.includes("set_session_name"));
    } finally {
        await fsRm(projectRoot, { recursive: true });
    }
});

test("the registry loads Operator with structured interview capability", async () => {
    const def = await agentRegistry.get("operator");

    assert(def.tools.includes("task_completed"));
    assert(def.tools.includes("user_interview"));
    assert(def.systemPrompt.includes("Use `user_interview` for operational choices or confirmations"));
});

test("the registry loads Guide with discovery, docs and image tools but no general file editing", async () => {
    const def = await agentRegistry.get("guide");

    assert(def.tools.includes("read"));
    assert(def.tools.includes("grep"));
    assert(def.tools.includes("find"));
    assert(def.tools.includes("ls"));
    assert(def.tools.includes("bash"));
    assert(def.tools.includes("memory"));
    assert(def.tools.includes("code_search"));
    assert(def.tools.includes("write_docs"));
    assert(def.tools.includes("edit_docs"));
    assert(def.tools.includes("create_image"));
    assert(def.systemPrompt.includes("explicitly asks you to preserve or update"));
    assert(def.systemPrompt.includes("Plans, PRDs, ADRs, `docs/domain-language.md`, `docs/domain-language-map.md`"));
    assert(def.systemPrompt.includes("context\n  `domain-language.md`, Work Records, Agent Definitions, Skills"));
    assert(def.systemPrompt.includes("## Durable Evidence for Project Questions"));
    assert(
        def.systemPrompt.includes(
            "root `PRD.md`; living central PRDs and transient feature PRDs in `docs/prd/**/*.md`",
        ),
    );
    assert(def.systemPrompt.includes("Intent and direction only; never proof of implementation"));
    assert(def.systemPrompt.includes("`status: accepted` is an authoritative current rule"));
    assert(def.systemPrompt.includes("Approved/current Work Records are authoritative retrospective outcomes"));
    assert(def.systemPrompt.includes("Cite project-relative artifact paths"));
    assert(def.systemPrompt.includes("Session Transcripts and local workflow metrics are excluded"));

    assert(!def.tools.includes("edit"));
    assert(!def.tools.includes("write"));
    assert(!def.tools.includes("multi_file_edit"));
    assert(!def.tools.includes("task_completed"));
    assert(!def.tools.includes("plan_written"));
    assert(!def.tools.includes("triage_report"));
});

test("layered Agent Definition overrides can remove delegate_agent", async () => {
    const projectRoot = await fsMkdtemp(join(tmpdir(), "runwield-delegate-override-"));
    const overrideDir = join(projectRoot, ".wld", "agents");
    try {
        await fsMkdir(overrideDir, { recursive: true });
        await fsWriteFile(
            join(overrideDir, `${AGENTS.GUIDE}.md`),
            [
                "---",
                "name: Guide",
                'description: "Project-local Guide"',
                "tools:",
                "  - read",
                "---",
                "",
                "Local Guide instructions.",
                "",
            ].join("\n"),
        );

        const def = await agentRegistry.get(AGENTS.GUIDE, projectRoot);
        assertEquals(def.tools.includes("read"), true);
        assertEquals(def.tools.includes("delegate_agent"), false);
        assertEquals(def.tools.includes("background_task"), false);
    } finally {
        await fsRm(projectRoot, { recursive: true });
    }
});

test("bundled shell Agents offer background work without extending workflow-only definitions", async () => {
    const allowed = [
        AGENTS.ARCHITECT,
        AGENTS.ENGINEER,
        AGENTS.GUIDE,
        AGENTS.IDEATOR,
        AGENTS.OPERATOR,
        AGENTS.PLANNER,
        AGENTS.ROUTER,
        "tester",
    ];
    for (const name of allowed) {
        const definition = await agentRegistry.get(name);
        assert(definition.tools.includes("bash"), `${name} must retain shell authority`);
        assert(definition.tools.includes("background_task"), `${name} cannot run background shell work`);
    }
    for (const name of [AGENTS.PLAN_ENGINEER, AGENTS.FRONTEND_ENGINEER, AGENTS.RECORDER]) {
        const definition = await agentRegistry.get(name);
        assertEquals(definition.tools.includes("background_task"), false, `${name} is workflow-only`);
    }
    for (const name of [SUBAGENTS.DELEGATED, SUBAGENTS.REVIEWER]) {
        const definition = await agentRegistry.isolated.load(name);
        assertEquals(definition.tools.includes("background_task"), false, `${name} must not gain shell authority`);
    }
});

test("Frontend Engineer autonomous base tools include task completion without pair checkpoint", async () => {
    const def = await agentRegistry.get(AGENTS.FRONTEND_ENGINEER);

    assertEquals(def.tools.includes("task_completed"), true);
    assertEquals(def.tools.includes("pair_checkpoint"), false);
});

test("Router and Recorder do not expose delegate_agent by default", async () => {
    const [router, recorder] = await Promise.all([agentRegistry.get(AGENTS.ROUTER), agentRegistry.get("recorder")]);

    assertEquals(router.tools.includes("delegate_agent"), false);
    assertEquals(recorder.tools.includes("delegate_agent"), false);
});

test("Init, Reviewer, and Slicer can delegate", async () => {
    const definitions = await Promise.all([
        agentRegistry.isolated.load(SUBAGENTS.INIT),
        agentRegistry.isolated.load(SUBAGENTS.REVIEWER),
        agentRegistry.isolated.load(SUBAGENTS.REVIEWER, { reviewerMode: "verify" }),
        agentRegistry.isolated.load(SUBAGENTS.SLICER),
    ]);

    for (const definition of definitions) {
        assert(definition.tools.includes("delegate_agent"), `${definition.displayName} cannot delegate`);
    }
});

test("all user-facing bundled Agents receive set_session_name", async () => {
    const agentNames = [
        AGENTS.OPERATOR,
        AGENTS.GUIDE,
        AGENTS.IDEATOR,
        AGENTS.PLANNER,
        AGENTS.ARCHITECT,
        AGENTS.ENGINEER,
        AGENTS.FRONTEND_ENGINEER,
        AGENTS.ROUTER,
        AGENTS.RECORDER,
    ];

    for (const agentName of agentNames) {
        const def = await agentRegistry.get(agentName);
        assert(def.tools.includes("set_session_name"), `${agentName} should include set_session_name`);
    }
});

test("isolated Subagent definitions do not receive set_session_name", async () => {
    const subagents = [
        SUBAGENTS.REVIEWER,
        SUBAGENTS.DELEGATED,
        SUBAGENTS.INIT,
        SUBAGENTS.SLICER,
        SUBAGENTS.MANUAL_QA,
        SUBAGENTS.REVIEWER_FEEDBACK_ENGINEER,
    ];

    for (const subagent of subagents) {
        const def = await agentRegistry.isolated.load(subagent);
        assertEquals(def.tools.includes("set_session_name"), false, `${subagent} must not include set_session_name`);
    }
});

test("bundled Work Record tools are protected for planning roles and excluded from Engineer", async () => {
    const projectRoot = await fsMkdtemp(join(tmpdir(), "runwield-planner-override-"));
    const localAgentsDir = join(projectRoot, ".wld", "agents");
    const plannerOverridePath = join(localAgentsDir, "planner.md");
    await fsMkdir(localAgentsDir, { recursive: true });
    await fsWriteFile(
        plannerOverridePath,
        ["---", "name: Planner", "tools:", "  - read", "---", "Local planner override."].join("\n"),
    );
    try {
        const planner = await agentRegistry.get(AGENTS.PLANNER, projectRoot);
        assert(planner.tools.includes("work_record_search"));
        assert(planner.tools.includes("work_record_read"));
        const guide = await agentRegistry.get(AGENTS.GUIDE);
        const recorder = await agentRegistry.get(AGENTS.RECORDER);
        const ideator = await agentRegistry.get(AGENTS.IDEATOR);
        const architect = await agentRegistry.get(AGENTS.ARCHITECT);
        for (const def of [guide, recorder, ideator, architect]) {
            assert(def.tools.includes("work_record_search"));
            assert(def.tools.includes("work_record_read"));
        }
        const engineer = await agentRegistry.get(AGENTS.ENGINEER);
        assertEquals(engineer.tools.includes("work_record_search"), false);
        assertEquals(engineer.tools.includes("work_record_read"), false);
    } finally {
        await fsRm(projectRoot, { recursive: true });
    }
});

test("Agent command front matter merges, clears, and validates layered defaults", async () => {
    const cwd = await fsMkdtemp(join(tmpdir(), "runwield-bash-frontmatter-"));
    const directory = join(cwd, ".wld", "agents");
    const overridePath = join(directory, "guide.md");
    try {
        await fsMkdir(directory, { recursive: true });
        const initial = await agentRegistry.get(AGENTS.GUIDE, cwd);
        assert(initial.bashAllowedCommands);
        assert(initial.bashAllowedCommands.includes("git status"));
        await fsWriteFile(overridePath, "---\nname: Guide\n---\n");
        assertEquals((await agentRegistry.get(AGENTS.GUIDE, cwd)).bashAllowedCommands, initial.bashAllowedCommands);
        await fsWriteFile(overridePath, "---\nbashAllowedCommands: [td, git status, td]\n---\n");
        assertEquals((await agentRegistry.get(AGENTS.GUIDE, cwd)).bashAllowedCommands, [
            ...initial.bashAllowedCommands,
            "td",
        ]);
        await fsWriteFile(overridePath, "---\nbashAllowedCommands: []\n---\n");
        assertEquals((await agentRegistry.get(AGENTS.GUIDE, cwd)).bashAllowedCommands, []);
        await fsWriteFile(overridePath, "---\nbashAllowedCommands: null\n---\n");
        assertEquals((await agentRegistry.get(AGENTS.GUIDE, cwd)).bashAllowedCommands, undefined);
        for (const invalid of ["false", "[pwd, 3]", "['']", "['git status && touch x']"]) {
            await fsWriteFile(overridePath, `---\nbashAllowedCommands: ${invalid}\n---\n`);
            await assertRejects(() => agentRegistry.get(AGENTS.GUIDE, cwd), Error, "bashAllowedCommands");
        }
    } finally {
        await fsRm(cwd, { recursive: true });
    }
});

test("Agent toolSets expand into the layer's tool list and validate set names", async () => {
    const cwd = await fsMkdtemp(join(tmpdir(), "runwield-toolsets-frontmatter-"));
    const directory = join(cwd, ".wld", "agents");
    try {
        await fsMkdir(directory, { recursive: true });
        await fsWriteFile(
            join(directory, "docs-writer.md"),
            "---\nname: Docs Writer\ntoolSets: [docs, shell]\ntools: [user_interview, bash]\n---\nWrite docs.\n",
        );
        assertEquals((await agentRegistry.get("docs-writer", cwd)).tools, [
            "write_docs",
            "edit_docs",
            "bash",
            "background_task",
            "user_interview",
            "set_session_name",
        ]);

        await fsWriteFile(join(directory, "reader.md"), "---\nname: Reader\ntoolSets: [read]\n---\n");
        const reader = await agentRegistry.get("reader", cwd);
        for (const toolName of [
            "memory",
            "user_interview",
            "work_record_search",
            "work_record_read",
            "delegate_agent",
        ]) {
            assert(reader.tools.includes(toolName), toolName);
        }
        assert(!reader.tools.includes("delegate_agent_read"));
        assertEquals(reader.delegationModes, ["read"]);

        await fsWriteFile(join(directory, "builder.md"), "---\nname: Builder\ntoolSets: [read, write]\n---\n");
        const builder = await agentRegistry.get("builder", cwd);
        assertEquals(builder.delegationModes, ["read", "write"]);
        assertEquals(
            builder.tools.filter((toolName) => toolName.startsWith("delegate_agent")),
            ["delegate_agent"],
        );

        await fsWriteFile(
            join(directory, "lead.md"),
            "---\nname: Lead\ntoolSets: [read]\ntools: [delegate_agent]\n---\n",
        );
        assertEquals((await agentRegistry.get("lead", cwd)).delegationModes, undefined);
        assertEquals((await agentRegistry.get(AGENTS.GUIDE, cwd)).delegationModes, undefined);

        await fsWriteFile(join(directory, "talker.md"), "---\nname: Talker\n---\nJust talk.\n");
        assertEquals((await agentRegistry.get("talker", cwd)).tools, ["set_session_name"]);

        const bundled = await agentRegistry.get(AGENTS.OPERATOR, cwd);
        const operatorPath = join(directory, "operator.md");
        await fsWriteFile(operatorPath, "---\ndescription: Read-only\n---\n");
        assertEquals((await agentRegistry.get(AGENTS.OPERATOR, cwd)).tools, bundled.tools);
        await fsWriteFile(operatorPath, "---\ntoolSets: [read]\n---\n");
        const narrowed = (await agentRegistry.get(AGENTS.OPERATOR, cwd)).tools;
        assert(narrowed.includes("code_outline"));
        assert(!narrowed.includes("edit") && !narrowed.includes("bash"));
        assert(narrowed.includes("task_completed") && narrowed.includes("memory"));

        for (const invalid of ["[reed]", "read", "[read, 3]"]) {
            await fsWriteFile(operatorPath, `---\ntoolSets: ${invalid}\n---\n`);
            await assertRejects(() => agentRegistry.get(AGENTS.OPERATOR, cwd), Error, "toolSets");
        }
    } finally {
        await fsRm(cwd, { recursive: true });
    }
});

test("Guide command lists merge across bundled, home, and project definitions", async () => {
    await withProcessGlobalTestLock(async () => {
        const originalHome = process.env["HOME"];
        const root = await fsMkdtemp(join(tmpdir(), "runwield-guide-command-layers-"));
        const home = join(root, "home");
        const cwd = join(root, "project");
        try {
            process.env["HOME"] = home;
            const homeAgents = join(home, ".wld", "agents");
            const projectAgents = join(cwd, ".wld", "agents");
            await fsMkdir(homeAgents, { recursive: true });
            await fsMkdir(projectAgents, { recursive: true });
            const bundled = await agentRegistry.get(AGENTS.GUIDE, cwd);
            assert(bundled.bashAllowedCommands);
            assert(bundled.bashAllowedCommands.includes("git status"));
            await fsWriteFile(join(homeAgents, "guide.md"), "---\nbashAllowedCommands: [td]\n---\n");
            assertEquals((await agentRegistry.get(AGENTS.GUIDE, cwd)).bashAllowedCommands, [
                ...bundled.bashAllowedCommands,
                "td",
            ]);
            await fsWriteFile(join(projectAgents, "guide.md"), "---\nbashAllowedCommands: [td, git version]\n---\n");
            assertEquals((await agentRegistry.get(AGENTS.GUIDE, cwd)).bashAllowedCommands, [
                ...bundled.bashAllowedCommands,
                "td",
                "git version",
            ]);
        } finally {
            if (originalHome === undefined) delete process.env["HOME"];
            else process.env["HOME"] = originalHome;
            await fsRm(root, { recursive: true });
        }
    });
});

test("AI Reviewer is workflow-only with read tools and read-only git commands", async () => {
    const definition = await agentRegistry.get(AGENTS.AI_REVIEWER);
    assertEquals(definition.displayName, "AI Reviewer");
    assertEquals(definition.workflowOnly, true);
    assertEquals(
        (await agentRegistry.list()).some((agent) => agent.name === AGENTS.AI_REVIEWER),
        false,
    );
    for (const tool of definition.tools) {
        assertEquals(
            ["codemode", "read", "grep", "find", "ls", "bash", "web_fetch", "set_session_name"].includes(tool) ||
                tool.startsWith("code_"),
            true,
            tool,
        );
    }
    assertEquals(definition.bashAllowedCommands, [
        "git status",
        "git diff",
        "git log",
        "git show",
        "git blame",
        "git grep",
        "git ls-files",
        "git ls-tree",
        "git rev-parse",
        "git rev-list",
        "git show-ref",
        "git branch --list",
        "git remote -v",
        "git worktree list",
    ]);
});
