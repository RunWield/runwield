import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { join } from "@std/path";
import { AGENTS } from "../../constants.js";
import { loadAgentDef } from "./agents.js";
import { withRuntimeCommandFixture } from "../../cmd/testing/runtime-command-fixture.ts";
import {
    __getRootSessionMetadataForTests,
    applyAttentionNudge,
    assembleFinalSystemPrompt,
    assembleFinalSystemPromptWithContextProjection,
    ensureRootAgentSession,
    getEngineerCompactionThreshold,
    getGlobalAgentMdPaths,
    installEngineerAutoCompactionThreshold,
    readGlobalAgentMd,
    runIsolatedAgentSession,
    runNonInteractiveAgentPrompt,
    runPrompt,
    runRootTurn,
    shouldBypassAutoCompactionForAssistantMessage,
    shouldReuseExistingRootSession,
} from "./session.js";
import { getRootExecutionMessages } from "./execution-backend.ts";
import { HostedSession } from "./hosted-session.js";
import { getRunWieldSessionDir } from "./root-session.js";
import { estimateContextTextTokens } from "./session-context-report.ts";
import { defineCommittedGitFixture, git } from "../git-test-fixture.ts";

import { withProcessGlobalTestLock } from "../../testing/process-global-lock.ts";

/**
 * @param {string | Record<string, any>} testDefinition
 * @param {(() => void | Promise<void>) | undefined} [fn]
 */
function sessionPromptTest(testDefinition, fn) {
    if (typeof testDefinition === "string") {
        if (!fn) throw new Error("sessionPromptTest requires a test function");
        Deno.test(testDefinition, () => withProcessGlobalTestLock(async () => await fn()));
        return;
    }
    Deno.test(
        /** @type {any} */ ({
            ...testDefinition,
            fn: () => withProcessGlobalTestLock(async () => await testDefinition.fn()),
        }),
    );
}

const promptGitFixture = defineCommittedGitFixture();

sessionPromptTest("assembleFinalSystemPrompt includes project-state context only when provided", async () => {
    const agentDef = {
        name: "test",
        displayName: "Test",
        description: "Test agent",
        model: "",
        tools: [],
        systemPrompt:
            "## Project Context\n\n{{PROJECT_STATE_CONTEXT}}\n{{PROJECT_AGENTSMD}}\n\n{{AVAILABLE_TOOLS}}\n{{GLOBAL_AGENTSMD}}\n{{MEMORIES}}\n{{SKILLS}}\n{{IMAGE_ATTACHMENTS_SECTION}}\n{{BUNDLED_AGENT_DEFS_DIR}}",
    };

    const withoutContext = await assembleFinalSystemPrompt(agentDef, [], [], Deno.cwd());
    const withContext = await assembleFinalSystemPrompt(agentDef, [], [], Deno.cwd(), "Greenfield note.");

    assertEquals(withoutContext.includes("### Project State"), false);
    assertStringIncludes(withContext, "### Project State\n\nGreenfield note.");
});

sessionPromptTest("assembleFinalSystemPrompt includes the Session naming reminder only while unnamed", async () => {
    const projectRoot = await Deno.makeTempDir({ prefix: "runwield-prompt-session-name-" });
    try {
        const reminder = "If this Session is unnamed, call `set_session_name` early with a short descriptive name.";
        const agentDef = await loadAgentDef(AGENTS.GUIDE, projectRoot);
        const sessionManager = SessionManager.inMemory(projectRoot);

        const unnamed = await assembleFinalSystemPrompt(
            agentDef,
            agentDef.tools,
            [],
            projectRoot,
            "",
            { sessionManager },
        );

        sessionManager.appendSessionInfo("router supplied name");
        const named = await assembleFinalSystemPrompt(
            agentDef,
            agentDef.tools,
            [],
            projectRoot,
            "",
            { sessionManager },
        );

        assertStringIncludes(unnamed, reminder);
        assertStringIncludes(unnamed, "set_session_name");
        assertEquals(named.includes(reminder), false);
        assertEquals(named.includes("{{SESSION_NAME_REMINDER}}"), false);
    } finally {
        await Deno.remove(projectRoot, { recursive: true }).catch(() => {});
    }
});

