import { getCwd } from "../../constants.js";
import process from "node:process";
import { Type } from "typebox";
import {
    chmod as fsChmod,
    mkdir as fsMkdir,
    mkdtemp as fsMkdtemp,
    readFile as fsReadFile,
    rm as fsRm,
    writeFile as fsWriteFile,
} from "node:fs/promises";
import { test } from "node:test";
import { tmpdir } from "node:os";
import { assertEquals, assertRejects, assertStringIncludes } from "../../testing/assertions.ts";
import { fauxAssistantMessage, fauxText, fauxToolCall, type AssistantMessage } from "@earendil-works/pi-ai";
import {
    SessionManager,
    type AgentSessionEventListener,
    type CustomEntry,
    type ExtensionToolContext,
    type ProviderModelConfig,
    type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { basename, join } from "node:path";
import { AGENTS } from "../../constants.js";
import { loadAgentDef } from "./agents.ts";
import { withRuntimeCommandFixture } from "../../cmd/testing/runtime-command-fixture.ts";
import {
    __getRootSessionMetadataForTests,
    attachSessionEventSubscribers,
    assembleFinalSystemPrompt,
    assembleFinalSystemPromptWithContextProjection,
    buildAgentSession,
    ensureRootAgentSession,
    getEngineerCompactionThreshold,
    installEngineerAutoCompactionThreshold,
    readGlobalAgentMd,
    runIsolatedAgentSession,
    runNonInteractiveAgentPrompt,
    runPrompt,
    runRootTurn,
    shouldBypassAutoCompactionForAssistantMessage,
} from "./session.js";
import { HostedSession } from "./hosted-session.js";
import type { RequestAttemptEntry } from "./request-dispatch.ts";
import type { ImageAttachment } from "./types.js";
import { getRunWieldSessionDir } from "./root-session.ts";
import { RunawayLoopGuardStoppedError } from "./runaway-loop-guard.ts";
import { estimateContextTextTokens } from "./session-context-report.ts";
import { createMnemotecaTools } from "../../extensions/mnemoteca/tools.ts";
import { denoHelperBinaryExec } from "../../extensions/helper-binary-exec.ts";
import { defineCommittedGitFixture, git } from "../git-test-fixture.ts";

import { withProcessGlobalTestLock } from "../../testing/process-global-lock.ts";

type PromptTest = () => void | Promise<void>;
type CompactionMessage = Pick<AssistantMessage, "role" | "stopReason">;

type AttemptEntry = CustomEntry<Pick<RequestAttemptEntry, "phase" | "requestId">>;

type FixtureModel = Pick<ProviderModelConfig, "input">;

interface FixtureProvider {
    models: FixtureModel[];
}

interface FixtureModelConfig {
    providers: Record<string, FixtureProvider>;
}

function sessionPromptTest(name: string, fn: PromptTest) {
    test(name, () => withProcessGlobalTestLock(async () => await fn()));
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

    const withoutContext = await assembleFinalSystemPrompt(agentDef, [], [], getCwd());
    const withContext = await assembleFinalSystemPrompt(agentDef, [], [], getCwd(), "Greenfield note.");

    assertEquals(withoutContext.includes("### Project State"), false);
    assertStringIncludes(withContext, "### Project State\n\nGreenfield note.");
});

sessionPromptTest("assembleFinalSystemPrompt includes the Session naming reminder only while unnamed", async () => {
    const projectRoot = await fsMkdtemp(join(tmpdir(), "runwield-prompt-session-name-"));
    try {
        const reminder = "If this Session is unnamed, call `set_session_name` early with a short descriptive name.";
        const agentDef = await loadAgentDef(AGENTS.GUIDE, projectRoot);
        const sessionManager = SessionManager.inMemory(projectRoot);

        const unnamed = await assembleFinalSystemPrompt(agentDef, agentDef.tools, [], projectRoot, "", {
            sessionManager,
        });

        sessionManager.appendSessionInfo("router supplied name");
        const named = await assembleFinalSystemPrompt(agentDef, agentDef.tools, [], projectRoot, "", {
            sessionManager,
        });

        assertStringIncludes(unnamed, reminder);
        assertStringIncludes(unnamed, "set_session_name");
        assertEquals(named.includes(reminder), false);
        assertEquals(named.includes("{{SESSION_NAME_REMINDER}}"), false);
    } finally {
        await fsRm(projectRoot, { recursive: true }).catch(() => {});
    }
});

