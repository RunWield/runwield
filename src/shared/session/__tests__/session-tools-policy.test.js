import { bashFixtureExecutable } from "../../../../scripts/bash-fixture.ts";
import { delimiter } from "node:path";
import {
    writeWorkflowBinaryFixtures,
    assertWorkflowBinaryCallsSupported,
} from "../../../testing/workflow-binary-fixtures.ts";
import { runtimeSourceArgs } from "../../../testing/runtime-source-args.ts";
import { captureForegroundProcess } from "../../captured-process.ts";
import { makeTempFile } from "../../../testing/temp-file.ts";
import { after, before, test } from "node:test";
import { tmpdir } from "node:os";
import {
    mkdir as fsMkdir,
    mkdtemp as fsMkdtemp,
    readFile as fsReadFile,
    rm as fsRm,
    stat as fsStat,
    writeFile as fsWriteFile,
} from "node:fs/promises";
import process from "node:process";
import { ok as assert } from "node:assert/strict";
import { assertEquals, assertRejects } from "../../../testing/assertions.ts";
import { fileURLToPath as fromFileUrl } from "node:url";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { withProcessGlobalTestLock } from "../../../testing/process-global-lock.ts";
import { AGENTS, SUBAGENTS } from "../../../constants.js";
import { __resetSettingsForTests, getSettingsManager } from "../../settings.js";
import { loadAgentDef, resolveSessionToolNames } from "../agents.js";
import { HostedSession } from "../hosted-session.js";
import { loadSubAgentDefinition, REVIEWER_SUBAGENT_TOOLS } from "../subagent-definitions.ts";
import {
    buildAgentSession,
    buildExecutionSession,
    composeAgyCliBridgedTools,
    composeClaudeCliBridgedTools,
    resolveEffectiveSessionToolNames,
} from "../session.js";
import { createReviewDiffTool } from "../../workflow/review-diff-tool.js";
import { startMcpIntegration } from "../../mcp/integration.ts";

let helperRoot = "";
let priorHelperPath = "";
before(() =>
    withProcessGlobalTestLock(async () => {
        priorHelperPath = process.env.PATH || "";
        helperRoot = await fsMkdtemp(join(tmpdir(), "session-policy-helpers-"));
        const bin = await writeWorkflowBinaryFixtures(helperRoot);
        process.env.PATH = `${bin}${delimiter}${priorHelperPath}`;
    }),
);
after(() =>
    withProcessGlobalTestLock(async () => {
        process.env.PATH = priorHelperPath;
        try {
            await assertWorkflowBinaryCallsSupported(helperRoot);
        } finally {
            await fsRm(helperRoot, { recursive: true });
        }
    }),
);

// Anchored to this file, not Deno.cwd(): test realms share one process, so a
// concurrent test file's chdir would otherwise point these at its temp dir.
const REPO_ROOT = fromFileUrl(new URL("../../../..", import.meta.url));
/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

const MCP_FIXTURE_SERVER = fromFileUrl(new URL("../../mcp/fixture-server.ts", import.meta.url));

/**
 * @param {string} cwd
 * @returns {Promise<{ pool: import('../../mcp/integration.ts').McpIntegration, tools: import('@earendil-works/pi-coding-agent').ToolDefinition[], logPath: string }>}
 */
async function startRealMcpFixtureTools(cwd) {
    const logPath = await makeTempFile({ prefix: "runwield-real-mcp-policy-" });
    const result = await startMcpIntegration({
        cwd,
        servers: [
            {
                name: "fixture",
                command: process.execPath,
                args: runtimeSourceArgs(["run", "-A", MCP_FIXTURE_SERVER]),
                env: { RUNWIELD_MCP_FIXTURE_LOG: logPath },
                source: "request",
            },
        ],
    });
    assertEquals(result.warnings, []);
    return { pool: result.integration, tools: result.integration.getTools(), logPath };
}

/** @param {string} path */
async function removeTempDir(path) {
    for (let attempt = 0; attempt < 5; attempt++) {
        try {
            await fsRm(path, { recursive: true });
            return;
        } catch (error) {
            if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
            if (attempt === 4) throw error;
            await delay(20 * (attempt + 1));
        }
    }
}

test("loadAgentDef preserves per-agent protected tools when override narrows router to read", async () => {
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
        const def = await loadAgentDef("router", projectRoot);

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
        await removeTempDir(projectRoot);
    }
});

test("loadAgentDef keeps filename identity separate from frontmatter display name", async () => {
    const projectRoot = await fsMkdtemp(join(tmpdir(), "runwield-agent-identity-"));
    const agentDirectory = join(projectRoot, ".wld", "agents");
    await fsMkdir(agentDirectory, { recursive: true });
    await fsWriteFile(
        join(agentDirectory, "case-contract.md"),
        ["---", "name: Arbitrary Frontmatter Display Name", "tools: []", "---", "", "Fixture prompt."].join("\n"),
    );

    try {
        const definition = await loadAgentDef("CASE-CONTRACT", projectRoot);

        assertEquals(definition.name, "case-contract");
        assertEquals(definition.displayName, "Arbitrary Frontmatter Display Name");
        assert(definition.tools.includes("set_session_name"));
    } finally {
        await removeTempDir(projectRoot);
    }
});

test("loadAgentDef loads Operator with structured interview capability", async () => {
    const def = await loadAgentDef("operator");

    assert(def.tools.includes("task_completed"));
    assert(def.tools.includes("user_interview"));
    assert(def.systemPrompt.includes("Use `user_interview` for operational choices or confirmations"));
});

test("loadAgentDef loads Guide with discovery, docs and image tools but no general file editing", async () => {
    const def = await loadAgentDef("guide");

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

        const def = await loadAgentDef(AGENTS.GUIDE, projectRoot);
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
        const definition = await loadAgentDef(name, REPO_ROOT);
        assert(definition.tools.includes("bash"), `${name} must retain shell authority`);
        assert(definition.tools.includes("background_task"), `${name} cannot run background shell work`);
    }
    for (const name of [AGENTS.PLAN_ENGINEER, AGENTS.FRONTEND_ENGINEER, AGENTS.RECORDER]) {
        const definition = await loadAgentDef(name, REPO_ROOT);
        assertEquals(definition.tools.includes("background_task"), false, `${name} is workflow-only`);
    }
    for (const name of [SUBAGENTS.DELEGATED, SUBAGENTS.REVIEWER]) {
        const definition = await loadSubAgentDefinition(name);
        assertEquals(definition.tools.includes("background_task"), false, `${name} must not gain shell authority`);
    }
});

test("effective tool selection cannot re-enable background shell after Agent policy removes it", () => {
    const resolved = resolveEffectiveSessionToolNames(
        ["read", "set_session_name"],
        ["read", "bash", "background_task"],
        [],
    );
    assertEquals(resolved.includes("background_task"), false);
});

test("Frontend Engineer autonomous base tools include task completion without pair checkpoint", async () => {
    const def = await loadAgentDef(AGENTS.FRONTEND_ENGINEER, REPO_ROOT);

    assertEquals(def.tools.includes("task_completed"), true);
    assertEquals(def.tools.includes("pair_checkpoint"), false);
});

test("Router and Recorder do not expose delegate_agent by default", async () => {
    const [router, recorder] = await Promise.all([
        loadAgentDef(AGENTS.ROUTER, REPO_ROOT),
        loadAgentDef("recorder", REPO_ROOT),
    ]);

    assertEquals(router.tools.includes("delegate_agent"), false);
    assertEquals(recorder.tools.includes("delegate_agent"), false);
});

test("RunWield PM, Init, Reviewer, and Slicer can delegate", async () => {
    const definitions = await Promise.all([
        loadAgentDef("pm", REPO_ROOT),
        loadSubAgentDefinition(SUBAGENTS.INIT),
        loadSubAgentDefinition(SUBAGENTS.REVIEWER),
        loadSubAgentDefinition(SUBAGENTS.REVIEWER, { reviewerMode: "verify" }),
        loadSubAgentDefinition(SUBAGENTS.SLICER),
    ]);

    for (const definition of definitions) {
        assert(definition.tools.includes("delegate_agent"), `${definition.displayName} cannot delegate`);
    }
});

