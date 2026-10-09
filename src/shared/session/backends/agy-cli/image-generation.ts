import { Buffer } from "node:buffer";
import { isAbsolute, join, relative } from "@std/path";
import type { ImageContent } from "@earendil-works/pi-ai";
import { getHomeDir } from "../../../../constants.js";
import { getModelRegistry } from "../../../models/model-registry.ts";
import type { ImageGenerationSettings } from "../../../image-generation-settings.ts";
import { mimeTypeForImagePath } from "../../image-attachments.ts";
import { concreteAgyModel, thinkingLevelToEffort } from "./model-options.ts";
import { DenoAgyCliProcessPort } from "./process.ts";
import { parseAgyCliStream } from "./stream-parser.ts";

interface AgyImageRequest {
    model: string;
    settings: ImageGenerationSettings;
    prompt: string;
    referencePaths: string[];
    signal?: AbortSignal;
}

interface ImagePathResponse {
    path: string;
}

function inside(root: string, file: string): boolean {
    const path = relative(root, file);
    return path !== "" && path !== ".." && !path.startsWith("../") && !path.startsWith("..\\") && !isAbsolute(path);
}

/** Agy owns authentication and native generation; RunWield validates and copies the result. */
export async function generateAgyImage(request: AgyImageRequest): Promise<ImageContent> {
    if (request.settings.temperature !== undefined) {
        throw new Error("agy-cli does not support imageGeneration.temperature. Remove that setting.");
    }
    if (!getModelRegistry().find("agy-cli", request.model)) {
        throw new Error(`Unsupported agy-cli model: ${request.model}. Select an Agy model supported by RunWield.`);
    }
    const effort = thinkingLevelToEffort(request.model, request.settings.thinkingLevel);
    request.signal?.throwIfAborted();
    const cwd = await Deno.makeTempDir({ prefix: "runwield-create-image-" });
    const prompt = [
        "Generate exactly one image using your native generate_image tool exactly once.",
        "Do not use MCP tools, shell commands, subagents, browser, or skills. Do not modify project files.",
        "Return the actual absolute path produced by that native tool in the required JSON schema.",
        "If generation fails, report the failure. Do not substitute a previous image or retry.",
        request.referencePaths.length
            ? `Use these exact reference image paths in ImagePaths: ${JSON.stringify(request.referencePaths)}.`
            : "This is a new image. Omit reference-image arguments.",
        `Image description: ${JSON.stringify(request.prompt)}`,
    ].join("\n");
    const args = [
        "-p",
        prompt,
        "--model",
        concreteAgyModel(request.model, effort),
        "--effort",
        effort,
        "--output-format",
        "stream-json",
        "--print-timeout",
        "5m",
        "--disable-slash-commands",
        "--json-schema",
        JSON.stringify({
            type: "object",
            properties: { path: { type: "string" } },
            required: ["path"],
            additionalProperties: false,
        }),
    ];
    // Do not install global agents, change MCP configuration, or bypass permissions.
    let process: ReturnType<DenoAgyCliProcessPort["run"]> | undefined;
    try {
        process = new DenoAgyCliProcessPort().run(
            { command: "agy", args, env: {}, timeoutMs: 300_000 },
            cwd,
            request.signal,
        );
        const tools = new Map<number, string>();
        const [parsed, outcome] = await Promise.all([
            parseAgyCliStream(process.stdout, {
                onTool: (tool) => {
                    if (tool.name === "generate_image") tools.set(tool.stepIndex, tool.state);
                },
            }),
            process.completed,
            // Consume diagnostics but never expose host logs or credentials in the tool result.
            process.stderrText,
        ]);
        request.signal?.throwIfAborted();
        if (!outcome.success || parsed.metadata.status !== "success" || parsed.metadata.permissionDenied) {
            throw new Error(
                `Agy image generation failed (${
                    outcome.terminatedBy ?? parsed.metadata.status ?? "process error"
                }). Check Agy login and permissions.`,
            );
        }
        if (tools.size !== 1 || [...tools.values()][0] !== "DONE") {
            throw new Error("Agy did not complete exactly one native image generation. No output was saved.");
        }
        const result = JSON.parse(parsed.rawResultText) as ImagePathResponse;
        if (!result || typeof result.path !== "string" || !isAbsolute(result.path)) {
            throw new Error("Agy did not return a structured absolute image path.");
        }
        const session = parsed.metadata.sessionId;
        if (!session || !/^[a-zA-Z0-9_-]+$/.test(session)) throw new Error("Agy did not identify its image session.");
        const source = await Deno.realPath(result.path);
        const temporaryRoot = await Deno.realPath(cwd);
        const hostRoot = join(getHomeDir(), ".gemini", "antigravity-cli", "brain", session);
        let currentSessionRoot = "";
        try {
            currentSessionRoot = await Deno.realPath(hostRoot);
        } catch { /* host may return the temporary path */ }
        if (!inside(temporaryRoot, source) && (!currentSessionRoot || !inside(currentSessionRoot, source))) {
            throw new Error("Agy returned an image outside this request's output directories.");
        }
        const stat = await Deno.stat(source);
        if (!stat.isFile || stat.size === 0 || stat.size > 32 * 1024 * 1024) {
            throw new Error("Agy image output must be a nonempty image file under 32 MiB.");
        }
        return {
            type: "image",
            data: Buffer.from(await Deno.readFile(source)).toString("base64"),
            mimeType: mimeTypeForImagePath(source),
        };
    } finally {
        if (process) {
            process.kill();
            await Promise.allSettled([process.completed, process.stderrText]);
        }
        await Deno.remove(cwd, { recursive: true });
    }
}
