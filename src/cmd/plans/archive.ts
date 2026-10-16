/**
 * @module cmd/plans/archive
 * Archive, list, and restore saved Plans.
 */

import { parseArgs } from "../../shared/cli-args.ts";
import { relative } from "node:path";
import { CLI_BIN, getCwd } from "../../constants.js";
import {
    archivePlan,
    getPlanDocumentRoot,
    isChildFeaturePlan,
    listArchivedPlans,
    listPlans,
    loadArchivedPlan,
    loadPlan,
    restoreArchivedPlan,
} from "../../plan-store.js";
import { formatArchiveRetentionNudge } from "../../shared/plan-archive-retention.ts";
import { runArchiveTransition, type TransitionResult } from "../../shared/workflow/state-transition.ts";
import { resolveWorkflowPlanLocation } from "../../shared/workflow/plan-location.ts";

type PlanEntry = Awaited<ReturnType<typeof listPlans>>[number];
type PlanStatus = PlanEntry["attrs"]["status"];
type ArchivedPlan = Awaited<ReturnType<typeof archivePlan>>;
type RestoredPlan = Awaited<ReturnType<typeof restoreArchivedPlan>>;

interface ArchiveOptions {
    reason?: string;
    force?: boolean;
}

interface BulkArchivePlanEntry {
    name: string;
    relativePath: string;
}

interface BulkArchivePlanFailure extends BulkArchivePlanEntry {
    message: string;
}

interface BulkArchiveResult {
    matched: BulkArchivePlanEntry[];
    archived: BulkArchivePlanEntry[];
    failed: BulkArchivePlanFailure[];
}

interface ArchiveTransitionEnvelope<T> {
    value: T;
}

function printArchiveHelp(): void {
    console.log(`Usage:
  ${CLI_BIN} plans archive
  ${CLI_BIN} plans archive <plan-name-or-id> [--reason <text>] [--force]
  ${CLI_BIN} plans archive --all --status <status> [--reason <text>] [--force]
  ${CLI_BIN} plans archive restore <archived-plan-name-or-id> [--to <plan-name>]

Archives are plaintext markdown under docs/plans/archived/.`);
}

function printArchivedPlans(plans: Awaited<ReturnType<typeof listArchivedPlans>>): void {
    if (plans.length === 0) {
        console.log("[RunWield] No archived plans found.");
        return;
    }
    console.log("\n[RunWield] Archived plans:\n");
    for (const plan of plans) {
        console.log(`  ${plan.name}`);
        console.log(`    Path: ${plan.relativePath}`);
        if (plan.planId) console.log(`    Plan ID: ${plan.planId}`);
        console.log(`    Status: ${plan.status}`);
        console.log(`    Summary: ${plan.summary || "(none)"}`);
        if (plan.attrs.archivedAt) console.log(`    Archived: ${plan.attrs.archivedAt}`);
        if (plan.attrs.archiveReason) console.log(`    Reason: ${plan.attrs.archiveReason}`);
        console.log();
    }
}

async function printArchiveRetentionNudge(cwd: string): Promise<void> {
    const nudge = await formatArchiveRetentionNudge(cwd);
    if (nudge) console.log(`[RunWield] ${nudge}`);
}

function printBulkArchiveResult(result: BulkArchiveResult, status: string): void {
    if (result.matched.length === 0) {
        console.log(`[RunWield] No active Plans with status ${status} found.`);
        return;
    }

    console.log(`[RunWield] Bulk archive for status ${status}:`);
    for (const plan of result.archived) console.log(`  Archived ${plan.name} to ${plan.relativePath}`);
    for (const plan of result.failed) {
        console.log(`  Failed ${plan.name} (${plan.relativePath}): ${plan.message}`);
    }
    console.log(
        `[RunWield] Archived ${result.archived.length}/${result.matched.length} matching Plan(s); ${result.failed.length} failed.`,
    );
}

function unwrapArchiveTransitionValue<T>(transition: TransitionResult): T {
    if (transition.status === "committed") {
        return (transition.value as ArchiveTransitionEnvelope<T>).value;
    }
    const recovery = (transition.recoveryActions || [])
        .map((action) => (action.command ? `${action.label}: ${action.command}` : action.label))
        .join("; ");
    throw new Error(
        `${transition.operation} for Plan needs recovery: ${transition.message || transition.status}${
            recovery ? `. Recovery: ${recovery}` : ""
        }`,
    );
}

function isChildFeatureArchiveCandidate(plan: PlanEntry): boolean {
    return isChildFeaturePlan(plan);
}

