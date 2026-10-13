import { realpath as fsRealpath } from "node:fs/promises";
import { delimiter } from "node:path";
import {
    removeExecutableFixtureDirectory,
    writeRuntimeExecutableFixture,
} from "../testing/runtime-executable-fixture.ts";
import {
    writeWorkflowBinaryFixtures,
    assertWorkflowBinaryCallsSupported,
} from "../testing/workflow-binary-fixtures.ts";
import { serveHttp } from "../shared/http-server.ts";
import { writeFileSync as fsWriteFileSync } from "node:fs";
import { test } from "node:test";
import {
    mkdir as fsMkdir,
    mkdtemp as fsMkdtemp,
    readFile as fsReadFile,
    rename as fsRename,
    stat as fsStat,
    symlink as fsSymlink,
    writeFile as fsWriteFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import process from "node:process";
import { ok as assert } from "node:assert/strict";
import { assertEquals, assertRejects, assertStringIncludes, assertThrows } from "../testing/assertions.ts";
import { dirname, join } from "node:path";
import { fileURLToPath as fromFileUrl } from "node:url";
import { PhotonImage } from "@silvia-odwyer/photon-node";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { Client } from "@modelcontextprotocol/sdk/client";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp";
import { getCwd, getHomeDir, SUBAGENTS } from "../constants.js";
import { withProcessGlobalTestLock } from "../testing/process-global-lock.ts";
import { __resetSettingsForTests, preserveRunWieldCustomSettingsForWrite } from "../shared/settings.js";
import { createImage, encodeCreatedImage } from "../shared/image-generation.ts";
import { persistImageAttachment } from "../shared/session/image-attachments.ts";
import { buildAgentSession, composeClaudeCliBridgedTools } from "../shared/session/session.js";
import { CLAUDE_CLI_MCP_PROVENANCE, startRunWieldMcpBridge } from "../shared/session/backends/claude-cli/mcp-bridge.ts";
import { resolveImageGenerationSettings } from "../shared/image-generation-settings.ts";
import type { ImageGenerationSettings } from "../shared/image-generation-settings.ts";
import { createImageTool } from "./create-image.ts";
import { loadAgentDef } from "../shared/session/agents.js";
import { loadSubAgentDefinition } from "../shared/session/subagent-definitions.ts";
import { resolveDelegatedToolNames } from "./delegate-agent.ts";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAQAAAACCAIAAADwyuo0AAAAEElEQVR4nGP4z8AARwzIHABvqgf5gNwAKAAAAABJRU5ErkJggg==";
const MODEL = "openrouter/google/gemini-3.1-flash-image";
const AGENT = { name: "fixture", displayName: "Fixture", model: MODEL, description: "Test agent", systemPrompt: "" };
const CLI_FIXTURE = fromFileUrl(
    new URL("../shared/session/backends/agy-cli/fixtures/fake-image-cli.ts", import.meta.url),
);
const CODEX_FIXTURE = fromFileUrl(new URL("../shared/image-generation/fixtures/fake-codex.ts", import.meta.url));

interface RequestPayload {
    model: string;
    temperature?: number;
    reasoning?: { effort: string };
    provider?: { require_parameters: boolean };
    messages: { content: { type: string; image_url?: { url: string } }[] }[];
    input?: { role: string; content: { type: string; image_url?: string }[] }[];
    tools?: { type: string; output_format: string }[];
    tool_choice?: { type: string };
}

interface Fixture {
    cwd: string;
    home: string;
    requests: RequestPayload[];
    settings(value: ImageGenerationSettings): Promise<void>;
    response: "image" | "text" | "invalid" | "multiple" | "unauthorized" | "model-denied" | "server-error" | "wait";
    onRequest?: () => void;
}

async function withFixture(run: (fixture: Fixture) => Promise<void>) {
    await withProcessGlobalTestLock(async () => {
        const home = getHomeDir();
        const cwd = getCwd();
        const path = process.env["PATH"];
        const temp = await fsMkdtemp(join(tmpdir(), "runwield-create-image-test-"));
        const envNames = [
            "RUNWIELD_IMAGE_FIXTURE_MODE",
            "RUNWIELD_IMAGE_FIXTURE_ARGS",
            "RUNWIELD_IMAGE_FIXTURE_OUTSIDE",
            "RUNWIELD_CODEX_IMAGE_MODE",
            "RUNWIELD_CODEX_IMAGE_LOG",
            "RUNWIELD_CODEX_IMAGE_OUTSIDE",
            "RUNWIELD_CODEX_IMAGE_START_GATE",
            "RUNWIELD_CODEX_IMAGE_PID",
        ];
        const prior = envNames.map((key) => process.env[key]);
        const fixture: Fixture = {
            cwd: join(temp, "project"),
            home: join(temp, "home"),
            requests: [],
            response: "image",
            async settings(value) {
                await fsWriteFile(
                    join(fixture.cwd, ".wld", "settings.json"),
                    JSON.stringify({ imageGeneration: value }),
                );
                __resetSettingsForTests();
            },
        };
        const server = serveHttp({ hostname: "127.0.0.1", port: 0, onListen() {} }, async (request) => {
            fixture.requests.push(await request.json());
            fixture.onRequest?.();
            if (fixture.response === "wait") {
                // A fully consumed request body need not expose a later client disconnect.
                await new Promise<void>((resolve) => setTimeout(resolve, 100));
            }
            if (fixture.response === "unauthorized") return new Response("unauthorized", { status: 401 });
            if (fixture.response === "model-denied") {
                return Response.json(
                    { error: { message: "Upstream request failed: Model access is disabled" } },
                    {
                        status: 403,
                    },
                );
            }
            if (fixture.response === "server-error") return new Response("provider unavailable", { status: 500 });
            if (new URL(request.url).pathname.endsWith("/responses")) {
                if (request.headers.get("authorization") !== "Bearer fixture-only") {
                    return Response.json(
                        { error: { message: "Missing configured provider credential" } },
                        {
                            status: 401,
                        },
                    );
                }
                const item = {
                    type: "image_generation_call",
                    status: "completed",
                    result: fixture.response === "invalid" ? "aGVsbG8=" : PNG,
                    output_format: "png",
                };
                return Response.json({
                    status: "completed",
                    output: fixture.response === "text" ? [] : fixture.response === "multiple" ? [item, item] : [item],
                });
            }
            const image = {
                image_url: { url: `data:image/png;base64,${fixture.response === "invalid" ? "aGVsbG8=" : PNG}` },
            };
            const images =
                fixture.response === "text" ? [] : fixture.response === "multiple" ? [image, image] : [image];
            return Response.json({ id: "fixture-image", choices: [{ message: { content: "fixture", images } }] });
        });
        try {
            await fsMkdir(join(fixture.home, ".wld"), { recursive: true });
            await fsMkdir(join(fixture.cwd, ".wld"), { recursive: true });
            process.env["HOME"] = fixture.home;
            process.chdir(fixture.cwd);
            await fsWriteFile(
                join(fixture.home, ".wld", "models.json"),
                JSON.stringify({
                    providers: {
                        openrouter: { baseUrl: `http://127.0.0.1:${server.addr.port}/v1`, apiKey: "fixture-only" },
                        opencode: {
                            baseUrl: `http://127.0.0.1:${server.addr.port}/v1`,
                            apiKey: "fixture-only",
                            models: [
                                {
                                    id: "image-supervisor",
                                    api: "openai-responses",
                                    reasoning: true,
                                    input: ["text", "image"],
                                },
                            ],
                        },
                        fixture: {
                            baseUrl: "https://example.invalid/v1",
                            api: "openai-completions",
                            apiKey: "fixture-only",
                            models: [
                                { id: "text", input: ["text"] },
                                { id: "vision", input: ["text", "image"] },
                            ],
                        },
                    },
                }),
            );
            await fixture.settings({ model: MODEL });
            const bin = await writeWorkflowBinaryFixtures(temp);
            await writeRuntimeExecutableFixture(join(bin, "agy"), CLI_FIXTURE);
            await writeRuntimeExecutableFixture(join(bin, "codex"), CODEX_FIXTURE);
            process.env["PATH"] = `${bin}${delimiter}${path || ""}`;
            await run(fixture);
            await assertWorkflowBinaryCallsSupported(temp);
        } finally {
            await server.shutdown();
            process.chdir(cwd);
            process.env["HOME"] = home;
            if (path === undefined) delete process.env["PATH"];
            else process.env["PATH"] = path;
            envNames.forEach((key, index) =>
                prior[index] === undefined ? delete process.env[key] : (process.env[key] = prior[index]!),
            );
            __resetSettingsForTests();
            await removeExecutableFixtureDirectory(temp);
        }
    });
}

test("create_image uses the real Pi adapter, mapped options, reference input and exact output path", () =>
    withFixture(async (f) => {
        await f.settings({ model: MODEL, thinkingLevel: "high", temperature: 0 });
        await fsWriteFile(
            join(f.cwd, "source.png"),
            Uint8Array.from(atob(PNG), (c) => c.charCodeAt(0)),
        );
        const result = await createImage({
            cwd: f.cwd,
            prompt: "Make it blue",
            outputPath: "assets/result.png",
            imageRefs: ["source.png"],
        });
        assertEquals(result.path, join("assets", "result.png"));
        assertEquals([result.width, result.height], [4, 2]);
        assertEquals(f.requests.length, 1);
        assertEquals(f.requests[0].temperature, 0);
        assertEquals(f.requests[0].reasoning, { effort: "high" });
        assertEquals(f.requests[0].provider, { require_parameters: true });
        assertEquals(f.requests[0].messages[0].content[1].image_url?.url, `data:image/png;base64,${PNG}`);
        const decoded = PhotonImage.new_from_byteslice(await fsReadFile(join(f.cwd, result.path)));
        assertEquals(decoded.get_width(), 4);
        decoded.free();
    }));

test("create_image converts PNG bytes to the requested JPEG or WebP instead of relabeling", () =>
    withFixture(async (f) => {
        for (const extension of ["jpg", "webp"]) {
            const result = await createImage({ cwd: f.cwd, prompt: "red mug", outputPath: `image.${extension}` });
            const bytes = await fsReadFile(join(f.cwd, result.path));
            if (extension === "jpg") assertEquals([...bytes.slice(0, 2)], [255, 216]);
            else assertEquals(new TextDecoder().decode(bytes.slice(8, 12)), "WEBP");
            const decoded = PhotonImage.new_from_byteslice(bytes);
            assertEquals(decoded.get_width(), 4);
            decoded.free();
        }
    }));

test("create_image rejects existing, escaping and symlink paths before calling Pi", () =>
    withFixture(async (f) => {
        await fsWriteFile(join(f.cwd, "existing.png"), "user data");
        await fsSymlink(f.home, join(f.cwd, "outside"));
        for (const outputPath of ["existing.png", "../escape.png", "outside/image.png", "file.txt"]) {
            await assertRejects(() => createImage({ cwd: f.cwd, prompt: "red", outputPath }));
        }
        assertEquals(await fsReadFile(join(f.cwd, "existing.png"), "utf8"), "user data");
        assertEquals(f.requests.length, 0);
    }));

test("create_image refuses no-image, invalid bytes, multiple images and provider errors without retrying", () =>
    withFixture(async (f) => {
        for (const mode of ["text", "invalid", "multiple", "unauthorized", "server-error"] as const) {
            f.response = mode;
            await assertRejects(() => createImage({ cwd: f.cwd, prompt: "red", outputPath: `${mode}.png` }));
            await assertRejects(() => fsStat(join(f.cwd, `${mode}.png`)), Error, "ENOENT");
        }
        f.response = "model-denied";
        await assertRejects(
            () => createImage({ cwd: f.cwd, prompt: "red", outputPath: "denied.png" }),
            Error,
            "Model access is disabled",
        );
        await assertRejects(() => fsStat(join(f.cwd, "denied.png")), Error, "ENOENT");
        assertEquals(f.requests.length, 6);
    }));

test("create_image rejects unsupported options and vision-only models", () =>
    withFixture(async (f) => {
        for (const settings of [
            { model: "openrouter/google/gemini-2.5-flash-image", thinkingLevel: "high" },
            { model: MODEL, thinkingLevel: "medium" },
            { model: MODEL, temperature: 3 },
            { model: "openrouter/black-forest-labs/flux.2-pro", temperature: 1 },
            { model: "google/gemini-3.1-pro" },
            { model: "agy-cli/gemini-3.8-flash", temperature: 1 },
        ]) {
            await f.settings(settings);
            await assertRejects(() => createImage({ cwd: f.cwd, prompt: "red", outputPath: "result.png" }));
        }
        assertEquals(f.requests.length, 0);
    }));

test("imageGeneration preserves settings and resets inherited options when the model changes", () =>
    withFixture(async (f) => {
        assertEquals(
            JSON.parse(
                preserveRunWieldCustomSettingsForWrite(JSON.stringify({ imageGeneration: { model: MODEL } }), "{}"),
            ),
            { imageGeneration: { model: MODEL } },
        );
        await fsWriteFile(
            join(f.home, ".wld", "settings.json"),
            JSON.stringify({ imageGeneration: { model: MODEL, temperature: 0.5, thinkingLevel: "high" } }),
        );
        await f.settings({ model: "agy-cli/gemini-3.8-flash" });
        assertEquals(resolveImageGenerationSettings(f.cwd), { model: "agy-cli/gemini-3.8-flash" });
        await fsWriteFile(
            join(f.cwd, ".wld", "settings.json"),
            JSON.stringify({
                imageGeneration: { model: MODEL },
                activeModelPreset: "images",
                modelPresets: {
                    images: { imageGeneration: { model: "agy-cli/gemini-3.1-pro", thinkingLevel: "low" } },
                },
            }),
        );
        __resetSettingsForTests();
        assertEquals(resolveImageGenerationSettings(f.cwd), { model: "agy-cli/gemini-3.1-pro", thinkingLevel: "low" });
        await f.settings({ model: MODEL, enabled: false });
        assertEquals(resolveImageGenerationSettings(f.cwd), undefined);
        await fsWriteFile(
            join(f.cwd, ".wld", "settings.json"),
            JSON.stringify({ imageGeneration: { model: MODEL, thinkingLvel: "high" } }),
        );
        __resetSettingsForTests();
        assertThrows(() => resolveImageGenerationSettings(f.cwd), Error, "thinkingLvel");
    }));

test("create_image routes agy-cli to a real subprocess with matching model/effort and saves PNG", () =>
    withFixture(async (f) => {
        await f.settings({ model: "agy-cli/gemini-3.8-flash", thinkingLevel: "medium" });
        const argsPath = join(f.cwd, "args.json");
        process.env["RUNWIELD_IMAGE_FIXTURE_ARGS"] = argsPath;
        const result = await createImage({ cwd: f.cwd, prompt: "red mug", outputPath: "agy.png" });
        const args: string[] = JSON.parse(await fsReadFile(argsPath, "utf8"));
        assertEquals(args[args.indexOf("--model") + 1], "gemini-3.8-flash-medium");
        assertEquals(args[args.indexOf("--effort") + 1], "medium");
        assert(!args.includes("--dangerously-skip-permissions"));
        assert(args.includes("--json-schema"));
        assertEquals(result.model, "agy-cli/gemini-3.8-flash");
        assertEquals(result.width, 4);
        assertEquals(f.requests.length, 0);
    }));

test("create_image does not trust Agy final SUCCESS or paths from other runs", () =>
    withFixture(async (f) => {
        await f.settings({ model: "agy-cli/gemini-3.8-flash" });
        process.env["RUNWIELD_IMAGE_FIXTURE_OUTSIDE"] = join(f.cwd, "existing.png");
        await fsWriteFile(
            join(f.cwd, "existing.png"),
            Uint8Array.from(atob(PNG), (c) => c.charCodeAt(0)),
        );
        for (const mode of ["false-success", "outside"]) {
            process.env["RUNWIELD_IMAGE_FIXTURE_MODE"] = mode;
            await assertRejects(() => createImage({ cwd: f.cwd, prompt: "red", outputPath: `${mode}.png` }));
            await assertRejects(() => fsStat(join(f.cwd, `${mode}.png`)), Error, "ENOENT");
        }
    }));

test("create_image tool returns text-only metadata when the primary model cannot view images", () =>
    withFixture(async (f) => {
        const tool = createImageTool({ cwd: f.cwd, includeImage: false });
        const result = await tool.execute(
            "fixture",
            { prompt: "red", outputPath: "result.png" },
            undefined,
            undefined,
            {} as never,
        );
        assertEquals(result.content.length, 1);
        assertEquals(result.details?.ok, true);
        assertStringIncludes(result.content[0].type === "text" ? result.content[0].text : "", "result.png");
    }));

test("create_image honors pre-cancellation without generating or saving", () =>
    withFixture(async (f) => {
        await assertRejects(() =>
            createImage({ cwd: f.cwd, prompt: "red", outputPath: "cancelled.png", signal: AbortSignal.abort() }),
        );
        assertEquals(f.requests.length, 0);
        await assertRejects(() => fsStat(join(f.cwd, "cancelled.png")), Error, "ENOENT");
    }));

test("create_image rejects mismatched raster MIME and symlinked reference escapes", () =>
    withFixture(async (f) => {
        assertThrows(() => encodeCreatedImage({ type: "image", data: PNG, mimeType: "image/jpeg" }, "image/jpeg"));
        await fsWriteFile(
            join(f.home, "private.png"),
            Uint8Array.from(atob(PNG), (c) => c.charCodeAt(0)),
        );
        await fsSymlink(join(f.home, "private.png"), join(f.cwd, "source.png"));
        await assertRejects(
            () =>
                createImage({
                    cwd: f.cwd,
                    prompt: "red",
                    outputPath: "result.png",
                    imageRefs: ["source.png"],
                }),
            Error,
            "symlink",
        );
        assertEquals(f.requests.length, 0);
    }));

test("create_image cancels an in-flight Pi request without saving or retrying", () =>
    withFixture(async (f) => {
        const abort = new AbortController();
        f.response = "wait";
        f.onRequest = () => abort.abort();
        await assertRejects(() =>
            createImage({
                cwd: f.cwd,
                prompt: "red",
                outputPath: "cancelled.png",
                signal: abort.signal,
            }),
        );
        assertEquals(f.requests.length, 1);
        await assertRejects(() => fsStat(join(f.cwd, "cancelled.png")), Error, "ENOENT");
    }));

test("create_image cancels a running Agy subprocess without saving", () =>
    withFixture(async (f) => {
        await f.settings({ model: "agy-cli/gemini-3.8-flash" });
        const argsPath = join(f.cwd, "args.json");
        process.env["RUNWIELD_IMAGE_FIXTURE_ARGS"] = argsPath;
        process.env["RUNWIELD_IMAGE_FIXTURE_MODE"] = "wait";
        const abort = new AbortController();
        const pending = assertRejects(() =>
            createImage({
                cwd: f.cwd,
                prompt: "red",
                outputPath: "cancelled.png",
                signal: abort.signal,
            }),
        );
        try {
            const deadline = Date.now() + 5000;
            while (!(await fsStat(argsPath).catch(() => null))) {
                if (Date.now() > deadline) throw new Error("Agy fixture did not start");
                await new Promise((resolve) => setTimeout(resolve, 10));
            }
        } finally {
            abort.abort();
            await pending;
        }
        await assertRejects(() => fsStat(join(f.cwd, "cancelled.png")), Error, "ENOENT");
    }));

test("create_image refuses a destination created while generation was in flight", () =>
    withFixture(async (f) => {
        f.onRequest = () => fsWriteFileSync(join(f.cwd, "result.png"), "user data");
        await assertRejects(() => createImage({ cwd: f.cwd, prompt: "red", outputPath: "result.png" }));
        assertEquals(await fsReadFile(join(f.cwd, "result.png"), "utf8"), "user data");
    }));

test("Claude receives create_image through the real MCP bridge with Session references and image results", () =>
    withFixture(async (f) => {
        const sessionManager = SessionManager.inMemory(f.cwd);
        const attachment = await persistImageAttachment({ base64: PNG, mimeType: "image/png" }, sessionManager, f.cwd);
        const tools = await composeClaudeCliBridgedTools({
            agentDef: { ...AGENT, tools: ["create_image"] },
            agentName: "fixture",
            hostedSession: null,
            triageMeta: undefined,
            cwd: f.cwd,
            sessionManager,
            mcpRootTools: [],
        });
        const bridge = await startRunWieldMcpBridge({
            tools,
            cwd: f.cwd,
            sessionManager,
            assistantBase: { api: "anthropic-messages", provider: "anthropic", model: "fixture" },
            provenance: CLAUDE_CLI_MCP_PROVENANCE,
        });
        const transport = new StreamableHTTPClientTransport(new URL(bridge.url), {
            requestInit: { headers: { Authorization: `Bearer ${bridge.token}` } },
        });
        const client = new Client({ name: "create-image-test", version: "1" });
        try {
            await client.connect(transport);
            assert((await client.listTools()).tools.some((tool) => tool.name === "create_image"));
            const result = await client.callTool({
                name: "create_image",
                arguments: { prompt: "make blue", outputPath: "mcp.png", imageRefs: [attachment.ref] },
            });
            assert(!result.isError);
            assert(Array.isArray(result.content) && result.content.some((block) => block.type === "image"));
            assert((await fsStat(join(f.cwd, "mcp.png"))).isFile());
            assertEquals(f.requests[0].messages[0].content[1].image_url?.url, `data:image/png;base64,${PNG}`);
        } finally {
            await client.close();
            await transport.close();
            await bridge.close();
        }
    }));

test("create_image is available only to configured image or file-writing agents", () =>
    withFixture(async (f) => {
        for (const names of [["read"], ["write"], ["multi_file_edit"], ["create_image"]]) {
            const tools = await composeClaudeCliBridgedTools({
                agentDef: { ...AGENT, tools: names },
                agentName: "fixture",
                hostedSession: null,
                triageMeta: undefined,
                cwd: f.cwd,
                mcpRootTools: [],
            });
            assertEquals(
                tools.some((tool) => tool.name === "create_image"),
                names[0] !== "read",
            );
        }
        await f.settings({ model: MODEL, enabled: false });
        const tools = await composeClaudeCliBridgedTools({
            agentDef: { ...AGENT, tools: ["write"] },
            agentName: "fixture",
            hostedSession: null,
            triageMeta: undefined,
            cwd: f.cwd,
            mcpRootTools: [],
        });
        assert(!tools.some((tool) => tool.name === "create_image"));
    }));

test("Pi Sessions inject create_image for writers and respect the primary model's image capability", () =>
    withFixture(async (f) => {
        for (const model of ["text", "vision"]) {
            const built = await buildAgentSession({
                cwd: f.cwd,
                agentName: "operator",
                modelOverride: `fixture/${model}`,
                toolNames: ["write"],
            });
            try {
                assert(built.tools.includes("create_image"));
                const tool = built.finalCustomTools.find((tool) => tool.name === "create_image");
                assert(tool);
                const result = await tool.execute(
                    "fixture",
                    { prompt: "red", outputPath: `${model}.png` },
                    undefined,
                    undefined,
                    {} as never,
                );
                assertEquals(
                    result.content.some((block) => block.type === "image"),
                    model === "vision",
                );
                assert((await fsStat(join(f.cwd, `${model}.png`))).isFile());
            } finally {
                built.session.dispose();
            }
        }
        const reader = await buildAgentSession({
            cwd: f.cwd,
            agentName: "operator",
            modelOverride: "fixture/text",
            toolNames: ["read"],
        });
        try {
            assert(!reader.tools.includes("create_image"));
            assert(!reader.finalCustomTools.some((tool) => tool.name === "create_image"));
        } finally {
            reader.session.dispose();
        }
    }));

test("Guide and write delegates get configured image tools in Pi and MCP; read delegates never inherit them", () =>
    withFixture(async (f) => {
        const guide = await loadAgentDef("guide", f.cwd);
        assert(guide.tools.includes("create_image"));
        assert(!guide.tools.some((name) => ["write", "edit", "multi_file_edit"].includes(name)));
        const targets = [
            {
                agentName: "guide",
                definition: guide,
                subAgentDefinition: undefined,
                toolNames: guide.tools,
                eligible: true,
            },
            ...(await Promise.all(
                (["write", "read"] as const).map(async (mode) => {
                    const id = mode === "write" ? SUBAGENTS.DELEGATED : SUBAGENTS.DELEGATED_READ;
                    const definition = await loadSubAgentDefinition(id);
                    assertEquals(definition.tools.includes("create_image"), mode === "write");
                    return {
                        agentName: definition.name,
                        definition,
                        subAgentDefinition: { id },
                        toolNames: resolveDelegatedToolNames(["read", "write", "create_image"], mode),
                        eligible: mode === "write",
                    };
                }),
            )),
        ];
        for (const enabled of [true, false]) {
            await f.settings({ model: MODEL, enabled });
            for (const target of targets) {
                const built = await buildAgentSession({
                    cwd: f.cwd,
                    agentName: target.agentName,
                    modelOverride: "fixture/text",
                    subAgentDefinition: target.subAgentDefinition,
                    toolNames: target.toolNames,
                });
                try {
                    assertEquals(
                        built.finalCustomTools.some((tool) => tool.name === "create_image"),
                        enabled && target.eligible,
                    );
                } finally {
                    built.session.dispose();
                }
                const bridged = await composeClaudeCliBridgedTools({
                    agentDef: { ...target.definition, tools: target.toolNames },
                    agentName: target.agentName,
                    hostedSession: null,
                    triageMeta: undefined,
                    cwd: f.cwd,
                    mcpRootTools: [],
                });
                assertEquals(
                    bridged.some((tool) => tool.name === "create_image"),
                    enabled && target.eligible,
                );
            }
        }
    }));

test("OpenCode adapter uses existing provider config with the hosted image tool and reference bytes", () =>
    withFixture(async (f) => {
        await f.settings({ model: "opencode/image-supervisor", thinkingLevel: "low" });
        await fsWriteFile(
            join(f.cwd, "source.png"),
            Uint8Array.from(atob(PNG), (c) => c.charCodeAt(0)),
        );
        const image = await createImage({
            cwd: f.cwd,
            prompt: "make blue",
            outputPath: "opencode.webp",
            imageRefs: ["source.png"],
        });
        assertEquals(image.model, "opencode/image-supervisor");
        assertEquals(image.mimeType, "image/webp");
        assertEquals(f.requests[0].reasoning, { effort: "low" });
        assertEquals(f.requests[0].tools, [{ type: "image_generation", output_format: "png" }]);
        assertEquals(f.requests[0].tool_choice, { type: "image_generation" });
        assertEquals(f.requests[0].input?.[0].content[1].image_url, `data:image/png;base64,${PNG}`);
    }));

test("OpenCode adapter rejects denied, image-free and malformed responses without fallback or retries", () =>
    withFixture(async (f) => {
        await f.settings({ model: "opencode/image-supervisor" });
        for (const response of ["unauthorized", "text", "multiple", "invalid", "server-error"] as const) {
            f.response = response;
            await assertRejects(() => createImage({ cwd: f.cwd, prompt: "red", outputPath: `${response}.png` }));
            await assertRejects(() => fsStat(join(f.cwd, `${response}.png`)), Error, "ENOENT");
        }
        assertEquals(f.requests.length, 5);
    }));

test("OpenCode adapter preserves cancellation and rejects unsupported controls before requesting", () =>
    withFixture(async (f) => {
        for (const options of [{ temperature: 1 }, { thinkingLevel: "ultra" }]) {
            await f.settings({ model: "opencode/image-supervisor", ...options });
            await assertRejects(() => createImage({ cwd: f.cwd, prompt: "red", outputPath: "invalid.png" }));
        }
        assertEquals(f.requests.length, 0);
        await f.settings({ model: "opencode/image-supervisor" });
        const abort = new AbortController();
        f.onRequest = () => abort.abort();
        f.response = "wait";
        await assertRejects(() =>
            createImage({ cwd: f.cwd, prompt: "red", outputPath: "cancelled.png", signal: abort.signal }),
        );
        await assertRejects(() => fsStat(join(f.cwd, "cancelled.png")), Error, "ENOENT");
    }));

interface RecordedCodexRequest {
    method: string;
    params?: {
        model?: string;
        modelProvider?: string;
        ephemeral?: boolean;
        sandbox?: string;
        effort?: string;
        input?: { text: string }[];
    };
}

test("Codex adapter uses official RPC, configured model/effort and exact reference paths", () =>
    withFixture(async (f) => {
        const log = join(f.cwd, "rpc.jsonl");
        process.env["RUNWIELD_CODEX_IMAGE_LOG"] = log;
        await fsWriteFile(
            join(f.cwd, "source.png"),
            Uint8Array.from(atob(PNG), (c) => c.charCodeAt(0)),
        );
        for (const provider of ["codex-cli", "openai-codex"]) {
            await f.settings({ model: `${provider}/fixture-model`, thinkingLevel: "low" });
            const image = await createImage({
                cwd: f.cwd,
                prompt: "make blue",
                outputPath: `${provider}.jpg`,
                imageRefs: ["source.png"],
            });
            assertEquals(image.width, 4);
        }
        const calls: RecordedCodexRequest[] = (await fsReadFile(log, "utf8"))
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line));
        const thread = calls.find((call) => call.method === "thread/start");
        assertEquals(thread?.params?.model, "fixture-model");
        assertEquals(thread?.params?.modelProvider, "openai");
        assertEquals(thread?.params?.ephemeral, true);
        assertEquals(thread?.params?.sandbox, "read-only");
        const turn = calls.find((call) => call.method === "turn/start");
        assertEquals(turn?.params?.effort, "low");
        assertStringIncludes(
            turn?.params?.input?.[0].text || "",
            `referenced_image_paths=${JSON.stringify([await fsRealpath(join(f.cwd, "source.png"))])}`,
        );
        assertEquals(f.requests.length, 0);
    }));

