import { CLI_BIN } from "../../constants.ts";
import { parseArgs } from "../../shared/cli-args.ts";
import { redactCollaborationUrl } from "@runwield/plans/plan-server";
import { sharePlanForReview } from "../../plan-store/index.ts";

export {
    sharePlanForReview,
    type SharePlanForReviewOptions,
    type SharedPlanReviewLink,
} from "../../plan-store/index.ts";

type PlansShareArgs =
    | { help: true; projectSecrets: boolean }
    | { help: false; target: string; planServer?: string; projectSecrets: boolean };

/** @param {string[]} argv */
export function parsePlansShareArgs(argv: string[]): PlansShareArgs {
    const parsed = parseArgs(argv, {
        boolean: ["help", "project-secrets"],
        string: ["plan-server"],
        alias: { h: "help" },
    });
    const positionals = parsed._.map(String);
    if (parsed.help) return { help: true, projectSecrets: Boolean(parsed["project-secrets"]) };
    if (positionals.length === 0) throw new Error("Missing Plan name or id for share.");
    if (positionals.length > 1) throw new Error(`Unexpected share argument: ${positionals[1]}`);
    return {
        planServer: typeof parsed["plan-server"] === "string" ? parsed["plan-server"] : undefined,
        projectSecrets: Boolean(parsed["project-secrets"]),
        help: false,
        target: positionals[0],
    };
}

function printShareHelp() {
    console.log(`Usage: ${CLI_BIN} plans share <plan-name-or-id> [--plan-server <url>] [--project-secrets]

Publishes an active saved Plan to a Plan Server with share retry support and prints secret reviewer/maintainer URLs once.`);
}

/**
 * @param {string[]} argv
 */
export async function runPlansShareCommand(argv: string[]): Promise<void> {
    const args = parsePlansShareArgs(argv);
    if (args.help) {
        printShareHelp();
        return;
    }
    const shared = await sharePlanForReview({
        target: args.target,
        planServer: args.planServer,
        projectSecrets: args.projectSecrets,
        allowExisting: false,
    });
    console.log(
        `[RunWield] Shared Plan ${shared.planName} as remote Shared Space ${shared.spaceId} (revision ${shared.revision}).`,
    );
    console.log("\nReviewer URL (secret; share only with reviewers):");
    console.log(shared.reviewerUrl);
    console.log("\nMaintainer URL (powerful secret):");
    console.log(shared.maintainerUrl);
    if (shared.expiresAt) {
        console.log(
            `\nInactivity retention: this Shared Space expires at ${shared.expiresAt}. New revisions, comments, resolve/reopen, or close actions refresh the expiry; viewing alone does not.`,
        );
    }
    console.log(
        "\nWarning: anyone with the maintainer URL can pull, push, close, or unshare this Shared Space. Store these URLs securely; RunWield will not print them again.",
    );
    console.log(
        `[RunWield] Stored local secret material outside Plan front matter/settings. API/server URL: ${redactCollaborationUrl(
            shared.serverUrl,
        )}`,
    );
}
