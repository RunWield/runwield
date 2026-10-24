import process from "node:process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ok as assert } from "node:assert/strict";
import { createAssistantMessageEventStream, type AssistantMessage, type ProviderStreams } from "@earendil-works/pi-ai";
import { registerApiProvider, unregisterApiProviders } from "@earendil-works/pi-ai/compat";
import { assertEquals } from "./assertions.ts";
import { writeRuntimeExecutableFixture } from "./runtime-executable-fixture.ts";
import { openOwnerCoordinationStore } from "../shared/owner-coordination/index.js";
import { getModelRegistry } from "../shared/models/model-registry.ts";
import { createRootSessionManager } from "../shared/session/root-session.js";
import { ClaudeCliExecutionSession } from "../shared/session/backends/claude-cli/execution-session.ts";
import { AgyCliExecutionSession } from "../shared/session/backends/agy-cli/execution-session.ts";
import { drainWorkflowMetrics, getWorkflowMetricsFilePath } from "../shared/workflow/metrics.js";
import type { MetricsJournalRow } from "../shared/workflow/metrics-export-record.ts";
import {
    cleanupReviewAgentState,
    createReviewAgentState,
    reviewAgentApi,
} from "../ui/workspace/routes/api/review-agent-handlers.js";
import { createOwnerWorkspaceApp } from "../ui/workspace/server.js";
import type { OwnerUsageReport } from "../ui/workspace/server/owner-usage.ts";

export const PRIVATE_TEXT = "journey-private-prompt-and-code";
export const JOURNEY_PERIOD = { start: "2026-09-01", end: "2026-09-04" };

/** Fixed upstream measurements, not token estimates from the faux provider's prompt serializer. */
export async function configureJourneyModel() {
    await getModelRegistry().getRuntime();
    const responses: AssistantMessage[] = [];
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
if (args.includes("/agents")) {
    const {readdir} = await import("node:fs/promises");
    console.log(JSON.stringify({agents: (await readdir(${JSON.stringify(join(home, ".gemini/config/agents"))}, {withFileTypes:true})).filter(e=>e.isDirectory()).map(e=>({name:e.name}))}));
} else {
    if (args.includes("--agent")) console.log(JSON.stringify({type:"init",agent:args[args.indexOf("--agent")+1],model:"gemini-3.8-flash-low"}));
    else {
        const lines = (await import("node:readline")).createInterface({input:process.stdin});
        await new Promise(resolve=>lines.once("line",resolve));
        lines.close();
    }
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
