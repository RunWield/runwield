import { assert, assertEquals, assertRejects, assertStringIncludes, assertThrows } from "@std/assert";
import { dirname, fromFileUrl, join } from "@std/path";
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
        const path = Deno.env.get("PATH");
        const temp = await Deno.makeTempDir({ prefix: "runwield-create-image-test-" });
        const envNames = [
            "RUNWIELD_IMAGE_FIXTURE_MODE",
            "RUNWIELD_IMAGE_FIXTURE_ARGS",
            "RUNWIELD_IMAGE_FIXTURE_OUTSIDE",
            "RUNWIELD_CODEX_IMAGE_MODE",
            "RUNWIELD_CODEX_IMAGE_LOG",
            "RUNWIELD_CODEX_IMAGE_OUTSIDE",
        ];
        const prior = envNames.map((key) => Deno.env.get(key));
        const fixture: Fixture = {
            cwd: join(temp, "project"),
            home: join(temp, "home"),
            requests: [],
            response: "image",
            async settings(value) {
                await Deno.writeTextFile(
                    join(fixture.cwd, ".wld", "settings.json"),
                    JSON.stringify({ imageGeneration: value }),
                );
                __resetSettingsForTests();
            },
        };
        const server = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen() {} }, async (request) => {
            fixture.requests.push(await request.json());
            fixture.onRequest?.();
            if (fixture.response === "wait") {
                // A fully consumed request body need not expose a later client disconnect.
                await new Promise<void>((resolve) => setTimeout(resolve, 100));
            }
            if (fixture.response === "unauthorized") return new Response("unauthorized", { status: 401 });
            if (fixture.response === "model-denied") {
                return Response.json({ error: { message: "Upstream request failed: Model access is disabled" } }, {
                    status: 403,
                });
            }
            if (fixture.response === "server-error") return new Response("provider unavailable", { status: 500 });
            if (new URL(request.url).pathname.endsWith("/responses")) {
                if (request.headers.get("authorization") !== "Bearer fixture-only") {
                    return Response.json({ error: { message: "Missing configured provider credential" } }, {
                        status: 401,
                    });
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
            const images = fixture.response === "text"
                ? []
                : fixture.response === "multiple"
                ? [image, image]
                : [image];
            return Response.json({ id: "fixture-image", choices: [{ message: { content: "fixture", images } }] });
        });
        try {
            await Deno.mkdir(join(fixture.home, ".wld"), { recursive: true });
            await Deno.mkdir(join(fixture.cwd, ".wld"), { recursive: true });
            Deno.env.set("HOME", fixture.home);
            Deno.chdir(fixture.cwd);
            await Deno.writeTextFile(
                join(fixture.home, ".wld", "models.json"),
                JSON.stringify({
                    providers: {
                        openrouter: { baseUrl: `http://127.0.0.1:${server.addr.port}/v1`, apiKey: "fixture-only" },
                        opencode: {
                            baseUrl: `http://127.0.0.1:${server.addr.port}/v1`,
                            apiKey: "fixture-only",
                            models: [{
                                id: "image-supervisor",
                                api: "openai-responses",
                                reasoning: true,
                                input: ["text", "image"],
                            }],
                        },
                        fixture: {
                            baseUrl: "https://example.invalid/v1",
                            api: "openai-completions",
                            apiKey: "fixture-only",
                            models: [{ id: "text", input: ["text"] }, { id: "vision", input: ["text", "image"] }],
                        },
                    },
                }),
            );
            await fixture.settings({ model: MODEL });
            const bin = join(temp, "bin");
            await Deno.mkdir(bin);
            await Deno.writeTextFile(
                join(bin, "agy"),
                `#!/bin/sh\nexec "${Deno.execPath()}" run -A "${CLI_FIXTURE}" "$@"\n`,
                { mode: 0o700 },
            );
            await Deno.writeTextFile(
                join(bin, "codex"),
                `#!/bin/sh\nexec "${Deno.execPath()}" run -A "${CODEX_FIXTURE}" "$@"\n`,
                { mode: 0o700 },
            );
            Deno.env.set("PATH", `${bin}:${path || ""}`);
            await run(fixture);
        } finally {
            await server.shutdown();
            Deno.chdir(cwd);
            Deno.env.set("HOME", home);
            if (path === undefined) Deno.env.delete("PATH");
            else Deno.env.set("PATH", path);
            envNames.forEach((key, index) =>
                prior[index] === undefined ? Deno.env.delete(key) : Deno.env.set(key, prior[index]!)
            );
            __resetSettingsForTests();
            await Deno.remove(temp, { recursive: true });
        }
    });
}

