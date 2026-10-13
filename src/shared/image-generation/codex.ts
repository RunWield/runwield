import { tmpdir } from "node:os";
import { mkdtemp } from "node:fs/promises";
import nodeProcess from "node:process";
import { readFile as fsReadFile, realpath as fsRealpath, rm as fsRm, stat as fsStat } from "node:fs/promises";
import { Buffer } from "node:buffer";
import { isAbsolute, join, relative } from "node:path";
import type { ImageContent } from "@earendil-works/pi-ai";
import { getHomeDir } from "../../constants.js";
import { spawnForegroundProcess } from "../foreground-process.ts";
import type { ImageGenerationSettings } from "../image-generation-settings.ts";
import { mimeTypeForImagePath } from "../session/image-attachments.ts";
import { resolveCodexExecutable } from "./codex-executable.ts";

interface CodexImageRequest {
    model: string;
    settings: ImageGenerationSettings;
    prompt: string;
    referencePaths: string[];
    signal?: AbortSignal;
}

interface CodexModel {
    id: string;
    model: string;
    supportedReasoningEfforts: { reasoningEffort: string }[];
}
interface CodexItem {
    type: string;
    id: string;
    status?: string;
    failure?: { message?: string } | null;
    savedPath?: string | null;
}
interface CodexTurn {
    id: string;
    status: string;
    items?: CodexItem[];
}
interface CodexResult {
    account?: { type: string } | null;
    imageGeneration?: boolean;
    data?: CodexModel[];
    nextCursor?: string | null;
    thread?: { id: string };
    turn?: CodexTurn;
}
interface RpcMessage {
    id?: string | number;
    method?: string;
    result?: CodexResult;
    error?: { code: number; message: string };
    params?: { threadId?: string; turnId?: string; item?: CodexItem; turn?: CodexTurn };
}
type JsonValue = string | number | boolean | null | JsonValue[] | JsonRecord;
interface JsonRecord {
    [key: string]: JsonValue;
}
interface PendingRequest {
    resolve(result: CodexResult): void;
    reject(error: Error): void;
}

function inside(root: string, path: string): boolean {
    const local = relative(root, path);
    return !!local && local !== ".." && !isAbsolute(local) && !local.startsWith("../") && !local.startsWith("..\\");
}

