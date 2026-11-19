import { Buffer } from "node:buffer";
import { constants } from "node:fs";
import { lstat, mkdir, mkdtemp, open, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import type { ImageContent } from "@earendil-works/pi-ai";
import { getHomeDir } from "../../../../constants.ts";
import { getModelRegistry } from "../../../models/model-registry.ts";
import type { ImageGenerationSettings } from "../../../image-generation-settings.ts";
import { mimeTypeForImagePath } from "../../image-attachments.ts";
import { runAgyAcpTurn } from "./acp-transport.ts";
import { thinkingLevelToEffort } from "./model-options.ts";

interface AgyImageRequest {
    model: string;
    settings: ImageGenerationSettings;
    prompt: string;
    referenceImages: ImageContent[];
    signal?: AbortSignal;
}

interface ImagePathResponse {
    path: string;
}

function inside(root: string, file: string): boolean {
    const path = relative(root, file);
    return path !== "" && path !== ".." && !path.startsWith("../") && !path.startsWith("..\\") && !isAbsolute(path);
}

/** One isolated ACP image turn. Never replay a failed request or substitute credentials. */
export async function generateAgyImage(request: AgyImageRequest): Promise<ImageContent> {
    request.signal?.throwIfAborted();
    if (request.settings.temperature !== undefined) {
        throw new Error("agy-cli does not support imageGeneration.temperature. Remove that setting.");
    }
    if (!getModelRegistry().find("agy-cli", request.model)) {
        throw new Error(`Unsupported agy-cli model: ${request.model}. Select an Agy model supported by RunWield.`);
    }
    const effort = thinkingLevelToEffort(request.model, request.settings.thinkingLevel);
    const cwd = await realpath(await mkdtemp(join(tmpdir(), "runwield-create-image-")));
    const name = `runwield-image-${crypto.randomUUID()}`;
    const signal = AbortSignal.any([...(request.signal ? [request.signal] : []), AbortSignal.timeout(300_000)]);
    try {
        const directory = join(cwd, ".agents", "agents", name);
        await mkdir(directory, { recursive: true, mode: 0o700 });
        await writeFile(
            join(directory, "agent.md"),
            [
                "---",
                `name: ${name}`,
                "description: One isolated native image generation",
                "mainAgent: true",
                "subagent: false",
                "tools: [generate_image]",
                "excludeDefaultComponents: true",
                "inheritMcp: false",
                "inheritCustomizations: false",
                "mcpServers: []",
                "skills: []",
                "plugins: []",
                "commandExecutionPolicy: off",
                "---",
                "Use only native generate_image exactly once. Do not retry or use other tools.",
                "Do not read unrelated files, use MCP, shell, browser, skills, or subagents.",
                "Return only JSON with a single path key containing the actual absolute generated image path.",
                "If generation fails, report failure. Never invent a path or reuse a previous image.",
            ].join("\n"),
            { mode: 0o600 },
        );
        // Stage the already-validated bytes, never hand mutable user paths to the vendor.
        const referencePaths: string[] = [];
        for (const [index, image] of request.referenceImages.entries()) {
            const extension =
                image.mimeType === "image/jpeg" ? "jpg" : image.mimeType === "image/webp" ? "webp" : "png";
            const path = join(cwd, `reference-${index}.${extension}`);
            await writeFile(path, Buffer.from(image.data, "base64"), { mode: 0o600 });
            referencePaths.push(path);
        }
        const tools = new Map<number, { name: string; state: string }>();
        const result = await runAgyAcpTurn(
            {
                cwd,
                agentName: name,
                model: request.model,
                effort,
                signal,
                mcpServers: [],
                userRequest: [
                    "Generate exactly one image using native generate_image exactly once. No retries or other tools.",
                    "Return only JSON with exactly one path key containing the actual absolute native output path.",
                    referencePaths.length
                        ? `Use exactly these reference paths as ImagePaths: ${JSON.stringify(referencePaths)}.`
                        : "This is a new image. Omit reference-image arguments.",
                    `Image description: ${JSON.stringify(request.prompt)}`,
                ].join("\n"),
            },
            { onTool: (tool) => tools.set(tool.stepIndex, { name: tool.name, state: tool.state }) },
        );
        signal.throwIfAborted();
        const tool = [...tools.values()][0];
        if (tools.size !== 1 || tool?.name !== "generate_image" || tool.state !== "DONE") {
            throw new Error("Agy did not complete exactly one native image generation. No output was saved.");
        }
        const parsed = JSON.parse(result.rawResultText) as ImagePathResponse | null;
        if (
            !parsed ||
            Array.isArray(parsed) ||
            Object.keys(parsed).length !== 1 ||
            typeof parsed.path !== "string" ||
            !isAbsolute(parsed.path)
        ) {
            throw new Error("Agy did not return exactly one structured absolute image path.");
        }
        const session = result.metadata.sessionId;
        if (!session || !/^[a-zA-Z0-9_-]+$/.test(session)) throw new Error("Agy did not identify its image session.");
        const source = await realpath(parsed.path);
        const temporaryRoot = await realpath(cwd);
        const sessionRoot = join(getHomeDir(), ".gemini", "antigravity-cli", "brain", session);
        // Canonicalize the brain parent, not the session directory: a session symlink must not widen scope.
        const canonicalBrain = await realpath(join(getHomeDir(), ".gemini", "antigravity-cli", "brain")).catch(
            () => "",
        );
        const canonicalSession = canonicalBrain ? join(canonicalBrain, session) : sessionRoot;
        if (!inside(temporaryRoot, source) && (!canonicalBrain || !inside(canonicalSession, source))) {
            throw new Error("Agy returned an image outside this request's output directories.");
        }
        const before = await lstat(source);
        const file = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
            const stat = await file.stat();
            if (
                before.isSymbolicLink() ||
                before.ino !== stat.ino ||
                before.dev !== stat.dev ||
                (await realpath(source)) !== source
            ) {
                throw new Error("Agy image output changed before reading.");
            }
            if (!stat.isFile() || stat.size === 0 || stat.size > 32 * 1024 * 1024) {
                throw new Error("Agy image output must be a nonempty image file under 32 MiB.");
            }
            const bytes = await file.readFile();
            if (bytes.length !== stat.size) throw new Error("Agy image output changed while reading.");
            signal.throwIfAborted();
            return {
                type: "image",
                data: Buffer.from(bytes).toString("base64"),
                mimeType: mimeTypeForImagePath(source),
            };
        } finally {
            await file.close();
        }
    } finally {
        await rm(cwd, { recursive: true, force: true });
    }
}
