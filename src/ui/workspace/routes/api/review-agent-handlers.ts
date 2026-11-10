/** Review-surface background review agent/job routes. */

import { spawnNativeProcess } from "../../../../shared/foreground-process.ts";
import { isStandaloneExecutable } from "../../../../shared/runtime-identity.ts";
import { captureForegroundProcess } from "../../../../shared/captured-process.ts";
import { getCwd } from "../../../../constants.ts";
import process from "node:process";
import {
    GUIDED_REVIEW_EVENT_PREFIX,
    type GuidedReviewMetadata,
    type GuidedReviewUsage as GuideUsageTotals,
    GUIDED_REVIEW_USAGE_VERSION,
    parseGuidedReviewMetadataLine,
    parseGuidedReviewUsageEventLine,
} from "../../../../cmd/guided-review/protocol.ts";
import {
    buildGuidedReviewPrompt,
    validateGuidedReviewExplainer,
    type GuidedReviewPlanAttributes,
} from "../../../../shared/workflow/guided-review.ts";
import { RuntimeUsageTotals, type UsageAvailability } from "../../../../shared/session/runtime-usage-totals.ts";
import { ExecutionMetricsRecorder } from "../../../../shared/workflow/execution-metrics.ts";
import {
    buildAiReviewPrompt,
    validateAiReviewResult,
    type AiReviewValue,
} from "../../../../shared/standalone-review/ai-review.ts";
import { recordWorkflowMetric } from "../../../../shared/workflow/metrics.ts";
import { parseDiffFiles } from "../../../../shared/workflow/review-diff-tool.ts";
import {
    createReviewWidgetStore,
    type ReviewWidgetGuide,
    type ReviewWidgetPayload,
    type ReviewWidgetStore,
} from "./review-widget-handlers.ts";

import type { JsonValue } from "../../../../shared/jsonc.ts";
import type { StandaloneReviewPayload } from "../../../review/review-launcher.ts";

export type { GuideUsageTotals };

export interface GuideCostTotals {
    usd: number | null;
}

export interface GuideProgress {
    onUsage?: (usage: GuideUsageTotals) => void;
}

interface GuideCommandResult extends Omit<GuidedReviewMetadata, "model"> {
    stdout: string;
    stderr?: string;
    model?: string;
    usage?: GuideUsageTotals;
    cost?: GuideCostTotals;
}

export type GuideRunner = (
    prompt: string,
    signal: AbortSignal,
    cwd: string,
    progress?: GuideProgress,
) => Promise<GuideCommandResult>;

type ReviewJobStatus = "running" | "done" | "failed" | "killed";
type ReviewJobUsageState = "pending" | "available" | "unavailable";

interface GuideJobSummary {
    correctness: string;
    explanation: string;
    confidence: number;
}

interface ReviewJobInfo {
    id: string;
    source: string;
    provider: "guide" | "ai-review";
    label: string;
    status: ReviewJobStatus;
    startedAt: number;
    endedAt: number | null;
    command: string[];
    cwd: string;
    engine: string;
    providerName?: string;
    model: string;
    thinkingLevel?: string;
    usageState: ReviewJobUsageState;
    tokens: GuideUsageTotals | null;
    usageAvailability?: UsageAvailability;
    cost: GuideCostTotals | null;
    costUnavailable: boolean;
    summary?: GuideJobSummary | Pick<AiReviewValue, "counts" | "specSource">;
    error?: string;
}

interface ReviewGuideJobEntry {
    info: ReviewJobInfo;
    guide: ReviewWidgetGuide | null;
    aiReview?: AiReviewValue | null;
    reviewed: boolean[];
    abortController: AbortController;
    done: Promise<void>;
    metricsRecorder?: ExecutionMetricsRecorder;
    usageTotals: RuntimeUsageTotals;
}

type ReviewAgentStandaloneTarget = Partial<
    Pick<StandaloneReviewPayload, "headRef" | "mode" | "baseLabel" | "reviewContext">
>;

export interface ReviewAgentPayload extends ReviewWidgetPayload {
    agentTurnOwner?: string;
    rawPatch?: string;
    agentCwd?: JsonValue;
    gitRef?: string;
    planContent?: string;
    planAttrs?: GuidedReviewPlanAttributes;
    standaloneReview?: ReviewAgentStandaloneTarget;
}

interface ReviewAgentOptions {
    token: string;
    cwd: string;
    reviewPayload: ReviewAgentPayload;
    runGuideCommand: GuideRunner;
}