/** Official App Server only. The host retains its login; no OAuth tokens leave Codex. */
export async function generateCodexImage(request: CodexImageRequest): Promise<ImageContent> {
    if (request.settings.temperature !== undefined) {
        throw new Error("Codex image generation does not support temperature.");
    }
    request.signal?.throwIfAborted();
    const executable = await resolveCodexExecutable();
    request.signal?.throwIfAborted();
    const cwd = await mkdtemp(join(tmpdir(), "runwield-codex-image-"));
    const startedAt = Date.now();
    const pending = new Map<number, PendingRequest>();
    const completed = Promise.withResolvers<CodexTurn>();
    // Completion can arrive before turn/start acknowledges; install its handler now.
    completed.promise.catch(() => undefined);
    let process: ReturnType<typeof spawnForegroundProcess> | undefined;
    let writer: WritableStreamDefaultWriter<Uint8Array> | undefined;
    let pump: Promise<void> | undefined;
    let stderr: Promise<void> | undefined;
    let nextId = 0;
    let threadId = "";
    let turnId = "";
    let turnStartRequestId: number | undefined;
    const turnAcknowledged = Promise.withResolvers<string>();
    const events: RpcMessage[] = [];
    let protocolError: Error | undefined;
    const fail = (error: Error) => {
        protocolError = error;
        for (const waiter of pending.values()) waiter.reject(error);
        pending.clear();
        completed.reject(error);
    };
    const onAbort = () => fail(new Error("Codex image generation cancelled."));
    const send = (message: JsonRecord) => writer!.write(new TextEncoder().encode(`${JSON.stringify(message)}\n`));
    const rpc = async (method: string, params: JsonRecord): Promise<CodexResult> => {
        request.signal?.throwIfAborted();
        if (protocolError) throw protocolError;
        const id = ++nextId;
        if (method === "turn/start") turnStartRequestId = id;
        const response = Promise.withResolvers<CodexResult>();
        pending.set(id, response);
        response.promise.catch(() => undefined);
        try {
            try {
                await send({ id, method, params });
            } catch (error) {
                if (id === turnStartRequestId) turnAcknowledged.resolve("");
                throw error;
            }
            return await response.promise;
        } finally {
            pending.delete(id);
        }
    };
    try {
        process = spawnForegroundProcess({
            command: executable,
            args: ["app-server"],
            cwd,
            stdin: "piped",
            timeoutMs: 300_000,
        });
        writer = process.stdin!.getWriter();
        request.signal?.addEventListener("abort", onAbort, { once: true });
        stderr = (async () => {
            for await (const _chunk of process!.stderr) {
                /* drain private host diagnostics */
            }
        })();
        pump = (async () => {
            let buffer = "";
            const decoder = new TextDecoder();
            try {
                for await (const chunk of process!.stdout) {
                    buffer += decoder.decode(chunk, { stream: true });
                    if (buffer.length > 48 * 1024 * 1024) throw new Error("Codex protocol output exceeds its limit.");
                    let newline: number;
                    while ((newline = buffer.indexOf("\n")) >= 0) {
                        const line = buffer.slice(0, newline).trim();
                        buffer = buffer.slice(newline + 1);
                        if (!line) continue;
                        const message = JSON.parse(line) as RpcMessage;
                        if (message.method && message.id !== undefined) {
                            // Never grant shell/file/MCP permissions on behalf of the user.
                            await send({
                                id: message.id,
                                error: { code: -32601, message: "Image helper cannot approve additional actions." },
                            });
                            throw new Error(
                                "Codex requested additional permissions or a client tool. No image was saved.",
                            );
                        } else if (typeof message.id === "number") {
                            // Cancellation rejects RPC callers, but a late start reply still
                            // identifies the owned turn that cleanup must interrupt.
                            if (message.id === turnStartRequestId) {
                                turnAcknowledged.resolve(message.result?.turn?.id || "");
                            }
                            const waiter = pending.get(message.id);
                            if (message.error) waiter?.reject(new Error(`Codex ${message.error.message}`));
                            else waiter?.resolve(message.result || {});
                        } else if (message.params?.threadId === threadId && threadId) {
                            if (["item/completed", "turn/completed"].includes(message.method || "")) {
                                if (events.length >= 256) {
                                    throw new Error("Codex image helper exceeded its event limit.");
                                }
                                events.push(message);
                            }
                            if (message.method === "turn/completed" && message.params.turn) {
                                completed.resolve(message.params.turn);
                            }
                        }
                    }
                }
                fail(
                    new Error(
                        "Codex App Server exited before image completion. Check its login and access to its local state directory.",
                    ),
                );
            } catch (error) {
                fail(error instanceof Error ? error : new Error("Invalid Codex image protocol."));
            } finally {
                turnAcknowledged.resolve("");
            }
        })();
        request.signal?.throwIfAborted();
        await rpc("initialize", {
            clientInfo: { name: "runwield-image", version: "1.0.0" },
            capabilities: { experimentalApi: true },
        });
        await send({ method: "initialized" });
        const account = await rpc("account/read", {});
        if (account.account?.type !== "chatgpt") {
            throw new Error(
                "Codex image generation requires an existing ChatGPT login in Codex. API-key fallback is disabled.",
            );
        }
        const capability = await rpc("modelProvider/capabilities/read", {});
        if (!capability.imageGeneration) {
            throw new Error("This Codex runtime does not advertise native image generation.");
        }
        let selected: CodexModel | undefined;
        let cursor: string | undefined;
        for (let page = 0; page < 20; page++) {
            const catalog = await rpc("model/list", { ...(cursor ? { cursor } : {}), limit: 100 });
            selected = catalog.data?.find((model) => model.id === request.model || model.model === request.model);
            if (selected || !catalog.nextCursor) break;
            cursor = catalog.nextCursor;
        }
        if (!selected) {
            throw new Error(`Codex model not available in its catalog: ${request.model}. No fallback was selected.`);
        }
        const effort = request.settings.thinkingLevel === "off" ? "none" : request.settings.thinkingLevel;
        if (effort && !selected.supportedReasoningEfforts?.some((option) => option.reasoningEffort === effort)) {
            throw new Error(`Unsupported Codex thinkingLevel ${request.settings.thinkingLevel} for ${request.model}.`);
        }
        const started = await rpc("thread/start", {
            model: selected.model,
            modelProvider: "openai",
            cwd,
            ephemeral: true,
            allowProviderModelFallback: false,
            sandbox: "read-only",
            developerInstructions:
                "Generate one image with the native image tool. Do not use shell, file edits, MCP, subagents, browser, or external services. Do not retry or replace a failed generation.",
        });
        threadId = started.thread?.id || "";
        if (!threadId) throw new Error("Codex did not create an image thread.");
        const prompt = [
            "Use the native image generation tool exactly once to create one image.",
            request.referencePaths.length
                ? `Use referenced_image_paths=${JSON.stringify(
                      request.referencePaths,
                  )}; omit num_last_images_to_include.`
                : "For a new image omit both referenced_image_paths and num_last_images_to_include; do not pass zero.",
            `Image description: ${JSON.stringify(request.prompt)}`,
        ].join("\n");
        const turn = await rpc("turn/start", {
            threadId,
            input: [{ type: "text", text: prompt }],
            ...(effort ? { effort } : {}),
        });
        turnId = turn.turn?.id || "";
        if (!turnId) throw new Error("Codex did not identify the image turn.");
        const finished = await completed.promise;
        request.signal?.throwIfAborted();
        if (protocolError) throw protocolError;
        if (finished.id !== turnId || finished.status !== "completed") {
            throw new Error("Codex image turn did not complete successfully.");
        }
        const images = new Map<string, CodexItem>();
        for (const event of events) {
            if (
                event.method === "item/completed" &&
                event.params?.turnId === turnId &&
                event.params.item?.type === "imageGeneration"
            ) {
                images.set(event.params.item.id, event.params.item);
            }
        }
        for (const item of finished.items || []) if (item.type === "imageGeneration") images.set(item.id, item);
        const image = [...images.values()][0];
        if (
            images.size !== 1 ||
            image.status !== "completed" ||
            image.failure ||
            !image.savedPath ||
            !isAbsolute(image.savedPath)
        ) {
            throw new Error("Codex did not complete exactly one native image with a savedPath. No output was saved.");
        }
        const source = await fsRealpath(image.savedPath);
        const generatedRoot = join(nodeProcess.env["CODEX_HOME"] || join(getHomeDir(), ".codex"), "generated_images");
        const hostRoot = await fsRealpath(generatedRoot).catch(() => "");
        if (!inside(await fsRealpath(cwd), source) && (!hostRoot || !inside(hostRoot, source))) {
            throw new Error("Codex image path is outside its generated-image storage.");
        }
        const stat = await fsStat(source);
        if (
            !stat.isFile() ||
            !stat.mtime ||
            stat.mtime.getTime() < startedAt - 1000 ||
            stat.size === 0 ||
            stat.size > 32 * 1024 * 1024
        ) {
            throw new Error("Codex returned a stale, empty or oversized image file.");
        }
        return {
            type: "image",
            data: Buffer.from(await fsReadFile(source)).toString("base64"),
            mimeType: mimeTypeForImagePath(source),
        };
    } finally {
        request.signal?.removeEventListener("abort", onAbort);
        if (request.signal?.aborted && threadId && !turnId && turnStartRequestId !== undefined) {
            let timeout: ReturnType<typeof setTimeout> | undefined;
            try {
                turnId = await Promise.race([
                    turnAcknowledged.promise,
                    new Promise<string>((resolve) => {
                        timeout = setTimeout(() => resolve(""), 1000);
                    }),
                ]);
            } finally {
                if (timeout !== undefined) clearTimeout(timeout);
            }
        }
        if (writer && request.signal?.aborted && threadId && turnId) {
            let timeout: ReturnType<typeof setTimeout> | undefined;
            const id = ++nextId;
            const interrupted = Promise.withResolvers<CodexResult>();
            pending.set(id, interrupted);
            await Promise.race([
                Promise.all([
                    send({ id, method: "turn/interrupt", params: { threadId, turnId } }),
                    interrupted.promise,
                ]).catch(() => undefined),
                new Promise<void>((resolve) => {
                    timeout = setTimeout(resolve, 250);
                }),
            ]);
            pending.delete(id);
            if (timeout !== undefined) clearTimeout(timeout);
        }
        process?.kill();
        await Promise.allSettled([process?.done, pump, stderr]);
        await writer?.close().catch(() => undefined);
        writer?.releaseLock();
        await fsRm(cwd, { recursive: true });
    }
}
