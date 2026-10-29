/**
 * @module shared/workflow/workflow-results
 * Helpers for extracting human-readable text and legacy test outcomes from
 * agent message streams. Production workflow transitions should prefer
 * Workflow Tool Events; transcript-derived tool results are display, audit, or
 * compatibility data only.
 */

/**
 * @param {unknown} value
 * @returns {string}
 */
function extractText(value) {
    if (typeof value === "string") return value.trim();
    if (!value || typeof value !== "object") return "";

    if (Array.isArray(value)) {
        return value.map(extractText).filter(Boolean).join("\n").trim();
    }

    const block = /** @type {{ type?: string, text?: unknown, content?: unknown, contentText?: unknown }} */ (value);
    if (typeof block.text === "string") return block.text.trim();
    if (typeof block.contentText === "string") return block.contentText.trim();
    if (block.type === "tool_result") return extractText(block.content);
    return "";
}

/**
 * @param {unknown} details
 * @returns {string | null}
 */
function extractTaskCompletedMessage(details) {
    if (!details || typeof details !== "object") return null;
    const message = /** @type {{ message?: unknown }} */ (details).message;
    return typeof message === "string" && message.trim() ? message.trim() : null;
}

/**
 * Read the latest task_completed report message from a message stream.
 *
 * @param {import('@earendil-works/pi-agent-core').AgentMessage[]} messages
 * @param {number} [fromIndex]
 * @returns {string | null}
 */
export function readLatestTaskCompletedMessage(messages, fromIndex) {
    const start = fromIndex != null && fromIndex <= messages.length ? fromIndex : 0;
    for (let i = messages.length - 1; i >= start; i--) {
        const msg = messages[i];
        if (
            msg &&
            "role" in msg &&
            msg.role === "toolResult" &&
            "toolName" in msg &&
            msg.toolName === "task_completed"
        ) {
            return extractTaskCompletedMessage(/** @type {{ details?: unknown }} */ (msg).details);
        }
    }
    return null;
}

/**
 * Extract the last text output from the agent's assistant messages.
 * Scans messages in reverse, checking all content blocks to handle cases where
 * tool_use blocks appear alongside text.
 * Falls back to the latest task_completed message because execution agents often
 * report their summary through the terminal tool call instead of a final text
 * response.
 *
 * @param {import('@earendil-works/pi-agent-core').AgentMessage[]} messages
 * @returns {string | null}
 */
export function extractAssistantOutput(messages) {
    /** @type {string | null} */
    let taskCompletedMessage = null;

    for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i];

        if (
            !taskCompletedMessage &&
            msg &&
            "role" in msg &&
            msg.role === "toolResult" &&
            "toolName" in msg &&
            msg.toolName === "task_completed"
        ) {
            taskCompletedMessage = extractTaskCompletedMessage(/** @type {{ details?: unknown }} */ (msg).details);
        }

        if (!("role" in msg) || msg.role !== "assistant") continue;

        const text = extractText(/** @type {{ content?: unknown }} */ (msg).content);
        if (text) {
            return text;
        }
    }

    return taskCompletedMessage;
}

/**
 * @typedef {Object} WorkflowResultDetails
 * @property {unknown} [outcome]
 * @property {unknown} [approved]
 * @property {unknown} [feedback]
 * @property {unknown} [findings]
 * @property {unknown} [advisories]
 * @property {unknown} [planName]
 * @property {unknown} [triageMeta]
 * @property {unknown} [message]
 */

/**
 * Pi tool-result details are JSON values. Only plain records can contain the
 * compatibility fields read by this module.
 *
 * @param {import('@earendil-works/pi-ai').JsonValue | undefined} details
 * @returns {WorkflowResultDetails | null}
 */
function readWorkflowResultDetails(details) {
    if (!details || typeof details !== "object" || Array.isArray(details)) return null;
    return /** @type {WorkflowResultDetails} */ (details);
}

/**
 * @typedef {"approved" | "feedback"} ReviewOutcome
 */

/**
 * @typedef {Object} ReviewOutcomeResult
 * @property {ReviewOutcome} outcome
 * @property {boolean} approved
 * @property {string} feedback
 * @property {import('../../tools/review-complete.ts').ReviewFinding[]} findings
 * @property {import('../../tools/review-complete.ts').ReviewAdvisory[]} advisories
 */

/**
 * Read the latest review_complete tool result from a message stream.
 *
 * Returns null when no review_complete call is found (for example, the session
 * was interrupted, or the agent finished via text output instead of the tool).
 *
 * When `fromIndex` is provided, only messages at or after that index are searched,
 * preventing stale outcomes from earlier turns from being picked up.
 *
 * @param {import('@earendil-works/pi-agent-core').AgentMessage[]} messages
 * @param {number} [fromIndex] - Only search messages from this index onwards.
 * @returns {ReviewOutcomeResult | null}
 */
