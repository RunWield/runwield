/**
 * @module cmd/plans
 * List and manage saved Plans.
 */

import { parseArgs } from "../../shared/cli-args.ts";
import { getCwd } from "../../constants.js";
import { countChildPlanProgress, groupPlanHierarchy, listPlans } from "../../plan-store.js";
import { printCommandHelp } from "../help/index.js";
import { runPlansArchiveCommand } from "./archive.ts";
import { runPlansDoctorCommand } from "./doctor.ts";
import { runPlansPullCommand } from "./pull.ts";
import { runPlansPruneCommand } from "./prune.ts";
import { runPlansPushCommand } from "./push.ts";
import { runPlansReadCommand } from "./read.ts";
import { runPlansShareCommand } from "./share.ts";
import { runPlansUiCommand } from "./ui.ts";
import { runPlansUnshareCommand } from "./unshare.ts";
import { SYSTEM_BROWSER_PORT } from "../../shared/browser-port.ts";
import { enterProjectRuntime } from "../../shared/project-runtime-layout.ts";

type PlanEntry = Awaited<ReturnType<typeof listPlans>>[number];

function isHelp(argv: string[]): boolean {
    return argv.includes("--help") || argv.includes("-h");
}

async function enterUnlessHelp(argv: string[]): Promise<void> {
    if (!isHelp(argv)) await enterProjectRuntime(getCwd());
}

function formatChildProgress(children: PlanEntry[]): string {
    const { verified, active, failed, onHold, remaining, total } = countChildPlanProgress(children);
    const label = total === 1 ? "Planned Change" : "Planned Changes";
    const parts = [`${verified}/${total} ${label} verified`];
    if (active > 0) parts.push(`${active} active/implemented`);
    if (onHold > 0) parts.push(`${onHold} on hold`);
    if (remaining > 0) parts.push(`${remaining} remaining`);
    if (failed > 0) parts.push(`${failed} failed`);
    return parts.join(" — ");
}

function formatEpicCompletionState(epic: PlanEntry): string {
    if (epic.attrs.epicCompletionMode !== "done_enough") return "";
    return " — done enough for now";
}

function printPlanDetails(plan: PlanEntry, indent: string): void {
    console.log(
        `${indent}Status: ${plan.attrs.status} | Classification: ${plan.attrs.classification} | Complexity: ${plan.attrs.complexity}`,
    );
    if (plan.attrs.status === "on_hold") {
        console.log(`${indent}Held from: ${plan.attrs.heldFromStatus || "unknown"}`);
        if (plan.attrs.holdReason) console.log(`${indent}Reason: ${plan.attrs.holdReason}`);
    }
    console.log(`${indent}Summary: ${plan.attrs.summary || "(none)"}`);
    if (plan.attrs.worktreeStatus || plan.attrs.worktreeBranch || plan.attrs.worktreePath) {
        const ref = plan.attrs.worktreeBranch || plan.attrs.worktreePath || "unknown";
        console.log(`${indent}Worktree: ${plan.attrs.worktreeStatus || "unknown"} (${ref})`);
    }
    console.log(`${indent}Created: ${plan.attrs.createdAt}`);
}

function printTopLevelPlan(plan: PlanEntry): void {
    console.log(`  ${plan.name}`);
    printPlanDetails(plan, "    ");
    console.log();
}

function printChildPlan(child: PlanEntry): void {
    console.log(`      - ${child.name}`);
    printPlanDetails(child, "        ");
}

export async function runPlansCommand(argv: string[]): Promise<void> {
    const [subcommand] = argv;
    if (subcommand === "ui") {
        await enterUnlessHelp(argv.slice(1));
        await runPlansUiCommand(argv.slice(1), { browser: SYSTEM_BROWSER_PORT });
        return;
    }
    if (subcommand === "archive") {
        await enterUnlessHelp(argv.slice(1));
        await runPlansArchiveCommand(argv.slice(1));
        return;
    }
    if (subcommand === "doctor") {
        await runPlansDoctorCommand(argv.slice(1));
        return;
    }
    if (subcommand === "read") {
        await enterUnlessHelp(argv.slice(1));
        await runPlansReadCommand(argv.slice(1));
        return;
    }
    if (subcommand === "share") {
        await enterUnlessHelp(argv.slice(1));
        await runPlansShareCommand(argv.slice(1));
        return;
    }
    if (subcommand === "pull") {
        await enterUnlessHelp(argv.slice(1));
        await runPlansPullCommand(argv.slice(1));
        return;
    }
    if (subcommand === "prune") {
        await enterUnlessHelp(argv.slice(1));
        await runPlansPruneCommand(argv.slice(1));
        return;
    }
    if (subcommand === "push") {
        await enterUnlessHelp(argv.slice(1));
        await runPlansPushCommand(argv.slice(1));
        return;
    }
    if (subcommand === "unshare") {
        await enterUnlessHelp(argv.slice(1));
        await runPlansUnshareCommand(argv.slice(1));
        return;
    }

    const parsed = parseArgs(argv, {
        boolean: ["help"],
        alias: { h: "help" },
    });

    if (parsed.help) {
        printCommandHelp("plans");
        return;
    }

    await enterProjectRuntime(getCwd());
    const plans = await listPlans(getCwd());
    if (plans.length === 0) {
        console.log("[RunWield] No saved plans found.");
        return;
    }

    const { epics, childrenByParent, standalone, orphanChildren } = groupPlanHierarchy(plans);
    const activeEpics = epics.filter((epic) => epic.attrs.status !== "on_hold");
    const heldEpics = epics.filter((epic) => epic.attrs.status === "on_hold");
    const activeStandalone = standalone.filter((plan) => plan.attrs.status !== "on_hold");
    const heldStandalone = standalone.filter((plan) => plan.attrs.status === "on_hold");
    const activeOrphans = orphanChildren.filter((plan) => plan.attrs.status !== "on_hold");
    const heldOrphans = orphanChildren.filter((plan) => plan.attrs.status === "on_hold");

    console.log("\n[RunWield] Saved plans:\n");

    const printEpic = (epic: PlanEntry): void => {
        const children = childrenByParent.get(epic.name) || [];
        console.log(`  ${epic.name}`);
        printPlanDetails(epic, "    ");
        console.log(`    Progress: ${formatChildProgress(children)}${formatEpicCompletionState(epic)}`);
        if (epic.attrs.epicDoneEnoughSummary) {
            console.log(`    Done enough: ${epic.attrs.epicDoneEnoughSummary}`);
        }
        if (children.length > 0) {
            console.log("    Planned Changes:");
            for (const child of children) printChildPlan(child);
        }
        console.log();
    };

    if (activeEpics.length > 0) {
        console.log("Epics:");
        for (const epic of activeEpics) printEpic(epic);
    }

    if (activeStandalone.length > 0) {
        console.log("Standalone plans:");
        for (const plan of activeStandalone) printTopLevelPlan(plan);
    }

    if (activeOrphans.length > 0) {
        console.log("Orphaned child plans:");
        for (const plan of activeOrphans) printTopLevelPlan(plan);
    }

    const onHoldPlans = [...heldEpics, ...heldStandalone, ...heldOrphans];
    if (onHoldPlans.length > 0) {
        console.log("On Hold:");
        for (const plan of onHoldPlans) {
            if (heldEpics.includes(plan)) printEpic(plan);
            else printTopLevelPlan(plan);
        }
    }
}
