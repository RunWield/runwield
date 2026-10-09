import process from "node:process";
import { getCwd } from "../../constants.js";
import { createSessionRuntime } from "../../shared/session/session-runtime.ts";
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
        process.stdout.write(text, (error) => error ? reject(error) : resolve())
    );
}

async function writeDefaultStderr(text: string): Promise<void> {
    await new Promise<void>((resolve, reject) =>
        process.stderr.write(text, (error) => error ? reject(error) : resolve())
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

    const runtime = createSessionRuntime({ ownerProcessKind: "workspace" });
    const sessionId = await runtime.createPromptReadySession({ cwd: getCwd(), agentName: "guide" });
    const pendingUsageWrites: Promise<void>[] = [];
    const unsubscribe = runtime.subscribeSessionEvents(sessionId, (event: RuntimeUsageEventLike) => {
        if (!isRuntimeUsageEvent(event)) return;
        pendingUsageWrites.push(
            Promise.resolve().then(() => io.writeStderr(encodeGuidedReviewUsageEvent(event.usage))),
        );
    });
    try {
        const result = await runtime.promptSession(sessionId, {
            initialRequest: prompt,
            emitInitialEvents: false,
        });
        await Promise.all(pendingUsageWrites);
        if (!result.ok) throw new Error(result.error || "Guided Review generation failed.");
        const output = await runtime.getLastAssistantText(sessionId);
        if (!output) throw new Error("RunWield Guided Review returned no assistant output.");
        const snapshot = runtime.getSessionSnapshot(sessionId);
        if (snapshot?.activeModel?.provider && snapshot.activeModel.model) {
            await io.writeStderr(encodeGuidedReviewMetadata({
                provider: snapshot.activeModel.provider,
                model: snapshot.activeModel.model,
                thinkingLevel: snapshot.thinkingLevel,
            }));
        }
        await io.writeStdout(`${output}\n`);
        return 0;
    } finally {
        unsubscribe();
        runtime.closeSession(sessionId);
    }
}
