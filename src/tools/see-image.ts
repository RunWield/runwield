/**
 * @module tools/see-image
 * Vision fallback Custom Tool for text-only primary models.
 */

import { toolRegistry } from "@runwield/tools";
import { defineTool } from "@earendil-works/pi-coding-agent";
import type { AgentToolResult, SessionManager } from "@earendil-works/pi-coding-agent";
import type { CodingAgent } from "@runwield/pi-ai/coding-agent";
import type { RunWieldModel } from "@runwield/pi-ai/models";
import { getNativeModelRegistry } from "@runwield/pi-ai/models";
import { remotePersonalResourcesActive } from "../shared/remote/personal-resources.ts";
import { readImageRef, resolveVisionFallbackModel } from "../shared/session/image-attachments.ts";
import { RuntimeUsageTotals } from "../shared/session/runtime-usage-totals.ts";
import type { ExecutionOutcome, ModelUsageObservation } from "../shared/workflow/execution-metrics.ts";

const seeImage = toolRegistry.get("see_image");
const { definition } = seeImage;

export interface VisionMeasurementHandle {
    /** Called once after the request, including failed responses and thrown errors. */
    finish(observation: ModelUsageObservation, outcome: ExecutionOutcome): void | Promise<void>;
}

interface SeeImageToolOptions {
    cwd: string;
    sessionManager?: SessionManager;
    completeTurn: CodingAgent["complete"];
    /** Capture the recorder and persist its start before dispatching the model request. */
    onModelStart?: () => VisionMeasurementHandle | Promise<VisionMeasurementHandle>;
    /** Selected by the bounded remote Session, never by this tool's caller. */
    remoteModel?: RunWieldModel;
}

interface SeeImageDetails {
    ok: boolean;
}

type SeeImageResult = AgentToolResult<SeeImageDetails> & { isError?: boolean };

export function createSeeImageTool(opts: SeeImageToolOptions) {
    const remote = remotePersonalResourcesActive();
    if (remote !== Boolean(opts.remoteModel)) {
        throw new Error("Remote see_image requires a selected vision model; local callers cannot replace it");
    }
    const modelRegistry = remote ? undefined : getNativeModelRegistry();

    return defineTool<typeof definition.parameters, SeeImageDetails>({
        ...definition,

        async execute(_toolCallId, params, signal, _onUpdate, _ctx): Promise<SeeImageResult> {
            try {
                const image = await readImageRef(params.imageRef, {
                    cwd: opts.cwd,
                    sessionManager: opts.sessionManager,
                });
                const fallback = remote
                    ? { model: opts.remoteModel! }
                    : await resolveVisionFallbackModel(modelRegistry!, opts.cwd);
                if (!fallback) throw new Error("visionFallback.model is not configured.");
                // Remote sessions have no provider credentials. The projected native runtime
                // carries this request over the authenticated control connection instead.
                const auth = remote ? undefined : await modelRegistry!.getApiKeyAndHeaders(fallback.model);
                if (auth && !auth.ok) throw new Error(auth.error || "Unable to resolve auth for visionFallback.model.");
                if (!remote && (!auth || (!auth.apiKey && !auth.headers))) {
                    throw new Error(
                        `No API key configured for visionFallback.model: ${fallback.model.provider}/${fallback.model.id}`,
                    );
                }

                const question = seeImage.resolveQuestion(params.question);

                const measurement = await opts.onModelStart?.();
                const startedAt = new Date().toISOString();
                let outcome: ExecutionOutcome = "failed";
                let observation: ModelUsageObservation = {
                    usageKind: "request",
                    aggregationBasis: "request",
                    provider: fallback.model.provider,
                    model: fallback.model.id,
                    startedAt,
                    inputTokens: null,
                    outputTokens: null,
                    cacheReadTokens: null,
                    cacheWriteTokens: null,
                    costAmount: null,
                    costSource: "unavailable",
                    inputCacheBasis: "excludes_cache",
                    measurementAvailability: "unavailable",
                    unavailableReason: "source_unavailable",
                };
                try {
                    const response = await opts.completeTurn(
                        fallback.model,
                        {
                            text: question,
                            images: [{ type: "image", data: image.base64, mimeType: image.mimeType }],
                        },
                        { signal, credentials: auth?.ok ? auth : undefined, maxTokens: 2048 },
                    );
                    const failed = response.status !== "succeeded";
                    const usage = response.usage;
                    observation = {
                        ...observation,
                        inputTokens: usage?.inputTokens ?? null,
                        outputTokens: usage?.outputTokens ?? null,
                        cacheReadTokens: usage?.cacheReadTokens ?? null,
                        cacheWriteTokens: usage?.cacheWriteTokens ?? null,
                        costAmount: usage?.costAmount ?? null,
                        costSource: usage?.costAmount != null ? "calculated" : "unavailable",
                        unavailableReason: failed ? "source_unavailable" : usage ? null : "not_reported",
                    };
                    const totals = new RuntimeUsageTotals();
                    totals.add(observation);
                    observation.measurementAvailability =
                        failed && totals.measurementAvailability !== "unavailable"
                            ? "partial"
                            : totals.measurementAvailability;
                    outcome = response.status;
                    if (failed) throw new Error(response.errorMessage || "visionFallback.model returned an error.");
                    const text = response.text || "(visionFallback.model returned no text)";
                    return { content: [{ type: "text" as const, text }], details: { ok: true } };
                } finally {
                    if (signal?.aborted) {
                        outcome = "canceled";
                        observation.unavailableReason = "source_unavailable";
                        if (observation.measurementAvailability === "complete")
                            observation.measurementAvailability = "partial";
                    }
                    observation.endedAt = new Date().toISOString();
                    await measurement?.finish(observation, outcome);
                }
            } catch (error) {
                return {
                    content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }],
                    details: { ok: false },
                    isError: true,
                };
            }
        },
    });
}