export interface ReviewAgentState extends ReviewAgentOptions {
    stopped: boolean;
    jobs: Map<string, ReviewGuideJobEntry>;
    streams: Set<ReadableStreamDefaultController<Uint8Array>>;
    widgets: ReviewWidgetStore;
}

interface GuideRunnerSelection {
    runner: GuideRunner;
}

interface StartReviewJobBody {
    provider?: string;
}

interface MarkGuideReviewedBody {
    reviewed?: JsonValue;
}

interface AiReviewJobTarget extends Omit<Parameters<typeof buildAiReviewPrompt>[0], "diffText" | "cwd"> {
    rawPatch: string;
}

interface GuideStderrReadResult {
    stderr: string;
    usage?: GuideUsageTotals;
    metadata?: GuidedReviewMetadata;
    protocolError?: Error;
}

interface GuideStderrFrame {
    version?: JsonValue;
}

type ReviewJobCommand = "guided-review" | "ai-review";

let configuredGuideRunner: GuideRunnerSelection | null = null;

/** Select the process runner before the review host starts. */
export function configureGuideRunner(runner: GuideRunner) {
    if (configuredGuideRunner) throw new Error("Guided Review runner is already configured");
    const selection = { runner };
    configuredGuideRunner = selection;
    return () => {
        if (configuredGuideRunner === selection) configuredGuideRunner = null;
    };
}

export function getGuideRunner(): GuideRunner {
    return configuredGuideRunner?.runner || runWldJobCommand;
}

export function createReviewAgentState(options: ReviewAgentOptions): ReviewAgentState {
    return {
        ...options,
        stopped: false,
        jobs: new Map(),
        streams: new Set(),
        widgets: createReviewWidgetStore(),
        runGuideCommand: options.runGuideCommand,
    };
}