sessionPromptTest("assembleFinalSystemPrompt suppresses the Session naming reminder for sanitized names", async () => {
    const projectRoot = await Deno.makeTempDir({ prefix: "runwield-prompt-sanitized-session-name-" });
    try {
        const reminder = "If this Session is unnamed, call `set_session_name` early with a short descriptive name.";
        const agentDef = await loadAgentDef(AGENTS.GUIDE, projectRoot);
        const sessionManager = SessionManager.inMemory(projectRoot);
        sessionManager.appendSessionInfo("  router\n\tsupplied name  ");

        const prompt = await assembleFinalSystemPrompt(
            agentDef,
            agentDef.tools,
            [],
            projectRoot,
            "",
            { sessionManager },
        );

        assertEquals(prompt.includes(reminder), false);
        assertEquals(prompt.includes("{{SESSION_NAME_REMINDER}}"), false);
    } finally {
        await Deno.remove(projectRoot, { recursive: true }).catch(() => {});
    }
});

sessionPromptTest("assembleFinalSystemPrompt includes Git branch and clean state for Git projects", async () => {
    const projectRoot = await promptGitFixture.checkout({ prefix: "runwield-prompt-git-clean-" });
    try {
        const prompt = await assembleFinalSystemPrompt(
            {
                name: "test",
                displayName: "Test",
                description: "Test agent",
                model: "",
                tools: [],
                systemPrompt: "{{PROJECT_STATE_CONTEXT}}",
            },
            [],
            [],
            projectRoot,
        );

        assertStringIncludes(prompt, "- Git Branch: main\n- Git Work tree: clean");
    } finally {
        await Deno.remove(projectRoot, { recursive: true }).catch(() => {});
    }
});

sessionPromptTest("assembleFinalSystemPrompt includes Git branch and dirty state for Git projects", async () => {
    const projectRoot = await promptGitFixture.checkout({ prefix: "runwield-prompt-git-dirty-" });
    try {
        await Deno.writeTextFile(join(projectRoot, "dirty.txt"), "changed\n");
        await git(projectRoot, ["checkout", "-b", "feature/git-prompt-state"]);

        const prompt = await assembleFinalSystemPrompt(
            {
                name: "test",
                displayName: "Test",
                description: "Test agent",
                model: "",
                tools: [],
                systemPrompt: "{{PROJECT_STATE_CONTEXT}}",
            },
            [],
            [],
            projectRoot,
        );

        assertStringIncludes(prompt, "- Git Branch: feature/git-prompt-state\n- Git Work tree: dirty");
    } finally {
        await Deno.remove(projectRoot, { recursive: true }).catch(() => {});
    }
});

sessionPromptTest("assembleFinalSystemPrompt omits Git state outside Git projects", async () => {
    const projectRoot = await Deno.makeTempDir({ prefix: "runwield-prompt-non-git-" });
    try {
        const prompt = await assembleFinalSystemPrompt(
            {
                name: "test",
                displayName: "Test",
                description: "Test agent",
                model: "",
                tools: [],
                systemPrompt: "{{PROJECT_STATE_CONTEXT}}",
            },
            [],
            [],
            projectRoot,
        );

        assertEquals(prompt.includes("### Git State"), false);
    } finally {
        await Deno.remove(projectRoot, { recursive: true }).catch(() => {});
    }
});