test("Codex adapter refuses unavailable capability, API-key billing, invalid output and mismatched turns", () =>
    withFixture(async (f) => {
        await f.settings({ model: "codex-cli/fixture-model" });
        process.env["RUNWIELD_CODEX_IMAGE_OUTSIDE"] = join(f.cwd, "source.png");
        await fsWriteFile(
            join(f.cwd, "source.png"),
            Uint8Array.from(atob(PNG), (c) => c.charCodeAt(0)),
        );
        for (const mode of [
            "api-key",
            "unsupported",
            "no-image",
            "multiple",
            "failed-image",
            "failed-turn",
            "wrong-turn",
            "outside",
            "stale",
            "approval",
            "malformed",
            "exit",
        ]) {
            process.env["RUNWIELD_CODEX_IMAGE_MODE"] = mode;
            await assertRejects(() => createImage({ cwd: f.cwd, prompt: "red", outputPath: `${mode}.png` }));
            await assertRejects(() => fsStat(join(f.cwd, `${mode}.png`)), Error, "ENOENT");
        }
        delete process.env["RUNWIELD_CODEX_IMAGE_MODE"];
        for (const settings of [
            { model: "codex-cli/missing" },
            {
                model: "codex-cli/fixture-model",
                thinkingLevel: "high",
            },
            { model: "codex-cli/fixture-model", temperature: 1 },
        ]) {
            await f.settings(settings);
            await assertRejects(() => createImage({ cwd: f.cwd, prompt: "red", outputPath: "invalid.png" }));
        }
    }));

