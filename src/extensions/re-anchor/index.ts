import { readFileSync } from "node:fs";
/**
 * @module extensions/re-anchor
 * Re-anchors the active agent on its durable artifact after context compaction.
 *
 * Compaction is where drift becomes invisible: the instruction to reread the
 * Plan lives in the very context compaction just discarded. This extension puts
 * the pointer back on the next provider request.
 *
 * It has to be an extension, and not a RunWield turn boundary, because
 * `threshold` and `overflow` compaction fire *mid-turn*. The request that
 * follows them is the same turn continuing, not a request RunWield built, so
 * injecting at `buildEngineerRequest` would catch only manual `/compact`. The
 * `context` event is the one seam that fires on the continuation request.
 */

import type { ContextEvent, ExtensionAPI, SessionCompactEvent } from "@earendil-works/pi-coding-agent";
import { buildReAnchorMessage, type ReAnchorContext } from "../../shared/workflow/workflow-prompts.ts";
import { projectEngineerPlanBody } from "../../shared/workflow/engineer-plan-projection.ts";
import { getStoredPlanPath } from "../../plan-store.ts";
import { normalizeWorkflowPlanName } from "../../shared/session/workflow-context-session.ts";
import { normalizeLedger, renderOpenItems } from "../../shared/workflow/review-ledger.ts";
import type { HostedSession } from "../../shared/session/hosted-session.ts";

export interface ReAnchorOptions {
    /** The agent this session was built for. Decides which artifact, if any, is re-anchored. */
    agentName: string;
    hostedSession?: HostedSession | null;
}

type ReAnchorResolution = Required<ReAnchorContext>;

/** Read the reminder from the active system prompt, including Agent overrides. */
function readCompactionReminder(systemPrompt: string): string {
    const lines = systemPrompt.split(/\r?\n/);
    const start = lines.findLastIndex((line) => /^## Compaction reminder\s*$/i.test(line));
    if (start < 0) return "";
    const remaining = lines.slice(start + 1);
    const end = remaining.findIndex((line) => /^#{1,2}\s/.test(line));
    return (end < 0 ? remaining : remaining.slice(0, end)).join("\n").trim();
}

// The Agents that execute or repair against an approved Plan. The selectable
// Engineer is absent on purpose: a QUICK_FIX has no Plan to re-anchor to.
const EXECUTION_AGENTS = new Set(["plan-engineer", "frontend-engineer", "reviewer-feedback-engineer"]);

/**
 * Resolve the artifact pointer from live session state.
 *
 * Execution and repair turns carry the Plan on the active execution workflow;
 * planning turns resumed through `load-plan` or settled by `plan_written` carry
 * it on the workflow context. Execution wins because a repair turn has both and
 * only one of them is the Plan currently being worked.
 */
function resolveReAnchorContext(options: ReAnchorOptions): ReAnchorResolution {
    const hostedSession = options.hostedSession;
    const activeWorkflow = hostedSession?.getActiveExecutionWorkflow() ?? null;
    const planName =
        normalizeWorkflowPlanName(activeWorkflow?.planName) ||
        normalizeWorkflowPlanName(hostedSession?.getWorkflowContext()?.planName);

    let planBody = "";
    if (planName && EXECUTION_AGENTS.has(options.agentName)) {
        const executionCwd = activeWorkflow?.executionCwd || activeWorkflow?.projectRoot || hostedSession?.cwd || "";
        if (executionCwd) {
            const markdown = readFileSync(getStoredPlanPath(executionCwd, planName), "utf8");
            planBody = projectEngineerPlanBody(markdown);
        }
    }

    return {
        agentName: options.agentName,
        planName,
        openReviewItems: activeWorkflow?.reviewLedger
            ? renderOpenItems(normalizeLedger(activeWorkflow.reviewLedger))
            : "",
        planBody,
    };
}

/**
 * Register post-compaction re-anchoring for one agent session.
 *
 * @param pi Extension API for the session being built.
 * @param options The agent identity and workflow state this session re-anchors against.
 */
export default function reAnchorExtension(pi: ExtensionAPI, options: ReAnchorOptions): void {
    let pendingReAnchor = false;

    pi.on("session_compact", (event: SessionCompactEvent) => {
        // Overflow recovery compacts, retries the aborted turn, and can compact
        // again for the same boundary. Only the settled compaction — the one
        // nothing is retried after — should arm the re-anchor, so a single
        // boundary never injects twice.
        if (event?.willRetry) return;
        pendingReAnchor = true;
    });

    pi.on("context", (event: ContextEvent, ctx) => {
        const reminder = readCompactionReminder(ctx.getSystemPrompt());
        // Project onto the compacted context, never onto the saved summary. Each
        // Agent session supplies its own reminder, including after resume/switch.
        const messages =
            reminder && event.messages.some((message) => message.role === "compactionSummary")
                ? event.messages.map((message) =>
                      message.role === "compactionSummary"
                          ? { ...message, summary: `${message.summary}\n\n## Compaction reminder\n\n${reminder}` }
                          : message,
                  )
                : event.messages;
        const projected = messages === event.messages ? undefined : { messages };
        if (!pendingReAnchor) return projected;
        // Clear before doing any work: one compaction boundary re-anchors once,
        // whether or not this particular request ends up carrying a message.
        pendingReAnchor = false;

        try {
            const text = buildReAnchorMessage(resolveReAnchorContext(options));
            if (!text) return projected;

            // Append only. The event can replace the whole array, and rebuilding
            // it would put this extension in charge of history it has no business
            // editing.
            return { messages: [...messages, { role: "user" as const, content: text, timestamp: Date.now() }] };
        } catch {
            // Re-anchoring is fail-open. A resolution failure loses the pointer;
            // throwing here would lose the provider request.
            return projected;
        }
    });
}
