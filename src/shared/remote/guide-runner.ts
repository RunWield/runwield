import process from "node:process";
import { generateGuidedReview } from "../../cmd/guided-review/index.ts";
import { RuntimeUsageTotals } from "../session/runtime-usage-totals.ts";
import type { GuidedReviewUsage } from "../../cmd/guided-review/protocol.ts";
import { runWldJobCommand } from "../../ui/workspace/routes/api/review-agent-handlers.js";

export interface GuideProgress {
    onUsage?: (usage: GuidedReviewUsage) => void;
}

/** The remote view must configure personal resources, settings and the laptop model registry first. */
export async function runRemoteGuideCommand(
    prompt: string,
    signal: AbortSignal,
    cwd: string,
    progress: GuideProgress = {},
) {
    // An explicit user command keeps its existing subprocess semantics.
    if (process.env["RUNWIELD_GUIDED_REVIEW_COMMAND"]) {
        return runWldJobCommand(prompt, signal, cwd, progress);
    }
    let usage: GuidedReviewUsage | undefined;
    const totals = new RuntimeUsageTotals();
    const result = await generateGuidedReview(prompt, {
        cwd,
        signal,
        inMemory: true,
        onUsage: (event) => {
            totals.add(event);
            usage = { ...totals.usage };
            progress.onUsage?.(event);
        },
    });
    return { ...result, ...(usage ? { usage, cost: { usd: usage.costUsd } } : {}) };
}