test("bundled Agent definitions omit the removed router handoff tool", async () => {
    const removedToolName = ["return", "to", "router"].join("_");
    const agentNames = [
        AGENTS.OPERATOR,
        AGENTS.GUIDE,
        AGENTS.IDEATOR,
        AGENTS.PLANNER,
        AGENTS.ARCHITECT,
        AGENTS.ENGINEER,
        AGENTS.FRONTEND_ENGINEER,
        "tester",
        AGENTS.ROUTER,
    ];

    for (const agentName of agentNames) {
        const def = await loadAgentDef(agentName, REPO_ROOT);
        assertEquals(def.tools.includes(removedToolName), false, `${agentName} must not expose removed handoff tool`);
        assertEquals(
            resolveEffectiveSessionToolNames(def.tools, undefined, []).includes(removedToolName),
            false,
            `${agentName} effective tools must not expose removed handoff tool`,
        );
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
        const def = await loadAgentDef(agentName, REPO_ROOT);
        assert(def.tools.includes("set_session_name"), `${agentName} should include set_session_name`);
    }
});

test("set_session_name survives a narrowed runtime tool list", async () => {
    const def = await loadAgentDef(AGENTS.GUIDE, REPO_ROOT);

    const resolved = resolveEffectiveSessionToolNames(def.tools, ["read"], []);

    assertEquals(resolved.includes("read"), true);
    assertEquals(resolved.includes("set_session_name"), true);
});

test("Claude CLI and Agy CLI bridge the session name tool", async () => {
    const tempHome = await fsMkdtemp(join(tmpdir(), "runwield-cli-session-name-tool-"));
    const sessionManager = SessionManager.inMemory(tempHome);
    const hostedSession = new HostedSession({
        id: "cli-session-name-tool",
        cwd: tempHome,
        sessionManager: /** @type {never} */ (sessionManager),
    });
    const agentDef = await loadAgentDef(AGENTS.ENGINEER, REPO_ROOT);

    try {
        const claudeTools = await composeClaudeCliBridgedTools({
            agentDef,
            agentName: AGENTS.ENGINEER,
            hostedSession,
            triageMeta: undefined,
            cwd: tempHome,
        });
        const agyTools = await composeAgyCliBridgedTools({
            agentDef,
            agentName: AGENTS.ENGINEER,
            hostedSession,
            triageMeta: undefined,
            cwd: tempHome,
        });

        assertEquals(
            claudeTools.some((tool) => tool.name === "set_session_name"),
            true,
        );
        assertEquals(
            agyTools.some((tool) => tool.name === "set_session_name"),
            true,
        );
        assertEquals(
            claudeTools.some((tool) => tool.name === "background_task"),
            true,
        );
        assertEquals(
            agyTools.some((tool) => tool.name === "background_task"),
            true,
        );
        assertEquals(
            claudeTools.some((tool) => tool.name === "delegate_agent"),
            false,
        );
        assertEquals(
            agyTools.some((tool) => tool.name === "delegate_agent"),
            false,
        );
    } finally {
        await removeTempDir(tempHome);
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
        const def = await loadSubAgentDefinition(subagent);
        assertEquals(def.tools.includes("set_session_name"), false, `${subagent} must not include set_session_name`);
    }
});

test("resolveSessionToolNames blocks runtime toolNames from re-enabling removed non-protected tools", () => {
    const agentTools = ["read", "memory", "triage_report"];
    const resolved = resolveSessionToolNames(agentTools, ["read", "bash", "triage_report"], []);

    assertEquals(resolved, ["read", "triage_report"]);
    assert(!resolved.includes("bash"));
});

test("Workflow tools cannot be re-enabled by static runtime tool names", () => {
    const resolved = resolveSessionToolNames(["read"], ["read", "pair_checkpoint", "record_plan_deviation"], []);
    assertEquals(resolved, ["read"]);
});

test("resolveSessionToolNames allows workflow runtime custom tools", () => {
    const resolved = resolveSessionToolNames(["read"], ["read"], ["pair_checkpoint", "record_plan_deviation", "read"]);
    assertEquals(resolved, ["read", "pair_checkpoint", "record_plan_deviation"]);
});

test("resolveEffectiveSessionToolNames does not special-case removed tool names", () => {
    const agentTools = ["read", "memory"];

    assertEquals(resolveEffectiveSessionToolNames(agentTools, undefined, []), ["read", "memory"]);
});

test("resolveEffectiveSessionToolNames normalizes legacy multi replace tool name", () => {
    assertEquals(resolveEffectiveSessionToolNames(["read", "edit", "multi_replace_file_content"], undefined, []), [
        "read",
        "edit",
        "multi_file_edit",
    ]);
});

test("root Pi Agent builds keep MCP tools when using a subagent definition", async () => {
    await withProcessGlobalTestLock(async () => {
        const originalHome = process.env["HOME"];
        const tempHome = await fsMkdtemp(join(tmpdir(), "runwield-root-mcp-subagent-"));
        /** @type {import('@earendil-works/pi-coding-agent').AgentSession | undefined} */
        let session;
        /** @type {Awaited<ReturnType<typeof startRealMcpFixtureTools>> | undefined} */
        let mcpFixture;
        try {
            process.env["HOME"] = tempHome;
            __resetSettingsForTests();
            await writeVisionModelConfig(tempHome);
            const hostedSession = new HostedSession({ id: "root-mcp-subagent", cwd: tempHome });
            mcpFixture = await startRealMcpFixtureTools(tempHome);
            const mcpTool = mcpFixture.tools[0];
            const built = await buildAgentSession({
                hostedSession,
                agentName: AGENTS.PLANNER,
                modelOverride: "test/text",
                subAgentDefinition: { id: SUBAGENTS.SLICER },
                mcpRootTools: [mcpTool],
            });
            session = built.session;

            assert(built.tools.includes(mcpTool.name));
            assert(built.finalCustomTools.some((tool) => tool.name === mcpTool.name));
        } finally {
            session?.dispose();
            await mcpFixture?.pool.close();
            if (mcpFixture) await fsRm(mcpFixture.logPath).catch(() => {});
            if (originalHome) process.env["HOME"] = originalHome;
            else delete process.env["HOME"];
            __resetSettingsForTests();
            await removeTempDir(tempHome);
        }
    });
});

test("bounded Pi and Claude subagent builds do not inherit root MCP tools", async () => {
    await withProcessGlobalTestLock(async () => {
        const originalHome = process.env["HOME"];
        const tempHome = await fsMkdtemp(join(tmpdir(), "runwield-subagent-mcp-exclusion-"));
        /** @type {import('@earendil-works/pi-coding-agent').AgentSession | undefined} */
        let session;
        /** @type {Awaited<ReturnType<typeof startRealMcpFixtureTools>> | undefined} */
        let mcpFixture;
        try {
            process.env["HOME"] = tempHome;
            __resetSettingsForTests();
            await writeVisionModelConfig(tempHome);
            const hostedSession = new HostedSession({ id: "subagent-mcp-exclusion", cwd: tempHome });
            mcpFixture = await startRealMcpFixtureTools(tempHome);
            const mcpTool = mcpFixture.tools[0];
            const built = await buildAgentSession({
                hostedSession,
                agentName: AGENTS.REVIEWER,
                modelOverride: "test/text",
                subAgentDefinition: { id: SUBAGENTS.REVIEWER },
                mcpRootTools: [],
            });
            session = built.session;
            assertEquals(built.tools.includes(mcpTool.name), false);
            assertEquals(
                built.finalCustomTools.some((tool) => tool.name === mcpTool.name),
                false,
            );

            const agentDef = await loadAgentDef(AGENTS.GUIDE, tempHome);
            const rootClaudeTools = await composeClaudeCliBridgedTools({
                agentDef,
                agentName: AGENTS.GUIDE,
                hostedSession,
                triageMeta: undefined,
                cwd: tempHome,
                mcpRootTools: [mcpTool],
            });
            const isolatedClaudeTools = await composeClaudeCliBridgedTools({
                agentDef,
                agentName: AGENTS.GUIDE,
                hostedSession,
                triageMeta: undefined,
                cwd: tempHome,
                mcpRootTools: [],
            });
            assert(rootClaudeTools.some((tool) => tool.name === mcpTool.name));
            assertEquals(
                isolatedClaudeTools.some((tool) => tool.name === mcpTool.name),
                false,
            );
        } finally {
            session?.dispose();
            await mcpFixture?.pool.close();
            if (mcpFixture) await fsRm(mcpFixture.logPath).catch(() => {});
            if (originalHome) process.env["HOME"] = originalHome;
            else delete process.env["HOME"];
            __resetSettingsForTests();
            await removeTempDir(tempHome);
        }
    });
});

