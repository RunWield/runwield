import { spawnNativeProcess } from "../../../../shared/foreground-process.ts";
import { isStandaloneExecutable } from "../../../../shared/runtime-identity.ts";
import { captureForegroundProcess } from "../../../../shared/captured-process.ts";
import { getCwd } from "../../../../constants.js";
import process from "node:process";
/** Review-surface background review agent/job routes. */

import {
    parseGuidedReviewMetadataLine,
    parseGuidedReviewUsageEventLine,
} from "../../../../cmd/guided-review/protocol.ts";
import { buildGuidedReviewPrompt, validateGuidedReviewExplainer } from "../../../../shared/workflow/guided-review.js";
import { buildAiReviewPrompt, validateAiReviewResult } from "../../../../shared/standalone-review/ai-review.ts";
import { recordWorkflowMetric } from "../../../../shared/workflow/metrics.js";
import { parseDiffFiles } from "../../../../shared/workflow/review-diff-tool.js";
import { createReviewWidgetStore } from "./review-widget-handlers.js";

/**
 * @typedef {Object} GuideUsageTotals
 * @property {number} inputTokens
 * @property {number} outputTokens
 * @property {number} cacheReadTokens
 * @property {number} cacheWriteTokens
 * @property {number} costUsd
 * @property {number} [contextWindow]
 */

/**
 * @typedef {Object} GuideCostTotals
 * @property {number} usd
 */

/** @typedef {import("../../../../shared/standalone-review/ai-review.ts").AiReviewValue} AiReviewJobResult */

/**
 * @typedef {Object} ReviewGuideJobEntry
 * @property {Record<string, unknown>} info
 * @property {Record<string, unknown> | null} guide
 * @property {AiReviewJobResult | null} [aiReview]
 * @property {boolean[]} reviewed
 * @property {AbortController} abortController
 * @property {Promise<void>} done
 */

/**
 * @typedef {Object} ReviewAgentState
 * @property {boolean} stopped
 * @property {string} token
 * @property {string} cwd
 * @property {Record<string, unknown>} reviewPayload
 * @property {Map<string, ReviewGuideJobEntry>} jobs
 * @property {Set<ReadableStreamDefaultController<Uint8Array>>} streams
 * @property {ReturnType<typeof createReviewWidgetStore>} widgets
 * @property {(prompt: string, signal: AbortSignal, cwd: string, progress?: { onUsage?: (usage: GuideUsageTotals) => void }) => Promise<{ stdout: string, stderr?: string, provider: string, model?: string, thinkingLevel?: string, usage?: GuideUsageTotals, cost?: GuideCostTotals }>} runGuideCommand
 */

/** @typedef {ReviewAgentState["runGuideCommand"]} GuideRunner */

/**
 * @typedef {Object} GuideRunnerSelection
 * @property {GuideRunner} runner
 */

/** @type {GuideRunnerSelection | null} */
let configuredGuideRunner = null;

/** Select the process runner before the review host starts. @param {GuideRunner} runner */
export function configureGuideRunner(runner) {
    if (configuredGuideRunner) throw new Error("Guided Review runner is already configured");
    const selection = { runner };
    configuredGuideRunner = selection;
    return () => {
        if (configuredGuideRunner === selection) configuredGuideRunner = null;
    };
}

/** @returns {GuideRunner} */
export function getGuideRunner() {
    return configuredGuideRunner?.runner || runWldJobCommand;
}

/**
 * @param {{ token: string, cwd: string, reviewPayload: Record<string, unknown>, runGuideCommand: ReviewAgentState["runGuideCommand"] }} options
 * @returns {ReviewAgentState}
 */
export function createReviewAgentState(options) {
    return {
        ...options,
        stopped: false,
        jobs: new Map(),
        streams: new Set(),
        widgets: createReviewWidgetStore(),
        runGuideCommand: options.runGuideCommand,
    };
}