export function readLatestReviewOutcome(messages, fromIndex) {
    const start = fromIndex != null && fromIndex <= messages.length ? fromIndex : 0;
    for (let i = messages.length - 1; i >= start; i--) {
        const msg = messages[i];
        if (
            msg &&
            "role" in msg &&
            msg.role === "toolResult" &&
            "toolName" in msg &&
            msg.toolName === "review_complete"
        ) {
            const details = readWorkflowResultDetails(msg.details);
            const outcome = details?.outcome;
            if (details && (outcome === "approved" || outcome === "feedback")) {
                return {
                    outcome: /** @type {ReviewOutcome} */ (outcome),
                    approved: details.approved === true,
                    feedback: typeof details.feedback === "string" ? details.feedback : "",
                    findings: Array.isArray(details.findings)
                        ? /** @type {import('../../tools/review-complete.ts').ReviewFinding[]} */ (details.findings)
                        : [],
                    advisories: Array.isArray(details.advisories)
                        ? /** @type {import('../../tools/review-complete.ts').ReviewAdvisory[]} */ (details.advisories)
                        : [],
                };
            }
        }
    }
    return null;
}

/**
 * @typedef {"approved_execute" | "approved_decompose" | "saved" | "feedback" | "conversation" | "canceled" | "repair_required" | "no_call"} PlanOutcome
 */

/**
 * @typedef {Object} PlanOutcomeResult
 * @property {PlanOutcome} outcome
 * @property {string} [planName]
 * @property {import('../../tools/plan-written.ts').TriageMeta} [triageMeta]
 * @property {string} [feedback]
 * @property {Array<{base64: string, mimeType: string}>} [images]
 */

/**
 * Read the latest plan_written tool result's outcome from a message stream.
 *
 * When `fromIndex` is provided, only messages at or after that index are searched,
 * preventing stale outcomes from earlier turns from being picked up.
 *
 * @param {import('@earendil-works/pi-agent-core').AgentMessage[]} messages
 * @param {number} [fromIndex] - Only search messages from this index onwards (exclusive lower bound)
 * @returns {PlanOutcomeResult | null}
 */
export function readLatestPlanOutcome(messages, fromIndex) {
    const start = fromIndex != null ? fromIndex : 0;
    for (let i = messages.length - 1; i >= start; i--) {
        const msg = messages[i];
        if (msg && "role" in msg && msg.role === "toolResult" && "toolName" in msg && msg.toolName === "plan_written") {
            const details = readWorkflowResultDetails(msg.details);
            const outcome = details?.outcome;
            if (outcome) {
                const images = readToolResultImages(/** @type {{ content?: unknown }} */ (msg).content);
                return {
                    outcome: /** @type {PlanOutcome} */ (outcome),
                    planName: /** @type {string | undefined} */ (details.planName),
                    triageMeta: /** @type {import('../../tools/plan-written.ts').TriageMeta | undefined} */ (
                        details.triageMeta
                    ),
                    feedback: typeof details.feedback === "string" ? details.feedback : undefined,
                    ...(images.length > 0 && { images }),
                };
            }
        }
    }
    return null;
}

/**
 * @param {unknown} content
 * @returns {Array<{base64: string, mimeType: string}>}
 */
function readToolResultImages(content) {
    if (!Array.isArray(content)) return [];
    return content.flatMap((block) => {
        if (!block || typeof block !== "object") return [];
        const image = /** @type {{type?: unknown, data?: unknown, mimeType?: unknown}} */ (block);
        if (image.type !== "image" || typeof image.data !== "string" || typeof image.mimeType !== "string") {
            return [];
        }
        return [{ base64: image.data, mimeType: image.mimeType }];
    });
}

/**
 * Read the latest task_completed tool result's outcome from a message stream.
 *
 * When `fromIndex` is provided, only messages at or after that index are searched,
 * preventing stale completions from earlier root turns from advancing workflow state.
 * If the returned message stream is shorter than `fromIndex`, treat it as a fresh
 * or sliced transcript and search it from the beginning.
 *
 * @param {import('@earendil-works/pi-agent-core').AgentMessage[]} messages
 * @param {number} [fromIndex] - Only search messages from this index onwards.
 * @returns {boolean}
 */
export function readLatestTaskCompletedOutcome(messages, fromIndex) {
    return readLatestTaskCompletedReport(messages, fromIndex).completed;
}

/**
 * Read the latest task_completed tool result including its report text.
 *
 * Semantic repair needs the report itself, not just the completion signal: the
 * next Reviewer round independently verifies the repair agent's per-item
 * dispositions, so the claims must survive the dispatch.
 *
 * @param {import('@earendil-works/pi-agent-core').AgentMessage[]} messages
 * @param {number} [fromIndex] - Only search messages from this index onwards.
 * @returns {{ completed: boolean, message: string }}
 */
export function readLatestTaskCompletedReport(messages, fromIndex) {
    const start = fromIndex != null && fromIndex <= messages.length ? fromIndex : 0;
    for (let i = messages.length - 1; i >= start; i--) {
        const msg = messages[i];
        if (
            msg &&
            "role" in msg &&
            msg.role === "toolResult" &&
            "toolName" in msg &&
            msg.toolName === "task_completed"
        ) {
            const details = readWorkflowResultDetails(msg.details);
            if (details?.outcome === "task_completed") {
                return {
                    completed: true,
                    message: typeof details.message === "string" ? details.message : "",
                };
            }
        }
    }
    return { completed: false, message: "" };
}
