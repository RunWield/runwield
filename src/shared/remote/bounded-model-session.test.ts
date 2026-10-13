import { bashFixtureExecutable, bashFixturePath } from "../../../scripts/bash-fixture.ts";
import { captureForegroundProcess } from "../captured-process.ts";
import { serveHttp } from "../http-server.ts";
import {
    mkdir as fsMkdir,
    mkdtemp as fsMkdtemp,
    readFile as fsReadFile,
    rm as fsRm,
    writeFile as fsWriteFile,
} from "node:fs/promises";
import { test } from "node:test";
import { tmpdir } from "node:os";
import { ok as assert } from "node:assert/strict";
import { assertEquals, assertRejects, assertStringIncludes, assertThrows } from "../../testing/assertions.ts";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
    createAssistantMessageEventStream,
    createProvider,
    fauxAssistantMessage,
    fauxText,
    fauxToolCall,
    InMemoryCredentialStore,
    type ProviderStreams,
} from "@earendil-works/pi-ai";
import { getModelRegistry, getModelRuntime } from "../models/model-registry.ts";
import { expandPromptTemplate, listPromptTemplates, resolveModel } from "../session/session.js";
import { expandSkillRecord, listSkills } from "../session/skill-catalog.ts";
import { createBoundedRemoteModelSession, resolveBoundedRemoteModelSelection } from "./bounded-model-session.ts";
import { handleModelRequest, LocalModelBridge } from "./model-bridge.ts";
import type { RemoteMount } from "./sftp-mount.ts";

interface TestSettingsObject {
    [key: string]: string | TestSettingsObject;
}

test("bounded remote session refuses saved CLI identity before connecting", async () => {
    const root = await fsMkdtemp(join(tmpdir(), "portable-fixture-"));
    try {
        for (const provider of ["claude-cli", "agy-cli"]) {
            await assertRejects(
                () =>
                    createBoundedRemoteModelSession({
                        mount: { globalRoot: root, lost: new Promise<void>(() => {}), close: () => Promise.resolve() },
                        connection: { port: 12345, credential: "a".repeat(64) },
                        cwd: root,
                        provider,
                        modelId: provider === "claude-cli" ? "sonnet" : "gemini-3.1-pro",
                    }),
                Error,
                `Unsupported model execution backend "${provider}"`,
            );
            await assertRejects(
                () =>
                    createBoundedRemoteModelSession({
                        mount: { globalRoot: root, lost: new Promise<void>(() => {}), close: () => Promise.resolve() },
                        connection: { port: 12345, credential: "a".repeat(64) },
                        cwd: root,
                        modelOverride: `${provider}/${provider === "claude-cli" ? "sonnet" : "gemini-3.1-pro"}`,
                    }),
                Error,
                `Unsupported model execution backend "${provider}"`,
            );
        }
    } finally {
        await fsRm(root, { recursive: true });
    }
});