/** @param {ReviewAgentState} state */
export async function cleanupReviewAgentState(state) {
    state.stopped = true;
    for (const entry of state.jobs.values()) entry.abortController.abort("review server stopped");
    for (const controller of state.streams) {
        try {
            controller.close();
        } catch {
            // The client may already have closed its stream.
        }
    }
    state.streams.clear();
    await Promise.allSettled([...state.jobs.values()].map((entry) => entry.done));
    await state.widgets.cleanup();
}

/**
 * @param {Request} request
 * @param {URL} url
 * @param {ReviewAgentState} state
 * @returns {Promise<Response | null>}
 */
export async function reviewAgentApi(request, url, state) {
    if (state.stopped) return new Response("Review stopped.", { status: 503, ...noStore() });
    if (request.method === "GET" && url.pathname === "/api/agents/capabilities") {
        const provider = detectGuideProvider();
        return Response.json(
            {
                mode: "review",
                available: Boolean(provider),
                providers: [
                    ...(state.reviewPayload.standaloneReview
                        ? [
                              {
                                  id: "ai-review",
                                  name: "AI Review",
                                  available: true,
                                  provider: detectAiReviewProvider().provider,
                                  model: detectAiReviewProvider().model,
                                  costAvailable: false,
                              },
                          ]
                        : []),
                    {
                        id: "guide",
                        name: "Guided Review Explainer",
                        available: Boolean(provider),
                        provider: provider?.provider || null,
                        model: provider?.model || null,
                        costAvailable: false,
                    },
                ],
            },
            noStore(),
        );
    }

    if (request.method === "GET" && url.pathname === "/api/agents/jobs") {
        return Response.json({ jobs: snapshotJobs(state), version: state.jobs.size }, noStore());
    }

    if (request.method === "GET" && url.pathname === "/api/agents/jobs/stream") {
        return streamJobs(state);
    }

    if (request.method === "POST" && url.pathname === "/api/agents/jobs") {
        const body = await request.json().catch(() => ({}));
        if (state.stopped) return new Response("Review stopped.", { status: 503, ...noStore() });
        if (
            !body ||
            typeof body !== "object" ||
            Array.isArray(body) ||
            !Object.hasOwn(body, "provider") ||
            !["guide", "ai-review"].includes(body.provider)
        ) {
            return Response.json(
                { error: "Unknown review provider. Use guide or ai-review (standalone only)." },
                {
                    status: 400,
                },
            );
        }
        if (body.provider === "ai-review") {
            if (!state.reviewPayload.standaloneReview) {
                return Response.json(
                    { error: "AI review is available only in Standalone Code Review." },
                    { status: 400 },
                );
            }
            const entry = createAiReviewJob(state);
            return Response.json({ job: entry.info }, { status: 202, headers: noStore().headers });
        }
        const provider = detectGuideProvider();
        if (!provider && !state.reviewPayload.guidedReviewFixture) {
            return Response.json(
                {
                    error: "No Guided Review provider available. Configure RUNWIELD_GUIDED_REVIEW_COMMAND or use RunWield model access.",
                },
                { status: 503 },
            );
        }
        const entry = createGuideJob(state, provider);
        return Response.json({ job: entry.info }, { status: 202, headers: noStore().headers });
    }

    const deleteMatch = /^\/api\/agents\/jobs\/([^/]+)$/.exec(url.pathname);
    if (request.method === "DELETE" && deleteMatch) {
        const entry = state.jobs.get(decodeURIComponent(deleteMatch[1]));
        if (entry && entry.info.status === "running") {
            entry.abortController.abort("Review job killed by reviewer.");
            entry.info.status = "killed";
            entry.info.endedAt = Date.now();
            broadcastJobs(state);
        }
        return Response.json({ ok: true }, noStore());
    }

    const aiReviewMatch = /^\/api\/ai-review\/([^/]+)$/.exec(url.pathname);
    if (request.method === "GET" && aiReviewMatch) {
        const entry = state.jobs.get(decodeURIComponent(aiReviewMatch[1]));
        if (!entry || entry.info.provider !== "ai-review") {
            return Response.json({ error: "AI review not found" }, { status: 404 });
        }
        if (entry.info.status !== "done" || !entry.aiReview) {
            return Response.json(
                { error: entry.info.error || "AI review is not ready", job: withElapsed(entry.info) },
                {
                    status: entry.info.status === "failed" ? 422 : 202,
                    headers: noStore().headers,
                },
            );
        }
        return Response.json(entry.aiReview, noStore());
    }

    const guideMatch = /^\/api\/guide\/([^/]+)$/.exec(url.pathname);
    if (request.method === "GET" && guideMatch) {
        const entry = state.jobs.get(decodeURIComponent(guideMatch[1]));
        if (!entry) return Response.json({ error: "Guide not found" }, { status: 404 });
        if (entry.info.status !== "done" || !entry.guide) {
            return Response.json(
                { error: entry.info.error || "Guide is not ready", job: entry.info },
                {
                    status: entry.info.status === "failed" ? 422 : 202,
                },
            );
        }
        return Response.json({ ...entry.guide, reviewed: entry.reviewed }, noStore());
    }

    const reviewedMatch = /^\/api\/guide\/([^/]+)\/reviewed$/.exec(url.pathname);
    if (request.method === "PUT" && reviewedMatch) {
        const entry = state.jobs.get(decodeURIComponent(reviewedMatch[1]));
        if (!entry) return Response.json({ error: "Guide not found" }, { status: 404 });
        const body = await request.json().catch(() => ({}));
        entry.reviewed = Array.isArray(body.reviewed) ? body.reviewed.map(Boolean) : [];
        return Response.json({ ok: true }, noStore());
    }

    return null;
}

