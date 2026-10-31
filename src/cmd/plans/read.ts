/**
 * @module cmd/plans/read
 * Open active or archived Plan markdown in a read-only browser view.
 */

import { CLI_BIN, getCwd, PLANS_DIR_NAME } from "../../constants.js";
import {
    findPlanById,
    listArchivedPlans,
    loadArchivedPlan,
    PlanNotFoundError,
    type PlanReadAvailability,
} from "../../plan-store.js";
import { NO_OPEN_BROWSER_PORT, SYSTEM_BROWSER_PORT } from "../../shared/browser-port.ts";
import { resolveWorkflowPlanLocation } from "../../shared/workflow/plan-location.ts";
import { startArtifactReadSurface } from "../../ui/review/review-launcher.ts";

interface ResolvedPlanReadArtifact {
    title: string;
    path: string;
    markdown: string;
    readAvailability?: PlanReadAvailability;
}

async function openPlanReadSurface(
    artifact: ResolvedPlanReadArtifact,
    options: { noOpen?: boolean } = {},
): Promise<void> {
    const noOpen = options.noOpen === true;
    const server = await startArtifactReadSurface({
        cwd: getCwd(),
        markdown: artifact.markdown,
        artifactKind: "plan",
        title: artifact.title,
        path: artifact.path,
        notices:
            artifact.readAvailability?.kind === "pending"
                ? [artifact.readAvailability.message || "Workflow details pending."]
                : [],
        browser: noOpen ? NO_OPEN_BROWSER_PORT : SYSTEM_BROWSER_PORT,
    });
    console.log(`[RunWield] Plan read-only view: ${server.url}`);
    if (!server.opened && !noOpen) {
        console.log(
            "[RunWield] Could not open your browser automatically. Open the URL above, then choose Close when finished.",
        );
    }
    try {
        await server.waitForDecision();
    } finally {
        await Promise.race([Promise.resolve(server.stop()), new Promise<void>((resolve) => setTimeout(resolve, 1000))]);
    }
}

export async function runPlansReadCommand(argv: string[]): Promise<void> {
    if (argv[0] === "--help" || argv[0] === "-h") {
        console.log(`Usage: ${CLI_BIN} plans read [--no-open] <plan-name-or-id>`);
        return;
    }
    let noOpen = false;
    const targets: string[] = [];
    for (const arg of argv) {
        if (arg === "--no-open") {
            noOpen = true;
            continue;
        }
        if (arg.startsWith("-")) throw new Error(`Unexpected read argument: ${arg}`);
        targets.push(arg);
    }
    const target = targets[0];
    if (!target) throw new Error("Missing Plan name or id.");
    if (targets.length > 1) throw new Error(`Unexpected read argument: ${targets[1]}`);

    const active = target.replaceAll("\\", "/").startsWith("archived/")
        ? null
        : (await resolveWorkflowPlanLocation(getCwd(), target, { readOnly: true })).plan;
    if (active && !target.replaceAll("\\", "/").startsWith("archived/")) {
        await openPlanReadSurface(
            {
                title: target.replace(/\.md$/, ""),
                path: active.path,
                markdown: active.markdown,
                readAvailability: active.readAvailability,
            },
            { noOpen },
        );
        return;
    }

    const archived = await loadArchivedPlan(getCwd(), target);
    if (archived) {
        await openPlanReadSurface(
            {
                title: `${PLANS_DIR_NAME}/archived/${archived.name}.md`,
                path: archived.path,
                markdown: archived.markdown,
                readAvailability: archived.readAvailability,
            },
            { noOpen },
        );
        return;
    }

    const archivedMatches = (await listArchivedPlans(getCwd())).filter((plan) => plan.planId === target);
    if (archivedMatches.length > 1) {
        throw new Error(`Duplicate archived planId values found for ${target}; use an archived Plan name instead.`);
    }
    if (archivedMatches.length === 1) {
        const loaded = await loadArchivedPlan(getCwd(), archivedMatches[0].name);
        if (loaded) {
            await openPlanReadSurface(
                {
                    title: `${PLANS_DIR_NAME}/archived/${loaded.name}.md`,
                    path: loaded.path,
                    markdown: loaded.markdown,
                    readAvailability: loaded.readAvailability,
                },
                { noOpen },
            );
            return;
        }
    }

    try {
        const activeById = await findPlanById(getCwd(), target);
        await openPlanReadSurface(
            {
                title: activeById.planName,
                path: activeById.path,
                markdown: activeById.markdown,
                readAvailability: activeById.readAvailability,
            },
            { noOpen },
        );
        return;
    } catch (error) {
        if (!(error instanceof PlanNotFoundError)) throw error;
        // Only ordinary absence may continue to the user-facing not-found error.
    }

    throw new Error(`Plan not found: ${target}`);
}
