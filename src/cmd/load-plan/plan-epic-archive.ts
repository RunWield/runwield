import { archiveEpicPlanFamily } from "../../plan-store/index.ts";
/**
 * @module cmd/load-plan/plan-epic-archive
 * Archive a terminal Epic with its child Plans.
 */

import { CLI_BIN } from "../../constants.js";
import {
    compareChildPlansByOrder,
    isRecoverableWorktreeStatus,
    isTerminalArchivableStatus,
} from "../../plan-format.ts";
import { findPlansByParent, loadPlan } from "../../plan-store/index.ts";
import { startBackgroundArchive } from "./archive-background.ts";
import { formatEpicProgressSummary } from "./plan-epic-children.ts";
import type { PlanFrontMatter } from "../../plan-store/index.ts";
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

function blockingWorktreePlans(plans: ListedPlanForArchive[]): ListedPlanForArchive[] {
    return plans.filter((entry) => isRecoverableWorktreeStatus(entry.attrs.worktreeStatus));
}

export async function archiveEpicWithChildren({ projectRoot, plan, uiAPI }: ArchiveEpicOptions): Promise<boolean> {
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

    startBackgroundArchive({
        projectRoot,
        planName: plan.planName,
        uiAPI,
        archive: async () => {
            const { archived, cleanupMessage } = await archiveEpicPlanFamily(
                projectRoot,
                plan.planName,
                children.map((child) => child.name),
            );
            if (cleanupMessage) uiAPI.appendSystemMessage(cleanupMessage, false, "RunWield");

            const archivedList = archived.map((entry) => `- ${entry.name}: ${entry.relativePath}`).join("\n");
            const archivedArtifacts = archived.flatMap((entry) => entry.artifacts || []);
            const artifactList =
                archivedArtifacts.length > 0
                    ? `\nMoved Epic Artifact(s):\n${archivedArtifacts
                          .map((entry) => `- ${entry.fileName}: ${entry.relativePath}`)
                          .join("\n")}`
                    : "";
            return `Archived Epic and child Plans:\n${archivedList}${artifactList}\nRestore with: ${CLI_BIN} plans archive restore <name>`;
        },
    });
    return true;
}