export async function cleanupReviewAgentState(state: ReviewAgentState) {
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

export async function reviewAgentApi(request: Request, url: URL, state: ReviewAgentState): Promise<Response | null> {
    if (state.stopped) return new Response("Review stopped.", { status: 503, ...noStore() });
    if (request.method === "GET" && url.pathname === "/api/agents/capabilities") {
        if (state.reviewPayload.agentTurnOwner === "host") {
            return Response.json({ mode: "review", available: false, providers: [] }, noStore());
        }
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
        if (state.reviewPayload.agentTurnOwner === "host") {
            return Response.json({ error: "Claude Code owns agent turns for this review." }, { status: 403 });
        }
        // Preserve the wire payload for the existing provider check below.
        const body: StartReviewJobBody | null = await request.json().catch(() => ({}));
        if (state.stopped) return new Response("Review stopped.", { status: 503, ...noStore() });
        if (
            !body ||
            typeof body !== "object" ||
            Array.isArray(body) ||
            !Object.hasOwn(body, "provider") ||
            !["guide", "ai-review"].includes(body.provider as string)
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
        const body: MarkGuideReviewedBody = await request.json().catch(() => ({}));
        entry.reviewed = Array.isArray(body.reviewed) ? body.reviewed.map(Boolean) : [];
        return Response.json({ ok: true }, noStore());
    }

    return null;
}

function createGuideJob(state: ReviewAgentState, provider: ReturnType<typeof detectGuideProvider> | null) {
    const id = crypto.randomUUID();
    const now = Date.now();
    const changedFiles = parseDiffFiles(String(state.reviewPayload.rawPatch || "")).map((entry) => entry.path);
    const abortController = new AbortController();
    const info: ReviewJobInfo = {
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
    const entry: ReviewGuideJobEntry = {
        info,
        guide: null,
        reviewed: [],
        abortController,
        done: Promise.resolve(),
        usageTotals: new RuntimeUsageTotals(),
    };
    state.jobs.set(id, entry);
    broadcastJobs(state);
    entry.done = runGuideJob(state, entry, changedFiles);
    return entry;
}

function createAiReviewJob(state: ReviewAgentState) {
    const id = crypto.randomUUID();
    const provider = detectAiReviewProvider();
    const cwd =
        typeof state.reviewPayload.agentCwd === "string" && state.reviewPayload.agentCwd.trim()
            ? state.reviewPayload.agentCwd
            : state.cwd;
    const rawPatch = String(state.reviewPayload.rawPatch || "");
    const info: ReviewJobInfo = {
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
    const entry: ReviewGuideJobEntry = {
        info,
        usageTotals: new RuntimeUsageTotals(),
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

async function runAiReviewJob(state: ReviewAgentState, entry: ReviewGuideJobEntry, target: AiReviewJobTarget) {
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
        if (result.usage && entry.info.usageState !== "available") addGuideJobUsage(state, entry, result.usage);
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

function addGuideJobUsage(state: ReviewAgentState, entry: ReviewGuideJobEntry, usage: GuideUsageTotals) {
    entry.usageTotals.add(usage);
    setGuideJobUsage(state, entry);
}

function setGuideJobUsage(state: ReviewAgentState, entry: ReviewGuideJobEntry) {
    const usage = { ...entry.usageTotals.usage };
    entry.info.usageState = Object.values(entry.usageTotals.availability).some((value) => value !== "unavailable")
        ? "available"
        : "unavailable";
    entry.info.tokens = usage;
    entry.info.usageAvailability = { ...entry.usageTotals.availability };
    entry.info.cost = usage.costUsd === null ? null : { usd: usage.costUsd };
    entry.info.costUnavailable = usage.costUsd === null;
    broadcastJobs(state);
}

function finishGuideJobUsage(entry: ReviewGuideJobEntry) {
    if (entry.info.usageState === "pending") {
        entry.info.usageState = "unavailable";
        entry.info.costUnavailable = true;
    }
}

async function runGuideJob(state: ReviewAgentState, entry: ReviewGuideJobEntry, changedFiles: string[]) {
    // Capture the boundary for every engine, including internally measured wld jobs and fixtures.
    const boundaryRecorder = new ExecutionMetricsRecorder({
        projectRoot: state.cwd,
        executionId: `guide_${entry.info.id}`,
        requestId: `guide_${entry.info.id}`,
        agentName: "guide",
        provider: String(entry.info.engine),
        model: String(entry.info.model),
        sourceSurface: "workspace",
        dispatchKind: "auxiliary",
        userInitiated: false,
    });
    entry.metricsRecorder = boundaryRecorder;
    try {
        if (entry.info.engine !== "wld" && !state.reviewPayload.guidedReviewFixture) {
            await boundaryRecorder.recordExecutionStart();
        }
        let raw;
        let meta: GuidedReviewMetadata = { provider: String(entry.info.engine), model: String(entry.info.model) };
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
                        ? state.reviewPayload.planAttrs
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
            if (!entry.info.tokens && (result.usage || result.cost)) {
                entry.usageTotals.add({ ...result.usage, costUsd: result.cost?.usd ?? result.usage?.costUsd });
                setGuideJobUsage(state, entry);
            }
            entry.info.providerName = meta.provider;
            entry.info.model = meta.model;
            entry.info.thinkingLevel = meta.thinkingLevel;
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

async function recordGuideJobMetric(state: ReviewAgentState, entry: ReviewGuideJobEntry) {
    const info = withElapsed(entry.info);
    // wld guided-review already journals each call through its Session runtime.
    if (info.engine !== "wld" && !state.reviewPayload.guidedReviewFixture) {
        const recorder = entry.metricsRecorder;
        try {
            await recorder?.recordModelUsage({
                ...entry.usageTotals.usage,
                provider: String(info.providerName || info.engine),
                model: String(info.model),
                sourceId: `guide_${info.id}`,
                usageKind: "turn",
                aggregationBasis: "turn",
                measurementAvailability: entry.usageTotals.measurementAvailability,
                costAvailability: entry.usageTotals.availability.costUsd,
                costSource: entry.usageTotals.usage.costUsd === null ? "unavailable" : "reported",
            });
        } finally {
            await recorder?.settleExecution(
                info.status === "done" ? "succeeded" : info.status === "killed" ? "interrupted" : "failed",
                "guided_review_completed",
            );
        }
    }
    const event = info.provider === "ai-review" ? "ai_review_generation_result" : "guided_review_generation_result";
    await recordWorkflowMetric(
        {
            ...entry.metricsRecorder?.measurementBoundary(),
            v: 2,
            category: "validation",
            event,
            recorderId: info.id,
            seq: 0,
            eventId: `${event}:${info.id}`,
            operationId: info.id,
            outcome: info.status === "done" ? "succeeded" : info.status === "killed" ? "interrupted" : "failed",
            elapsedMs: info.elapsedMs,
            provider: info.providerName || info.engine,
            model: info.model,
            ...(info.provider === "ai-review"
                ? {
                      annotationCount: entry.aiReview?.annotations.length || 0,
                      counts: entry.aiReview?.counts,
                      costAvailability: entry.usageTotals.availability.costUsd,
                  }
                : {
                      sectionCount:
                          entry.guide && Array.isArray(entry.guide.sections) ? entry.guide.sections.length : 0,
                  }),
            failureKind: classifyGuideJobError(info.error),
        },
        state.cwd,
    );
}

function classifyGuideJobError(error: string | undefined) {
    if (typeof error !== "string" || !error) return null;
    if (/not JSON|JSON/i.test(error)) return "invalid_json";
    if (/no output|empty/i.test(error)) return "empty_output";
    if (/schemaVersion|sections|blocks|changed file|unsupported|widget|role/i.test(error)) return "schema_invalid";
    if (/killed|aborted|abort/i.test(error)) return "aborted";
    return "provider_failed";
}

function snapshotJobs(state: ReviewAgentState) {
    return [...state.jobs.values()].map((entry) => withElapsed(entry.info));
}

function withElapsed(info: ReviewJobInfo) {
    const started = typeof info.startedAt === "number" ? info.startedAt : Date.now();
    const ended = typeof info.endedAt === "number" ? info.endedAt : Date.now();
    return { ...info, elapsedMs: Math.max(0, ended - started) };
}

function streamJobs(state: ReviewAgentState) {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
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

function broadcastJobs(state: ReviewAgentState) {
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

function parseJsonFromModel(raw: string): JsonValue {
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

async function readStreamText(stream: ReadableStream<Uint8Array>) {
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

async function readGuideStderr(
    stream: ReadableStream<Uint8Array>,
    parseInternalFrames: boolean,
    progress: GuideProgress,
): Promise<GuideStderrReadResult> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffered = "";
    let stderr = "";
    let usage: GuideUsageTotals | null = null;
    const totals = new RuntimeUsageTotals();
    let protocolError: Error | null = null;
    let metadata: GuidedReviewMetadata | null = null;
    function handleLine(line: string) {
        if (!parseInternalFrames) {
            // External commands opt into measurements with a current versioned usage frame.
            // Other stderr, including legacy look-alike text, remains ordinary diagnostics.
            let version: GuideStderrFrame["version"];
            try {
                version = line.startsWith(GUIDED_REVIEW_EVENT_PREFIX)
                    ? (JSON.parse(line.slice(GUIDED_REVIEW_EVENT_PREFIX.length)) as GuideStderrFrame | null)?.version
                    : null;
            } catch {
                version = null;
            }
            if (version !== GUIDED_REVIEW_USAGE_VERSION) {
                stderr += `${line}\n`;
                return;
            }
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
        totals.add(event.usage);
        usage = { ...totals.usage };
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

async function writeGuidePrompt(stdin: WritableStream<Uint8Array>, prompt: string) {
    const writer = stdin.getWriter();
    try {
        await writer.write(new TextEncoder().encode(prompt));
        await writer.close();
    } finally {
        writer.releaseLock();
    }
}

export async function runWldJobCommand(
    prompt: string,
    signal: AbortSignal,
    cwd: string,
    progress: GuideProgress = {},
    subcommand: ReviewJobCommand = "guided-review",
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
    if (inputResult.status === "rejected") {
        // Custom commands may produce a result without consuming all of stdin.
        // Built-in jobs must still confirm prompt delivery, and other I/O errors remain failures.
        const ignoredCustomInput =
            configured &&
            inputResult.reason instanceof Error &&
            "code" in inputResult.reason &&
            inputResult.reason.code === "EPIPE";
        if (!ignoredCustomInput) throw inputResult.reason;
    }
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

async function resolveRunWieldJobCommand(cwd: string, subcommand: ReviewJobCommand) {
    // Private job commands must use the running binary, not a different installed version.
    if (isStandaloneExecutable()) return { command: process.execPath, args: [subcommand] };
    if (await commandExists("wld")) return { command: "wld", args: [subcommand] };
    return {
        command: process.execPath,
        args: isStandaloneExecutable() ? [subcommand] : ["run", ...[], "src/cli.ts", subcommand],
        cwd,
    };
}

async function commandExists(command: string) {
    const which = process.platform === "win32" ? "where" : "which";
    const output = await captureForegroundProcess(which, { args: [command], cwd: getCwd() }).catch(() => ({
        success: false,
    }));
    return Boolean(output.success);
}

function shellCommand(configured: string) {
    return process.platform === "win32"
        ? { command: "cmd", args: ["/d", "/s", "/c", `"${configured}"`] }
        : { command: "sh", args: ["-lc", configured] };
}

function noStore() {
    return { headers: { "cache-control": "no-store" } };
}

function readStandaloneReviewContext(value: ReviewAgentPayload["standaloneReview"]) {
    if (!value || typeof value !== "object" || !("reviewContext" in value)) return "";
    return typeof value.reviewContext === "string" ? value.reviewContext : "";
}