/** @param {ReviewAgentState} state @param {{ provider: string, model?: string } | null} provider */
function createGuideJob(state, provider) {
    const id = crypto.randomUUID();
    const now = Date.now();
    const changedFiles = parseDiffFiles(String(state.reviewPayload.rawPatch || "")).map((entry) => entry.path);
    const abortController = new AbortController();
    const info = {
        id,
        source: `guide-${id.slice(0, 8)}`,
        provider: "guide",
        label: "Guided Review Explainer",
        status: "running",
        startedAt: now,
        endedAt: null,
        command: provider ? [provider.provider, "guided-review"] : ["fixture"],
        cwd:
            typeof state.reviewPayload.agentCwd === "string" && state.reviewPayload.agentCwd.trim()
                ? state.reviewPayload.agentCwd
                : state.cwd,
        engine: provider?.provider || "fixture",
        model: provider?.model || "unknown",
        usageState: provider?.provider === "wld" ? "pending" : "unavailable",
        tokens: null,
        cost: null,
        costUnavailable: true,
    };
    /** @type {ReviewGuideJobEntry} */
    const entry = { info, guide: null, reviewed: [], abortController, done: Promise.resolve() };
    state.jobs.set(id, entry);
    broadcastJobs(state);
    entry.done = runGuideJob(state, entry, changedFiles);
    return entry;
}