test("bounded remote Pi session reads its project through a tool and sends the result to the laptop model", async () => {
    const root = await fsMkdtemp(join(tmpdir(), "portable-fixture-"));
    const project = join(root, "remote-project");
    await fsMkdir(project);
    const sentinel = `remote-only-${crypto.randomUUID()}`;
    await fsWriteFile(join(project, "sentinel.txt"), sentinel);
    await fsWriteFile(join(project, "shot.png"), new Uint8Array([1, 2, 3]));
    const skillDir = join(root, "skills", "remote-sentinel");
    const scriptDir = join(skillDir, "scripts", "nested");
    await fsMkdir(scriptDir, { recursive: true });
    await fsWriteFile(
        join(skillDir, "SKILL.md"),
        "---\nname: remote-sentinel\ndescription: Read the remote project sentinel\n---\n" +
            "Run scripts/nested/read-sentinel.sh from this Skill directory to read the remote project sentinel. " +
            "The script uses its sibling format-result.sh.\n",
    );
    await fsWriteFile(
        join(scriptDir, "read-sentinel.sh"),
        '#!/bin/sh\nset -eu\n. ./scripts/nested/format-result.sh\nprintf "%s:%s\\n" "$RESULT_PREFIX" "$(cat "$1")"\n',
    );
    await fsWriteFile(join(scriptDir, "format-result.sh"), 'RESULT_PREFIX="skill-sibling-result"\n');
    const scriptResult = `skill-sibling-result:${sentinel}`;
    await fsMkdir(join(root, "prompts"));
    await fsWriteFile(
        join(root, "prompts", "remote-report.md"),
        "---\ndescription: Report the remote project sentinel\n---\n" +
            "Use the remote-sentinel Skill and report the result from its nested script.\n",
    );
    await fsMkdir(join(project, ".wld", "agents"), { recursive: true });
    await fsWriteFile(join(root, "RUNWIELD.md"), "mounted-laptop-instructions");
    await fsWriteFile(join(project, "RUNWIELD.md"), "remote-project-instructions");
    await fsWriteFile(
        join(project, ".wld", "agents", "engineer.md"),
        "---\nname: Project Engineer\n---\nremote-project-agent-instructions\n",
    );
    await fsWriteFile(
        join(project, ".wld", "settings.json"),
        JSON.stringify({
            visionFallback: { model: "laptop-only/vision" },
            defaultProvider: "claude-cli",
            defaultModel: "sonnet",
            compaction: { enabled: true, reserveTokens: 100, keepRecentTokens: 1 },
        }),
    );
    const laptopSecret = `laptop-only-${crypto.randomUUID()}`;
    const contexts: string[] = [];
    const modelRequests: string[] = [];
    const summary = `Laptop summary: ${scriptResult}`;
    const turnSummary = "Laptop turn context: shot.png described using see_image";
    const stream: ProviderStreams["streamSimple"] = (model, context, options) => {
        const result = createAssistantMessageEventStream();
        contexts.push(JSON.stringify(context));
        modelRequests.push(model.id);
        const reply =
            contexts.length === 1
                ? fauxAssistantMessage(fauxToolCall("read_remote_sentinel", {}))
                : contexts.length === 2
                  ? fauxAssistantMessage(fauxText(`Received ${scriptResult}`))
                  : contexts.length === 3
                    ? fauxAssistantMessage(fauxToolCall("see_image", { imageRef: "shot.png" }))
                    : contexts.length === 4
                      ? fauxAssistantMessage(fauxText("remote vision description"))
                      : contexts.length === 5
                        ? fauxAssistantMessage(fauxText("Vision completed"))
                        : contexts.length === 6
                          ? fauxAssistantMessage(fauxText(summary))
                          : fauxAssistantMessage(fauxText(turnSummary));
        queueMicrotask(() => {
            if (options?.signal?.aborted) return;
            result.push({ type: "done", reason: "stop", message: reply });
            result.end();
        });
        return result;
    };
    const runtime = await ModelRuntime.create({
        credentials: new InMemoryCredentialStore(),
        modelsPath: null,
        allowModelNetwork: false,
        refreshOnCreate: false,
    });
    runtime.registerNativeProvider(
        createProvider({
            id: "laptop-only",
            name: "Laptop",
            models: [
                {
                    provider: "laptop-only",
                    id: "vision",
                    name: "Vision",
                    api: "openai-completions",
                    baseUrl: `https://${laptopSecret}.invalid`,
                    reasoning: false,
                    input: ["text", "image"],
                    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                    contextWindow: 1000,
                    maxTokens: 100,
                },
                {
                    provider: "laptop-only",
                    id: "allowed",
                    name: "Allowed",
                    api: "openai-completions",
                    baseUrl: `https://${laptopSecret}.invalid`,
                    headers: { Authorization: laptopSecret },
                    reasoning: false,
                    input: ["text"],
                    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                    contextWindow: 128000,
                    maxTokens: 100,
                },
            ],
            auth: {
                apiKey: {
                    name: "Local",
                    check: () => Promise.resolve({ type: "api_key" }),
                    resolve: () => Promise.resolve({ auth: {} }),
                },
            },
            api: { stream, streamSimple: stream },
        }),
    );
    await runtime.refresh({ allowNetwork: false });
    const bridge = new LocalModelBridge(runtime);
    const credential = "a".repeat(64);
    const server = serveHttp({ hostname: "127.0.0.1", port: 0, onListen() {} }, (request) =>
        request.headers.get("Authorization") === `Bearer ${credential}`
            ? handleModelRequest(bridge, request, new URL(request.url).pathname)
            : new Response(null, { status: 401 }),
    );
    const mount: RemoteMount = { globalRoot: root, lost: new Promise<void>(() => {}), close: () => Promise.resolve() };
    try {
        const connection = { port: server.addr.transport === "tcp" ? server.addr.port : 0, credential };
        const tool = {
            name: "read_remote_sentinel",
            label: "Read remote sentinel",
            description: "Run the nested Skill script against a file in the remote project",
            parameters: { type: "object", properties: {} },
            execute: async () => {
                const output = await captureForegroundProcess(bashFixtureExecutable(), {
                    args: ["scripts/nested/read-sentinel.sh", bashFixturePath(join(project, "sentinel.txt"))],
                    cwd: skillDir,
                });
                if (output.code !== 0) throw new Error(new TextDecoder().decode(output.stderr));
                return {
                    content: [{ type: "text" as const, text: new TextDecoder().decode(output.stdout).trimEnd() }],
                    details: null,
                };
            },
        };
        const { session, registry } = await createBoundedRemoteModelSession({
            mount,
            connection,
            cwd: project,
            provider: "laptop-only",
            modelId: "allowed",
            customTools: [tool],
        });
        try {
            assertEquals(session.model?.id, "allowed");
            assert(session.promptTemplates.some((template) => template.name === "remote-report"));
            assertEquals(
                registry
                    .getSelectable()
                    .map((item) => item.id)
                    .sort(),
                ["allowed", "vision"],
            );
            assertEquals(registry.find("anthropic", "claude-sonnet-4-5"), undefined);
            assertEquals((await registry.getApiKeyAndHeaders(registry.find("laptop-only", "allowed")!)).ok, false);
            assertThrows(() => getModelRegistry(), Error, "explicit control connection");
            assertThrows(() => getModelRuntime(), Error, "explicit control connection");
            for (const selection of ["claude-cli/sonnet", "agy-cli/gemini-3.1-pro"]) {
                await assertRejects(
                    () =>
                        resolveModel(
                            selection,
                            { name: "engineer" } as Parameters<typeof resolveModel>[1],
                            "engineer",
                            registry,
                            undefined,
                            project,
                        ),
                    Error,
                    "Unsupported model execution backend",
                );
            }
            await assertRejects(
                () =>
                    resolveModel(
                        undefined,
                        { name: "engineer" } as Parameters<typeof resolveModel>[1],
                        "engineer",
                        registry,
                        undefined,
                        project,
                    ),
                Error,
                "Unsupported model execution backend",
            );
            // Each project has its own real settings file. A valid catalog model in
            // the global default must not silently replace a strict CLI choice.
            const piDefault = { defaultProvider: "laptop-only", defaultModel: "allowed" };
            const agentDef = {
                name: "engineer",
                displayName: "Engineer",
                model: "laptop-only/allowed",
                description: "",
                systemPrompt: "",
                tools: [],
            };
            const check = async (
                label: string,
                globalSettings: TestSettingsObject,
                projectSettings: TestSettingsObject,
                selection: Omit<Parameters<typeof resolveBoundedRemoteModelSelection>[1], "cwd">,
                expectedError = "Unsupported model execution backend",
            ) => {
                const caseRoot = join(project, label);
                await fsMkdir(join(caseRoot, ".wld"), { recursive: true });
                await fsWriteFile(join(root, "settings.json"), JSON.stringify(globalSettings));
                await fsWriteFile(join(caseRoot, ".wld", "settings.json"), JSON.stringify(projectSettings));
                const resolve = () =>
                    resolveBoundedRemoteModelSelection(registry, { cwd: caseRoot, agentDef, ...selection });
                if (expectedError) await assertRejects(resolve, Error, expectedError);
                else assertEquals((await resolve()).id, "allowed");
            };
            await check("explicit", piDefault, {}, { modelOverride: "claude-cli/sonnet" });
            await check("saved-resume", piDefault, {}, { provider: "agy-cli", modelId: "gemini-3.1-pro" });
            await check("global-default", { defaultProvider: "claude-cli", defaultModel: "sonnet" }, {}, {});
            await check(
                "project-default",
                piDefault,
                { defaultProvider: "agy-cli", defaultModel: "gemini-3.1-pro" },
                {},
            );
            await check("global-agent", { ...piDefault, agents: { engineer: { model: "claude-cli/sonnet" } } }, {}, {});
            await check("project-agent", piDefault, { agents: { engineer: { model: "agy-cli/gemini-3.1-pro" } } }, {});
            await check(
                "global-preset",
                {
                    ...piDefault,
                    activeModelPreset: "remote",
                    modelPresets: { remote: { agents: { engineer: { model: "claude-cli/sonnet" } } } },
                },
                {},
                {},
            );
            await check(
                "project-preset",
                piDefault,
                {
                    activeModelPreset: "remote",
                    modelPresets: { remote: { agents: { engineer: { model: "agy-cli/gemini-3.1-pro" } } } },
                },
                {},
            );
            for (const name of ["delegated", "plan-engineer", "reviewer-feedback-engineer", "guide"]) {
                await check(
                    name,
                    piDefault,
                    { agents: { [name]: { model: "claude-cli/sonnet" } } },
                    {
                        agentName: name,
                        agentDef: { ...agentDef, name, displayName: name },
                    },
                );
            }
            await check(
                "repair-engineer-fallback",
                piDefault,
                {
                    agents: { engineer: { model: "agy-cli/gemini-3.1-pro" } },
                },
                {
                    agentName: "reviewer-feedback-engineer",
                    agentDef: { ...agentDef, name: "reviewer-feedback-engineer" },
                },
            );
            await check("definition", {}, {}, { agentDef: { ...agentDef, model: "agy-cli/gemini-3.1-pro" } });
            await check(
                "catalog-explicit",
                { defaultProvider: "claude-cli", defaultModel: "sonnet" },
                {},
                {
                    modelOverride: "laptop-only/allowed",
                },
                "",
            );
            await check("catalog-saved", piDefault, {}, { provider: "laptop-only", modelId: "allowed" }, "");
            await check("catalog-agent", piDefault, { agents: { engineer: { model: "laptop-only/allowed" } } }, {}, "");
            await check(
                "catalog-preset",
                piDefault,
                {
                    activeModelPreset: "remote",
                    modelPresets: { remote: { agents: { engineer: { model: "laptop-only/allowed" } } } },
                },
                {},
                "",
            );
            await check(
                "unknown-strict",
                piDefault,
                {},
                { modelOverride: "laptop-only/not-in-catalog" },
                "Unknown invocation model override",
            );
            const skill = (await listSkills({ cwd: project })).find((entry) => entry.name === "remote-sentinel");
            const template = (await listPromptTemplates({ cwd: project })).find(
                (entry) => entry.name === "remote-report",
            );
            assertEquals(skill?.source, "home");
            assertEquals(skill?.path, join(skillDir, "SKILL.md"));
            assertEquals(template?.source, "home");
            assertEquals(template?.path, join(root, "prompts", "remote-report.md"));
            if (!skill || !template) throw new Error("Mounted personal Skill or prompt template was not selected");
            const request = await expandSkillRecord(
                skill,
                await expandPromptTemplate(template.path, "Read the remote project sentinel and report it."),
            );
            await session.prompt(request);
            assertEquals(contexts.length, 2);
            assertStringIncludes(contexts[0], "mounted-laptop-instructions");
            assertStringIncludes(contexts[0], "remote-project-instructions");
            assertStringIncludes(contexts[0], "remote-project-agent-instructions");
            assertStringIncludes(contexts[0], JSON.stringify(join(skillDir, "SKILL.md")).slice(1, -1));
            assertStringIncludes(contexts[0], "Run scripts/nested/read-sentinel.sh from this Skill directory");
            assertStringIncludes(contexts[0], "Use the remote-sentinel Skill and report the result");
            assertStringIncludes(contexts[0], "Read the remote project sentinel and report it.");
            assertEquals(contexts[0].includes(sentinel), false);
            assertStringIncludes(contexts[1], scriptResult);
            assertStringIncludes(contexts[1], sentinel);
            assertStringIncludes(JSON.stringify(session.messages), scriptResult);
            await session.prompt("Describe shot.png using see_image");
            assertStringIncludes(contexts[3], btoa(String.fromCharCode(1, 2, 3)));
            assertStringIncludes(contexts[4], "remote vision description");

            const globalSettingsBefore = await fsReadFile(join(root, "settings.json"), "utf8");
            const projectSettingsBefore = await fsReadFile(join(project, ".wld", "settings.json"), "utf8");
            assertEquals(session.sessionFile, undefined);
            const next = await session.cycleModel("forward");
            assertEquals(next?.isScoped, false);
            assertEquals(next?.model.provider, "laptop-only");
            assertEquals(next?.model.id, "vision");
            assertEquals(session.model?.id, "vision");
            const previous = await session.cycleModel("forward");
            assertEquals(previous?.model.id, "allowed");
            assertEquals(session.model?.id, "allowed");
            assertEquals(await fsReadFile(join(root, "settings.json"), "utf8"), globalSettingsBefore);
            assertEquals(await fsReadFile(join(project, ".wld", "settings.json"), "utf8"), projectSettingsBefore);

            const result = await session.compact();
            assertStringIncludes(result.summary, summary);
            assertStringIncludes(result.summary, turnSummary);
            assertEquals(contexts.length, 7);
            assertEquals(modelRequests.slice(5), ["allowed", "allowed"]);
            assertStringIncludes(contexts[5], "<conversation>");
            assertStringIncludes(contexts[5], scriptResult);
            assertStringIncludes(contexts[6], "Describe shot.png using see_image");
            const compactions = session.sessionManager.getBranch().filter((entry) => entry.type === "compaction");
            assertEquals(compactions.length, 1);
            assertEquals(compactions[0].summary, result.summary);
            assertStringIncludes(JSON.stringify(session.messages), summary);
            assertEquals(session.sessionFile, undefined);
            assertEquals(await fsReadFile(join(root, "settings.json"), "utf8"), globalSettingsBefore);
            assertEquals(await fsReadFile(join(project, ".wld", "settings.json"), "utf8"), projectSettingsBefore);
            assert(
                !JSON.stringify({ contexts, messages: session.messages, catalog: await bridge.catalog() }).includes(
                    laptopSecret,
                ),
            );
        } finally {
            session.dispose();
        }
    } finally {
        bridge.close();
        await server.shutdown();
        await fsRm(root, { recursive: true });
    }
});