test(
    "Codex adapter discovers the app-bundled CLI when codex is absent from PATH",
    {
        skip: process.platform !== "darwin",
    },
    () =>
        withFixture(async (f) => {
            const executable = join(
                f.home,
                "Applications",
                "ChatGPT.app",
                "Contents",
                "Resources",
                "codex-cli",
                "CodexCLI.app",
                "Contents",
                "MacOS",
                "codex",
            );
            await fsMkdir(dirname(executable), { recursive: true });
            await fsRename(join(dirname(f.home), "bin", "codex"), executable);
            // Exclude the calling app's injected PATH as well as the removed fixture command.
            process.env["PATH"] = join(dirname(f.home), "bin");
            await f.settings({ model: "codex-cli/fixture-model" });
            const image = await createImage({ cwd: f.cwd, prompt: "red", outputPath: "bundled.png" });
            assertEquals(image.width, 4);
            assert((await fsStat(join(f.cwd, "bundled.png"))).isFile());
            assertEquals(f.requests.length, 0);
        }),
);

test("Codex adapter interrupts a late-acknowledged turn and terminates its helper on cancellation", () =>
    withFixture(async (f) => {
        await f.settings({ model: "codex-cli/fixture-model" });
        const log = join(f.cwd, "rpc.jsonl");
        const startGate = join(f.cwd, "start-gate");
        const pidPath = join(f.cwd, "helper.pid");
        process.env["RUNWIELD_CODEX_IMAGE_LOG"] = log;
        process.env["RUNWIELD_CODEX_IMAGE_START_GATE"] = startGate;
        process.env["RUNWIELD_CODEX_IMAGE_PID"] = pidPath;
        process.env["RUNWIELD_CODEX_IMAGE_MODE"] = "wait";
        const abort = new AbortController();
        const pending = assertRejects(() =>
            createImage({ cwd: f.cwd, prompt: "red", outputPath: "cancelled.png", signal: abort.signal }),
        );
        try {
            const deadline = Date.now() + 5000;
            while (!(await fsReadFile(log, "utf8").catch(() => "")).includes("turn/start")) {
                if (Date.now() > deadline) throw new Error("Codex fixture did not start its turn");
                await new Promise((resolve) => setTimeout(resolve, 10));
            }
        } finally {
            abort.abort();
            await fsWriteFile(startGate, "acknowledge");
            await pending;
        }
        assertStringIncludes(
            await fsReadFile(log, "utf8"),
            '"method":"turn/interrupt","params":{"threadId":"thread-fixture","turnId":"turn-fixture"}',
        );
        const pid = Number(await fsReadFile(pidPath, "utf8"));
        assert(pid > 0);
        const gone = assertThrows(() => process.kill(pid, 0), Error);
        assertEquals("code" in gone ? gone.code : "missing-code", "ESRCH");
        await assertRejects(() => fsStat(join(f.cwd, "cancelled.png")), Error, "ENOENT");
    }));