/** @param {ReviewAgentState} state */
function createAiReviewJob(state) {
    const id = crypto.randomUUID();
    const provider = detectAiReviewProvider();
    const cwd =
        typeof state.reviewPayload.agentCwd === "string" && state.reviewPayload.agentCwd.trim()
            ? state.reviewPayload.agentCwd
            : state.cwd;
    const rawPatch = String(state.reviewPayload.rawPatch || "");
    const info = {
        id,
        source: `ai-review-${id.slice(0, 8)}`,
        provider: "ai-review",
        label: "AI Review",
        status: "running",
        startedAt: Date.now(),
        endedAt: null,
        command: [provider.provider, "ai-review"],
        cwd,
        engine: provider.provider,
        model: provider.model,
        usageState: provider.provider === "wld" ? "pending" : "unavailable",
        tokens: null,
        cost: null,
        costUnavailable: true,
    };
    /** @type {ReviewGuideJobEntry} */
    const entry = {
        info,
        guide: null,
        aiReview: null,
        reviewed: [],
        abortController: new AbortController(),
        done: Promise.resolve(),
    };
    state.jobs.set(id, entry);
    broadcastJobs(state);
    // Capture all target data before prompt expansion yields to a refresh.
    const standalone = state.reviewPayload.standaloneReview;
    const target = {
        headRef:
            standalone && typeof standalone === "object" && "headRef" in standalone ? standalone.headRef : undefined,
        mode: standalone && typeof standalone === "object" && "mode" in standalone ? standalone.mode : undefined,
        baseLabel:
            standalone && typeof standalone === "object" && "baseLabel" in standalone
                ? standalone.baseLabel
                : undefined,
    };
    entry.done = runAiReviewJob(state, entry, {
        rawPatch,
        mode:
            target.mode === "uncommitted"
                ? "uncommitted"
                : typeof target.headRef === "string"
                  ? String(target.mode)
                  : "worktree",
        gitRef: typeof target.headRef === "string" ? target.headRef : "HEAD",
        baseLabel: typeof target.baseLabel === "string" ? target.baseLabel : "",
        reviewContext: readStandaloneReviewContext(standalone),
    });
    return entry;
}

/**
 * @typedef {Object} AiReviewJobTarget
 * @property {string} rawPatch
 * @property {string} mode
 * @property {string} gitRef
 * @property {string} baseLabel
 * @property {string} reviewContext
 */

/** @param {ReviewAgentState} state @param {ReviewGuideJobEntry} entry @param {AiReviewJobTarget} target */
async function runAiReviewJob(state, entry, target) {
    try {
        const prompt = await buildAiReviewPrompt({ ...target, diffText: target.rawPatch, cwd: String(entry.info.cwd) });
        entry.abortController.signal.throwIfAborted();
        const result = await runWldJobCommand(
            prompt,
            entry.abortController.signal,
            String(entry.info.cwd),
            {
                onUsage: (usage) => addGuideJobUsage(state, entry, usage),
            },
            "ai-review",
            "RUNWIELD_AI_REVIEW_COMMAND",
        );
        entry.abortController.signal.throwIfAborted();
        if (result.usage && entry.info.usageState !== "available") setGuideJobUsage(state, entry, result.usage);
        entry.info.providerName = result.provider;
        entry.info.model = result.model || entry.info.model;
        entry.info.thinkingLevel = result.thinkingLevel;
        const validation = validateAiReviewResult(result.stdout, { rawPatch: target.rawPatch });
        if (!validation.ok) throw new Error(validation.error);
        entry.aiReview = validation.value;
        entry.info.status = "done";
        entry.info.summary = { counts: validation.value.counts, specSource: validation.value.specSource };
    } catch (error) {
        entry.info.status = entry.abortController.signal.aborted ? "killed" : "failed";
        entry.info.error = error instanceof Error ? error.message : String(error);
    } finally {
        finishGuideJobUsage(entry);
        entry.info.endedAt = Date.now();
        await recordGuideJobMetric(state, entry);
        broadcastJobs(state);
    }
}

/** @returns {GuideUsageTotals} */
function emptyGuideUsageTotals() {
    return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 };
}

/** @param {Record<string, unknown> | null} tokens */
function readGuideUsageTotals(tokens) {
    if (!tokens) return emptyGuideUsageTotals();
    return {
        inputTokens: Number(tokens.inputTokens || 0),
        outputTokens: Number(tokens.outputTokens || 0),
        cacheReadTokens: Number(tokens.cacheReadTokens || 0),
        cacheWriteTokens: Number(tokens.cacheWriteTokens || 0),
        costUsd: Number(tokens.costUsd || 0),
        ...(typeof tokens.contextWindow === "number" ? { contextWindow: tokens.contextWindow } : {}),
    };
}

