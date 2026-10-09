/**
 * @module ui/tui/runtime-interaction-adapter
 * TUI implementation of the adapter-neutral SessionRuntime interaction port.
 */

import {
    isApprovalAcceptedValue,
    RuntimeInteractionOutcomes,
    RuntimeInteractionTypes,
} from "../../shared/session/session-runtime-interactions.js";
import { runCodeReview } from "../review/code-review.ts";
import { submitPlanForReview } from "../review/plan-review.ts";
import { startArtifactReadSurface } from "../review/review-launcher.ts";

/**
 * @typedef {Object} TuiInteractionPorts
 * @property {import('../../shared/browser-port.ts').BrowserPort} browser
 */

/**
 * @param {import('./types.js').UiAPI} uiAPI
 * @param {AbortSignal | undefined} signal
 * @param {() => Promise<string | null>} openPrompt
 * @returns {Promise<string | null>}
 */
async function waitForPrompt(uiAPI, signal, openPrompt) {
    if (signal?.aborted) return null;
    const abort = () => uiAPI.abortActivePrompt?.();
    signal?.addEventListener("abort", abort, { once: true });
    try {
        return await openPrompt();
    } finally {
        signal?.removeEventListener("abort", abort);
    }
}

/**
 * @param {import('./types.js').UiAPI} uiAPI
 * @param {TuiInteractionPorts} ports
 * @returns {import('../../shared/session/session-runtime-interactions.js').RuntimeInteractionAdapter}
 */
