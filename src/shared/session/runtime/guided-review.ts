import { SessionManager } from "@earendil-works/pi-coding-agent";
import { buildAgentSession } from "../session.js";
import { normalizeRuntimeUsage } from "../session-runtime-events.js";

interface InMemoryGuideOptions {
    cwd: string;
    signal?: AbortSignal;
    onUsage?: (usage: import("../session-runtime-events.js").RuntimeUsage) => void | Promise<void>;
}

interface InMemoryGuideResult {
    stdout: string;
    provider: string;
    model: string;
    thinkingLevel?: string;
}

export async function generateInMemoryGuide(
    prompt: string,
    options: InMemoryGuideOptions,
): Promise<InMemoryGuideResult> {
    const { session, resolvedModel, resolvedThinkingLevel } = await buildAgentSession({
        agentName: "guide",
        cwd: options.cwd,
        sessionManager: SessionManager.inMemory(options.cwd),
    });
    const pendingUsageWrites: Promise<void>[] = [];
    const unsubscribe = session.subscribe((event) => {
        if (event.type !== "message_end" || event.message.role !== "assistant") return;
        const usage = event.message.usage;
        pendingUsageWrites.push(Promise.resolve().then(() => options.onUsage?.(normalizeRuntimeUsage(usage))));
    });
    const abort = () => {
        void session.abort();
    };
    options.signal?.addEventListener("abort", abort, { once: true });
    try {
        options.signal?.throwIfAborted();
        await session.prompt(prompt);
        await Promise.all(pendingUsageWrites);
        options.signal?.throwIfAborted();
        const message = session.messages.findLast((entry) => entry.role === "assistant");
        if (message?.role === "assistant" && message.stopReason === "error") {
            throw new Error(message.errorMessage || "Guided Review generation failed.");
        }
        const output =
            message?.role === "assistant"
                ? message.content
                      .filter((block) => block.type === "text")
                      .map((block) => block.text)
                      .join("\n")
                : "";
        if (!output) throw new Error("RunWield Guided Review returned no assistant output.");
        return {
            stdout: output,
            provider: resolvedModel.provider,
            model: resolvedModel.id,
            thinkingLevel: resolvedThinkingLevel,
        };
    } finally {
        options.signal?.removeEventListener("abort", abort);
        unsubscribe();
        session.dispose();
    }
}