/** @param {ReviewAgentState} state @param {ReviewGuideJobEntry} entry @param {GuideUsageTotals} usage */
function addGuideJobUsage(state, entry, usage) {
    const current = readGuideUsageTotals(
        entry.info.tokens && typeof entry.info.tokens === "object"
            ? /** @type {Record<string, unknown>} */ (entry.info.tokens)
            : null,
    );
    const next = {
        inputTokens: current.inputTokens + usage.inputTokens,
        outputTokens: current.outputTokens + usage.outputTokens,
        cacheReadTokens: current.cacheReadTokens + usage.cacheReadTokens,
        cacheWriteTokens: current.cacheWriteTokens + usage.cacheWriteTokens,
        costUsd: current.costUsd + usage.costUsd,
        ...(typeof usage.contextWindow === "number" ? { contextWindow: usage.contextWindow } : {}),
    };
    setGuideJobUsage(state, entry, next);
}

/** @param {ReviewAgentState} state @param {ReviewGuideJobEntry} entry @param {GuideUsageTotals} usage */
function setGuideJobUsage(state, entry, usage) {
    entry.info.usageState = "available";
    entry.info.tokens = usage;
    entry.info.cost = { usd: usage.costUsd };
    entry.info.costUnavailable = false;
    broadcastJobs(state);
}

/** @param {ReviewGuideJobEntry} entry */
function finishGuideJobUsage(entry) {
    if (entry.info.usageState === "pending") {
        entry.info.usageState = "unavailable";
        entry.info.costUnavailable = true;
    }
}

/** @param {ReviewAgentState} state @param {ReviewGuideJobEntry} entry @param {string[]} changedFiles */
async function runGuideJob(state, entry, changedFiles) {
    try {
        let raw;
        /** @type {import("../../../../cmd/guided-review/protocol.ts").GuidedReviewMetadata} */
        let meta = { provider: String(entry.info.engine), model: String(entry.info.model) };
        if (state.reviewPayload.guidedReviewFixture) {
            raw = JSON.stringify(state.reviewPayload.guidedReviewFixture);
            meta = { provider: "fixture", model: "dev-fixture" };
        } else {
            const prompt = buildGuidedReviewPrompt({
                diffText: String(state.reviewPayload.rawPatch || ""),
                gitRef:
                    typeof state.reviewPayload.gitRef === "string"
                        ? state.reviewPayload.gitRef
                        : "RunWield code review diff",
                changedFiles,
                reviewContext: readStandaloneReviewContext(state.reviewPayload.standaloneReview),
                planContent: typeof state.reviewPayload.planContent === "string" ? state.reviewPayload.planContent : "",
                planAttrs:
                    state.reviewPayload.planAttrs && typeof state.reviewPayload.planAttrs === "object"
                        ? /** @type {Record<string, unknown>} */ (state.reviewPayload.planAttrs)
                        : {},
            });
            const result = await state.runGuideCommand(prompt, entry.abortController.signal, String(entry.info.cwd), {
                onUsage: (usage) => addGuideJobUsage(state, entry, usage),
            });
            raw = result.stdout;
            meta = {
                provider: result.provider,
                model: result.model || String(entry.info.model),
                thinkingLevel: result.thinkingLevel,
            };
            if (result.usage && entry.info.usageState !== "available") setGuideJobUsage(state, entry, result.usage);
        }
        finishGuideJobUsage(entry);
        const parsed = parseJsonFromModel(raw);
        const validation = validateGuidedReviewExplainer(parsed, { changedFiles });
        if (!validation.ok) throw new Error(validation.errors.join("; "));
        const guide = await state.widgets.registerGuideWidgets(validation.value, entry.info.id);
        entry.guide = guide;
        entry.info.status = "done";
        entry.info.providerName = meta.provider;
        entry.info.model = meta.model || entry.info.model;
        entry.info.thinkingLevel = meta.thinkingLevel;
        entry.info.endedAt = Date.now();
        entry.info.summary = {
            correctness: "Guide Generated",
            explanation: `${Array.isArray(guide.sections) ? guide.sections.length : 0} sections`,
            confidence: 1,
        };
    } catch (error) {
        if (entry.abortController.signal.aborted && entry.info.status === "killed") {
            finishGuideJobUsage(entry);
            return;
        }
        finishGuideJobUsage(entry);
        entry.info.status = entry.abortController.signal.aborted ? "killed" : "failed";
        entry.info.error = error instanceof Error ? error.message : String(error);
        entry.info.endedAt = Date.now();
    } finally {
        await recordGuideJobMetric(state, entry);
        broadcastJobs(state);
    }
}

