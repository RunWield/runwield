/**
 * @module acp/interaction-mapper
 * Maps SessionRuntime interaction requests to ACP client elicitation requests.
 */

import { methods } from "@agentclientprotocol/sdk";
import {
    isApprovalAcceptedValue,
    RuntimeInteractionOutcomes,
    RuntimeInteractionTypes,
} from "../shared/session/session-runtime-interactions.js";
import { startBrowserQuestionServer } from "../shared/session/browser-question.ts";
import { requestLocalReviewInteraction } from "../shared/session/local-review-interactions.ts";

/** @param {unknown} capabilities */
function supportsFormElicitation(capabilities) {
    const value = /** @type {any} */ (capabilities || {});
    return Boolean(value.elicitation?.form);
}

/**
 * @param {{ request?: Function, client?: { request?: Function } }} context
 * @param {string} method
 * @param {unknown} params
 */
function requestClient(context, method, params) {
    if (typeof context.request === "function") return context.request(method, params);
    if (context.client && typeof context.client.request === "function") return context.client.request(method, params);
    return Promise.resolve({ action: "cancel" });
}

/**
 * @param {{ notify?: Function, client?: { notify?: Function } }} context
 * @param {string} method
 * @param {unknown} params
 */
function notifyClient(context, method, params) {
    if (typeof context.notify === "function") return Promise.resolve(context.notify(method, params));
    if (context.client && typeof context.client.notify === "function") {
        return Promise.resolve(context.client.notify(method, params));
    }
    return Promise.resolve();
}

/**
 * @param {{ context: any, acpSessionId: string, interaction: import('../shared/session/session-runtime-interactions.js').RuntimeInteractionRequest, signal?: AbortSignal }} options
 */
async function requestBrowserQuestion(options) {
    /** @type {PromiseWithResolvers<import('../shared/session/session-runtime-interactions.js').RuntimeInteractionResponse>} */
    const answered = Promise.withResolvers();
    let used = false;
    let origin = "";
    /** @param {Request} request */
    const answerQuestion = async (request) => {
        const requestOrigin = request.headers.get("origin");
        if (!requestOrigin || requestOrigin !== origin) return new Response("Wrong origin", { status: 403 });
        if (used) return new Response("This question is already answered.", { status: 409 });
        const form = await request.formData();
        if (used) return new Response("This question is already answered.", { status: 409 });
        if (form.get("cancel")) {
            used = true;
            answered.resolve({
                outcome: RuntimeInteractionOutcomes.CANCELED,
                message: "Browser question canceled.",
            });
            return new Response("Question canceled. You can close this tab.");
        }
        const value = String(form.get("answer") ?? "");
        if (options.interaction.type === RuntimeInteractionTypes.TEXT) {
            if (!options.interaction.allowEmpty && !value.trim()) {
                return new Response("An answer is required.", { status: 400 });
            }
            used = true;
            answered.resolve({ outcome: RuntimeInteractionOutcomes.TEXT, value });
            return new Response("Answer submitted. You can close this tab.");
        }
        const option = (options.interaction.options || []).find((item) => item.value === value);
        if (!option) return new Response("Choose one of the listed options.", { status: 400 });
        used = true;
        if (options.interaction.type === RuntimeInteractionTypes.APPROVAL) {
            answered.resolve(
                isApprovalAcceptedValue(options.interaction, value)
                    ? { outcome: RuntimeInteractionOutcomes.ACCEPTED, value: true, valueLabel: option.label }
                    : {
                        outcome: RuntimeInteractionOutcomes.CANCELED,
                        value: false,
                        valueLabel: option.label,
                        message: "Approval was not accepted.",
                    },
            );
        } else {
            answered.resolve({ outcome: RuntimeInteractionOutcomes.SELECTED, value, valueLabel: option.label });
        }
        return new Response("Answer submitted. You can close this tab.");
    };
    const question = startBrowserQuestionServer({
        interaction: options.interaction,
        acpSessionId: options.acpSessionId,
        answerQuestion,
    });
    origin = new URL(question.url).origin;
    const questionUrl = question.url;
    let pageResponse;
    try {
        pageResponse = await fetch(questionUrl, { signal: options.signal });
    } catch (error) {
        await question.shutdown();
        if (options.signal?.aborted) {
            return { outcome: RuntimeInteractionOutcomes.CANCELED, message: "Interaction canceled." };
        }
        throw error;
    }
    await pageResponse.body?.cancel();
    if (!pageResponse.ok) {
        await question.shutdown();
        return {
            outcome: RuntimeInteractionOutcomes.UNSUPPORTED,
            message:
                `RunWield could not open the browser question page (${pageResponse.status}). Use an ACP client with form elicitation or rebuild Workspace assets.`,
        };
    }
    const abort = () =>
        answered.resolve({ outcome: RuntimeInteractionOutcomes.CANCELED, message: "Interaction canceled." });
    if (options.signal?.aborted) abort();
    else options.signal?.addEventListener("abort", abort, { once: true });
    try {
        await notifyClient(options.context, methods.client.session.update, {
            sessionId: options.acpSessionId,
            update: {
                sessionUpdate: "agent_message_chunk",
                content: { type: "text", text: `Open this RunWield question to continue: ${questionUrl}` },
                _meta: {
                    runwield: {
                        interactionId: options.interaction.id,
                        interactionType: options.interaction.type,
                        questionUrl,
                    },
                },
            },
        });
        return await answered.promise;
    } finally {
        options.signal?.removeEventListener("abort", abort);
        await question.shutdown({ drain: used && !options.signal?.aborted });
    }
}