export function createTuiInteractionAdapter(uiAPI, ports) {
    return {
        supportsInteraction(type) {
            return type === RuntimeInteractionTypes.PLAN_DEVIATION_CONFIRMATION ||
                type === RuntimeInteractionTypes.ARTIFACT_REVIEW;
        },
        async requestInteraction(request, signal) {
            if (request.type === RuntimeInteractionTypes.SELECT || request.type === RuntimeInteractionTypes.APPROVAL) {
                const value = await waitForPrompt(
                    uiAPI,
                    signal,
                    () =>
                        uiAPI.promptSelect(
                            request.prompt,
                            request.options || [],
                            request._meta?.presentation === "code_review_offer" ? { persistResult: false } : undefined,
                        ),
                );
                if (value === null) return { outcome: RuntimeInteractionOutcomes.CANCELED };
                const option = (request.options || []).find((item) => item.value === value);
                if ((request.options || []).length && !option) {
                    return {
                        outcome: RuntimeInteractionOutcomes.UNSUPPORTED,
                        message: `Select prompt returned invalid option: ${value}`,
                    };
                }
                if (request.type === RuntimeInteractionTypes.APPROVAL) {
                    if (!isApprovalAcceptedValue(request, value)) {
                        return {
                            outcome: RuntimeInteractionOutcomes.CANCELED,
                            value: false,
                            valueLabel: option?.label || String(value),
                            message: "Approval was not accepted.",
                        };
                    }
                    return { outcome: RuntimeInteractionOutcomes.ACCEPTED, value: true };
                }
                return {
                    outcome: RuntimeInteractionOutcomes.SELECTED,
                    value,
                    valueLabel: option?.label || String(value),
                };
            }
            if (request.type === RuntimeInteractionTypes.TEXT) {
                const value = await waitForPrompt(
                    uiAPI,
                    signal,
                    () =>
                        uiAPI.promptText(request.prompt, {
                            defaultValue: request.defaultValue,
                            placeholder: request.placeholder,
                            allowEmpty: request.allowEmpty,
                        }),
                );
                if (value === null) return { outcome: RuntimeInteractionOutcomes.CANCELED };
                return { outcome: RuntimeInteractionOutcomes.TEXT, value };
            }
            if (request.type === RuntimeInteractionTypes.ARTIFACT_REVIEW) {
                const meta = /** @type {any} */ (request._meta || {});
                const supportedKinds = new Set(["plan", "prd", "adr", "work-record", "epic-artifact", "report"]);
                const artifactKind = supportedKinds.has(meta.artifactKind) ? meta.artifactKind : "report";
                uiAPI.setBusy?.(false);
                const surface = await startArtifactReadSurface({
                    cwd: meta.cwd,
                    markdown: meta.markdown,
                    artifactKind,
                    title: meta.title,
                    path: meta.artifactPath,
                    browser: ports.browser,
                });
                try {
                    const feedback = await uiAPI.promptText(request.prompt, {
                        placeholder: request.placeholder,
                        allowEmpty: true,
                    });
                    if (feedback === null) return { outcome: RuntimeInteractionOutcomes.CANCELED };
                    return { outcome: RuntimeInteractionOutcomes.TEXT, value: feedback };
                } finally {
                    await surface.stop();
                    uiAPI.setBusy?.(true);
                }
            }
            if (request.type === RuntimeInteractionTypes.PLAN_DEVIATION_CONFIRMATION) {
                const prompt = [
                    "Plan Deviation confirmation",
                    typeof request.prompt === "string" ? request.prompt.trim() : "",
                ].filter(Boolean).join("\n");
                const options = request.options && request.options.length ? request.options : [
                    { value: "confirm", label: "Confirm Plan Deviation" },
                    { value: "cancel", label: "Cancel; keep the original Plan requirement" },
                ];
                const value = await uiAPI.promptSelect(prompt, options);
                if (value === null || value === "cancel") return { outcome: RuntimeInteractionOutcomes.CANCELED };
                if (value !== "confirm") {
                    return {
                        outcome: RuntimeInteractionOutcomes.UNSUPPORTED,
                        message: `Plan Deviation prompt returned invalid option: ${value}`,
                    };
                }
                return { outcome: RuntimeInteractionOutcomes.ACCEPTED, value: true };
            }
            if (request.type === RuntimeInteractionTypes.PLAN_REVIEW) {
                const meta = /** @type {any} */ (request._meta || {});
                uiAPI.setBusy?.(false);
                try {
                    const result = await submitPlanForReview({
                        cwd: meta.cwd,
                        sequenceDocuments: meta.sequenceDocuments,
                        planName: meta.planName,
                        planPath: meta.planPath,
                        previousPlan: typeof meta.previousPlan === "string" ? meta.previousPlan : undefined,
                        planVersions: Array.isArray(meta.planVersions) ? meta.planVersions : undefined,
                        reviewConversation: meta.reviewConversation,
                        agentLabel: typeof meta.agentLabel === "string" ? meta.agentLabel : undefined,
                        triageMeta: meta.triageMeta,
                        onOutput: typeof meta.onOutput === "function" ? meta.onOutput : undefined,
                        onSurfaceReady: typeof meta.onSurfaceReady === "function" ? meta.onSurfaceReady : undefined,
                        signal,
                        browser: ports.browser,
                    });
                    return {
                        outcome: result.canceled
                            ? RuntimeInteractionOutcomes.CANCELED
                            : result.approved
                            ? RuntimeInteractionOutcomes.ACCEPTED
                            : RuntimeInteractionOutcomes.SELECTED,
                        _meta: result,
                    };
                } finally {
                    // Feedback and recoverable failures also return to the active Agent turn.
                    uiAPI.setBusy?.(true);
                }
            }
            if (request.type === RuntimeInteractionTypes.CODE_REVIEW) {
                const meta = /** @type {any} */ (request._meta || {});
                const result = await runCodeReview({
                    planName: meta.planName,
                    planTitle: meta.planTitle,
                    diffText: meta.diffText,
                    planContent: meta.planContent,
                    planAttrs: meta.planAttrs,
                    executionCwd: meta.executionCwd,
                    targetBranch: typeof meta.targetBranch === "string" ? meta.targetBranch : undefined,
                    guidedReview: meta.guidedReview,
                    reviewConversation: meta.reviewConversation,
                    agentLabel: typeof meta.agentLabel === "string" ? meta.agentLabel : undefined,
                    signal,
                    browser: ports.browser,
                    onSurfaceReady: typeof meta.onSurfaceReady === "function" ? meta.onSurfaceReady : undefined,
                });
                return {
                    outcome: result.canceled || result.exit
                        ? RuntimeInteractionOutcomes.CANCELED
                        : result.approved
                        ? RuntimeInteractionOutcomes.ACCEPTED
                        : RuntimeInteractionOutcomes.SELECTED,
                    _meta: result,
                };
            }
            return {
                outcome: RuntimeInteractionOutcomes.UNSUPPORTED,
                message: `Unsupported interaction type: ${request.type}`,
            };
        },
        cancelAll() {
            uiAPI.abortActivePrompt?.();
        },
    };
}