sessionPromptTest("assembleFinalSystemPromptWithContextProjection attributes resident context", async () => {
    const tempHome = await Deno.makeTempDir({ prefix: "runwield-context-home-" });
    const projectRoot = await Deno.makeTempDir({ prefix: "runwield-context-project-" });
    const localSkillDir = join(projectRoot, ".wld", "skills", "visible-skill");
    const hiddenSkillDir = join(projectRoot, ".wld", "skills", "hidden-skill");
    try {
        await Deno.mkdir(join(tempHome, ".wld"), { recursive: true });
        await Deno.writeTextFile(join(tempHome, ".wld", "RUNWIELD.md"), "Global context instructions");
        await Deno.writeTextFile(join(projectRoot, "RUNWIELD.md"), "Project context instructions");
        await Deno.mkdir(localSkillDir, { recursive: true });
        await Deno.writeTextFile(
            join(localSkillDir, "SKILL.md"),
            ["---", "name: visible-skill", "description: Visible skill", "---", "Full skill body"].join("\n"),
        );
        await Deno.mkdir(hiddenSkillDir, { recursive: true });
        await Deno.writeTextFile(
            join(hiddenSkillDir, "SKILL.md"),
            [
                "---",
                "name: hidden-skill",
                "description: Hidden skill",
                "disable-model-invocation: true",
                "---",
                "Hidden body",
            ].join("\n"),
        );

        const { prompt, projection } = await assembleFinalSystemPromptWithContextProjection(
            /** @type {any} */ ({
                name: "test",
                displayName: "Test",
                description: "Test agent",
                systemPrompt:
                    "Agent instructions {{AVAILABLE_TOOLS}} {{GLOBAL_AGENTSMD}} {{PROJECT_AGENTSMD}} {{MEMORIES}} {{SKILLS}} {{PROJECT_STATE_CONTEXT}} {{IMAGE_ATTACHMENTS_SECTION}} {{BUNDLED_AGENT_DEFS_DIR}}",
            }),
            ["read", "custom_tool"],
            [
                /** @type {any} */ ({
                    name: "custom_tool",
                    label: "Custom Tool",
                    description: "Custom tool with schema",
                    promptSnippet: "custom_tool(value): use schema-backed custom tool",
                    parameters: {
                        type: "object",
                        properties: {
                            value: { type: "string", description: "Important schema-only value details" },
                        },
                        required: ["value"],
                    },
                }),
            ],
            projectRoot,
            "Runtime project state",
            { homeDir: tempHome },
        );

        assertStringIncludes(prompt, "Global context instructions");
        assertStringIncludes(prompt, "Project context instructions");
        assertStringIncludes(prompt, "Runtime project state");
        assertStringIncludes(prompt, "visible-skill");
        assertEquals(prompt.includes("hidden-skill"), false);
        assertEquals(projection.instructionFiles.map((file) => file.source), ["home", "local"]);
        assertEquals(projection.skills.some((skill) => skill.name === "visible-skill"), true);
        assertEquals(projection.skills.some((skill) => skill.name === "hidden-skill"), false);
        const customToolItem = projection.categories.find((category) => category.id === "tools")?.items?.find((item) =>
            item.name === "custom_tool"
        );
        assertEquals(typeof customToolItem?.tokens, "number");
        assertEquals(
            (customToolItem?.tokens || 0) >
                Math.ceil("- custom_tool - custom_tool(value): use schema-backed custom tool".length / 4),
            true,
        );
        assertEquals(
            projection.categories.some((category) => category.id === "project_state" && category.tokens > 0),
            true,
        );
        assertEquals(projection.categories.some((category) => category.id === "tools" && category.tokens > 0), true);
    } finally {
        await Deno.remove(tempHome, { recursive: true }).catch(() => {});
        await Deno.remove(projectRoot, { recursive: true }).catch(() => {});
    }
});

sessionPromptTest("assembleFinalSystemPromptWithContextProjection includes Core Memory from Mnemoteca", async () => {
    const projectRoot = await Deno.makeTempDir({ prefix: "runwield-context-project-" });
    const fakeBin = join(projectRoot, "fake-bin");
    const commandLog = join(projectRoot, "mnemoteca-command.log");
    const previousPath = Deno.env.get("PATH");
    const pathSeparator = Deno.build.os === "windows" ? ";" : ":";
    try {
        await Deno.mkdir(fakeBin);
        await Deno.writeTextFile(
            join(fakeBin, "mnemoteca"),
            `#!/usr/bin/env bash
set -euo pipefail
printf 'args=%s\n' "$*" > '${commandLog}'
if [[ "$*" != 'list -t core -f plain' ]]; then
  exit 64
fi
printf 'Core memory from Mnemoteca\nSecond core memory\n'
`,
        );
        await Deno.chmod(join(fakeBin, "mnemoteca"), 0o755);
        Deno.env.set("PATH", previousPath ? `${fakeBin}${pathSeparator}${previousPath}` : fakeBin);

        const { prompt, projection } = await assembleFinalSystemPromptWithContextProjection(
            /** @type {any} */ ({
                name: "test",
                displayName: "Test",
                description: "Test agent",
                systemPrompt: "Agent instructions {{MEMORIES}}",
            }),
            [],
            [],
            projectRoot,
        );

        assertStringIncludes(prompt, "Core memory from Mnemoteca");
        assertStringIncludes(prompt, "Second core memory");
        assertEquals(await Deno.readTextFile(commandLog), "args=list -t core -f plain\n");
        const coreMemoryItem = projection.categories.find((category) => category.id === "core_memories")?.items?.[0];
        assertEquals(coreMemoryItem?.source, "mnemoteca");
        assertEquals(coreMemoryItem?.label, "Core Memories");
    } finally {
        if (previousPath === undefined) Deno.env.delete("PATH");
        else Deno.env.set("PATH", previousPath);
        await Deno.remove(projectRoot, { recursive: true }).catch(() => {});
    }
});

