import process from "node:process";
import { getCwd } from "../../constants.js";
import { createSessionRuntime, generateInMemoryGuide } from "../../shared/session/session-runtime.ts";
import { RuntimeEventTypes } from "../../shared/session/session-runtime-events.js";
import { encodeGuidedReviewMetadata, encodeGuidedReviewUsageEvent, type GuidedReviewUsage } from "./protocol.ts";

export interface GuidedReviewCommandIo {
    readStdin: () => Promise<string>;
    writeStdout: (text: string) => void | Promise<void>;
    writeStderr: (text: string) => void | Promise<void>;
}

interface RuntimeUsageEventLike {
    type: string;
    usage?: GuidedReviewUsage;
}

async function readDefaultStdin(): Promise<string> {
    const chunks: Uint8Array[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    return Buffer.concat(chunks).toString("utf8");
}

async function writeDefaultStdout(text: string): Promise<void> {
    await new Promise<void>((resolve, reject) =>
        process.stdout.write(text, (error) => (error ? reject(error) : resolve())),
    );
}

async function writeDefaultStderr(text: string): Promise<void> {
    await new Promise<void>((resolve, reject) =>
        process.stderr.write(text, (error) => (error ? reject(error) : resolve())),
    );
}

function isRuntimeUsageEvent(
    event: RuntimeUsageEventLike,
): event is RuntimeUsageEventLike & { usage: GuidedReviewUsage } {
    return event.type === RuntimeEventTypes.USAGE && Boolean(event.usage);
}

export function createGuidedReviewCliIo(): GuidedReviewCommandIo {
    return {
        readStdin: readDefaultStdin,
        writeStdout: writeDefaultStdout,
        writeStderr: writeDefaultStderr,
    };
}

export async function runGuidedReviewCommand(io: GuidedReviewCommandIo): Promise<number> {
    const prompt = await io.readStdin();
    if (!prompt.trim()) {
        await io.writeStderr("RunWield Guided Review requires a prompt on stdin.\n");
        return 1;
    }

    const result = await generateGuidedReview(prompt, {
        cwd: getCwd(),
        onUsage: (usage) => io.writeStderr(encodeGuidedReviewUsageEvent(usage)),
    });
    if (result.model)
        await io.writeStderr(
            encodeGuidedReviewMetadata({
                provider: result.provider,
                model: result.model,
                thinkingLevel: result.thinkingLevel,
            }),
        );
    await io.writeStdout(`${result.stdout}\n`);
    return 0;
}

export interface GuidedReviewGenerationOptions {
    cwd: string;
    inMemory?: boolean;
    signal?: AbortSignal;
    onUsage?: (usage: GuidedReviewUsage) => void | Promise<void>;
}

export interface GuidedReviewGenerationResult {
    stdout: string;
    provider: string;
    model?: string;
    thinkingLevel?: string;
}

/** Generate a guide with the normal agent admission; remote callers own no managed Session writer. */
export async function generateGuidedReview(
    prompt: string,
    options: GuidedReviewGenerationOptions,
): Promise<GuidedReviewGenerationResult> {
    options.signal?.throwIfAborted();
    if (!prompt.trim()) throw new Error("RunWield Guided Review requires a prompt.");
    if (options.inMemory) return generateInMemoryGuide(prompt, options);
    const runtime = createSessionRuntime({ ownerProcessKind: "workspace" });
    const sessionId = await runtime.createPromptReadySession({ cwd: options.cwd, agentName: "guide" });
    const pendingUsageWrites: Promise<void>[] = [];
    const unsubscribe = runtime.subscribeSessionEvents(sessionId, (event: RuntimeUsageEventLike) => {
        if (!isRuntimeUsageEvent(event)) return;
        pendingUsageWrites.push(Promise.resolve().then(() => options.onUsage?.(event.usage)));
    });
    try {
        const result = await runtime.promptSession(sessionId, {
            initialRequest: prompt,
            emitInitialEvents: false,
        });
        await Promise.all(pendingUsageWrites);
        if (!result.ok) throw new Error(result.error || "Guided Review generation failed.");
        const output = await runtime.getLastAssistantText(sessionId);
        if (typeof output !== "string" || !output) {
            throw new Error("RunWield Guided Review returned no assistant output.");
        }
        const snapshot = runtime.getSessionSnapshot(sessionId);
        return {
            stdout: output,
            provider: snapshot?.activeModel?.provider || "wld",
            model: snapshot?.activeModel?.model,
            thinkingLevel: snapshot?.thinkingLevel,
        };
    } finally {
        unsubscribe();
        runtime.closeSession(sessionId);
    }
}