function normalizePlanNameArgument(target: string): string {
    return target
        .trim()
        .replace(/^docs\/plans\//i, "")
        .replace(/\.md$/i, "");
}

async function resolveActiveArchiveTarget(cwd: string, target: string): Promise<{ name: string; revision?: string }> {
    const normalizedName = normalizePlanNameArgument(target);
    const byName = (await resolveWorkflowPlanLocation(cwd, normalizedName, { readOnly: true })).plan;
    if (byName) return { name: normalizedName, revision: byName.revision };
    const matches = (await listPlans(cwd)).filter((plan) => plan.attrs.planId === target);
    if (matches.length > 1) throw new Error(`Duplicate planId values found for ${target}; use a Plan name instead.`);
    if (matches.length !== 1) throw new Error(`Active Plan not found: ${target}`);
    const loaded = await loadPlan(getPlanDocumentRoot(matches[0].path), matches[0].name);
    if (!loaded) throw new Error(`Active Plan not found: ${matches[0].name}`);
    return { name: matches[0].name, revision: loaded.revision };
}

async function resolveRestoreDestination(cwd: string, target: string, destination?: string): Promise<string> {
    if (destination) return normalizePlanNameArgument(destination);
    const archived = await loadArchivedPlan(cwd, target);
    if (!archived) throw new Error(`Archived Plan not found: ${target}`);
    return archived.name;
}

async function archivePlansByStatusTransactionally(
    cwd: string,
    status: PlanStatus,
    archiveOptions: ArchiveOptions,
): Promise<BulkArchiveResult> {
    const plans = await listPlans(cwd);
    const childrenByParent = new Map<string, PlanEntry[]>();
    for (const plan of plans) {
        if (!isChildFeatureArchiveCandidate(plan)) continue;
        const parentPlan = plan.attrs.parentPlan || "";
        const children = childrenByParent.get(parentPlan) || [];
        children.push(plan);
        childrenByParent.set(parentPlan, children);
    }
    for (const children of childrenByParent.values()) children.sort((a, b) => a.name.localeCompare(b.name));
    const matchingParentPlans = plans
        .filter((plan) => !isChildFeatureArchiveCandidate(plan) && plan.attrs.status === status)
        .sort((a, b) => a.name.localeCompare(b.name));
    const matchingPlans = matchingParentPlans.flatMap((plan) => [plan, ...(childrenByParent.get(plan.name) || [])]);
    const matched = matchingPlans.map((plan) => ({ name: plan.name, relativePath: relative(cwd, plan.path) }));
    const archived: BulkArchivePlanEntry[] = [];
    const failed: BulkArchivePlanFailure[] = [];
    const now = new Date().toISOString();
    for (const parentPlan of matchingParentPlans) {
        const queue = [
            { plan: parentPlan, options: archiveOptions },
            ...(childrenByParent.get(parentPlan.name) || []).map((plan) => ({
                plan,
                options: { ...archiveOptions, force: true },
            })),
        ];
        for (const item of queue) {
            try {
                const loaded = await loadPlan(getPlanDocumentRoot(item.plan.path), item.plan.name);
                const result = unwrapArchiveTransitionValue<ArchivedPlan>(
                    await runArchiveTransition({
                        projectRoot: cwd,
                        planName: item.plan.name,
                        action: "archive",
                        expectedRevision: loaded?.revision,
                        move: async () => await archivePlan(cwd, item.plan.name, { ...item.options, now }),
                    }),
                );
                archived.push({ name: result.name, relativePath: result.relativePath });
            } catch (error) {
                failed.push({
                    name: item.plan.name,
                    relativePath: relative(cwd, item.plan.path),
                    message: error instanceof Error ? error.message : String(error),
                });
                if (item.plan.name === parentPlan.name) break;
            }
        }
    }
    return { matched, archived, failed };
}

export async function runPlansArchiveCommand(argv: string[]): Promise<void> {
    const parsed = parseArgs(argv, {
        boolean: ["help", "force", "all"],
        string: ["reason", "to", "status"],
        alias: { h: "help" },
    });

    if (parsed.help) {
        printArchiveHelp();
        return;
    }

    const positionals = parsed._.map(String);
    if (positionals[0] === "restore") {
        if (parsed.all) throw new Error("Cannot use --all with archive restore.");
        if (parsed.status !== undefined) throw new Error("Cannot use --status with archive restore.");
        const target = positionals[1];
        if (!target) throw new Error("Missing archived Plan name or id for restore.");
        if (positionals.length > 2) throw new Error(`Unexpected restore argument: ${positionals[2]}`);
        const source = await loadArchivedPlan(getCwd(), target);
        const restored = unwrapArchiveTransitionValue<RestoredPlan>(
            await runArchiveTransition({
                projectRoot: source ? getPlanDocumentRoot(source.path) : getCwd(),
                planName: await resolveRestoreDestination(getCwd(), target, parsed.to),
                action: "restore",
                move: async () => await restoreArchivedPlan(getCwd(), target, { to: parsed.to }),
            }),
        );
        console.log(`[RunWield] Restored ${target} to ${restored.relativePath}`);
        return;
    }

    if (parsed.all) {
        if (parsed.status === undefined) throw new Error("Missing --status for bulk archive.");
        if (positionals.length > 0) throw new Error(`Unexpected archive argument with --all: ${positionals[0]}`);
        const result = await archivePlansByStatusTransactionally(getCwd(), parsed.status as PlanStatus, {
            reason: parsed.reason,
            force: Boolean(parsed.force),
        });
        printBulkArchiveResult(result, parsed.status);
        if (result.archived.length > 0) await printArchiveRetentionNudge(getCwd());
        if (result.failed.length > 0) throw new Error(`Bulk archive failed for ${result.failed.length} Plan(s).`);
        return;
    }

    if (parsed.status !== undefined) throw new Error("--status requires --all for bulk archive.");

    if (positionals.length === 0) {
        printArchivedPlans(await listArchivedPlans(getCwd()));
        return;
    }

    if (positionals.length > 1) throw new Error(`Unexpected archive argument: ${positionals[1]}`);
    const target = await resolveActiveArchiveTarget(getCwd(), positionals[0]);
    const archived = unwrapArchiveTransitionValue<ArchivedPlan>(
        await runArchiveTransition({
            projectRoot: getCwd(),
            planName: target.name,
            action: "archive",
            expectedRevision: target.revision,
            move: async () =>
                await archivePlan(getCwd(), target.name, {
                    reason: parsed.reason,
                    force: Boolean(parsed.force),
                }),
        }),
    );
    console.log(`[RunWield] Archived ${positionals[0]} to ${archived.relativePath}`);
    await printArchiveRetentionNudge(getCwd());
}