Deno.test("create_image uses the real Pi adapter, mapped options, reference input and exact output path", () =>
    withFixture(async (f) => {
        await f.settings({ model: MODEL, thinkingLevel: "high", temperature: 0 });
        await Deno.writeFile(join(f.cwd, "source.png"), Uint8Array.from(atob(PNG), (c) => c.charCodeAt(0)));
        const result = await createImage({
            cwd: f.cwd,
            prompt: "Make it blue",
            outputPath: "assets/result.png",
            imageRefs: ["source.png"],
        });
        assertEquals(result.path, "assets/result.png");
        assertEquals([result.width, result.height], [4, 2]);
        assertEquals(f.requests.length, 1);
        assertEquals(f.requests[0].temperature, 0);
        assertEquals(f.requests[0].reasoning, { effort: "high" });
        assertEquals(f.requests[0].provider, { require_parameters: true });
        assertEquals(f.requests[0].messages[0].content[1].image_url?.url, `data:image/png;base64,${PNG}`);
        const decoded = PhotonImage.new_from_byteslice(await Deno.readFile(join(f.cwd, result.path)));
        assertEquals(decoded.get_width(), 4);
        decoded.free();
    }));

Deno.test("create_image converts PNG bytes to the requested JPEG or WebP instead of relabeling", () =>
    withFixture(async (f) => {
        for (const extension of ["jpg", "webp"]) {
            const result = await createImage({ cwd: f.cwd, prompt: "red mug", outputPath: `image.${extension}` });
            const bytes = await Deno.readFile(join(f.cwd, result.path));
            if (extension === "jpg") assertEquals([...bytes.slice(0, 2)], [255, 216]);
            else assertEquals(new TextDecoder().decode(bytes.slice(8, 12)), "WEBP");
            const decoded = PhotonImage.new_from_byteslice(bytes);
            assertEquals(decoded.get_width(), 4);
            decoded.free();
        }
    }));

Deno.test("create_image rejects existing, escaping and symlink paths before calling Pi", () =>
    withFixture(async (f) => {
        await Deno.writeTextFile(join(f.cwd, "existing.png"), "user data");
        await Deno.symlink(f.home, join(f.cwd, "outside"));
        for (const outputPath of ["existing.png", "../escape.png", "outside/image.png", "file.txt"]) {
            await assertRejects(() => createImage({ cwd: f.cwd, prompt: "red", outputPath }));
        }
        assertEquals(await Deno.readTextFile(join(f.cwd, "existing.png")), "user data");
        assertEquals(f.requests.length, 0);
    }));

Deno.test("create_image refuses no-image, invalid bytes, multiple images and provider errors without retrying", () =>
    withFixture(async (f) => {
        for (const mode of ["text", "invalid", "multiple", "unauthorized", "server-error"] as const) {
            f.response = mode;
            await assertRejects(() => createImage({ cwd: f.cwd, prompt: "red", outputPath: `${mode}.png` }));
            await assertRejects(() => Deno.stat(join(f.cwd, `${mode}.png`)), Deno.errors.NotFound);
        }
        f.response = "model-denied";
        await assertRejects(
            () => createImage({ cwd: f.cwd, prompt: "red", outputPath: "denied.png" }),
            Error,
            "Model access is disabled",
        );
        await assertRejects(() => Deno.stat(join(f.cwd, "denied.png")), Deno.errors.NotFound);
        assertEquals(f.requests.length, 6);
    }));

Deno.test("create_image rejects unsupported options and vision-only models", () =>
    withFixture(async (f) => {
        for (
            const settings of [
                { model: "openrouter/google/gemini-2.5-flash-image", thinkingLevel: "high" },
                { model: MODEL, thinkingLevel: "medium" },
                { model: MODEL, temperature: 3 },
                { model: "openrouter/black-forest-labs/flux.2-pro", temperature: 1 },
                { model: "google/gemini-3.1-pro" },
                { model: "agy-cli/gemini-3.8-flash", temperature: 1 },
            ]
        ) {
            await f.settings(settings);
            await assertRejects(() => createImage({ cwd: f.cwd, prompt: "red", outputPath: "result.png" }));
        }
        assertEquals(f.requests.length, 0);
    }));