test("buildAgentSession auto-wires Guide docs-only tools when requested", async () => {
    await withProcessGlobalTestLock(async () => {
        const originalHome = process.env["HOME"];
        const tempHome = await fsMkdtemp(join(tmpdir(), "runwield-guide-docs-tools-"));
        /** @type {import('@earendil-works/pi-coding-agent').AgentSession | undefined} */
        let session;

        try {
            process.env["HOME"] = tempHome;
            __resetSettingsForTests();
            await writeVisionModelConfig(tempHome);
            const hostedSession = new HostedSession({ id: "guide-docs-tools", cwd: tempHome });
            const built = await buildAgentSession({
                hostedSession,
                agentName: AGENTS.GUIDE,
                modelOverride: "test/text",
            });
            session = built.session;

            assertEquals(built.tools.includes("write_docs"), true);
            assertEquals(built.tools.includes("edit_docs"), true);
            const writeDocs = built.finalCustomTools.find((tool) => tool.name === "write_docs");
            const editDocs = built.finalCustomTools.find((tool) => tool.name === "edit_docs");
            assert(writeDocs, "expected write_docs to be auto-wired");
            assert(editDocs, "expected edit_docs to be auto-wired");
            assertEquals(typeof writeDocs.execute, "function");
            assertEquals(typeof editDocs.execute, "function");
        } finally {
            session?.dispose();
            __resetSettingsForTests();
            if (originalHome === undefined) delete process.env["HOME"];
            else process.env["HOME"] = originalHome;
            __resetSettingsForTests();
            await removeTempDir(tempHome);
        }
    });
});

test("buildAgentSession wires task_completed with an event-only HostedSession", async () => {
    await withProcessGlobalTestLock(async () => {
        /** @type {any[]} */
        const events = [];
        const debugLogPath = await makeTempFile({ prefix: "runwield-session-debug-test-", suffix: ".log" });

        /** @type {import('@earendil-works/pi-coding-agent').AgentSession | undefined} */
        let session;
        const originalHome = process.env["HOME"];
        const tempHome = await fsMkdtemp(join(tmpdir(), "runwield-session-tools-policy-"));

        try {
            process.env["HOME"] = tempHome;
            __resetSettingsForTests();
            await writeVisionModelConfig(tempHome);

            const hostedSession = new HostedSession({ id: "task-completed-policy", cwd: tempHome });
            hostedSession.setEventSink({ emit: (/** @type {any} */ event) => events.push(event) });

            const built = await buildAgentSession({
                hostedSession,
                agentName: "operator",
                modelOverride: "test/model",
                debugLogPath,
            });
            session = built.session;
            const { finalCustomTools } = built;
            const tool = finalCustomTools.find((candidate) => candidate.name === "task_completed");
            assert(tool, "expected task_completed to be wired");
            const execute =
                /** @type {(id: string, params: { message?: string }, signal: AbortSignal, onUpdate: () => void, context: object) => Promise<unknown>} */ (
                    tool.execute
                );

            await execute("tool-call-1", { message: "Done." }, new AbortController().signal, () => {}, {});

            assertEquals(events.length, 1);
            assertEquals(events[0].delta, "**Task completed.**\n\nDone.");
            assertEquals(events[0].agentName, "Operator");
        } finally {
            session?.dispose();
            __resetSettingsForTests();
            if (originalHome === undefined) delete process.env["HOME"];
            else process.env["HOME"] = originalHome;
            __resetSettingsForTests();
            await removeTempDir(tempHome);
            await fsRm(debugLogPath);
        }
    });
});

test("buildAgentSession auto-wires set_session_name for user-facing Agents", async () => {
    await withProcessGlobalTestLock(async () => {
        const originalHome = process.env["HOME"];
        const tempHome = await fsMkdtemp(join(tmpdir(), "runwield-set-session-name-wiring-"));
        /** @type {import('@earendil-works/pi-coding-agent').AgentSession | undefined} */
        let session;
        try {
            process.env["HOME"] = tempHome;
            __resetSettingsForTests();
            await writeVisionModelConfig(tempHome);
            const sessionManager = SessionManager.inMemory(tempHome);
            const hostedSession = new HostedSession({
                id: "set-session-name-policy",
                cwd: tempHome,
                sessionManager: /** @type {never} */ (sessionManager),
            });

            const built = await buildAgentSession({
                hostedSession,
                agentName: AGENTS.GUIDE,
                modelOverride: "test/text",
                toolNames: ["read"],
            });
            session = built.session;

            assertEquals(built.tools.includes("set_session_name"), true);
            const tool = built.finalCustomTools.find((candidate) => candidate.name === "set_session_name");
            assert(tool, "expected set_session_name to be auto-wired");
            const result = await /** @type {any} */ (tool.execute)("tool-call-1", { name: "guide session" });
            assertEquals(result.details, { name: "guide session" });
            assertEquals(sessionManager.getSessionName(), "guide session");
        } finally {
            session?.dispose();
            __resetSettingsForTests();
            if (originalHome === undefined) delete process.env["HOME"];
            else process.env["HOME"] = originalHome;
            __resetSettingsForTests();
            await removeTempDir(tempHome);
        }
    });
});

test("buildAgentSession wires review_complete and file tools into the Semantic Reviewer subagent", async () => {
    // Regression: the Semantic Reviewer's session once started with only
    // `review_diff` + `see_image` — no read/grep/find/ls and no
    // `review_complete` — so every `review_complete` call failed with "Tool
    // review_complete not found" and Workflow Validation stalled mid-round.
    // The canonical tool ceiling lives in the subagent definition registry and
    // must reach the session's effective tools and auto-wired custom tools.
    await withProcessGlobalTestLock(async () => {
        const originalHome = process.env["HOME"];
        const tempHome = await fsMkdtemp(join(tmpdir(), "runwield-reviewer-tools-"));
        /** @type {import('@earendil-works/pi-coding-agent').AgentSession | undefined} */
        let session;

        try {
            process.env["HOME"] = tempHome;
            __resetSettingsForTests();
            await writeVisionModelConfig(tempHome);

            const hostedSession = new HostedSession({ id: "reviewer-tools-policy", cwd: REPO_ROOT });
            const built = await buildAgentSession({
                hostedSession,
                agentName: AGENTS.REVIEWER,
                modelOverride: "test/text",
                subAgentDefinition: {
                    id: SUBAGENTS.REVIEWER,
                    options: { reviewerMode: "discovery" },
                },
                toolNames: [...REVIEWER_SUBAGENT_TOOLS],
                customTools: [createReviewDiffTool({ full: "diff" })],
                includeEditFallback: false,
            });
            session = built.session;

            for (const toolName of ["read", "grep", "find", "ls", "review_diff", "review_complete", "delegate_agent"]) {
                assert(built.tools.includes(toolName), `expected ${toolName} in effective reviewer tools`);
            }
            assert(built.finalCustomTools.some((tool) => tool.name === "delegate_agent"));
            const reviewComplete = built.finalCustomTools.find((tool) => tool.name === "review_complete");
            assert(reviewComplete, "expected review_complete to be auto-wired into the reviewer session");
            assertEquals(typeof reviewComplete.execute, "function");
        } finally {
            session?.dispose();
            __resetSettingsForTests();
            if (originalHome === undefined) delete process.env["HOME"];
            else process.env["HOME"] = originalHome;
            __resetSettingsForTests();
            await removeTempDir(tempHome);
        }
    });
});