test("Codex adapter terminates a helper that never acknowledges turn startup on cancellation", () =>
    withFixture(async (f) => {
        await f.settings({ model: "codex-cli/fixture-model" });
        const log = join(f.cwd, "rpc.jsonl");
        const pidPath = join(f.cwd, "helper.pid");
        process.env["RUNWIELD_CODEX_IMAGE_LOG"] = log;
        process.env["RUNWIELD_CODEX_IMAGE_PID"] = pidPath;
        process.env["RUNWIELD_CODEX_IMAGE_MODE"] = "unacknowledged";
        const abort = new AbortController();
        const pending = assertRejects(() =>
            createImage({ cwd: f.cwd, prompt: "red", outputPath: "cancelled.png", signal: abort.signal }),
        );
        try {
            const deadline = Date.now() + 5000;
            while (!(await fsReadFile(log, "utf8").catch(() => "")).includes("turn/start")) {
                if (Date.now() > deadline) throw new Error("Codex fixture did not start its turn");
                await new Promise((resolve) => setTimeout(resolve, 10));
            }
        } finally {
            abort.abort();
            await pending;
        }
        const pid = Number(await fsReadFile(pidPath, "utf8"));
        assert(pid > 0);
        const gone = assertThrows(() => process.kill(pid, 0), Error);
        assertEquals("code" in gone ? gone.code : "missing-code", "ESRCH");
        await assertRejects(() => fsStat(join(f.cwd, "cancelled.png")), Error, "ENOENT");
    }));