Deno.test("imageGeneration preserves settings and resets inherited options when the model changes", () =>
    withFixture(async (f) => {
        assertEquals(
            JSON.parse(
                preserveRunWieldCustomSettingsForWrite(JSON.stringify({ imageGeneration: { model: MODEL } }), "{}"),
            ),
            { imageGeneration: { model: MODEL } },
        );
        await Deno.writeTextFile(
            join(f.home, ".wld", "settings.json"),
            JSON.stringify({ imageGeneration: { model: MODEL, temperature: 0.5, thinkingLevel: "high" } }),
        );
        await f.settings({ model: "agy-cli/gemini-3.8-flash" });
        assertEquals(resolveImageGenerationSettings(f.cwd), { model: "agy-cli/gemini-3.8-flash" });
        await Deno.writeTextFile(
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
        await Deno.writeTextFile(
            join(f.cwd, ".wld", "settings.json"),
            JSON.stringify({ imageGeneration: { model: MODEL, thinkingLvel: "high" } }),
        );
        __resetSettingsForTests();
        assertThrows(() => resolveImageGenerationSettings(f.cwd), Error, "thinkingLvel");
    }));

Deno.test("create_image routes agy-cli to a real subprocess with matching model/effort and saves PNG", () =>
    withFixture(async (f) => {
        await f.settings({ model: "agy-cli/gemini-3.8-flash", thinkingLevel: "medium" });
        const argsPath = join(f.cwd, "args.json");
        Deno.env.set("RUNWIELD_IMAGE_FIXTURE_ARGS", argsPath);
        const result = await createImage({ cwd: f.cwd, prompt: "red mug", outputPath: "agy.png" });
        const args: string[] = JSON.parse(await Deno.readTextFile(argsPath));
        assertEquals(args[args.indexOf("--model") + 1], "gemini-3.8-flash-medium");
        assertEquals(args[args.indexOf("--effort") + 1], "medium");
        assert(!args.includes("--dangerously-skip-permissions"));
        assert(args.includes("--json-schema"));
        assertEquals(result.model, "agy-cli/gemini-3.8-flash");
        assertEquals(result.width, 4);
        assertEquals(f.requests.length, 0);
    }));

Deno.test("create_image does not trust Agy final SUCCESS or paths from other runs", () =>
    withFixture(async (f) => {
        await f.settings({ model: "agy-cli/gemini-3.8-flash" });
        Deno.env.set("RUNWIELD_IMAGE_FIXTURE_OUTSIDE", join(f.cwd, "existing.png"));
        await Deno.writeFile(join(f.cwd, "existing.png"), Uint8Array.from(atob(PNG), (c) => c.charCodeAt(0)));
        for (const mode of ["false-success", "outside"]) {
            Deno.env.set("RUNWIELD_IMAGE_FIXTURE_MODE", mode);
            await assertRejects(() => createImage({ cwd: f.cwd, prompt: "red", outputPath: `${mode}.png` }));
            await assertRejects(() => Deno.stat(join(f.cwd, `${mode}.png`)), Deno.errors.NotFound);
        }
    }));

Deno.test("create_image tool returns text-only metadata when the primary model cannot view images", () =>
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

Deno.test("create_image honors pre-cancellation without generating or saving", () =>
    withFixture(async (f) => {
        await assertRejects(() =>
            createImage({ cwd: f.cwd, prompt: "red", outputPath: "cancelled.png", signal: AbortSignal.abort() })
        );
        assertEquals(f.requests.length, 0);
        await assertRejects(() => Deno.stat(join(f.cwd, "cancelled.png")), Deno.errors.NotFound);
    }));

Deno.test("create_image rejects mismatched raster MIME and symlinked reference escapes", () =>
    withFixture(async (f) => {
        assertThrows(() => encodeCreatedImage({ type: "image", data: PNG, mimeType: "image/jpeg" }, "image/jpeg"));
        await Deno.writeFile(join(f.home, "private.png"), Uint8Array.from(atob(PNG), (c) => c.charCodeAt(0)));
        await Deno.symlink(join(f.home, "private.png"), join(f.cwd, "source.png"));
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

Deno.test("create_image cancels an in-flight Pi request without saving or retrying", () =>
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
            })
        );
        assertEquals(f.requests.length, 1);
        await assertRejects(() => Deno.stat(join(f.cwd, "cancelled.png")), Deno.errors.NotFound);
    }));

