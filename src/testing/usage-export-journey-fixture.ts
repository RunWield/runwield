import process from "node:process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ok as assert } from "node:assert/strict";
import {
    fauxAssistantMessage,
    createAssistantMessageEventStream,
    type AssistantMessage,
    type ProviderStreams,
} from "@earendil-works/pi-ai";
import { registerApiProvider, unregisterApiProviders } from "@earendil-works/pi-ai/compat";
import { assertEquals } from "./assertions.ts";
import { writeRuntimeExecutableFixture } from "./runtime-executable-fixture.ts";
import { openOwnerCoordinationStore } from "../shared/owner-coordination/index.ts";
import { getModelRegistry } from "../shared/models/model-registry.ts";
import { createRootSessionManager } from "../shared/session/root-session.ts";
import { ClaudeCliExecutionSession } from "../shared/session/backends/claude-cli/execution-session.ts";
import { AgyCliExecutionSession } from "../shared/session/backends/agy-cli/execution-session.ts";
import { drainWorkflowMetrics, getWorkflowMetricsFilePath } from "../shared/workflow/metrics.ts";
import type { MetricsJournalRow } from "../shared/workflow/metrics-export-record.ts";
import {
    cleanupReviewAgentState,
    createReviewAgentState,
    reviewAgentApi,
} from "../ui/workspace/routes/api/review-agent-handlers.ts";
import { createOwnerWorkspaceApp } from "../ui/workspace/server.ts";
import type { OwnerUsageReport } from "../ui/workspace/server/owner-usage.ts";

export const PRIVATE_TEXT = "journey-private-prompt-and-code";
export const JOURNEY_PERIOD = { start: "2026-09-01", end: "2026-09-04" };

/** Fixed upstream measurements, not token estimates from the faux provider's prompt serializer. */
export async function configureJourneyModel() {
    await getModelRegistry().getRuntime();
    const responses: AssistantMessage[] = [];
    let interrupt: (() => void) | undefined;
    const stream: ProviderStreams["streamSimple"] = (model) => {
        const response = responses.shift();
        assert(response, "No journey model response queued");
        const message: AssistantMessage = {
            ...response,
            api: model.api,
            provider: model.provider,
            model: model.id,
            usage: {
                input: 11,
                output: 3,
                cacheRead: 2,
                cacheWrite: 0,
                totalTokens: 16,
                cost: { input: 0.1, output: 0.02, cacheRead: 0.005, cacheWrite: 0, total: 0.125 },
            },
        };
        const events = createAssistantMessageEventStream();
        queueMicrotask(() => {
            const cancel = interrupt;
            interrupt = undefined;
            cancel?.();
            events.push({ type: "done", reason: "stop", message });
            events.end();
        });
        return events;
    };
    registerApiProvider({ api: "runtime-command-faux", stream, streamSimple: stream }, "usage-journey");
    return {
        respond(...messages: AssistantMessage[]) {
            responses.push(...messages);
        },
        interruptNext(cancel: () => void) {
            interrupt = cancel;
            responses.push({ ...fauxAssistantMessage("Interrupted execution"), timestamp: Date.now() });
        },
        dispose() {
            unregisterApiProviders("usage-journey");
            assertEquals(responses.length, 0, "Every scripted response must be consumed");
        },
    };
}

/** The only CLI stand-in: replay pinned upstream streams through the real executables' boundary. */
export async function runJourneyCli(home: string, root: string, backend: "claude-cli" | "agy-cli") {
    const bin = join(home, "journey-bin");
    await mkdir(bin, { recursive: true });
    const fixture =
        backend === "claude-cli"
            ? "claude-cli/fixtures/claude-2.1.284-read-tool-stream.jsonl"
            : "agy-cli/fixtures/agy-1.2.12-tool-stream.jsonl";
    const vendor = await readFile(new URL(`../shared/session/backends/${fixture}`, import.meta.url), "utf8");
    const script = join(bin, `${backend}.ts`);
    await writeFile(
        script,
        `
const args = process.argv.slice(2);
if (args[0] === "acp") {
    if (args.includes("-p") || args.includes("--dangerously-skip-permissions")) throw new Error("unsafe legacy invocation");
    const lines = (await import("node:readline")).createInterface({ input: (await import("node:process")).stdin });
    const send = (frame) => console.log(JSON.stringify({ jsonrpc: "2.0", ...frame }));
    const sessionId = "usage-session";
    const selected = { mode: "default", model: "gemini-3.8-flash", thought_level: "low" };
    const config = () => ({ configOptions: Object.entries(selected).map(([id,currentValue]) => ({ id,currentValue })) });
    const update = (value) => send({ method: "session/update", params: { sessionId, update: value } });
    for await (const line of lines) {
        const request = JSON.parse(line);
        const respond = (result) => send({ id: request.id, result });
        if (request.method === "initialize") respond({ protocolVersion: 1 });
        else if (request.method === "session/new") respond({ sessionId, ...config() });
        else if (request.method === "session/set_config_option") {
            selected[request.params.configId] = request.params.value;
            respond(config());
        } else if (request.method === "session/prompt") {
            const frames = ${JSON.stringify(vendor)}.trim().split("\\n").map(JSON.parse);
            const resultFrame = frames.find((frame) => (frame.event || frame.type) === "result");
            const result = typeof resultFrame.result === "object" ? resultFrame.result : resultFrame;
            const usage = result.usage || {};
            update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: result.response || (typeof result.result === "string" ? result.result : "reply") } });
            for (const frame of frames) {
                const step = frame.step_update;
                if (step?.step_type !== "tool") continue;
                update({ sessionUpdate: "tool_call_update", toolCallId: String(step.step_index), name: step.tool_name || step.tool_info?.name || "read_file", status: step.state === "ACTIVE" ? "in_progress" : step.state === "ERROR" ? "failed" : "completed", rawInput: step.tool_info?.parameters || {} });
            }
            // Translate captured legacy measurements into ACP fields without
            // supplying defaults: missing and measured zero remain distinct.
            respond({ stopReason: "end_turn", usage: {
                inputTokens: usage.input_tokens, outputTokens: usage.output_tokens,
                cachedReadTokens: usage.cache_read_tokens, cachedWriteTokens: usage.cache_write_tokens,
                thoughtTokens: usage.thinking_tokens,
            } });
        } else if (request.method === "session/close") { respond({}); lines.close(); break; }
        else throw new Error("Unexpected ACP request: " + request.method);
    }
} else {
    const lines = (await import("node:readline")).createInterface({input:process.stdin});
    await new Promise(resolve=>lines.once("line",resolve));
    lines.close();
    console.log(${JSON.stringify(vendor)});
}
`,
    );
    await writeRuntimeExecutableFixture(join(bin, backend === "claude-cli" ? "claude" : "agy"), script);
    const previousPath = process.env.PATH;
    process.env.PATH = `${bin}${process.platform === "win32" ? ";" : ":"}${previousPath || ""}`;
    try {
        const model = getModelRegistry().find(backend, backend === "claude-cli" ? "sonnet" : "gemini-3.8-flash");
        assert(model);
        const options = {
            cwd: root,
            agentName: "Guide",
            agentDisplayName: "Guide",
            finalSystemPrompt: `${PRIVATE_TEXT} system instructions`,
            model,
            sessionManager: await createRootSessionManager("new", root),
        };
        const session =
            backend === "claude-cli"
                ? new ClaudeCliExecutionSession(options)
                : await AgyCliExecutionSession.create(options);
        try {
            await session.runTurn({ userRequest: PRIVATE_TEXT });
        } finally {
            await session.dispose();
        }
    } finally {
        if (previousPath === undefined) delete process.env.PATH;
        else process.env.PATH = previousPath;
    }
}