/**
 * @param {string} tempHome
 */
async function writeVisionModelConfig(tempHome) {
    await fsMkdir(join(tempHome, ".wld"), { recursive: true });
    await fsWriteFile(
        join(tempHome, ".wld", "models.json"),
        JSON.stringify({
            providers: {
                test: {
                    baseUrl: "https://example.invalid/v1",
                    api: "openai-completions",
                    apiKey: "test-key",
                    models: [
                        { id: "model", input: ["text"] },
                        { id: "text", input: ["text"] },
                        { id: "vision", input: ["text", "image"] },
                        { id: "cli", input: ["text"], executionBackend: "claude-cli" },
                    ],
                },
            },
        }),
    );
}

test("Engineer model fallback is one regular system message per Agent", async () => {
    await withProcessGlobalTestLock(async () => {
        const originalHome = process.env["HOME"];
        const tempHome = await fsMkdtemp(join(tmpdir(), "runwield-agent-model-fallback-"));
        /** @type {import('@earendil-works/pi-coding-agent').AgentSession[]} */
        const sessions = [];
        /** @type {import('../session-runtime-events.js').SessionRuntimeEvent[]} */
        const events = [];
        try {
            process.env["HOME"] = tempHome;
            await writeVisionModelConfig(tempHome);
            await fsWriteFile(
                join(tempHome, ".wld", "settings.json"),
                `${JSON.stringify({ agents: { engineer: { model: "test/model" } } }, null, 4)}\n`,
            );
            __resetSettingsForTests();
            const eventSink = {
                /** @param {import('../session-runtime-events.js').SessionRuntimeEvent} event */
                emit(event) {
                    events.push(event);
                },
            };
            const hostedSession = new HostedSession({
                id: "agent-model-fallback",
                cwd: tempHome,
                eventSink,
            });

            for (let index = 0; index < 2; index++) {
                const built = await buildAgentSession({
                    hostedSession,
                    agentName: AGENTS.REVIEWER_FEEDBACK_ENGINEER,
                    subAgentDefinition: { id: SUBAGENTS.REVIEWER_FEEDBACK_ENGINEER },
                });
                sessions.push(built.session);
            }

            const notices = events.filter((event) => event.type === "system_status");
            assertEquals(notices.length, 1);
            assertEquals(notices[0].header, "RunWield");
            assertEquals(notices[0].level, "info");
            assertEquals(notices[0].message, "The repair Engineer is using the Engineer model: test/model.");
        } finally {
            for (const session of sessions) session.dispose();
            __resetSettingsForTests();
            if (originalHome === undefined) delete process.env["HOME"];
            else process.env["HOME"] = originalHome;
            await removeTempDir(tempHome);
        }
    });
});

test("buildAgentSession applies invocation thinking override before settings and agent defaults", async () => {
    await withProcessGlobalTestLock(async () => {
        const originalHome = process.env["HOME"];
        const tempHome = await fsMkdtemp(join(tmpdir(), "runwield-fixture-"));
        try {
            process.env["HOME"] = tempHome;
            __resetSettingsForTests();
            await writeVisionModelConfig(tempHome);
            await fsWriteFile(join(tempHome, ".wld", "settings.json"), JSON.stringify({ defaultThinkingLevel: "low" }));

            const hostedSession = new HostedSession({ id: "thinking-override", cwd: tempHome });
            const built = await buildAgentSession({
                hostedSession,
                agentName: "delegated",
                modelOverride: "test/text",
                thinkingLevelOverride: "high",
                subAgentDefinition: { id: "delegated" },
            });

            assertEquals(built.resolvedThinkingLevel, "high");
            assertEquals(hostedSession.getThinkingLevel(), "high");
            built.session.dispose();
        } finally {
            __resetSettingsForTests();
            if (originalHome === undefined) delete process.env["HOME"];
            else process.env["HOME"] = originalHome;
            __resetSettingsForTests();
            await removeTempDir(tempHome);
        }
    });
});

test("Validation Repair Engineer thinking falls back through repair, Engineer, then defaults", async () => {
    await withProcessGlobalTestLock(async () => {
        const originalHome = process.env["HOME"];
        const tempHome = await fsMkdtemp(join(tmpdir(), "runwield-repair-thinking-fallback-"));
        /** @type {import('@earendil-works/pi-coding-agent').AgentSession[]} */
        const sessions = [];
        try {
            process.env["HOME"] = tempHome;
            await writeVisionModelConfig(tempHome);
            const settingsPath = join(tempHome, ".wld", "settings.json");

            await fsWriteFile(
                settingsPath,
                JSON.stringify({
                    agents: {
                        engineer: { thinkingLevel: "high" },
                        [AGENTS.REVIEWER_FEEDBACK_ENGINEER]: { model: "test/text" },
                    },
                    defaultThinkingLevel: "low",
                }),
            );
            __resetSettingsForTests();
            const engineerFallback = await buildAgentSession({
                cwd: tempHome,
                agentName: AGENTS.REVIEWER_FEEDBACK_ENGINEER,
                modelOverride: "test/text",
                subAgentDefinition: { id: SUBAGENTS.REVIEWER_FEEDBACK_ENGINEER },
            });
            sessions.push(engineerFallback.session);
            assertEquals(engineerFallback.resolvedThinkingLevel, "high");
            assertEquals(engineerFallback.resolvedModel.id, "text");

            await fsWriteFile(
                settingsPath,
                JSON.stringify({
                    agents: {
                        engineer: { model: "test/model", thinkingLevel: "high" },
                        [AGENTS.REVIEWER_FEEDBACK_ENGINEER]: { thinkingLevel: "minimal" },
                    },
                    defaultThinkingLevel: "low",
                }),
            );
            __resetSettingsForTests();
            const repairSpecific = await buildAgentSession({
                cwd: tempHome,
                agentName: AGENTS.REVIEWER_FEEDBACK_ENGINEER,
                subAgentDefinition: { id: SUBAGENTS.REVIEWER_FEEDBACK_ENGINEER },
            });
            sessions.push(repairSpecific.session);
            assertEquals(repairSpecific.resolvedThinkingLevel, "minimal");
            assertEquals(repairSpecific.resolvedModel.id, "model");

            await fsWriteFile(
                settingsPath,
                JSON.stringify({
                    agents: {
                        engineer: { thinkingLevel: "high" },
                        [AGENTS.REVIEWER_FEEDBACK_ENGINEER]: { thinkingLevel: "off" },
                    },
                    defaultThinkingLevel: "low",
                }),
            );
            __resetSettingsForTests();
            const repairOff = await buildAgentSession({
                cwd: tempHome,
                agentName: AGENTS.REVIEWER_FEEDBACK_ENGINEER,
                modelOverride: "test/text",
                subAgentDefinition: { id: SUBAGENTS.REVIEWER_FEEDBACK_ENGINEER },
            });
            sessions.push(repairOff.session);
            assertEquals(repairOff.resolvedThinkingLevel, "off");

            await fsWriteFile(
                settingsPath,
                JSON.stringify({
                    agents: { engineer: { thinkingLevel: "off" } },
                    defaultThinkingLevel: "low",
                }),
            );
            __resetSettingsForTests();
            const offFallback = await buildAgentSession({
                cwd: tempHome,
                agentName: AGENTS.REVIEWER_FEEDBACK_ENGINEER,
                modelOverride: "test/text",
                subAgentDefinition: { id: SUBAGENTS.REVIEWER_FEEDBACK_ENGINEER },
            });
            sessions.push(offFallback.session);
            assertEquals(offFallback.resolvedThinkingLevel, "off");

            await fsWriteFile(
                settingsPath,
                JSON.stringify({
                    defaultThinkingLevel: "low",
                }),
            );
            __resetSettingsForTests();
            const defaultFallback = await buildAgentSession({
                cwd: tempHome,
                agentName: AGENTS.REVIEWER_FEEDBACK_ENGINEER,
                modelOverride: "test/text",
                subAgentDefinition: { id: SUBAGENTS.REVIEWER_FEEDBACK_ENGINEER },
            });
            sessions.push(defaultFallback.session);
            assertEquals(defaultFallback.resolvedThinkingLevel, "low");

            await fsWriteFile(
                settingsPath,
                JSON.stringify({
                    activeModelPreset: "repair",
                    modelPresets: {
                        repair: {
                            agents: {
                                engineer: { thinkingLevel: "medium" },
                            },
                        },
                    },
                    agents: { engineer: { thinkingLevel: "high" } },
                    defaultThinkingLevel: "low",
                }),
            );
            __resetSettingsForTests();
            const presetFallback = await buildAgentSession({
                cwd: tempHome,
                agentName: AGENTS.REVIEWER_FEEDBACK_ENGINEER,
                modelOverride: "test/text",
                subAgentDefinition: { id: SUBAGENTS.REVIEWER_FEEDBACK_ENGINEER },
            });
            sessions.push(presetFallback.session);
            assertEquals(presetFallback.resolvedThinkingLevel, "medium");

            const invocationOverride = await buildAgentSession({
                cwd: tempHome,
                agentName: AGENTS.REVIEWER_FEEDBACK_ENGINEER,
                modelOverride: "test/text",
                thinkingLevelOverride: "xhigh",
                subAgentDefinition: { id: SUBAGENTS.REVIEWER_FEEDBACK_ENGINEER },
            });
            sessions.push(invocationOverride.session);
            assertEquals(invocationOverride.resolvedThinkingLevel, "xhigh");
        } finally {
            for (const session of sessions) session.dispose();
            __resetSettingsForTests();
            if (originalHome === undefined) delete process.env["HOME"];
            else process.env["HOME"] = originalHome;
            await removeTempDir(tempHome);
        }
    });
});