Deno.test("create_image cancels a running Agy subprocess without saving", () =>
    withFixture(async (f) => {
        await f.settings({ model: "agy-cli/gemini-3.8-flash" });
        const argsPath = join(f.cwd, "args.json");
        Deno.env.set("RUNWIELD_IMAGE_FIXTURE_ARGS", argsPath);
        Deno.env.set("RUNWIELD_IMAGE_FIXTURE_MODE", "wait");
        const abort = new AbortController();
        const pending = assertRejects(() =>
            createImage({
                cwd: f.cwd,
                prompt: "red",
                outputPath: "cancelled.png",
                signal: abort.signal,
            })
        );
        try {
            const deadline = Date.now() + 5000;
            while (!(await Deno.stat(argsPath).catch(() => null))) {
                if (Date.now() > deadline) throw new Error("Agy fixture did not start");
                await new Promise((resolve) => setTimeout(resolve, 10));
            }
        } finally {
            abort.abort();
            await pending;
        }
        await assertRejects(() => Deno.stat(join(f.cwd, "cancelled.png")), Deno.errors.NotFound);
    }));

Deno.test("create_image refuses a destination created while generation was in flight", () =>
    withFixture(async (f) => {
        f.onRequest = () => Deno.writeTextFileSync(join(f.cwd, "result.png"), "user data");
        await assertRejects(() => createImage({ cwd: f.cwd, prompt: "red", outputPath: "result.png" }));
        assertEquals(await Deno.readTextFile(join(f.cwd, "result.png")), "user data");
    }));

Deno.test("Claude receives create_image through the real MCP bridge with Session references and image results", () =>
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
            assert((await Deno.stat(join(f.cwd, "mcp.png"))).isFile);
            assertEquals(f.requests[0].messages[0].content[1].image_url?.url, `data:image/png;base64,${PNG}`);
        } finally {
            await client.close();
            await transport.close();
            await bridge.close();
        }
    }));

Deno.test("create_image is available only to configured image or file-writing agents", () =>
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
            assertEquals(tools.some((tool) => tool.name === "create_image"), names[0] !== "read");
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

Deno.test("Pi Sessions inject create_image for writers and respect the primary model's image capability", () =>
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
                assertEquals(result.content.some((block) => block.type === "image"), model === "vision");
                assert((await Deno.stat(join(f.cwd, `${model}.png`))).isFile);
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

Deno.test("Guide and write delegates get configured image tools in Pi and MCP; read delegates never inherit them", () =>
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
            ...await Promise.all((["write", "read"] as const).map(async (mode) => {
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
            })),
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
                assertEquals(bridged.some((tool) => tool.name === "create_image"), enabled && target.eligible);
            }
        }
    }));