/** @param {ReviewAgentState} state @param {ReviewGuideJobEntry} entry */
async function recordGuideJobMetric(state, entry) {
    const info = /** @type {Record<string, unknown>} */ (withElapsed(entry.info));
    await recordWorkflowMetric(
        {
            category: "validation",
            event: info.provider === "ai-review" ? "ai_review_generation_result" : "guided_review_generation_result",
            details: {
                status: info.status,
                provider: info.providerName || info.engine,
                model: info.model,
                elapsedMs: info.elapsedMs,
                tokensAvailable: Boolean(info.tokens),
                costAvailable: Boolean(info.cost),
                costUnavailable: Boolean(info.costUnavailable),
                ...(info.provider === "ai-review"
                    ? {
                          annotationCount:
                              entry.aiReview && Array.isArray(entry.aiReview.annotations)
                                  ? entry.aiReview.annotations.length
                                  : 0,
                          counts: entry.aiReview?.counts || null,
                      }
                    : {
                          sectionCount:
                              entry.guide && Array.isArray(entry.guide.sections) ? entry.guide.sections.length : 0,
                      }),
                hasError: typeof info.error === "string" && info.error.length > 0,
                errorKind: classifyGuideJobError(info.error),
            },
        },
        state.cwd,
    );
}

/** @param {unknown} error */
function classifyGuideJobError(error) {
    if (typeof error !== "string" || !error) return null;
    if (/not JSON|JSON/i.test(error)) return "invalid_json";
    if (/no output|empty/i.test(error)) return "empty_output";
    if (/schemaVersion|sections|blocks|changed file|unsupported|widget|role/i.test(error)) return "schema_invalid";
    if (/killed|aborted|abort/i.test(error)) return "aborted";
    return "provider_failed";
}

/** @param {ReviewAgentState} state */
function snapshotJobs(state) {
    return [...state.jobs.values()].map((entry) => withElapsed(entry.info));
}

/** @param {Record<string, unknown>} info */
function withElapsed(info) {
    const started = typeof info.startedAt === "number" ? info.startedAt : Date.now();
    const ended = typeof info.endedAt === "number" ? info.endedAt : Date.now();
    return { ...info, elapsedMs: Math.max(0, ended - started) };
}

/** @param {ReviewAgentState} state */
function streamJobs(state) {
    const encoder = new TextEncoder();
    const body = new ReadableStream({
        start(controller) {
            state.streams.add(controller);
            controller.enqueue(
                encoder.encode(`data: ${JSON.stringify({ type: "snapshot", jobs: snapshotJobs(state) })}\n\n`),
            );
        },
        cancel() {
            // Controllers are removed lazily on next broadcast if already closed.
        },
    });
    return new Response(body, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } });
}

/** @param {ReviewAgentState} state */
function broadcastJobs(state) {
    const encoder = new TextEncoder();
    const payload = encoder.encode(`data: ${JSON.stringify({ type: "snapshot", jobs: snapshotJobs(state) })}\n\n`);
    for (const controller of [...state.streams]) {
        try {
            controller.enqueue(payload);
        } catch {
            state.streams.delete(controller);
        }
    }
}

/** @param {string} raw */
function parseJsonFromModel(raw) {
    const text = raw.trim();
    if (!text) throw new Error("Guide provider returned no output.");
    try {
        return JSON.parse(text);
    } catch {
        const match = /```(?:json)?\s*([\s\S]*?)```/.exec(text) || /(\{[\s\S]*\})/.exec(text);
        if (!match) throw new Error("Guide provider output was not JSON.");
        return JSON.parse(match[1]);
    }
}