test("Validation Repair Engineer thinking fallback reaches CLI execution session construction", async () => {
    await withProcessGlobalTestLock(async () => {
        const originalHome = process.env["HOME"];
        const tempHome = await fsMkdtemp(join(tmpdir(), "runwield-repair-thinking-execution-"));
        try {
            process.env["HOME"] = tempHome;
            await writeVisionModelConfig(tempHome);
            await fsWriteFile(
                join(tempHome, ".wld", "settings.json"),
                JSON.stringify({
                    agents: {
                        engineer: { thinkingLevel: "high" },
                        [AGENTS.REVIEWER_FEEDBACK_ENGINEER]: { model: "claude-cli/sonnet" },
                    },
                    defaultThinkingLevel: "low",
                }),
            );
            __resetSettingsForTests();

            const built = await buildExecutionSession({
                cwd: tempHome,
                agentName: AGENTS.REVIEWER_FEEDBACK_ENGINEER,
                subAgentDefinition: { id: SUBAGENTS.REVIEWER_FEEDBACK_ENGINEER },
            });
            assertEquals(built.resolvedModel.executionBackend, "claude-cli");
            assertEquals(built.resolvedThinkingLevel, "high");
            built.session.dispose();
        } finally {
            __resetSettingsForTests();
            if (originalHome === undefined) delete process.env["HOME"];
            else process.env["HOME"] = originalHome;
            await removeTempDir(tempHome);
        }
    });
});

test("buildAgentSession disables developer role for Kimi code models", async () => {
    await withProcessGlobalTestLock(async () => {
        const originalHome = process.env["HOME"];
        const tempHome = await fsMkdtemp(join(tmpdir(), "runwield-kimi-compat-"));
        try {
            process.env["HOME"] = tempHome;
            __resetSettingsForTests();
            await fsMkdir(join(tempHome, ".wld"), { recursive: true });
            await fsWriteFile(
                join(tempHome, ".wld", "models.json"),
                JSON.stringify({
                    providers: {
                        "kimi-code": {
                            baseUrl: "https://api.kimi.com/coding/v1",
                            api: "openai-completions",
                            apiKey: "test-key",
                            models: [
                                {
                                    id: "k3-256k",
                                    reasoning: true,
                                    input: ["text"],
                                    compat: { supportsTemperature: false },
                                },
                            ],
                        },
                    },
                }),
            );

            const built = await buildAgentSession({
                cwd: tempHome,
                agentName: "operator",
                modelOverride: "kimi-code/k3-256k",
            });

            assertEquals(built.resolvedModel.compat?.supportsDeveloperRole, false);
            assertEquals(built.resolvedModel.compat?.supportsTemperature, false);
            built.session.dispose();
        } finally {
            __resetSettingsForTests();
            if (originalHome === undefined) delete process.env["HOME"];
            else process.env["HOME"] = originalHome;
            __resetSettingsForTests();
            await removeTempDir(tempHome);
        }
    });
});

test("buildAgentSession wires bundled background shell and retained delegate tools", async () => {
    await withProcessGlobalTestLock(async () => {
        const originalHome = process.env["HOME"];
        const tempHome = await fsMkdtemp(join(tmpdir(), "runwield-delegate-wiring-"));
        /** @type {import('@earendil-works/pi-coding-agent').AgentSession[]} */
        const sessions = [];
        try {
            process.env["HOME"] = tempHome;
            __resetSettingsForTests();
            await writeVisionModelConfig(tempHome);

            const hostedSession = new HostedSession({ id: "delegate-wiring", cwd: tempHome });
            const enabled = await buildAgentSession({
                hostedSession,
                cwd: tempHome,
                agentName: AGENTS.GUIDE,
                modelOverride: "test/vision",
            });
            sessions.push(enabled.session);
            assert(enabled.finalCustomTools.some((tool) => tool.name === "delegate_agent"));
            assert(enabled.finalCustomTools.some((tool) => tool.name === "background_task"));

            const disabled = await buildAgentSession({
                hostedSession,
                cwd: tempHome,
                agentName: AGENTS.ROUTER,
                modelOverride: "test/vision",
            });
            sessions.push(disabled.session);
            assertEquals(
                disabled.finalCustomTools.some((tool) => tool.name === "delegate_agent"),
                false,
            );
            assert(disabled.finalCustomTools.some((tool) => tool.name === "background_task"));
        } finally {
            for (const session of sessions) session.dispose();
            __resetSettingsForTests();
            if (originalHome === undefined) delete process.env["HOME"];
            else process.env["HOME"] = originalHome;
            __resetSettingsForTests();
            await removeTempDir(tempHome);
        }
    });
});

test("buildAgentSession injects see_image only for text-only model with vision fallback", async () => {
    await withProcessGlobalTestLock(async () => {
        const originalHome = process.env["HOME"];
        const tempHome = await fsMkdtemp(join(tmpdir(), "runwield-see-image-injection-"));
        /** @type {import('@earendil-works/pi-coding-agent').AgentSession[]} */
        const sessions = [];
        try {
            process.env["HOME"] = tempHome;
            __resetSettingsForTests();
            await writeVisionModelConfig(tempHome);
            await fsWriteFile(
                join(tempHome, ".wld", "settings.json"),
                JSON.stringify({
                    visionFallback: { model: "test/vision" },
                }),
            );

            const textBuilt = await buildAgentSession({
                cwd: tempHome,
                agentName: "operator",
                modelOverride: "test/text",
            });
            sessions.push(textBuilt.session);
            assertEquals(textBuilt.tools.includes("see_image"), true);
            assert(textBuilt.finalCustomTools.find((tool) => tool.name === "see_image"));
            const seeImage = /** @type {any} */ (textBuilt.finalCustomTools.find((tool) => tool.name === "see_image"));
            assert(seeImage, "expected see_image custom tool");
            assert(seeImage.execute, "expected see_image execute");

            const visionBuilt = await buildAgentSession({
                cwd: tempHome,
                agentName: "operator",
                modelOverride: "test/vision",
            });
            sessions.push(visionBuilt.session);
            assertEquals(visionBuilt.tools.includes("see_image"), false);
            assertEquals(Boolean(visionBuilt.finalCustomTools.find((tool) => tool.name === "see_image")), false);
        } finally {
            for (const session of sessions) session.dispose();
            __resetSettingsForTests();
            if (originalHome === undefined) delete process.env["HOME"];
            else process.env["HOME"] = originalHome;
            await removeTempDir(tempHome);
        }
    });
});