sessionPromptTest("assembleFinalSystemPromptWithContextProjection excludes omitted placeholder context", async () => {
    const originalHome = Deno.env.get("HOME");
    const tempHome = await Deno.makeTempDir({ prefix: "runwield-context-home-" });
    const projectRoot = await Deno.makeTempDir({ prefix: "runwield-context-project-" });
    const localSkillDir = join(projectRoot, ".wld", "skills", "visible-skill");
    try {
        Deno.env.set("HOME", tempHome);
        await Deno.mkdir(join(tempHome, ".wld"), { recursive: true });
        await Deno.writeTextFile(join(tempHome, ".wld", "RUNWIELD.md"), "Global context instructions");
        await Deno.writeTextFile(join(projectRoot, "RUNWIELD.md"), "Project context instructions");
        await Deno.mkdir(localSkillDir, { recursive: true });
        await Deno.writeTextFile(
            join(localSkillDir, "SKILL.md"),
            ["---", "name: visible-skill", "description: Visible skill", "---", "Full skill body"].join("\n"),
        );

        const { prompt, projection } = await assembleFinalSystemPromptWithContextProjection(
            /** @type {any} */ ({
                name: "test",
                displayName: "Test",
                description: "Test agent",
                systemPrompt: "Bare agent instructions.",
            }),
            ["see_image"],
            [],
            projectRoot,
            "Runtime project state",
        );

        assertEquals(prompt.includes("Global context instructions"), false);
        assertEquals(prompt.includes("Project context instructions"), false);
        assertEquals(prompt.includes("Runtime project state"), false);
        assertEquals(prompt.includes("visible-skill"), false);
        assertEquals(prompt.includes("Image Attachments"), false);
        assertEquals(projection.instructionFiles, []);
        assertEquals(projection.skills, []);
        assertEquals(projection.categories.some((category) => category.id === "project_state"), false);
        assertEquals(projection.categories.some((category) => category.id === "skill_catalog"), false);
        const agentItem = projection.categories.find((category) => category.id === "agent_instructions")?.items?.[0];
        const timezoneLine = `Timezone: ${Intl.DateTimeFormat().resolvedOptions().timeZone}`;
        assertEquals(
            agentItem?.tokens,
            estimateContextTextTokens(["Bare agent instructions.", timezoneLine].join("\n")),
        );
    } finally {
        if (originalHome === undefined) Deno.env.delete("HOME");
        else Deno.env.set("HOME", originalHome);
        await Deno.remove(tempHome, { recursive: true }).catch(() => {});
        await Deno.remove(projectRoot, { recursive: true }).catch(() => {});
    }
});

sessionPromptTest("readGlobalAgentMd falls back from ~/.wld/RUNWIELD.md to ~/.wld/AGENTS.md", async () => {
    const tempHome = await Deno.makeTempDir({ prefix: "runwield-agents-md-" });

    try {
        await Deno.mkdir(join(tempHome, ".wld"), { recursive: true });
        await Deno.writeTextFile(join(tempHome, ".wld", "AGENTS.md"), "Global AGENTS fallback");

        const prompt = await readGlobalAgentMd(tempHome);

        assertEquals(prompt, "Global AGENTS fallback");
    } finally {
        await Deno.remove(tempHome, { recursive: true });
    }
});

sessionPromptTest("readGlobalAgentMd falls back to ~/.agents/AGENTS.md by default", async () => {
    const tempHome = await Deno.makeTempDir({ prefix: "runwield-agents-md-" });

    try {
        await Deno.mkdir(join(tempHome, ".agents"), { recursive: true });
        await Deno.writeTextFile(join(tempHome, ".agents", "AGENTS.md"), "External AGENTS fallback");

        const prompt = await readGlobalAgentMd(tempHome);

        assertEquals(prompt, "External AGENTS fallback");
    } finally {
        await Deno.remove(tempHome, { recursive: true });
    }
});

sessionPromptTest("readGlobalAgentMd can disable ~/.agents/AGENTS.md fallback", async () => {
    const tempHome = await Deno.makeTempDir({ prefix: "runwield-agents-md-" });

    try {
        await Deno.mkdir(join(tempHome, ".agents"), { recursive: true });
        await Deno.writeTextFile(join(tempHome, ".agents", "AGENTS.md"), "External AGENTS fallback");

        const prompt = await readGlobalAgentMd(tempHome, { includeExternal: false });

        assertEquals(prompt, "");
    } finally {
        await Deno.remove(tempHome, { recursive: true });
    }
});

sessionPromptTest("getGlobalAgentMdPaths stays inside ~/.wld", () => {
    assertEquals(getGlobalAgentMdPaths("/tmp/home", { includeExternal: false }), [
        "/tmp/home/.wld/RUNWIELD.md",
        "/tmp/home/.wld/AGENTS.md",
    ]);
});

