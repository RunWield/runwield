import { readFile as fsReadFile, realpath as fsRealpath, stat as fsStat } from "node:fs/promises";
/* Explicit, one-turn LIVE proof. This is not an interactive remote Session. */
import { isAbsolute, join, relative } from "node:path";
import type { RemoteModelConnection } from "./model-bridge.ts";
import type { RemoteMount } from "./sftp-mount.ts";
import { createBoundedRemoteModelSession } from "./bounded-model-session.ts";
import { parseRemoteModelProof, type RemoteModelProof } from "./model-proof-config.ts";

function inside(root: string, path: string): boolean {
    const rest = relative(root, path).replaceAll("\\", "/");
    return rest === "" || (rest !== ".." && !rest.startsWith("../") && !isAbsolute(rest));
}

/** Runs only in the authenticated remote supervisor, after its mount is verified. */
export async function runRemoteModelProof(options: {
    proof: RemoteModelProof;
    mount: RemoteMount;
    connection: RemoteModelConnection;
    cwd: string;
    signal?: AbortSignal;
}): Promise<void> {
    const signal = options.signal;
    signal?.throwIfAborted();
    // Validate again at the receiving end. Never trust an untyped private header.
    const proof = parseRemoteModelProof(JSON.stringify(options.proof));
    const project = await fsRealpath(options.cwd);
    const path = await fsRealpath(join(project, proof.sentinelFile));
    const mountedRoots = [
        options.mount.globalRoot,
        options.mount.agentsRoot,
        ...Object.values(options.mount.packageRoots ?? {}),
    ]
        .filter((root): root is string => typeof root === "string");
    if (
        !inside(project, path) || path === project ||
        mountedRoots.some((root) => inside(root, path) || inside(root, project))
    ) {
        throw new Error("Remote model proof sentinel must be inside the remote project");
    }
    const info = await fsStat(path);
    if (!info.isFile() || info.size > 4096) throw new Error("Invalid remote model proof sentinel");
    const sentinel = (await fsReadFile(path, "utf8")).trim();
    if (!sentinel || sentinel.length > 512 || /[\r\n]/.test(sentinel)) {
        throw new Error("Invalid remote model proof sentinel");
    }
    signal?.throwIfAborted();
    let toolResult: string | undefined;
    const { session } = await createBoundedRemoteModelSession({
        mount: options.mount,
        connection: options.connection,
        cwd: project,
        provider: proof.provider,
        modelId: proof.modelId,
        customTools: [{
            name: "read_remote_sentinel",
            label: "Read remote sentinel",
            description: "Read the approved remote project sentinel",
            parameters: { type: "object", properties: {}, additionalProperties: false },
            execute: async () => {
                // Recheck before each read so a changed symlink cannot redirect the tool to laptop files.
                const current = await fsRealpath(join(project, proof.sentinelFile));
                if (
                    current !== path || !inside(project, current) || mountedRoots.some((root) => inside(root, current))
                ) {
                    throw new Error("Remote model proof sentinel changed");
                }
                const value = (await fsReadFile(current, "utf8")).trim();
                if (value !== sentinel) throw new Error("Remote model proof sentinel changed");
                toolResult = value;
                return { content: [{ type: "text" as const, text: value }], details: null };
            },
        }],
    });
    try {
        signal?.throwIfAborted();
        if (session.getAllTools().some((tool) => tool.name !== "read_remote_sentinel")) {
            throw new Error("Remote model proof requires only the sentinel tool");
        }
        let timedOut = false;
        const abortPrompt = () => {
            // Pi's abort() waits for the prompt to settle; do not await it in the listener.
            void session.abort().catch(() => undefined);
        };
        signal?.addEventListener("abort", abortPrompt, { once: true });
        const timeout = setTimeout(() => {
            timedOut = true;
            abortPrompt();
        }, 60_000);
        try {
            signal?.throwIfAborted();
            await session.prompt("Call read_remote_sentinel once. Then repeat its exact text in your final response.", {
                expandPromptTemplates: false,
            });
            signal?.throwIfAborted();
            if (timedOut) throw new Error("Remote model proof timed out");
        } finally {
            clearTimeout(timeout);
            signal?.removeEventListener("abort", abortPrompt);
        }
        const messages = session.messages;
        const resultIndex = messages.findIndex((message) =>
            message.role === "toolResult" && message.toolName === "read_remote_sentinel" &&
            !message.isError && message.content.some((part) => part.type === "text" && part.text === sentinel)
        );
        const reply = messages.slice(resultIndex + 1).find((message) => message.role === "assistant");
        if (
            toolResult !== sentinel || resultIndex < 0 || reply?.role !== "assistant" ||
            reply.stopReason !== "stop" ||
            !reply.content.some((part) => part.type === "text" && part.text.includes(sentinel))
        ) throw new Error("Remote model proof did not confirm the remote tool result and response");
    } finally {
        session.dispose();
    }
}