function detectAiReviewProvider() {
    return {
        provider: process.env["RUNWIELD_AI_REVIEW_COMMAND"] ? "custom" : "wld",
        model:
            process.env["RUNWIELD_AI_REVIEW_MODEL"] ||
            (process.env["RUNWIELD_AI_REVIEW_COMMAND"] ? "configured-command" : "wld"),
    };
}

function detectGuideProvider() {
    const configured = process.env["RUNWIELD_GUIDED_REVIEW_COMMAND"];
    if (configured) {
        return { provider: "custom", model: process.env["RUNWIELD_GUIDED_REVIEW_MODEL"] || "configured-command" };
    }
    return { provider: "wld", model: process.env["RUNWIELD_GUIDED_REVIEW_MODEL"] || "wld" };
}

/** @param {ReadableStream<Uint8Array>} stream */
async function readStreamText(stream) {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let text = "";
    try {
        while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            text += decoder.decode(value, { stream: true });
        }
        text += decoder.decode();
        return text;
    } finally {
        reader.releaseLock();
    }
}

/**
 * @typedef {Object} GuideStderrReadResult
 * @property {string} stderr
 * @property {GuideUsageTotals} [usage]
 * @property {import("../../../../cmd/guided-review/protocol.ts").GuidedReviewMetadata} [metadata]
 * @property {Error} [protocolError]
 */

/**
 * @param {ReadableStream<Uint8Array>} stream
 * @param {boolean} parseInternalFrames
 * @param {{ onUsage?: (usage: GuideUsageTotals) => void }} progress
 * @returns {Promise<GuideStderrReadResult>}
 */
async function readGuideStderr(stream, parseInternalFrames, progress) {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffered = "";
    let stderr = "";
    /** @type {GuideUsageTotals | null} */
    let usage = null;
    /** @type {Error | null} */
    let protocolError = null;
    /** @type {import("../../../../cmd/guided-review/protocol.ts").GuidedReviewMetadata | null} */
    let metadata = null;
    /** @param {string} line */
    function handleLine(line) {
        if (!parseInternalFrames) {
            stderr += `${line}\n`;
            return;
        }
        let event;
        try {
            const details = parseGuidedReviewMetadataLine(line);
            if (details) {
                metadata = details;
                return;
            }
            event = parseGuidedReviewUsageEventLine(line);
        } catch (error) {
            protocolError = error instanceof Error ? error : new Error(String(error));
            return;
        }
        if (!event) {
            stderr += `${line}\n`;
            return;
        }
        usage = usage || emptyGuideUsageTotals();
        usage.inputTokens += event.usage.inputTokens;
        usage.outputTokens += event.usage.outputTokens;
        usage.cacheReadTokens += event.usage.cacheReadTokens;
        usage.cacheWriteTokens += event.usage.cacheWriteTokens;
        usage.costUsd += event.usage.costUsd;
        if (typeof event.usage.contextWindow === "number") usage.contextWindow = event.usage.contextWindow;
        progress.onUsage?.(event.usage);
    }
    try {
        while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            buffered += decoder.decode(value, { stream: true });
            let newlineIndex = buffered.indexOf("\n");
            while (newlineIndex >= 0) {
                handleLine(buffered.slice(0, newlineIndex).replace(/\r$/, ""));
                buffered = buffered.slice(newlineIndex + 1);
                newlineIndex = buffered.indexOf("\n");
            }
        }
        buffered += decoder.decode();
        if (buffered) handleLine(buffered.replace(/\r$/, ""));
        return {
            stderr,
            ...(usage ? { usage } : {}),
            ...(metadata ? { metadata } : {}),
            ...(protocolError ? { protocolError } : {}),
        };
    } finally {
        reader.releaseLock();
    }
}

/** @param {WritableStream<Uint8Array>} stdin @param {string} prompt */
async function writeGuidePrompt(stdin, prompt) {
    const writer = stdin.getWriter();
    try {
        await writer.write(new TextEncoder().encode(prompt));
        await writer.close();
    } finally {
        writer.releaseLock();
    }
}