sessionPromptTest("getGlobalAgentMdPaths includes shared ~/.agents/AGENTS.md when enabled", () => {
    assertEquals(getGlobalAgentMdPaths("/tmp/home", { includeExternal: true }), [
        "/tmp/home/.wld/RUNWIELD.md",
        "/tmp/home/.wld/AGENTS.md",
        "/tmp/home/.agents/AGENTS.md",
    ]);
});

sessionPromptTest("applyAttentionNudge only injects scheduled long-lived agent nudges", () => {
    assertEquals(applyAttentionNudge(AGENTS.IDEATOR, "User asks", 1), "User asks");
    assertEquals(applyAttentionNudge(AGENTS.OPERATOR, "User asks", 6), "User asks");

    assertEquals(
        applyAttentionNudge(AGENTS.GUIDE, "User asks", 6),
        [
            "<attention_nudge>",
            "You are still the Guide. Answer direct questions concisely from durable project evidence with compact citations, separate intent from verified outcomes/current behavior, use docs-only Markdown tools only after explicit preservation requests, and state the concrete limit and offer `/agent` options for code/config edits, workflow artifacts, plans, execution, or deeper ideation.",
            "</attention_nudge>",
            "",
            "User asks",
        ].join("\n"),
    );

    assertEquals(
        applyAttentionNudge(AGENTS.IDEATOR, "User asks", 6),
        [
            "<attention_nudge>",
            "You are still the Ideator. Stay at problem and product altitude: investigate feasibility, surface overlooked consequences, prioritize consequential divergent decisions, infer low-risk solution details, batch minor preferences when input is truly needed, and state the concrete limit and offer `/agent` options for actionable implementation or planning requests.",
            "</attention_nudge>",
            "",
            "User asks",
        ].join("\n"),
    );
});

sessionPromptTest("shouldReuseExistingRootSession ignores undefined optional overrides", () => {
    assertEquals(
        shouldReuseExistingRootSession({
            agentName: AGENTS.OPERATOR,
            userRequest: "commit",
            modelOverride: undefined,
        }, AGENTS.OPERATOR),
        true,
    );

    assertEquals(
        shouldReuseExistingRootSession({
            agentName: AGENTS.OPERATOR,
            userRequest: "commit",
            modelOverride: "test/model",
        }, AGENTS.OPERATOR),
        false,
    );
});

sessionPromptTest("task_completed assistant messages bypass post-turn auto-compaction", () => {
    assertEquals(
        shouldBypassAutoCompactionForAssistantMessage({
            role: "assistant",
            content: [{ type: "tool_use", name: "task_completed", input: { message: "Done" } }],
        }),
        true,
    );
    assertEquals(
        shouldBypassAutoCompactionForAssistantMessage({
            role: "assistant",
            content: [{ type: "toolCall", name: "task_completed", arguments: { message: "Done" } }],
        }),
        true,
    );
    assertEquals(
        shouldBypassAutoCompactionForAssistantMessage({
            role: "assistant",
            content: [{ type: "tool_use", name: "bash", input: { command: "deno task test" } }],
        }),
        false,
    );
});

sessionPromptTest("Engineer compaction uses 60 percent of context or 120K tokens", () => {
    assertEquals(getEngineerCompactionThreshold(AGENTS.ENGINEER, 128_000), 76_800);
    assertEquals(getEngineerCompactionThreshold(AGENTS.PLAN_ENGINEER, 128_000), 76_800);
    assertEquals(getEngineerCompactionThreshold(AGENTS.FRONTEND_ENGINEER, 200_000), 120_000);
    assertEquals(getEngineerCompactionThreshold(AGENTS.REVIEWER_FEEDBACK_ENGINEER, 1_000_000), 120_000);
    assertEquals(getEngineerCompactionThreshold(AGENTS.PLANNER, 128_000), null);
});

