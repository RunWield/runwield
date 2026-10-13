import { getCwd } from "../../constants.js";
import { SYSTEM_BROWSER_PORT } from "../../shared/browser-port.ts";
import { resolveReviewTarget } from "../../shared/standalone-review/review-target.ts";
import { runStandaloneReview } from "../../shared/standalone-review/review-loop.ts";
export async function runReviewCommand(args: string[]): Promise<void> {
    if (args.includes("--help") || args.includes("-h")) {
        console.log(
            "Usage:\n  wld review\n  wld review <branch>\n  wld review <PR/MR URL>\n\nReview uncommitted changes, a branch, or a PR with Guided Review and Engineer chat.",
        );
        return;
    }
    if (args.length > 1 || args.some((arg) => arg.startsWith("-"))) {
        throw new Error("Usage: wld review [branch | PR/MR URL]");
    }
    await runStandaloneReview(await resolveReviewTarget(getCwd(), args[0]), {
        browser: SYSTEM_BROWSER_PORT,
        print: console.log,
    });
}