test("buildAgentSession omits see_image for text-only model without fallback", async () => {
    await withProcessGlobalTestLock(async () => {
        const originalHome = process.env["HOME"];
        const tempHome = await fsMkdtemp(join(tmpdir(), "runwield-see-image-no-fallback-"));
        /** @type {import('@earendil-works/pi-coding-agent').AgentSession | undefined} */
        let session;
        try {
            process.env["HOME"] = tempHome;
            __resetSettingsForTests();
            await writeVisionModelConfig(tempHome);
            await fsWriteFile(join(tempHome, ".wld", "settings.json"), JSON.stringify({}));

            const built = await buildAgentSession({
                cwd: tempHome,
                agentName: "operator",
                modelOverride: "test/text",
            });
            session = built.session;
            assertEquals(built.tools.includes("see_image"), false);
        } finally {
            session?.dispose();
            __resetSettingsForTests();
            if (originalHome === undefined) delete process.env["HOME"];
            else process.env["HOME"] = originalHome;
            await removeTempDir(tempHome);
        }
    });
});

test("buildAgentSession defers invalid optional vision fallback until image use", async () => {
    await withProcessGlobalTestLock(async () => {
        const originalHome = process.env["HOME"];
        const tempHome = await fsMkdtemp(join(tmpdir(), "runwield-see-image-invalid-fallback-"));
        /** @type {import('@earendil-works/pi-coding-agent').AgentSession | undefined} */
        let session;
        try {
            process.env["HOME"] = tempHome;
            __resetSettingsForTests();
            await writeVisionModelConfig(tempHome);
            await fsWriteFile(
                join(tempHome, ".wld", "settings.json"),
                JSON.stringify({
                    visionFallback: { model: "not-valid" },
                }),
            );
            await fsWriteFile(join(tempHome, "shot.png"), new Uint8Array([1]));

            const built = await buildAgentSession({
                cwd: tempHome,
                agentName: "operator",
                modelOverride: "test/text",
            });
            session = built.session;
            const seeImage = /** @type {any} */ (built.finalCustomTools.find((tool) => tool.name === "see_image"));
            assert(seeImage, "expected see_image custom tool");
            const result = await seeImage.execute("1", { imageRef: "shot.png" }, undefined, undefined, {});

            assertEquals(result.isError, true);
            assertEquals(result.content[0].text, "Invalid visionFallback.model: not-valid. Use provider/id.");
        } finally {
            session?.dispose();
            __resetSettingsForTests();
            if (originalHome === undefined) delete process.env["HOME"];
            else process.env["HOME"] = originalHome;
            await removeTempDir(tempHome);
        }
    });
});

test("resolveModel candidate metrics include enum failed reasons for skipped candidates", async () => {
    const source = await fsReadFile(new URL("../session.js", import.meta.url), "utf8");
    assertEquals(source.includes('failedReason: "invalid_candidate"'), true);
    assertEquals(source.includes('failedReason: "unknown_candidate"'), true);
    assertEquals(source.includes('failedReason: "discovery_error"'), true);
    assertEquals(source.includes('failedReason: "missing_auth"'), true);
    assertEquals(source.includes('event: "selection_resolved"'), true);
    assertEquals(source.includes("discovered"), true);
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
        const planner = await loadAgentDef(AGENTS.PLANNER, projectRoot);
        assert(planner.tools.includes("work_record_search"));
        assert(planner.tools.includes("work_record_read"));
        const guide = await loadAgentDef(AGENTS.GUIDE, REPO_ROOT);
        const recorder = await loadAgentDef(AGENTS.RECORDER, REPO_ROOT);
        const ideator = await loadAgentDef(AGENTS.IDEATOR, REPO_ROOT);
        const architect = await loadAgentDef(AGENTS.ARCHITECT, REPO_ROOT);
        for (const def of [guide, recorder, ideator, architect]) {
            assert(def.tools.includes("work_record_search"));
            assert(def.tools.includes("work_record_read"));
        }
        const engineer = await loadAgentDef(AGENTS.ENGINEER, REPO_ROOT);
        assertEquals(engineer.tools.includes("work_record_search"), false);
        assertEquals(engineer.tools.includes("work_record_read"), false);
    } finally {
        await removeTempDir(projectRoot);
    }
});

test("buildAgentSession auto-wires Work Record tools with role access modes", async () => {
    await withProcessGlobalTestLock(async () => {
        const originalHome = process.env["HOME"];
        const tempHome = await fsMkdtemp(join(tmpdir(), "runwield-work-record-tool-wiring-"));
        /** @type {import('@earendil-works/pi-coding-agent').AgentSession[]} */
        const sessions = [];
        try {
            process.env["HOME"] = tempHome;
            __resetSettingsForTests();
            await writeVisionModelConfig(tempHome);
            await fsMkdir(join(tempHome, ".wld", "agents"), { recursive: true });
            await fsWriteFile(
                join(tempHome, ".wld", "agents", "custom-agent.md"),
                [
                    "---",
                    "name: Custom Agent",
                    "tools:",
                    "  - work_record_search",
                    "  - work_record_read",
                    "---",
                    "Fixture prompt.",
                ].join("\n"),
            );

            /** @param {string} agentName */
            const build = async (agentName) => {
                const built = await buildAgentSession({
                    cwd: tempHome,
                    agentName,
                    modelOverride: "test/model",
                });
                sessions.push(built.session);
                return built;
            };

            const guideBuilt = await build(AGENTS.GUIDE);
            const plannerBuilt = await build(AGENTS.PLANNER);
            const customBuilt = await build("custom-agent");
            for (const built of [guideBuilt, plannerBuilt, customBuilt]) {
                assert(built.finalCustomTools.find((tool) => tool.name === "work_record_search"));
                assert(built.finalCustomTools.find((tool) => tool.name === "work_record_read"));
            }

            const guideSearch = /** @type {any} */ (
                guideBuilt.finalCustomTools.find((tool) => tool.name === "work_record_search")
            );
            const plannerSearch = /** @type {any} */ (
                plannerBuilt.finalCustomTools.find((tool) => tool.name === "work_record_search")
            );
            const customRead = /** @type {any} */ (
                customBuilt.finalCustomTools.find((tool) => tool.name === "work_record_read")
            );
            assertEquals(
                (await guideSearch.execute("1", { query: "" }, undefined, undefined, {})).details.accessMode,
                "all",
            );
            assertEquals(
                (await plannerSearch.execute("1", { query: "" }, undefined, undefined, {})).details.accessMode,
                "current",
            );
            assertEquals(
                (await customRead.execute("1", { recordId: "" }, undefined, undefined, {})).details.accessMode,
                "current",
            );
        } finally {
            for (const session of sessions) session.dispose();
            __resetSettingsForTests();
            if (originalHome === undefined) delete process.env["HOME"];
            else process.env["HOME"] = originalHome;
            __resetSettingsForTests();
            await removeTempDir(tempHome);
        }
    });
});