sessionPromptTest("runPrompt compacts Engineer before Pi's configured threshold", async () => {
    const calls = /** @type {string[]} */ ([]);
    const session = /** @type {any} */ ({
        model: { provider: "test", id: "model", input: ["text"], contextWindow: 100 },
        modelRegistry: { hasConfiguredAuth: () => true },
        settingsManager: {
            getCompactionSettings: () => ({ enabled: true, reserveTokens: 10, keepRecentTokens: 10 }),
        },
        sessionManager: {
            buildSessionContext: () => ({ messages: [], thinkingLevel: "", model: null }),
        },
        getContextUsage: () => ({ tokens: 60, contextWindow: 100, percent: 60 }),
        _runAutoCompaction: (/** @type {string} */ reason, /** @type {boolean} */ willRetry) => {
            calls.push(`compact:${reason}:${willRetry}`);
            return Promise.resolve(true);
        },
        prompt: () => {
            calls.push("prompt");
            return Promise.resolve();
        },
        agent: { waitForIdle: () => Promise.resolve(), state: { messages: [] } },
    });
    const subscriberState = /** @type {any} */ ({
        resetTurn: () => {},
        endThinking: () => {},
        drainInvokedToolNames: () => [],
    });

    await runPrompt({
        session,
        agentDef: {
            name: "engineer",
            displayName: "Engineer",
            model: "",
            description: "Test engineer",
            tools: [],
            systemPrompt: "system",
        },
        agentName: "engineer",
        userRequest: "next task",
        finalSystemPrompt: "system",
        subscriberState,
    });

    assertEquals(calls, ["compact:threshold:false", "prompt"]);
});

sessionPromptTest("Engineer post-response compaction re-arms after new context growth", async () => {
    const calls = /** @type {string[]} */ ([]);
    let tokens = 59;
    /** @type {import('@earendil-works/pi-coding-agent').AgentSessionEventListener | undefined} */
    let listener;
    const session = /** @type {any} */ ({
        model: { contextWindow: 100 },
        settingsManager: {
            getCompactionSettings: () => ({ enabled: true, reserveTokens: 10, keepRecentTokens: 10 }),
        },
        getContextUsage: () => ({ tokens, contextWindow: 100, percent: tokens }),
        subscribe: /** @param {import('@earendil-works/pi-coding-agent').AgentSessionEventListener} callback */ (
            callback,
        ) => {
            listener = callback;
            return () => {};
        },
        _checkCompaction: () => Promise.resolve(false),
        _runAutoCompaction: (/** @type {string} */ reason, /** @type {boolean} */ willRetry) => {
            calls.push(`compact:${reason}:${willRetry}`);
            listener?.({
                type: "compaction_end",
                reason: "threshold",
                result: { summary: "summary", firstKeptEntryId: "recent", tokensBefore: tokens },
                aborted: false,
                willRetry: false,
            });
            return Promise.resolve(false);
        },
    });

    installEngineerAutoCompactionThreshold(session, AGENTS.ENGINEER);
    await session._checkCompaction({ role: "assistant", stopReason: "stop" });
    assertEquals(calls, []);
    tokens = 60;
    await session._checkCompaction({ role: "assistant", stopReason: "stop" });
    await session._checkCompaction({ role: "assistant", stopReason: "stop" });
    tokens = 64;
    await session._checkCompaction({ role: "assistant", stopReason: "stop" });
    tokens = 65;
    await session._checkCompaction({ role: "assistant", stopReason: "stop" });

    assertEquals(calls, ["compact:threshold:false", "compact:threshold:false"]);
});

sessionPromptTest("Engineer threshold respects disabled automatic compaction", async () => {
    const calls = /** @type {string[]} */ ([]);
    const session = /** @type {any} */ ({
        model: { contextWindow: 100 },
        settingsManager: {
            getCompactionSettings: () => ({ enabled: false, reserveTokens: 10, keepRecentTokens: 10 }),
        },
        getContextUsage: () => ({ tokens: 75, contextWindow: 100, percent: 75 }),
        subscribe: () => () => {},
        _checkCompaction: () => Promise.resolve(false),
        _runAutoCompaction: () => {
            calls.push("compact");
            return Promise.resolve(true);
        },
    });

    installEngineerAutoCompactionThreshold(session, AGENTS.ENGINEER);
    await session._checkCompaction({ role: "assistant", stopReason: "stop" });

    assertEquals(calls, []);
});

