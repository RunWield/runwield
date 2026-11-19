import type { CommandContext } from "../registry.ts";

/** Show the active review or reopen this Session's most recent review. */
export async function runPlanReviewCommand(
    args: string[],
    options?: CommandContext,
): Promise<void | "failed" | "rejected"> {
    const ui = options?.uiAPI;
    if (!ui || !options?.sessionRuntime || !options.sessionId) {
        throw new Error("/plan-review requires an interactive Session.");
    }
    if (args.length) {
        ui.appendSystemMessage("Usage: /plan-review");
        return "rejected";
    }
    const result = await options.sessionRuntime.reopenPlanReview(options.sessionId);
    ui.appendSystemMessage(result.url ? `${result.message} ${result.url}` : result.message);
    if (!result.url) return "failed";
}