Deno.test("OpenCode adapter uses existing provider config with the hosted image tool and reference bytes", () =>
    withFixture(async (f) => {
        await f.settings({ model: "opencode/image-supervisor", thinkingLevel: "low" });
        await Deno.writeFile(join(f.cwd, "source.png"), Uint8Array.from(atob(PNG), (c) => c.charCodeAt(0)));
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

Deno.test("OpenCode adapter rejects denied, image-free and malformed responses without fallback or retries", () =>
    withFixture(async (f) => {
        await f.settings({ model: "opencode/image-supervisor" });
        for (const response of ["unauthorized", "text", "multiple", "invalid", "server-error"] as const) {
            f.response = response;
            await assertRejects(() => createImage({ cwd: f.cwd, prompt: "red", outputPath: `${response}.png` }));
            await assertRejects(() => Deno.stat(join(f.cwd, `${response}.png`)), Deno.errors.NotFound);
        }
        assertEquals(f.requests.length, 5);
    }));

Deno.test("OpenCode adapter preserves cancellation and rejects unsupported controls before requesting", () =>
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
            createImage({ cwd: f.cwd, prompt: "red", outputPath: "cancelled.png", signal: abort.signal })
        );
        await assertRejects(() => Deno.stat(join(f.cwd, "cancelled.png")), Deno.errors.NotFound);
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

Deno.test("Codex adapter uses official RPC, configured model/effort and exact reference paths", () =>
    withFixture(async (f) => {
        const log = join(f.cwd, "rpc.jsonl");
        Deno.env.set("RUNWIELD_CODEX_IMAGE_LOG", log);
        await Deno.writeFile(join(f.cwd, "source.png"), Uint8Array.from(atob(PNG), (c) => c.charCodeAt(0)));
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
        const calls: RecordedCodexRequest[] = (await Deno.readTextFile(log)).trim().split("\n").map((line) =>
            JSON.parse(line)
        );
        const thread = calls.find((call) => call.method === "thread/start");
        assertEquals(thread?.params?.model, "fixture-model");
        assertEquals(thread?.params?.modelProvider, "openai");
        assertEquals(thread?.params?.ephemeral, true);
        assertEquals(thread?.params?.sandbox, "read-only");
        const turn = calls.find((call) => call.method === "turn/start");
        assertEquals(turn?.params?.effort, "low");
        assertStringIncludes(turn?.params?.input?.[0].text || "", join(f.cwd, "source.png"));
        assertEquals(f.requests.length, 0);
    }));

Deno.test("Codex adapter refuses unavailable capability, API-key billing, invalid output and mismatched turns", () =>
    withFixture(async (f) => {
        await f.settings({ model: "codex-cli/fixture-model" });
        Deno.env.set("RUNWIELD_CODEX_IMAGE_OUTSIDE", join(f.cwd, "source.png"));
        await Deno.writeFile(join(f.cwd, "source.png"), Uint8Array.from(atob(PNG), (c) => c.charCodeAt(0)));
        for (
            const mode of [
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
            ]
        ) {
            Deno.env.set("RUNWIELD_CODEX_IMAGE_MODE", mode);
            await assertRejects(() => createImage({ cwd: f.cwd, prompt: "red", outputPath: `${mode}.png` }));
            await assertRejects(() => Deno.stat(join(f.cwd, `${mode}.png`)), Deno.errors.NotFound);
        }
        Deno.env.delete("RUNWIELD_CODEX_IMAGE_MODE");
        for (
            const settings of [{ model: "codex-cli/missing" }, {
                model: "codex-cli/fixture-model",
                thinkingLevel: "high",
            }, { model: "codex-cli/fixture-model", temperature: 1 }]
        ) {
            await f.settings(settings);
            await assertRejects(() => createImage({ cwd: f.cwd, prompt: "red", outputPath: "invalid.png" }));
        }
    }));

Deno.test({
    name: "Codex adapter discovers the app-bundled CLI when codex is absent from PATH",
    ignore: Deno.build.os !== "darwin",
    fn: () =>
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
            await Deno.mkdir(dirname(executable), { recursive: true });
            await Deno.rename(join(dirname(f.home), "bin", "codex"), executable);
            // Exclude the calling app's injected PATH as well as the removed fixture command.
            Deno.env.set("PATH", join(dirname(f.home), "bin"));
            await f.settings({ model: "codex-cli/fixture-model" });
            const image = await createImage({ cwd: f.cwd, prompt: "red", outputPath: "bundled.png" });
            assertEquals(image.width, 4);
            assert((await Deno.stat(join(f.cwd, "bundled.png"))).isFile);
            assertEquals(f.requests.length, 0);
        }),
});

Deno.test("Codex adapter interrupts and terminates an in-flight owned helper on cancellation", () =>
    withFixture(async (f) => {
        await f.settings({ model: "codex-cli/fixture-model" });
        const log = join(f.cwd, "rpc.jsonl");
        Deno.env.set("RUNWIELD_CODEX_IMAGE_LOG", log);
        Deno.env.set("RUNWIELD_CODEX_IMAGE_MODE", "wait");
        const abort = new AbortController();
        const pending = assertRejects(() =>
            createImage({ cwd: f.cwd, prompt: "red", outputPath: "cancelled.png", signal: abort.signal })
        );
        try {
            const deadline = Date.now() + 5000;
            while (!(await Deno.readTextFile(log).catch(() => "")).includes("turn/start")) {
                if (Date.now() > deadline) throw new Error("Codex fixture did not start its turn");
                await new Promise((resolve) => setTimeout(resolve, 10));
            }
        } finally {
            abort.abort();
            await pending;
        }
        assertStringIncludes(await Deno.readTextFile(log), "turn/interrupt");
        await assertRejects(() => Deno.stat(join(f.cwd, "cancelled.png")), Deno.errors.NotFound);
    }));