sessionPromptTest("runPrompt sends fallback image markers without raw image content to text-only model", async () => {
    const originalHome = Deno.env.get("HOME");
    const originalCwd = Deno.cwd();
    const tempHome = await Deno.makeTempDir({ prefix: "runwield-runprompt-home-" });
    const tempProject = await Deno.makeTempDir({ prefix: "runwield-runprompt-project-" });
    try {
        Deno.env.set("HOME", tempHome);
        Deno.chdir(tempProject);
        await Deno.mkdir(".wld", { recursive: true });
        await Deno.writeTextFile(".wld/settings.json", JSON.stringify({ visionFallback: { model: "test/vision" } }));
        const fallbackModel = { provider: "test", id: "vision", input: ["text", "image"] };
        /** @type {Array<{ text: string, options: any }>} */
        const prompts = [];
        const session = /** @type {any} */ ({
            model: { provider: "test", id: "text", input: ["text"] },
            modelRegistry: {
                find: () => fallbackModel,
                hasConfiguredAuth: () => true,
            },
            prompt: (/** @type {string} */ text, /** @type {any} */ options) => {
                prompts.push({ text, options });
                return Promise.resolve();
            },
            agent: { waitForIdle: () => Promise.resolve(), state: { messages: [] } },
        });
        const subscriberState = /** @type {any} */ ({
            resetTurn: () => {},
            endThinking: () => {},
            drainInvokedToolNames: () => [],
        });

        await runPrompt({
            session,
            agentDef: {
                name: "operator",
                displayName: "Operator",
                model: "",
                description: "Test operator",
                tools: [],
                systemPrompt: "system",
            },
            agentName: "operator",
            userRequest: "please inspect",
            finalSystemPrompt: "system",
            images: /** @type {import('./types.js').ImageAttachment[]} */ ([{
                base64: "abc",
                mimeType: "image/png",
                ref: "attachment:123",
            }]),
            subscriberState,
        });

        assertEquals(prompts.length, 1);
        assertEquals(prompts[0].text, "please inspect\n\n[Image attached: attachment:123 image/png]");
        assertEquals(prompts[0].options.images, undefined);
    } finally {
        Deno.chdir(originalCwd);
        if (originalHome === undefined) Deno.env.delete("HOME");
        else Deno.env.set("HOME", originalHome);
        await Deno.remove(tempHome, { recursive: true });
        await Deno.remove(tempProject, { recursive: true });
    }
});

/**
 * @param {string} projectRoot
 * @param {string} id
 */
function makeHostedRuntimeSession(projectRoot, id) {
    const manager = SessionManager.create(projectRoot, getRunWieldSessionDir(projectRoot), { id: `${id}-manager` });
    return new HostedSession({ id, cwd: projectRoot, sessionManager: /** @type {any} */ (manager) });
}

Deno.test("ensureRootAgentSession scopes real roots and transcripts to each HostedSession", async () => {
    await withRuntimeCommandFixture("session-root-scope-", async ({ projectRoot }) => {
        const hostedA = makeHostedRuntimeSession(projectRoot, "root-a");
        const hostedB = makeHostedRuntimeSession(projectRoot, "root-b");
        hostedA.setProjectStateContext("context-a");
        hostedB.setProjectStateContext("context-b");

        const rootA = await ensureRootAgentSession({ hostedSession: hostedA, agentName: "guide" });
        const rootB = await ensureRootAgentSession({ hostedSession: hostedB, agentName: "operator" });

        assertEquals(hostedA.getRootAgentSession(), rootA);
        assertEquals(hostedB.getRootAgentSession(), rootB);
        assertEquals(hostedA.getRootAgentName(), "guide");
        assertEquals(hostedB.getRootAgentName(), "operator");
        assertEquals(__getRootSessionMetadataForTests(rootA).projectStateContext, "context-a");
        assertEquals(__getRootSessionMetadataForTests(rootB).projectStateContext, "context-b");
        assertEquals(hostedA.getAgentInfoStack()[0].displayName, "Guide");
        assertEquals(hostedB.getAgentInfoStack()[0].displayName, "Operator");
        assertEquals(rootA === rootB, false);
        hostedA.dispose();
        hostedB.dispose();
    });
});

Deno.test("ensureRootAgentSession rejects a real replacement for a closed HostedSession", async () => {
    await withRuntimeCommandFixture("session-root-closed-", async ({ projectRoot }) => {
        const hostedSession = makeHostedRuntimeSession(projectRoot, "closed-before-build");
        hostedSession.dispose();

        await assertRejects(
            () => ensureRootAgentSession({ hostedSession, agentName: "operator" }),
            Error,
            'HostedSession "closed-before-build" is disposed',
        );
    });
});

sessionPromptTest("backend-neutral root message accessor reads Claude CLI messages", () => {
    const messages = /** @type {any[]} */ ([{ role: "assistant", content: "claude" }]);
    const root = { kind: "claude-cli", session: { getMessages: () => messages } };
    assertEquals(getRootExecutionMessages(/** @type {any} */ (root)), messages);
});