/**
 * @param {import('../shared/session/session-runtime-interactions.js').RuntimeInteractionRequest} interaction
 */
function buildSchema(interaction) {
    if (interaction.type === RuntimeInteractionTypes.SELECT || interaction.type === RuntimeInteractionTypes.APPROVAL) {
        const oneOf = (interaction.options || []).map((option) => ({ const: option.value, title: option.label }));
        return {
            type: "object",
            title: interaction.prompt,
            properties: {
                answer: {
                    type: "string",
                    title: "Answer",
                    ...(oneOf.length ? { oneOf } : {}),
                },
                ...(interaction.otherOptionValue
                    ? {
                        otherAnswer: {
                            type: "string",
                            title: "Other answer",
                            description: "Fill this in when you select Other. Otherwise leave it empty.",
                        },
                    }
                    : {}),
            },
            required: ["answer"],
        };
    }
    return {
        type: "object",
        title: interaction.prompt,
        properties: {
            answer: {
                type: "string",
                title: "Answer",
                ...(interaction.defaultValue ? { default: interaction.defaultValue } : {}),
                ...(interaction.placeholder ? { description: interaction.placeholder } : {}),
            },
        },
        required: interaction.allowEmpty ? [] : ["answer"],
    };
}

/**
 * @param {{ context: any, acpSessionId: string, clientCapabilities?: unknown, presentInterview?: (interaction: import('../shared/session/session-runtime-interactions.js').RuntimeInteractionRequest, signal?: AbortSignal) => Promise<import('../shared/session/session-runtime-interactions.js').RuntimeInteractionResponse> }} options
 * @returns {import('../shared/session/session-runtime-interactions.js').RuntimeInteractionAdapter}
 */