test("Guide bash policy reaches Pi and background tools and refreshes after root rebuild", async () => {
    await withProcessGlobalTestLock(async () => {
        const originalHome = process.env["HOME"];
        const cwd = await fsMkdtemp(join(tmpdir(), "runwield-guide-bash-policy-"));
        const { ensureRootAgentSession, getRootSessionRebuildOptions, __getRootSessionMetadataForTests } =
            await import("../session.js");
        const overrideDir = join(cwd, ".wld", "agents");
        const overridePath = join(overrideDir, "guide.md");
        const hostedSession = new HostedSession({ id: "guide-bash-policy", cwd });
        /** @param {string} value */
        const setPolicy = async (value) => {
            await fsMkdir(overrideDir, { recursive: true });
            await fsWriteFile(overridePath, `---\nbashAllowedCommands: ${value}\n---\n`);
        };
        /** @param {string} name */
        const findTool = (name) => {
            const metadata = __getRootSessionMetadataForTests(/** @type {any} */ (hostedSession.getRootAgentSession()));
            return /** @type {import("@earendil-works/pi-coding-agent").ToolDefinition[]} */ (
                metadata?.finalCustomTools || []
            ).find((tool) => tool.name === name);
        };
        try {
            process.env["HOME"] = cwd;
            __resetSettingsForTests();
            await writeVisionModelConfig(cwd);
            const init = await captureForegroundProcess("git", { cwd, args: ["init", "-b", "main"] });
            assert(init.success);
            await fsWriteFile(join(cwd, "dirty.txt"), "visible in status\n");
            await setPolicy("[git version]");
            getSettingsManager(cwd).setShellPath(bashFixtureExecutable());
            getSettingsManager(cwd).setShellCommandPrefix("printf 'configured shell' > shell-prefix.txt; ");
            await ensureRootAgentSession({ hostedSession, agentName: AGENTS.GUIDE, modelOverride: "test/text" });
            /** @param {import("@earendil-works/pi-coding-agent").ToolDefinition | undefined} tool
             * @param {{ action?: string, command?: string, task_id?: string }} params */
            const execute = (tool, params) => {
                assert(tool);
                return tool.execute(
                    "call",
                    params,
                    new AbortController().signal,
                    () => {},
                    /** @type {any} */ ({ sessionManager: SessionManager.inMemory(cwd) }),
                );
            };
            assertEquals(
                (await execute(findTool("bash"), { command: "git version" })).content.some(
                    (item) => item.type === "text" && item.text.includes("git version"),
                ),
                true,
            );
            assertEquals(await fsReadFile(join(cwd, "shell-prefix.txt"), "utf8"), "configured shell");
            assert(
                (await execute(findTool("bash"), { command: "git status --short" })).content.some(
                    (item) => item.type === "text" && item.text.includes("dirty.txt"),
                ),
            );
            await assertRejects(
                () => execute(findTool("bash"), { command: "touch forbidden" }),
                Error,
                "report a blocker",
            );
            const denied = await execute(findTool("background_task"), { action: "start", command: "touch forbidden" });
            assert(denied.content.some((item) => item.type === "text" && item.text.includes("git version")));
            assertEquals(
                getRootSessionRebuildOptions(hostedSession).customTools?.some((tool) => tool.name === "bash"),
                false,
            );
            assert(findTool("bash")?.description.includes("git version"));
            assert(
                __getRootSessionMetadataForTests(
                    /** @type {any} */ (hostedSession.getRootAgentSession()),
                )?.promptState.text.includes("git version"),
            );
            await setPolicy("[git status]");
            await ensureRootAgentSession({
                hostedSession,
                agentName: AGENTS.GUIDE,
                modelOverride: "test/text",
                ...getRootSessionRebuildOptions(hostedSession),
            });
            await assertRejects(() => execute(findTool("bash"), { command: "git version" }), Error, "git status");
            const started = await execute(findTool("background_task"), {
                action: "start",
                command: "git status --short",
            });
            const taskId = started.details?.task_id;
            assert(taskId);
            await hostedSession.backgroundTasks.wait(taskId);
            assert(
                (
                    await execute(findTool("background_task"), { action: "status", task_id: taskId })
                ).details?.output.includes("dirty.txt"),
            );
            assert(
                (await execute(findTool("background_task"), { action: "start", command: "git version" })).content.some(
                    (item) => item.type === "text" && item.text.includes("git status"),
                ),
            );
            await setPolicy("[]");
            await ensureRootAgentSession({
                hostedSession,
                agentName: AGENTS.GUIDE,
                modelOverride: "test/text",
                ...getRootSessionRebuildOptions(hostedSession),
            });
            await assertRejects(() => execute(findTool("bash"), { command: "pwd" }), Error, "(none)");
            await setPolicy("null");
            await ensureRootAgentSession({
                hostedSession,
                agentName: AGENTS.GUIDE,
                modelOverride: "test/text",
                ...getRootSessionRebuildOptions(hostedSession),
            });
            await execute(findTool("bash"), { command: "touch unrestricted-file" });
            assertEquals((await fsStat(join(cwd, "unrestricted-file"))).isFile(), true);
        } finally {
            hostedSession.getRootAgentSession()?.dispose?.();
            if (originalHome === undefined) delete process.env["HOME"];
            else process.env["HOME"] = originalHome;
            __resetSettingsForTests();
            await removeTempDir(cwd);
        }
    });
});

test("read and write delegated Pi sessions inherit only the parent's available bash authority", async () => {
    await withProcessGlobalTestLock(async () => {
        const originalHome = process.env["HOME"];
        const cwd = await fsMkdtemp(join(tmpdir(), "runwield-delegate-bash-policy-"));
        /** @type {import('@earendil-works/pi-coding-agent').AgentSession[]} */
        const sessions = [];
        try {
            process.env["HOME"] = cwd;
            __resetSettingsForTests();
            await writeVisionModelConfig(cwd);
            const hostedSession = new HostedSession({ id: "read-delegate-bash-policy", cwd });
            /** @param {string} id
             * @param {string[]} toolNames
             * @param {readonly string[] | undefined} inheritedBashAllowedCommands */
            const build = async (id, toolNames, inheritedBashAllowedCommands) => {
                const built = await buildAgentSession({
                    hostedSession,
                    agentName: AGENTS.DELEGATED,
                    subAgentDefinition: { id },
                    toolNames,
                    inheritedBashAllowedCommands,
                    modelOverride: "test/text",
                });
                sessions.push(built.session);
                return built;
            };
            const read = await build(SUBAGENTS.DELEGATED_READ, ["bash", "read"], ["git status"]);
            const readBash = read.finalCustomTools.find((tool) => tool.name === "bash");
            assert(readBash);
            await assertRejects(
                () =>
                    readBash.execute(
                        "call",
                        { command: "git log" },
                        new AbortController().signal,
                        () => {},
                        /** @type {any} */ ({ sessionManager: SessionManager.inMemory(cwd) }),
                    ),
                Error,
                "git status",
            );
            assertEquals(read.tools.includes("background_task"), false);
            const write = await build(SUBAGENTS.DELEGATED, ["bash", "read"], ["pwd"]);
            const writeBash = write.finalCustomTools.find((tool) => tool.name === "bash");
            assert(writeBash);
            await assertRejects(
                () =>
                    writeBash.execute(
                        "call",
                        { command: "git status" },
                        new AbortController().signal,
                        () => {},
                        /** @type {any} */ ({ sessionManager: SessionManager.inMemory(cwd) }),
                    ),
                Error,
                "pwd",
            );
            const noBash = await build(SUBAGENTS.DELEGATED_READ, ["read"], undefined);
            assertEquals(noBash.tools.includes("bash"), false);
            assertEquals(
                noBash.finalCustomTools.some((tool) => tool.name === "bash"),
                false,
            );
            const unrestrictedWrite = await build(SUBAGENTS.DELEGATED, ["bash", "read"], undefined);
            const unrestrictedBash = unrestrictedWrite.finalCustomTools.find((tool) => tool.name === "bash");
            assert(unrestrictedBash);
            await unrestrictedBash.execute(
                "call",
                { command: "touch write-delegate-file" },
                new AbortController().signal,
                () => {},
                /** @type {any} */ ({ sessionManager: SessionManager.inMemory(cwd) }),
            );
            assertEquals((await fsStat(join(cwd, "write-delegate-file"))).isFile(), true);
            const defaultRead = await build(SUBAGENTS.DELEGATED_READ, ["bash", "read"], undefined);
            const defaultReadBash = defaultRead.finalCustomTools.find((tool) => tool.name === "bash");
            assert(defaultReadBash);
            const restrictedInput = { command: "cat 'write-delegate-file'" };
            await defaultRead.session.extensionRunner.emitToolCall({
                type: "tool_call",
                toolName: "bash",
                toolCallId: "restricted",
                input: restrictedInput,
            });
            assertEquals(restrictedInput.command, "cat 'write-delegate-file'");
            const unrestrictedInput = { command: "cat 'write-delegate-file'" };
            await unrestrictedWrite.session.extensionRunner.emitToolCall({
                type: "tool_call",
                toolName: "bash",
                toolCallId: "unrestricted",
                input: unrestrictedInput,
            });
            assert(unrestrictedInput.command.includes("snip run --"));
            await assertRejects(
                () =>
                    defaultReadBash.execute(
                        "call",
                        { command: "touch forbidden" },
                        new AbortController().signal,
                        () => {},
                        /** @type {any} */ ({ sessionManager: SessionManager.inMemory(cwd) }),
                    ),
                Error,
                "report a blocker",
            );
            assertEquals(
                await fsStat(join(cwd, "forbidden")).then(
                    () => true,
                    () => false,
                ),
                false,
            );
        } finally {
            for (const session of sessions) session.dispose();
            if (originalHome === undefined) delete process.env["HOME"];
            else process.env["HOME"] = originalHome;
            __resetSettingsForTests();
            await removeTempDir(cwd);
        }
    });
});