Deno.test("runRootTurn completes through the real root prompt machinery", async () => {
    await withRuntimeCommandFixture("session-root-turn-", async ({ projectRoot, setModelResponse }) => {
        setModelResponse("The real root turn completed.");
        const hostedSession = makeHostedRuntimeSession(projectRoot, "turn-root");
        const root = await ensureRootAgentSession({ hostedSession, agentName: AGENTS.GUIDE });

        const messages = await runRootTurn({
            hostedSession,
            agentName: AGENTS.GUIDE,
            userRequest: "Explain the fixture.",
        });

        assertEquals(JSON.stringify(messages).includes("The real root turn completed."), true);
        assertEquals(__getRootSessionMetadataForTests(root).rootTurnCount, 1);
        hostedSession.dispose();
    });
});

Deno.test("runIsolatedAgentSession keeps real disposable agents scoped to their HostedSessions", async () => {
    await withRuntimeCommandFixture("session-isolated-scope-", async ({ projectRoot, setModelMessages }) => {
        setModelMessages([
            fauxAssistantMessage(fauxText("Guide isolated response.")),
            fauxAssistantMessage(fauxText("Operator isolated response.")),
        ]);
        const hostedA = makeHostedRuntimeSession(projectRoot, "isolated-a");
        const hostedB = makeHostedRuntimeSession(projectRoot, "isolated-b");

        const guideMessages = await runIsolatedAgentSession({
            hostedSession: hostedA,
            agentName: "guide",
            userRequest: "isolated a",
        });
        const operatorMessages = await runIsolatedAgentSession({
            hostedSession: hostedB,
            agentName: "operator",
            userRequest: "isolated b",
        });

        assertEquals(JSON.stringify(guideMessages).includes("Guide isolated response."), true);
        assertEquals(JSON.stringify(operatorMessages).includes("Operator isolated response."), true);
        assertEquals(hostedA.getRootAgentName(), null);
        assertEquals(hostedB.getRootAgentName(), null);
        assertEquals(hostedA.getSubAgentSessions().size, 0);
        assertEquals(hostedB.getSubAgentSessions().size, 0);
        assertEquals(hostedA.getAgentInfoStack(), []);
        assertEquals(hostedB.getAgentInfoStack(), []);
        hostedA.dispose();
        hostedB.dispose();
    });
});

Deno.test("runIsolatedAgentSession clears its real child after an external model failure", async () => {
    await withRuntimeCommandFixture("session-isolated-error-", async ({ projectRoot, setModelResponseFactory }) => {
        setModelResponseFactory(() => {
            throw new Error("fixture model failed");
        });
        const hostedSession = makeHostedRuntimeSession(projectRoot, "isolated-error");

        const messages = await runIsolatedAgentSession({
            hostedSession,
            agentName: "guide",
            userRequest: "fail",
        });

        assertEquals(JSON.stringify(messages).includes("fixture model failed"), true);
        assertEquals(hostedSession.getActiveSteeringTargetSession(), null);
        assertEquals(hostedSession.getSubAgentSessions().size, 0);
        assertEquals(hostedSession.getAgentInfoStack(), []);
        hostedSession.dispose();
    });
});

Deno.test("runNonInteractiveAgentPrompt completes a real high-thinking disposable turn", async () => {
    await withRuntimeCommandFixture("session-non-interactive-", async ({ projectRoot, setModelResponse }) => {
        setModelResponse("Non-interactive response.");

        const messages = await runNonInteractiveAgentPrompt({
            cwd: projectRoot,
            agentName: "guide",
            userRequest: "inspect",
            thinkingLevelOverride: "high",
        });

        assertEquals(JSON.stringify(messages).includes("Non-interactive response."), true);
    });
});

Deno.test("runIsolatedAgentSession does not call the external model when already canceled", async () => {
    await withRuntimeCommandFixture("session-isolated-canceled-", async ({ projectRoot, setModelResponseFactory }) => {
        let modelCalls = 0;
        setModelResponseFactory(() => {
            modelCalls++;
            return fauxAssistantMessage(fauxText("unexpected"));
        });
        const hostedSession = makeHostedRuntimeSession(projectRoot, "isolated-canceled");
        const controller = new AbortController();
        controller.abort(new Error("cancel before start"));

        await assertRejects(
            () =>
                runIsolatedAgentSession({
                    hostedSession,
                    agentName: "guide",
                    userRequest: "do not start",
                    signal: controller.signal,
                }),
            Error,
            "cancel before start",
        );

        assertEquals(modelCalls, 0);
        assertEquals(hostedSession.getSubAgentSessions().size, 0);
        assertEquals(hostedSession.getAgentInfoStack(), []);
        hostedSession.dispose();
    });
});