/** Real job handling and aggregate writer; only the external guide command is scripted. */
export async function runJourneyGuide(root: string) {
    const previous = process.env.RUNWIELD_GUIDED_REVIEW_COMMAND;
    const state = createReviewAgentState({
        cwd: root,
        token: "journey-guide-token",
        reviewPayload: {
            rawPatch: `diff --git a/src/a.js b/src/a.js\n--- a/src/a.js\n+++ b/src/a.js\n@@ -1 +1,2 @@\n export const a = 1;\n+export const b = 2;\n`,
        },
        runGuideCommand: (_prompt, _signal, _cwd, progress) => {
            progress?.onUsage?.({
                inputTokens: 12,
                outputTokens: 3,
                cacheReadTokens: 0,
                cacheWriteTokens: 0,
                costUsd: 1,
            });
            progress?.onUsage?.({
                inputTokens: 12,
                outputTokens: 3,
                cacheReadTokens: 0,
                cacheWriteTokens: 0,
                costUsd: null,
            });
            return Promise.resolve({
                provider: "journey-guide",
                model: "guide-model",
                stdout: JSON.stringify({
                    schemaVersion: "1.0",
                    title: "Guide",
                    sections: [
                        {
                            title: "Core",
                            role: "core",
                            blocks: [{ type: "diff", file: "src/a.js", summary: PRIVATE_TEXT }],
                        },
                    ],
                    everythingElse: [],
                }),
            });
        },
    });
    process.env.RUNWIELD_GUIDED_REVIEW_COMMAND = "journey-external-guide";
    try {
        const url = new URL("http://localhost/api/agents/jobs");
        const response = await reviewAgentApi(
            new Request(url, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ provider: "guide" }),
            }),
            url,
            state,
        );
        assert(response);
        const { job } = await response.json();
        await state.jobs.get(job.id)?.done;
        assertEquals(state.jobs.get(job.id)?.info.status, "done");
    } finally {
        if (previous === undefined) delete process.env.RUNWIELD_GUIDED_REVIEW_COMMAND;
        else process.env.RUNWIELD_GUIDED_REVIEW_COMMAND = previous;
        await cleanupReviewAgentState(state);
    }
}

export async function journeyRows(root: string): Promise<MetricsJournalRow[]> {
    await drainWorkflowMetrics();
    return (await readFile(getWorkflowMetricsFilePath(root), "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
}

/** Pair with the real owner API on each host, including after a fresh-process restart. */
export async function readJourneyReport(home: string, root: string): Promise<OwnerUsageReport> {
    const store = openOwnerCoordinationStore({ dbPath: join(home, "journey-owner.sqlite3") });
    store.registerProject({ root, displayName: "Journey" });
    const origin = "http://127.0.0.1:8787";
    const app = createOwnerWorkspaceApp({ mode: "owner", publicOrigin: origin, store });
    try {
        const pairing = store.createPairingRequest();
        store.approvePairingRequest(pairing.code);
        const device = store.claimPairingRequest(pairing.proof);
        const response = await app.handler()(
            new Request(`${origin}/api/owner/usage?${new URLSearchParams(JOURNEY_PERIOD)}`, {
                headers: { cookie: `rw_owner_device=${encodeURIComponent(device.credential)}` },
            }),
        );
        assertEquals(response.status, 200);
        return await response.json();
    } finally {
        await app.close();
        store.close();
    }
}
