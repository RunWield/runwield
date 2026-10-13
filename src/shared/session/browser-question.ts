// @ts-nocheck: browser question bridge keeps JS Runtime interaction types at the boundary.
/**
 * @module shared/session/browser-question
 * Starts the compiled Workspace question page for Runtime interactions.
 */

import { startSessionQuestionWorkspaceServer } from "../../ui/workspace/server.js";

/**
 * @typedef {Object} BrowserQuestionServer
 * @property {string} token
 * @property {string} url
 * @property {(options?: { drain?: boolean }) => Promise<void>} shutdown
 */

/**
 * @param {{ interaction: import('./session-runtime-interactions.js').RuntimeInteractionRequest, acpSessionId?: string, answerQuestion: (request: Request) => Promise<Response>|Response }} options
 * @returns {BrowserQuestionServer}
 */
export function startBrowserQuestionServer({ interaction, acpSessionId = "", answerQuestion }) {
    const token = crypto.randomUUID();
    const controller = new AbortController();
    const server = startSessionQuestionWorkspaceServer({
        token,
        signal: controller.signal,
        questionPayload: {
            mode: interaction.type,
            sessionId: acpSessionId,
            questionId: interaction.id || "",
            prompt: interaction.prompt,
            defaultValue: interaction.defaultValue || "",
            placeholder: interaction.placeholder || "",
            allowEmpty: interaction.allowEmpty === true,
            options: interaction.options || [],
        },
        answerQuestion,
    });
    const origin = `http://${server.addr.hostname}:${server.addr.port}`;
    return {
        token,
        url: `${origin}/session-question?token=${encodeURIComponent(token)}`,
        shutdown: async ({ drain = false } = {}) => {
            if (!drain) {
                controller.abort();
                await server.finished;
                return;
            }
            // Let the accepted answer reach the browser, but bound unrelated unfinished uploads.
            const timer = setTimeout(() => controller.abort(), 1_000);
            try {
                await server.shutdown();
            } finally {
                clearTimeout(timer);
            }
        },
    };
}