test("Agent command front matter merges, clears, and validates layered defaults", async () => {
    const cwd = await fsMkdtemp(join(tmpdir(), "runwield-bash-frontmatter-"));
    const directory = join(cwd, ".wld", "agents");
    const overridePath = join(directory, "guide.md");
    try {
        await fsMkdir(directory, { recursive: true });
        const initial = await loadAgentDef(AGENTS.GUIDE, cwd);
        assert(initial.bashAllowedCommands);
        assert(initial.bashAllowedCommands.includes("git status"));
        await fsWriteFile(overridePath, "---\nname: Guide\n---\n");
        assertEquals((await loadAgentDef(AGENTS.GUIDE, cwd)).bashAllowedCommands, initial.bashAllowedCommands);
        await fsWriteFile(overridePath, "---\nbashAllowedCommands: [td, git status, td]\n---\n");
        assertEquals((await loadAgentDef(AGENTS.GUIDE, cwd)).bashAllowedCommands, [
            ...initial.bashAllowedCommands,
            "td",
        ]);
        await fsWriteFile(overridePath, "---\nbashAllowedCommands: []\n---\n");
        assertEquals((await loadAgentDef(AGENTS.GUIDE, cwd)).bashAllowedCommands, []);
        await fsWriteFile(overridePath, "---\nbashAllowedCommands: null\n---\n");
        assertEquals((await loadAgentDef(AGENTS.GUIDE, cwd)).bashAllowedCommands, undefined);
        for (const invalid of ["false", "[pwd, 3]", "['']", "['git status && touch x']"]) {
            await fsWriteFile(overridePath, `---\nbashAllowedCommands: ${invalid}\n---\n`);
            await assertRejects(() => loadAgentDef(AGENTS.GUIDE, cwd), Error, "bashAllowedCommands");
        }
    } finally {
        await removeTempDir(cwd);
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
        assertEquals((await loadAgentDef("docs-writer", cwd)).tools, [
            "write_docs",
            "edit_docs",
            "bash",
            "background_task",
            "user_interview",
            "set_session_name",
        ]);

        await fsWriteFile(join(directory, "talker.md"), "---\nname: Talker\n---\nJust talk.\n");
        assertEquals((await loadAgentDef("talker", cwd)).tools, ["set_session_name"]);

        const bundled = await loadAgentDef(AGENTS.OPERATOR, cwd);
        const operatorPath = join(directory, "operator.md");
        await fsWriteFile(operatorPath, "---\ndescription: Read-only\n---\n");
        assertEquals((await loadAgentDef(AGENTS.OPERATOR, cwd)).tools, bundled.tools);
        await fsWriteFile(operatorPath, "---\ntoolSets: [read]\n---\n");
        const narrowed = (await loadAgentDef(AGENTS.OPERATOR, cwd)).tools;
        assert(narrowed.includes("code_outline"));
        assert(!narrowed.includes("edit") && !narrowed.includes("bash"));
        assert(narrowed.includes("task_completed") && narrowed.includes("memory"));

        for (const invalid of ["[reed]", "read", "[read, 3]"]) {
            await fsWriteFile(operatorPath, `---\ntoolSets: ${invalid}\n---\n`);
            await assertRejects(() => loadAgentDef(AGENTS.OPERATOR, cwd), Error, "toolSets");
        }
    } finally {
        await removeTempDir(cwd);
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
            const bundled = await loadAgentDef(AGENTS.GUIDE, cwd);
            assert(bundled.bashAllowedCommands);
            assert(bundled.bashAllowedCommands.includes("git status"));
            await fsWriteFile(join(homeAgents, "guide.md"), "---\nbashAllowedCommands: [td]\n---\n");
            assertEquals((await loadAgentDef(AGENTS.GUIDE, cwd)).bashAllowedCommands, [
                ...bundled.bashAllowedCommands,
                "td",
            ]);
            await fsWriteFile(join(projectAgents, "guide.md"), "---\nbashAllowedCommands: [td, git version]\n---\n");
            assertEquals((await loadAgentDef(AGENTS.GUIDE, cwd)).bashAllowedCommands, [
                ...bundled.bashAllowedCommands,
                "td",
                "git version",
            ]);
        } finally {
            if (originalHome === undefined) delete process.env["HOME"];
            else process.env["HOME"] = originalHome;
            await removeTempDir(root);
        }
    });
});

test("external CLI bridge filters RunWield background starts but not native host commands", async () => {
    const cwd = await fsMkdtemp(join(tmpdir(), "runwield-bridge-bash-policy-"));
    const hostedSession = new HostedSession({ id: "bridge-bash-policy", cwd });
    try {
        const agentDef = await loadAgentDef(AGENTS.GUIDE, cwd);
        const bridged = await composeClaudeCliBridgedTools({
            agentDef,
            agentName: AGENTS.GUIDE,
            hostedSession,
            cwd,
            triageMeta: undefined,
        });
        const background = bridged.find((tool) => tool.name === "background_task");
        assert(background);
        const result = await background.execute(
            "call",
            { action: "start", command: "touch bridge-sentinel" },
            new AbortController().signal,
            () => {},
            /** @type {any} */ ({}),
        );
        assert(result.content.some((item) => item.type === "text" && item.text.includes("report a blocker")));
        assertEquals(
            await fsStat(join(cwd, "bridge-sentinel")).then(
                () => true,
                () => false,
            ),
            false,
        );
    } finally {
        await hostedSession.backgroundTasks.cancelAllAndSuppress();
        await removeTempDir(cwd);
    }
});

test("Claude CLI and Agy CLI bridge declared Plan Deviations for execution Agents", async () => {
    const cwd = await fsMkdtemp(join(tmpdir(), "runwield-cli-deviation-"));
    const hostedSession = new HostedSession({ id: crypto.randomUUID(), cwd });
    try {
        for (const agentName of ["plan-engineer", "frontend-engineer"]) {
            const agentDef = await loadAgentDef(agentName, REPO_ROOT);
            for (const compose of [composeClaudeCliBridgedTools, composeAgyCliBridgedTools]) {
                const tools = await compose({ agentDef, agentName, hostedSession, triageMeta: undefined, cwd });
                assertEquals(tools.filter((tool) => tool.name === "record_plan_deviation").length, 1);
            }
        }
    } finally {
        hostedSession.dispose();
        await removeTempDir(cwd);
    }
});
