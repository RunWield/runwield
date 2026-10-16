import { rmdir as fsRmdir } from "node:fs/promises";
/**
 * @module cmd/load-plan/plan-epic-archive
 * Archive a terminal Epic with its child Plans.
 */

import { CLI_BIN } from "../../constants.js";
import {
    archivePlan,
    compareChildPlansByOrder,
    findPlansByParent,
    isRecoverableWorktreeStatus,
    isTerminalArchivableStatus,
    loadPlan,
} from "../../plan-store.js";
import { runArchiveTransition } from "../../shared/workflow/state-transition.ts";
import { formatArchiveRetentionNudge } from "../../shared/plan-archive-retention.ts";
import { formatEpicProgressSummary } from "./plan-epic-children.ts";
import { transitionFailureError } from "./transition-failure.ts";
import { relative } from "node:path";
import type { PlanFrontMatter } from "../../plan-store.js";
import type { UiAPI } from "../../ui/tui/types.js";

export interface ArchiveEpicPlanRef {
    planName: string;
    attrs: PlanFrontMatter;
}

export interface ArchiveEpicOptions {
    projectRoot: string;
    plan: ArchiveEpicPlanRef;
    uiAPI: UiAPI;
}

interface ListedPlanForArchive {
    name: string;
    path: string;
    attrs: PlanFrontMatter;
}

interface ArchivedPlanResult {
    name: string;
    relativePath: string;
    artifacts?: Array<{ fileName: string; relativePath: string }>;
}

function relativeProjectPath(projectRoot: string, path: string): string {
    return relative(projectRoot, path).replaceAll("\\", "/");
}

function activeEpicChildDirectory(epicPath: string): string {
    return epicPath.endsWith(".md") ? epicPath.slice(0, -3) : `${epicPath}.children`;
}

function blockingWorktreePlans(plans: ListedPlanForArchive[]): ListedPlanForArchive[] {
    return plans.filter((entry) => isRecoverableWorktreeStatus(entry.attrs.worktreeStatus));
}

async function archiveOnePlan(
    projectRoot: string,
    planName: string,
    now: string,
    force: boolean,
): Promise<ArchivedPlanResult> {
    const loaded = await loadPlan(projectRoot, planName);
    if (!loaded) throw new Error(`Plan not found: ${planName}`);
    let archived: ArchivedPlanResult | null = null;
    const transition = await runArchiveTransition({
        projectRoot,
        planName,
        action: "archive",
        expectedRevision: loaded.revision,
        move: async () => {
            const result = await archivePlan(projectRoot, planName, force ? { force: true, now } : { now });
            archived = { name: result.name, relativePath: result.relativePath, artifacts: result.artifacts };
            return result.relativePath;
        },
    });
    if (transition.status !== "committed") {
        throw transitionFailureError(transition, `Archive transaction failed for ${planName}.`);
    }
    if (!archived) throw new Error(`Archive transaction did not return a result for ${planName}.`);
    return archived;
}

async function removeActiveEpicChildDirectory(projectRoot: string, epicChildDirectory: string, uiAPI: UiAPI) {
    const relativePath = relativeProjectPath(projectRoot, epicChildDirectory);
    try {
        await fsRmdir(epicChildDirectory);
    } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") {
            uiAPI.appendSystemMessage(
                `Active Epic child directory was already absent: ${relativePath}`,
                false,
                "RunWield",
            );
            return;
        }
        const reason = error instanceof Error ? error.message : String(error);
        uiAPI.appendSystemMessage(
            `Active Epic child directory was left in place because it is missing protected cleanup preconditions or is not empty: ${relativePath}. ${reason}`,
            false,
            "RunWield",
        );
    }
}

export async function archiveEpicWithChildren(
    { projectRoot, plan, uiAPI }: ArchiveEpicOptions,
): Promise<boolean> {
    if (!isTerminalArchivableStatus(plan.attrs.status)) {
        uiAPI.appendSystemMessage(
            `Epics with status ${plan.attrs.status} cannot be archived from this menu.`,
            true,
            "RunWield",
        );
        return false;
    }

    const loadedEpic = await loadPlan(projectRoot, plan.planName);
    if (!loadedEpic) {
        uiAPI.appendSystemMessage(`Epic not found: ${plan.planName}`, true, "RunWield");
        return false;
    }
    const epicChildDirectory = activeEpicChildDirectory(loadedEpic.path);
    const epicEntry: ListedPlanForArchive = { name: plan.planName, path: loadedEpic.path, attrs: loadedEpic.attrs };
    const children = (await findPlansByParent(projectRoot, plan.planName)).sort(compareChildPlansByOrder);
    const allPlans = [epicEntry, ...children];
    const blockers = blockingWorktreePlans(allPlans);
    if (blockers.length > 0) {
        const details = blockers.map((entry) => `${entry.name} (${entry.attrs.worktreeStatus})`).join(", ");
        uiAPI.appendSystemMessage(
            `Cannot archive Epic because these Plans have recoverable worktreeStatus values: ${details}. Resolve or abandon the worktrees before archiving.`,
            true,
            "RunWield",
        );
        return false;
    }

    const unfinishedChildren = children.filter((child) => !isTerminalArchivableStatus(child.attrs.status)).length;
    const confirmationMessage = [
        ...(children.length > 0 ? [formatEpicProgressSummary(children)] : []),
        `Archive Epic will archive ${children.length} child Plan(s) with the Epic. ${unfinishedChildren} child Plan(s) are not at a terminal archivable status.`,
        `Restore later with: ${CLI_BIN} plans archive restore <name>`,
    ].join("\n");
    uiAPI.appendSystemMessage(confirmationMessage, false, "RunWield");
    const answer = await uiAPI.promptSelect("Archive this Epic and its child Plans?", [
        { value: "confirm", label: "Archive Epic and child Plans" },
        { value: "cancel", label: "Cancel" },
    ]);
    if (answer !== "confirm") {
        uiAPI.appendSystemMessage("Epic archive canceled.", false, "RunWield");
        return false;
    }

    const now = new Date().toISOString();
    const archived: ArchivedPlanResult[] = [];
    for (const child of children) {
        archived.push(await archiveOnePlan(projectRoot, child.name, now, true));
    }
    archived.push(await archiveOnePlan(projectRoot, plan.planName, now, false));

    await removeActiveEpicChildDirectory(projectRoot, epicChildDirectory, uiAPI);

    const archivedList = archived.map((entry) => `- ${entry.name}: ${entry.relativePath}`).join("\n");
    const archivedArtifacts = archived.flatMap((entry) => entry.artifacts || []);
    const artifactList = archivedArtifacts.length > 0
        ? `\nMoved Epic Artifact(s):\n${
            archivedArtifacts.map((entry) => `- ${entry.fileName}: ${entry.relativePath}`).join("\n")
        }`
        : "";
    uiAPI.appendSystemMessage(
        `Archived Epic and child Plans:\n${archivedList}${artifactList}\nRestore with: ${CLI_BIN} plans archive restore <name>`,
        false,
        "RunWield",
    );
    const nudge = await formatArchiveRetentionNudge(projectRoot);
    if (nudge) uiAPI.appendSystemMessage(nudge, false, "RunWield");
    return true;
}