sessionPromptTest("assembleFinalSystemPrompt suppresses the Session naming reminder for sanitized names", async () => {
    const projectRoot = await fsMkdtemp(join(tmpdir(), "runwield-prompt-sanitized-session-name-"));
    try {
        const reminder = "If this Session is unnamed, call `set_session_name` early with a short descriptive name.";
        const agentDef = await loadAgentDef(AGENTS.GUIDE, projectRoot);
        const sessionManager = SessionManager.inMemory(projectRoot);
        sessionManager.appendSessionInfo("  router\n\tsupplied name  ");

        const prompt = await assembleFinalSystemPrompt(agentDef, agentDef.tools, [], projectRoot, "", {
            sessionManager,
        });

        assertEquals(prompt.includes(reminder), false);
        assertEquals(prompt.includes("{{SESSION_NAME_REMINDER}}"), false);
    } finally {
        await fsRm(projectRoot, { recursive: true }).catch(() => {});
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
        await fsRm(projectRoot, { recursive: true }).catch(() => {});
    }
});

sessionPromptTest("assembleFinalSystemPrompt includes Git branch and dirty state for Git projects", async () => {
    const projectRoot = await promptGitFixture.checkout({ prefix: "runwield-prompt-git-dirty-" });
    try {
        await fsWriteFile(join(projectRoot, "dirty.txt"), "changed\n");
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
        await fsRm(projectRoot, { recursive: true }).catch(() => {});
    }
});

sessionPromptTest("assembleFinalSystemPrompt omits Git state outside Git projects", async () => {
    const projectRoot = await fsMkdtemp(join(tmpdir(), "runwield-prompt-non-git-"));
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
        await fsRm(projectRoot, { recursive: true }).catch(() => {});
    }
});