export function createAcpInteractionAdapter({ context, acpSessionId, clientCapabilities, presentInterview }) {
    return {
        supportsInteraction(type) {
            return type === RuntimeInteractionTypes.SELECT || type === RuntimeInteractionTypes.TEXT ||
                type === RuntimeInteractionTypes.APPROVAL || type === RuntimeInteractionTypes.PLAN_REVIEW ||
                type === RuntimeInteractionTypes.CODE_REVIEW || type === RuntimeInteractionTypes.ARTIFACT_REVIEW;
        },
        async requestInteraction(interaction, signal) {
            if (interaction.type === RuntimeInteractionTypes.PAIR_CHECKPOINT) {
                return {
                    outcome: RuntimeInteractionOutcomes.UNSUPPORTED,
                    message: "Pair checkpoints use ordinary ACP prompts, not structured interactions.",
                };
            }
            /** @param {string | { url: string }} surface */
            const notifySurfaceReady = async (surface) => {
                const reviewUrl = typeof surface === "string" ? surface : surface.url;
                await notifyClient(context, methods.client.session.update, {
                    sessionId: acpSessionId,
                    update: {
                        sessionUpdate: "agent_message_chunk",
                        content: { type: "text", text: `Open this RunWield review to continue: ${reviewUrl}` },
                        _meta: {
                            runwield: { interactionId: interaction.id, interactionType: interaction.type, reviewUrl },
                        },
                    },
                });
            };
            if (
                interaction.type === RuntimeInteractionTypes.PLAN_REVIEW ||
                interaction.type === RuntimeInteractionTypes.CODE_REVIEW ||
                interaction.type === RuntimeInteractionTypes.ARTIFACT_REVIEW
            ) {
                return await requestLocalReviewInteraction(interaction, signal, {
                    onSurfaceReady: notifySurfaceReady,
                    requestArtifactDecision: async () => {
                        const decision = {
                            ...interaction,
                            type: RuntimeInteractionTypes.TEXT,
                            prompt: interaction.prompt,
                            allowEmpty: true,
                            placeholder: interaction.placeholder || "Feedback (leave empty to accept)",
                        };
                        return await requestBrowserQuestion({ context, acpSessionId, interaction: decision, signal });
                    },
                });
            }
            if (
                interaction.type !== RuntimeInteractionTypes.SELECT &&
                interaction.type !== RuntimeInteractionTypes.TEXT &&
                interaction.type !== RuntimeInteractionTypes.APPROVAL
            ) {
                return {
                    outcome: RuntimeInteractionOutcomes.UNSUPPORTED,
                    message: `ACP interaction type is unsupported: ${interaction.type}`,
                };
            }
            if (!supportsFormElicitation(clientCapabilities)) {
                if (
                    interaction._meta?.source === "user_interview" &&
                    (interaction.type === RuntimeInteractionTypes.SELECT ||
                        interaction.type === RuntimeInteractionTypes.TEXT)
                ) {
                    return presentInterview ? await presentInterview(interaction, signal) : {
                        outcome: RuntimeInteractionOutcomes.UNSUPPORTED,
                        message: "Interview chat is unavailable.",
                    };
                }
                return await requestBrowserQuestion({ context, acpSessionId, interaction, signal });
            }
            const response = await requestClient(context, methods.client.elicitation.create, {
                mode: "form",
                sessionId: acpSessionId,
                message: interaction.prompt,
                requestedSchema: buildSchema(interaction),
                _meta: { runwield: { interactionId: interaction.id, interactionType: interaction.type } },
            });
            const action = response?.action;
            if (action === "cancel" || action === "decline") {
                return { outcome: RuntimeInteractionOutcomes.CANCELED, message: `ACP elicitation ${action}.` };
            }
            if (action !== "accept") {
                return {
                    outcome: RuntimeInteractionOutcomes.UNSUPPORTED,
                    message: "ACP elicitation returned no answer.",
                };
            }
            const value = response?.content?.answer;
            if (interaction.type === RuntimeInteractionTypes.TEXT) {
                const text = typeof value === "undefined" ? "" : String(value);
                if (!interaction.allowEmpty && !text.trim()) {
                    return {
                        outcome: RuntimeInteractionOutcomes.UNSUPPORTED,
                        message: "An answer is required.",
                    };
                }
                return {
                    outcome: RuntimeInteractionOutcomes.TEXT,
                    value: text,
                };
            }
            const valueText = typeof value === "undefined" ? "" : String(value);
            const option = (interaction.options || []).find((item) => item.value === valueText);
            if ((interaction.options || []).length && !option) {
                return {
                    outcome: RuntimeInteractionOutcomes.UNSUPPORTED,
                    message: `ACP elicitation returned invalid option: ${valueText}`,
                };
            }
            if (interaction.type === RuntimeInteractionTypes.APPROVAL) {
                if (!isApprovalAcceptedValue(interaction, valueText)) {
                    return {
                        outcome: RuntimeInteractionOutcomes.CANCELED,
                        value: false,
                        valueLabel: option?.label || valueText,
                        message: "Approval was not accepted.",
                    };
                }
                return {
                    outcome: RuntimeInteractionOutcomes.ACCEPTED,
                    value: true,
                };
            }
            return {
                outcome: RuntimeInteractionOutcomes.SELECTED,
                value: valueText,
                valueLabel: option?.label || valueText,
                ...(interaction.otherOptionValue && valueText === interaction.otherOptionValue
                    ? { otherText: String(response?.content?.otherAnswer ?? "") }
                    : {}),
            };
        },
    };
}