/**
 * @param {string} prompt
 * @param {AbortSignal} signal
 * @param {string} cwd
 * @param {{ onUsage?: (usage: GuideUsageTotals) => void }} [progress]
 * @param {"guided-review" | "ai-review"} [subcommand]
 * @param {string} [overrideVariable]
 */
export async function runWldJobCommand(
    prompt,
    signal,
    cwd,
    progress = {},
    subcommand = "guided-review",
    overrideVariable = "RUNWIELD_GUIDED_REVIEW_COMMAND",
) {
    const configured = process.env[overrideVariable];
    const modelVariable = overrideVariable.replace(/_COMMAND$/, "_MODEL");
    const command = configured ? shellCommand(configured) : await resolveRunWieldJobCommand(cwd, subcommand);
    const provider = configured ? "custom" : "wld";
    const child = spawnNativeProcess(command.command, {
        args: command.args,
        windowsRawArguments: Boolean(configured) && process.platform === "win32",
        stdin: "piped",
        stdout: "piped",
        stderr: "piped",
        cwd,
        signal,
    });
    const results = await Promise.allSettled([
        child.status,
        readStreamText(child.stdout),
        readGuideStderr(child.stderr, provider === "wld", progress),
        writeGuidePrompt(child.stdin, prompt),
    ]);
    signal.throwIfAborted();
    const [statusResult, stdoutResult, stderrResult, inputResult] = results;
    if (statusResult.status === "rejected") throw statusResult.reason;
    if (stdoutResult.status === "rejected") throw stdoutResult.reason;
    if (stderrResult.status === "rejected") throw stderrResult.reason;
    if (stderrResult.value.protocolError) throw stderrResult.value.protocolError;
    if (!statusResult.value.success) {
        throw new Error(
            stderrResult.value.stderr.trim() || `${subcommand} provider exited with ${statusResult.value.code}`,
        );
    }
    if (inputResult.status === "rejected") throw inputResult.reason;
    return {
        stdout: stdoutResult.value,
        stderr: stderrResult.value.stderr,
        provider: stderrResult.value.metadata?.provider || provider,
        model:
            stderrResult.value.metadata?.model ||
            process.env[modelVariable] ||
            (configured ? "configured-command" : "wld"),
        thinkingLevel: stderrResult.value.metadata?.thinkingLevel,
        ...(stderrResult.value.usage
            ? { usage: stderrResult.value.usage, cost: { usd: stderrResult.value.usage.costUsd } }
            : {}),
    };
}

/** @param {string} cwd @param {string} subcommand */
async function resolveRunWieldJobCommand(cwd, subcommand) {
    // Private job commands must use the running binary, not a different installed version.
    if (isStandaloneExecutable()) return { command: process.execPath, args: [subcommand] };
    if (await commandExists("wld")) return { command: "wld", args: [subcommand] };
    return {
        command: process.execPath,
        args: isStandaloneExecutable() ? [subcommand] : ["run", ...[], "src/cli.ts", subcommand],
        cwd,
    };
}

/** @param {string} command */
async function commandExists(command) {
    const which = process.platform === "win32" ? "where" : "which";
    const output = await captureForegroundProcess(which, { args: [command], cwd: getCwd() }).catch(() => ({
        success: false,
    }));
    return Boolean(output.success);
}

/** @param {string} configured */
function shellCommand(configured) {
    return process.platform === "win32"
        ? { command: "cmd", args: ["/d", "/s", "/c", `"${configured}"`] }
        : { command: "sh", args: ["-lc", configured] };
}

function noStore() {
    return { headers: { "cache-control": "no-store" } };
}

/** @param {unknown} value */
function readStandaloneReviewContext(value) {
    if (!value || typeof value !== "object" || !("reviewContext" in value)) return "";
    return typeof value.reviewContext === "string" ? value.reviewContext : "";
}