sessionPromptTest("assembleFinalSystemPromptWithContextProjection attributes resident context", async () => {
    const tempHome = await fsMkdtemp(join(tmpdir(), "runwield-context-home-"));
    const projectRoot = await fsMkdtemp(join(tmpdir(), "runwield-context-project-"));
    const localSkillDir = join(projectRoot, ".wld", "skills", "visible-skill");
    const hiddenSkillDir = join(projectRoot, ".wld", "skills", "hidden-skill");
    try {
        await fsMkdir(join(tempHome, ".wld"), { recursive: true });
        await fsWriteFile(join(tempHome, ".wld", "RUNWIELD.md"), "Global context instructions");
        await fsWriteFile(join(projectRoot, "RUNWIELD.md"), "Project context instructions");
        await fsMkdir(localSkillDir, { recursive: true });
        await fsWriteFile(
            join(localSkillDir, "SKILL.md"),
            ["---", "name: visible-skill", "description: Visible skill", "---", "Full skill body"].join("\n"),
        );
        await fsMkdir(hiddenSkillDir, { recursive: true });
        await fsWriteFile(
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
            {
                name: "test",
                displayName: "Test",
                description: "Test agent",
                model: "",
                tools: [],
                systemPrompt:
                    "Agent instructions {{AVAILABLE_TOOLS}} {{GLOBAL_AGENTSMD}} {{PROJECT_AGENTSMD}} {{MEMORIES}} {{SKILLS}} {{PROJECT_STATE_CONTEXT}} {{IMAGE_ATTACHMENTS_SECTION}} {{BUNDLED_AGENT_DEFS_DIR}}",
            },
            ["read", "custom_tool"],
            [
                {
                    name: "custom_tool",
                    label: "Custom Tool",
                    description: "Custom tool with schema",
                    promptSnippet: "custom_tool(value): use schema-backed custom tool",
                    parameters: Type.Object({
                        value: Type.String({ description: "Important schema-only value details" }),
                    }),
                    execute: () => {
                        throw new Error("Prompt projection must not execute the custom tool");
                    },
                },
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
        assertEquals(
            projection.instructionFiles.map((file) => file.source),
            ["home", "local"],
        );
        assertEquals(
            projection.skills.some((skill) => skill.name === "visible-skill"),
            true,
        );
        assertEquals(
            projection.skills.some((skill) => skill.name === "hidden-skill"),
            false,
        );
        const customToolItem = projection.categories
            .find((category) => category.id === "tools")
            ?.items?.find((item) => item.name === "custom_tool");
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
        assertEquals(
            projection.categories.some((category) => category.id === "tools" && category.tokens > 0),
            true,
        );
    } finally {
        await fsRm(tempHome, { recursive: true }).catch(() => {});
        await fsRm(projectRoot, { recursive: true }).catch(() => {});
    }
});

sessionPromptTest("core memories stored from the checkout are injected into its worktree prompt", async () => {
    const projectRoot = await promptGitFixture.checkout();
    const worktreeParent = await fsMkdtemp(join(tmpdir(), "runwield-memory-worktree-"));
    const worktree = join(worktreeParent, "feature");
    const fakeBin = join(projectRoot, "fake-bin");
    const commandLog = join(projectRoot, "mnemoteca-command.log");
    const memoryFile = join(projectRoot, "fixture-memory.txt");
    const previousPath = process.env["PATH"];
    const pathSeparator = process.platform === "win32" ? ";" : ":";
    try {
        await git(projectRoot, ["worktree", "add", "-b", "memory-feature", worktree]);
        await fsMkdir(fakeBin);
        const executable = join(fakeBin, "mnemoteca");
        await fsWriteFile(
            executable,
            `#!/usr/bin/env bash
set -euo pipefail
printf 'args=%s\n' "$*" >> '${commandLog}'
[[ "$2" == '--name' && "$3" == '${basename(projectRoot)}' ]] || exit 64
case "$1" in
  init) ;;
  add) printf '%s\n' "\${@: -1}" > '${memoryFile}' ;;
  list) [[ "$*" == 'list --name ${basename(projectRoot)} -t core -f plain' ]] || exit 64
        cat '${memoryFile}' ;;
  *) exit 64 ;;
esac
`,
        );
        await fsChmod(executable, 0o755);
        process.env["PATH"] = previousPath ? `${fakeBin}${pathSeparator}${previousPath}` : fakeBin;
        const [memoryTool] = createMnemotecaTools({ cwd: projectRoot, exec: denoHelperBinaryExec });
        await memoryTool.execute(
            "store-core",
            { action: "store", content: "Core memory from Mnemoteca\nSecond core memory", core: true },
            new AbortController().signal,
            () => {},
            {} as ExtensionToolContext,
        );

        const { prompt, projection } = await assembleFinalSystemPromptWithContextProjection(
            {
                name: "test",
                displayName: "Test",
                description: "Test agent",
                model: "",
                tools: [],
                systemPrompt: "Agent instructions {{MEMORIES}}",
            },
            [],
            [],
            worktree,
        );

        assertStringIncludes(prompt, "Core memory from Mnemoteca");
        assertStringIncludes(prompt, "Second core memory");
        assertStringIncludes(
            await fsReadFile(commandLog, "utf8"),
            `args=list --name ${basename(projectRoot)} -t core -f plain\n`,
        );
        const coreMemoryItem = projection.categories.find((category) => category.id === "core_memories")?.items?.[0];
        assertEquals(coreMemoryItem?.source, "mnemoteca");
        assertEquals(coreMemoryItem?.label, "Core Memories");
    } finally {
        if (previousPath === undefined) delete process.env["PATH"];
        else process.env["PATH"] = previousPath;
        await fsRm(worktreeParent, { recursive: true }).catch(() => {});
        await fsRm(projectRoot, { recursive: true }).catch(() => {});
    }
});

sessionPromptTest("assembleFinalSystemPromptWithContextProjection excludes omitted placeholder context", async () => {
    const originalHome = process.env["HOME"];
    const tempHome = await fsMkdtemp(join(tmpdir(), "runwield-context-home-"));
    const projectRoot = await fsMkdtemp(join(tmpdir(), "runwield-context-project-"));
    const localSkillDir = join(projectRoot, ".wld", "skills", "visible-skill");
    try {
        process.env["HOME"] = tempHome;
        await fsMkdir(join(tempHome, ".wld"), { recursive: true });
        await fsWriteFile(join(tempHome, ".wld", "RUNWIELD.md"), "Global context instructions");
        await fsWriteFile(join(projectRoot, "RUNWIELD.md"), "Project context instructions");
        await fsMkdir(localSkillDir, { recursive: true });
        await fsWriteFile(
            join(localSkillDir, "SKILL.md"),
            ["---", "name: visible-skill", "description: Visible skill", "---", "Full skill body"].join("\n"),
        );

        const { prompt, projection } = await assembleFinalSystemPromptWithContextProjection(
            {
                name: "test",
                displayName: "Test",
                description: "Test agent",
                model: "",
                tools: [],
                systemPrompt: "Bare agent instructions.",
            },
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
        assertEquals(
            projection.categories.some((category) => category.id === "project_state"),
            false,
        );
        assertEquals(
            projection.categories.some((category) => category.id === "skill_catalog"),
            false,
        );
        const agentItem = projection.categories.find((category) => category.id === "agent_instructions")?.items?.[0];
        const timezoneLine = `Timezone: ${Intl.DateTimeFormat().resolvedOptions().timeZone}`;
        assertEquals(
            agentItem?.tokens,
            estimateContextTextTokens(["Bare agent instructions.", timezoneLine].join("\n")),
        );
    } finally {
        if (originalHome === undefined) delete process.env["HOME"];
        else process.env["HOME"] = originalHome;
        await fsRm(tempHome, { recursive: true }).catch(() => {});
        await fsRm(projectRoot, { recursive: true }).catch(() => {});
    }
});

sessionPromptTest("readGlobalAgentMd falls back from ~/.wld/RUNWIELD.md to ~/.wld/AGENTS.md", async () => {
    const tempHome = await fsMkdtemp(join(tmpdir(), "runwield-agents-md-"));

    try {
        await fsMkdir(join(tempHome, ".wld"), { recursive: true });
        await fsWriteFile(join(tempHome, ".wld", "AGENTS.md"), "Global AGENTS fallback");

        const prompt = await readGlobalAgentMd(tempHome);

        assertEquals(prompt, "Global AGENTS fallback");
    } finally {
        await fsRm(tempHome, { recursive: true });
    }
});

sessionPromptTest("readGlobalAgentMd falls back to ~/.agents/AGENTS.md by default", async () => {
    const tempHome = await fsMkdtemp(join(tmpdir(), "runwield-agents-md-"));

    try {
        await fsMkdir(join(tempHome, ".agents"), { recursive: true });
        await fsWriteFile(join(tempHome, ".agents", "AGENTS.md"), "External AGENTS fallback");

        const prompt = await readGlobalAgentMd(tempHome);

        assertEquals(prompt, "External AGENTS fallback");
    } finally {
        await fsRm(tempHome, { recursive: true });
    }
});

sessionPromptTest("readGlobalAgentMd can disable ~/.agents/AGENTS.md fallback", async () => {
    const tempHome = await fsMkdtemp(join(tmpdir(), "runwield-agents-md-"));

    try {
        await fsMkdir(join(tempHome, ".agents"), { recursive: true });
        await fsWriteFile(join(tempHome, ".agents", "AGENTS.md"), "External AGENTS fallback");

        const prompt = await readGlobalAgentMd(tempHome, { includeExternal: false });

        assertEquals(prompt, "");
    } finally {
        await fsRm(tempHome, { recursive: true });
    }
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

test("runPrompt compacts Engineer before Pi's configured threshold", async () => {
    await withRuntimeCommandFixture(
        "runprompt-engineer-threshold-",
        async (fixture) => {
            const observations: string[] = [];
            await fsMkdir(join(fixture.projectRoot, ".wld"), { recursive: true });
            await fsWriteFile(
                join(fixture.projectRoot, ".wld/settings.json"),
                JSON.stringify({ compaction: { enabled: true, reserveTokens: 10, keepRecentTokens: 10 } }),
            );
            fixture.setModelResponseFactories([
                (context) => {
                    const isRequest = JSON.stringify(context.messages).includes("next task");
                    if (isRequest) observations.push("prompt");
                    return fauxAssistantMessage(
                        fauxText(isRequest ? "The request completed." : "The conversation was compacted."),
                    );
                },
                (context) => {
                    const isRequest = JSON.stringify(context.messages).includes("next task");
                    if (isRequest) observations.push("prompt");
                    return fauxAssistantMessage(
                        fauxText(isRequest ? "The request completed." : "The conversation was compacted."),
                    );
                },
                (context) => {
                    const isRequest = JSON.stringify(context.messages).includes("next task");
                    if (isRequest) observations.push("prompt");
                    return fauxAssistantMessage(
                        fauxText(isRequest ? "The request completed." : "The conversation was compacted."),
                    );
                },
            ]);
            const manager = SessionManager.create(fixture.projectRoot, join(fixture.homeDir, "sessions"));
            manager.appendMessage({
                role: "user",
                content: `Earlier task ${"context ".repeat(40)}`,
                timestamp: Date.now(),
            });
            manager.appendMessage(fauxAssistantMessage(fauxText("Earlier work completed.")));
            manager.appendMessage({
                role: "user",
                content: `Recent task ${"details ".repeat(40)}`,
                timestamp: Date.now(),
            });
            manager.appendMessage(fauxAssistantMessage(fauxText("Recent work completed.")));
            const built = await buildAgentSession({
                agentName: "engineer",
                cwd: fixture.projectRoot,
                toolNames: [],
                sessionManager: manager,
            });
            assertEquals(built.session.model?.contextWindow, 100);
            const subscriber = attachSessionEventSubscribers(built.session, built.agentDef);
            let tokens = 60;
            const unsubscribeCompactionEvents = built.session.subscribe((event) => {
                if (event.type === "compaction_start") observations.push(`compact:${event.reason}`);
                if (event.type === "compaction_end") tokens = 0;
            });
            built.session.getContextUsage = () => ({ tokens, contextWindow: 100, percent: tokens });

            try {
                await runPrompt({
                    ...built,
                    agentName: "engineer",
                    userRequest: "next task",
                    finalSystemPrompt: "system",
                    subscriberState: subscriber,
                });

                const thresholdCompactionIndex = observations.indexOf("compact:threshold");
                const promptIndex = observations.indexOf("prompt");
                assertEquals(thresholdCompactionIndex >= 0, true);
                assertEquals(promptIndex > thresholdCompactionIndex, true);
                assertEquals(
                    manager
                        .getBranch()
                        .some((entry) => entry.type === "custom" && entry.customType === "runwield.loop_guard_turn"),
                    true,
                );
            } finally {
                unsubscribeCompactionEvents();
                subscriber.unsubscribe();
                built.session.dispose();
            }
        },
        { contextWindow: 100 },
    );
});

sessionPromptTest("Engineer post-response compaction re-arms after new context growth", async () => {
    const calls: string[] = [];
    let tokens = 59;
    let listener: AgentSessionEventListener | undefined;
    const session = {
        model: { contextWindow: 100 },
        settingsManager: {
            getCompactionSettings: () => ({ enabled: true, reserveTokens: 10, keepRecentTokens: 10 }),
        },
        getContextUsage: () => ({ tokens, contextWindow: 100, percent: tokens }),
        subscribe: (callback: AgentSessionEventListener) => {
            listener = callback;
            return () => {};
        },
        _checkCompaction: (_message: CompactionMessage) => Promise.resolve(false),
        _runAutoCompaction: (reason: string, willRetry: boolean) => {
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
    };

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
    const calls: string[] = [];
    const session = {
        model: { contextWindow: 100 },
        settingsManager: {
            getCompactionSettings: () => ({ enabled: false, reserveTokens: 10, keepRecentTokens: 10 }),
        },
        getContextUsage: () => ({ tokens: 75, contextWindow: 100, percent: 75 }),
        subscribe: () => () => {},
        _checkCompaction: (_message: CompactionMessage) => Promise.resolve(false),
        _runAutoCompaction: () => {
            calls.push("compact");
            return Promise.resolve(true);
        },
    };

    installEngineerAutoCompactionThreshold(session, AGENTS.ENGINEER);
    await session._checkCompaction({ role: "assistant", stopReason: "stop" });

    assertEquals(calls, []);
});

test("runPrompt sends fallback image markers without raw image content to text-only model", async () => {
    await withRuntimeCommandFixture(
        "runprompt-text-image-fallback-",
        async (fixture) => {
            const modelsPath = join(fixture.homeDir, ".wld/models.json");
            const modelsConfig: FixtureModelConfig = JSON.parse(await fsReadFile(modelsPath, "utf8"));
            modelsConfig.providers["runtime-command-fixture"].models[0].input = ["text"];
            await fsWriteFile(modelsPath, JSON.stringify(modelsConfig));
            await fsMkdir(join(fixture.projectRoot, ".wld"), { recursive: true });
            await fsWriteFile(
                join(fixture.projectRoot, ".wld/settings.json"),
                JSON.stringify({ visionFallback: { model: "runtime-command-fixture/vision" } }),
            );
            let modelRequest = "";
            fixture.setModelResponseFactory((context) => {
                modelRequest = JSON.stringify(context.messages);
                return fauxAssistantMessage(fauxText("The image was described."));
            });
            const manager = SessionManager.create(fixture.projectRoot, join(fixture.homeDir, "sessions"));
            const built = await buildAgentSession({
                agentName: "operator",
                cwd: fixture.projectRoot,
                toolNames: [],
                sessionManager: manager,
            });
            assertEquals(built.session.model?.input, ["text"]);
            const subscriber = attachSessionEventSubscribers(built.session, built.agentDef);

            const images: ImageAttachment[] = [{ base64: "abc", mimeType: "image/png", ref: "attachment:123" }];

            try {
                await runPrompt({
                    ...built,
                    agentName: "operator",
                    userRequest: "please inspect",
                    finalSystemPrompt: "system",
                    images,
                    subscriberState: subscriber,
                });

                assertStringIncludes(modelRequest, "please inspect\\n\\n[Image attached: attachment:123 image/png]");
                assertEquals(modelRequest.includes("abc"), false);
                assertEquals(
                    manager
                        .getBranch()
                        .some((entry) => entry.type === "custom" && entry.customType === "runwield.loop_guard_turn"),
                    true,
                );
            } finally {
                subscriber.unsubscribe();
                built.session.dispose();
            }
        },
        { additionalModels: [{ id: "vision", name: "Vision fallback" }] },
    );
});

function makeHostedRuntimeSession(projectRoot: string, id: string) {
    const manager = SessionManager.create(projectRoot, getRunWieldSessionDir(projectRoot), { id: `${id}-manager` });
    return new HostedSession({ id, cwd: projectRoot, sessionManager: manager });
}

test("ensureRootAgentSession scopes real roots and transcripts to each HostedSession", async () => {
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

test("ensureRootAgentSession rejects a real replacement for a closed HostedSession", async () => {
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

test("runRootTurn completes through the real root prompt machinery", async () => {
    await withRuntimeCommandFixture("session-root-turn-", async ({ projectRoot, setModelResponse }) => {
        setModelResponse("The real root turn completed.");
        const hostedSession = makeHostedRuntimeSession(projectRoot, "turn-root");
        await ensureRootAgentSession({ hostedSession, agentName: AGENTS.GUIDE });

        const messages = await runRootTurn({
            hostedSession,
            agentName: AGENTS.GUIDE,
            userRequest: "Explain the fixture.",
        });

        assertEquals(JSON.stringify(messages).includes("The real root turn completed."), true);
        hostedSession.dispose();
    });
});

test("a runaway root turn is recorded as failed and a new instruction gets a fresh request", async () => {
    await withRuntimeCommandFixture("session-root-loop-guard-", async ({ projectRoot, setModelResponseFactories }) => {
        let modelCalls = 0;
        let toolCalls = 0;
        const repeatTool: ToolDefinition = {
            name: "repeat_tool",
            label: "Repeat tool",
            description: "Returns a stable synthetic result",
            parameters: { type: "object", properties: {} },
            execute: () => {
                toolCalls += 1;
                return Promise.resolve({
                    content: [{ type: "text", text: "stable result" }],
                    details: null,
                });
            },
        };
        setModelResponseFactories([
            () => {
                modelCalls += 1;
                return fauxAssistantMessage(fauxToolCall("repeat_tool", {}));
            },
            () => {
                modelCalls += 1;
                return fauxAssistantMessage(fauxToolCall("repeat_tool", {}));
            },
            () => {
                modelCalls += 1;
                return fauxAssistantMessage(fauxToolCall("repeat_tool", {}));
            },
            () => {
                modelCalls += 1;
                return fauxAssistantMessage(fauxText("Fresh instruction completed."));
            },
        ]);
        const hostedSession = makeHostedRuntimeSession(projectRoot, "root-loop-guard");
        const root = await ensureRootAgentSession({
            hostedSession,
            agentName: AGENTS.GUIDE,
            customTools: [repeatTool],
            toolNames: ["repeat_tool"],
        });

        try {
            await assertRejects(
                () =>
                    runRootTurn({
                        hostedSession,
                        agentName: AGENTS.GUIDE,
                        userRequest: "Use the synthetic repeat tool",
                    }),
                RunawayLoopGuardStoppedError,
            );
            assertEquals(modelCalls, 3);
            assertEquals(toolCalls, 3);
            const attempts = root.sessionManager
                .getBranch()
                .filter((entry) => entry.type === "custom" && entry.customType === "runwield.request_attempt")
                .map((entry) => (entry as AttemptEntry).data);
            assertEquals(attempts.at(-1)?.phase, "failed");

            const messages = await runRootTurn({
                hostedSession,
                agentName: AGENTS.GUIDE,
                userRequest: "Answer with a fresh synthetic instruction",
            });
            assertEquals(modelCalls, 4);
            assertStringIncludes(JSON.stringify(messages.at(-1)), "Fresh instruction completed.");
            const completedAttempts = root.sessionManager
                .getBranch()
                .filter((entry) => entry.type === "custom" && entry.customType === "runwield.request_attempt")
                .map((entry) => (entry as AttemptEntry).data);
            assertEquals(completedAttempts.at(-1)?.phase, "completed");
            assertEquals(completedAttempts.at(-1)?.requestId === attempts.at(-1)?.requestId, false);
        } finally {
            hostedSession.dispose();
        }
    });
});

test("runIsolatedAgentSession keeps real disposable agents scoped to their HostedSessions", async () => {
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

test("runIsolatedAgentSession clears its real child after an external model failure", async () => {
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

test("runNonInteractiveAgentPrompt completes a real high-thinking disposable turn", async () => {
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

test("runIsolatedAgentSession does not call the external model when already canceled", async () => {
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
