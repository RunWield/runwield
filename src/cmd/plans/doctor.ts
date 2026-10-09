/**
 * @module cmd/plans/doctor
 * Report and safely repair Plan/worktree lifecycle drift.
 */

import { parseArgs } from "@std/cli/parse-args";
import { join } from "@std/path";
import { CLI_BIN, getCwd, isPlannedChangeClassification, WORKTREE_BRANCH_PREFIX } from "../../constants.js";
import {
    ensurePlanIdentity,
    getPlanDocumentRoot,
    getPlansDir,
    inspectPlanFileStrict,
    isProjectPlan,
} from "../../plan-store.js";
import {
    enterProjectRuntime,
    inspectProjectRuntimeLayout,
    ProjectRuntimeEntryRefusedError,
    type ProjectRuntimeLayout,
    type ProjectRuntimeMigrationBlockedResult,
    resolveProjectRuntimeLayout,
} from "../../shared/project-runtime-layout.ts";
import { inspectRunWieldGitignore } from "../../shared/runwield-owned-paths.ts";
import { readLockFileSnapshot, removeLockFileIfSnapshotMatches } from "../../shared/lock-file-snapshot.ts";
import { inspectPlanIdentityDocuments } from "../../shared/workflow/plan-diagnostic-evidence.ts";
import {
    getTransitionJournalDir,
    reconcileTransitionRecoveryRecords,
    type TransitionReconciliation,
} from "../../shared/workflow/state-transition.ts";
import { buildEffectProver, listGitWorktreePaths, runGitLines } from "../../shared/workflow/transition-recovery.ts";
import { isLockHolderGone, isLockHolderUnattributable } from "../../shared/process-liveness.ts";
import { doctorCheckMessage, doctorCleanMessage, doctorNeedsHelpMessage } from "./doctor-messages.ts";
import {
    inspectWorktreeRegistryAtPath,
    listEntries,
    pruneEntry,
    reconcileEntryIdentity,
} from "../../shared/worktree-registry.js";
import { isEpicArtifactPlanName } from "../../shared/epic-artifacts.ts";
import { inspectTargetBranchPlansByParent } from "../../shared/workflow/planning-worktree.ts";
import { readControllerRecordAtPath } from "../../shared/workflow/controller-registry.ts";
import { verifyRecordedPublication } from "../../shared/workflow/validation-merge-verification.ts";

/** A registry attempt as stored, before doctor proves anything about it. */
type RegistryEntry = Awaited<ReturnType<typeof inspectWorktreeRegistryAtPath>>["entries"][number];

interface DoctorIssue {
    kind: string;
    message: string;
    planName?: string;
    worktreeId?: string;
    repairable?: boolean;
    /**
     * Commands for this exact occurrence, ready to paste. Instance-specific paths
     * and ids belong here; `IssueGuidance.nextSteps` covers the general advice.
     */
    commands?: string[];
    /** What --repair did, or would do. Printed so the action is never a surprise. */
    repairSummary?: string;
}

interface IssueGuidance {
    category: string;
    severity: "Critical" | "Needs attention" | "Cleanup";
    diagnosis: string;
    nextSteps: string[];
}

type PlansDoctorCommandOptions = Record<never, never>;

const READ_ONLY_DOCTOR_FLAG = "--check";

function migrationRefusalGuidance(blocked: ProjectRuntimeMigrationBlockedResult): string[] {
    switch (blocked.reason) {
        case "newer_layout":
            return [
                "Use the RunWield version that created this layout, or a newer version. Do not downgrade the marker.",
            ];
        case "malformed_migration_evidence":
            return ["Preserve the named migration files. Restore valid RunWield evidence, then retry."];
        case "authority_conflict":
            return [
                "Keep both old and new authorities. Decide which copy is authoritative before retrying; RunWield will not choose or delete one.",
            ];
        case "active_legacy_writer":
            return [
                "Finish or stop the named 0.10 RunWield process, then retry. Do not delete its lock while it can still be live.",
            ];
        case "malformed_registry":
            return [
                "Preserve the registry and its worktrees. Repair the malformed bookkeeping with the RunWield version that wrote it, then retry.",
            ];
        case "tracked_runtime":
            return [
                "Remove the named runtime paths from the Git index without deleting local files, commit that change, then retry.",
            ];
        case "tracked_secret":
            return [
                "Untrack the named secret path, remove it from repository history, and rotate every exposed capability. The secret value is not shown.",
            ];
        case "symlink":
            return [
                "Replace the named runtime symlink with a real local path after preserving its target. RunWield stopped before reading through it.",
            ];
        case "invalid_registered_checkout":
            return [
                "Repair or remove the invalid Git worktree registration only after preserving its branch and local work, then retry.",
            ];
        case "unsupported_filesystem_move":
            return blocked.message.includes("populated project-local worktree directory")
                ? [
                    "Preserve the populated project-local fallback worktree directory. Finish or deliberately remove its work with the RunWield version that created it, then retry. RunWield will not move it.",
                ]
                : [
                    "Move the project or runtime authority onto one supported filesystem, or complete the upgrade with a supported RunWield version.",
                ];
        default: {
            const exhaustive: never = blocked.reason;
            return [exhaustive];
        }
    }
}

function migrationBlockedIssue(blocked: ProjectRuntimeMigrationBlockedResult): DoctorIssue {
    return {
        kind: "runtime_migration_blocked",
        message: `Migration refusal (${blocked.reason}): ${blocked.message}${
            blocked.paths.length ? ` Paths: ${blocked.paths.join(", ")}.` : ""
        }${blocked.securityAction ? ` Security action: ${blocked.securityAction.message}` : ""}`,
        commands: migrationRefusalGuidance(blocked),
    };
}

function printHelp() {
    console.log(`Usage:
  ${CLI_BIN} plans doctor [${READ_ONLY_DOCTOR_FLAG}]

Fixes safe Plan problems. Use ${READ_ONLY_DOCTOR_FLAG} to only look. --repair is kept as an alias.`);
}

function getIssueGuidance(issue: DoctorIssue): IssueGuidance {
    switch (issue.kind) {
        case "runtime_migration_blocked":
            return {
                category: "Project runtime adoption",
                severity: "Critical",
                diagnosis:
                    "RunWield stopped before changing project runtime state because safe adoption is not proven.",
                nextSteps: ["Follow the specific action below, preserve every named path, then run Doctor again."],
            };
        case "runtime_adoption_pending":
            return {
                category: "Project runtime adoption",
                severity: "Needs attention",
                diagnosis: "This project still uses the 0.10 runtime layout.",
                nextSteps: [`Run ${CLI_BIN} plans doctor --repair to adopt it after you review this report.`],
            };
        case "broad_wld_ignore":
            return {
                category: "Git protection",
                severity: "Needs attention",
                diagnosis: "A user-owned ignore rule hides more than RunWield runtime state.",
                nextSteps: ["Keep or narrow this rule yourself. Doctor will never remove a user-owned rule."],
            };
        case "malformed_plan":
        case "malformed_archived_plan":
        case "non_regular_plan_path":
            return {
                category: "Plan files",
                severity: "Critical",
                diagnosis:
                    "RunWield cannot parse the Front Matter block in this Plan file, so it will not touch the file at all.",
                nextSteps: [
                    "Only the YAML between the leading --- markers has to be valid. Your body text below it is yours and is never parsed, so nothing there can cause this.",
                    "RunWield left the file byte-for-byte as it found it, so a git diff shows exactly what changed.",
                    `Plan actions stay blocked until it parses; re-run ${CLI_BIN} plans doctor to confirm the fix.`,
                ],
            };
        case "duplicate_plan_id":
            return {
                category: "Plan identity",
                severity: "Critical",
                diagnosis: "Two Plans claim the same stable identity, so RunWield can attach work to the wrong Plan.",
                nextSteps: [
                    "Inspect both Plans and decide which one owns the planId.",
                    "Do not hand-edit Plan metadata unless you are intentionally repairing identity state; prefer restoring from the correct Plan source.",
                ],
            };
        case "verified_without_evidence":
        case "uncertain_publication":
        case "publication_inspection_error":
            return {
                category: "Delivery evidence",
                severity: "Needs attention",
                diagnosis: "Validation passed, but delivery to the target branch has not been confirmed.",
                nextSteps: [
                    "Load this Plan and choose validation to continue its saved publication attempt.",
                    "If its target branch was intentionally removed or rewritten after delivery, this warning does not mean the changes were lost.",
                ],
            };
        case "target_branch_inspection_error":
            return {
                category: "Target branch inspection",
                severity: "Critical",
                diagnosis:
                    "RunWield could not inspect the authoritative target branch, so child Plan state is unknown.",
                nextSteps: [
                    "Restore remote access and run Doctor again.",
                    "Do not treat a clean local target branch as proof while remote inspection is unavailable.",
                ],
            };
        case "unresolved_transition":
        case "unresolved_transition_in_worktree":
            return {
                category: "Plan updates",
                severity: "Critical",
                diagnosis:
                    "A Plan update stopped before RunWield could prove how it ended, so RunWield is holding further changes to that Plan.",
                nextSteps: [
                    "The detail line names the exact effect involved; that is the only thing worth checking.",
                    "Nothing here is lost work: the Plan, its worktree, and its branch are untouched while this is open.",
                    "Plan Recovery clears these records after a successful recovery action.",
                ],
            };
        case "stale_plan_lock":
            return {
                category: "Plan updates",
                severity: "Cleanup",
                diagnosis:
                    "A lock file outlived the process that created it. RunWield reclaims these on its own, but only after making the next command wait.",
                nextSteps: [
                    "Nothing is at risk: the file records only that a process was working on the Plan.",
                    "Clear it now to avoid an unexplained pause the next time you touch this Plan.",
                ],
            };
        case "registry_integrity_error":
            return {
                category: "Worktree registry",
                severity: "Critical",
                diagnosis:
                    "RunWield's own worktree registry file is unreadable, so attempt state is hidden until it is restored.",
                nextSteps: [
                    "Preserve this machine-owned file and inspect git worktree list before repair.",
                    "Attempts remain recoverable from their branches and directories, which are untouched.",
                ],
            };
        case "unsupported_schema_version":
            return {
                category: "Worktree registry",
                severity: "Critical",
                diagnosis:
                    "The worktree registry was written by a newer RunWield than the one running now, so this version must not rewrite it.",
                nextSteps: [
                    "Upgrade RunWield to the version that wrote this registry rather than downgrading the file.",
                    "Do not start, merge, or abandon attempts with this version in the meantime.",
                ],
            };
        case "orphan_git_worktree":
            return {
                category: "Git worktrees",
                severity: "Needs attention",
                diagnosis: "Git knows about a RunWield-looking worktree that RunWield is not tracking.",
                nextSteps: [
                    "Inspect the worktree path and identify whether it contains in-progress Plan work.",
                    "If it is stale, remove it with git worktree remove; if it is active, recover or recreate the RunWield attempt record.",
                ],
            };
        case "orphan_worktree_branch":
            return {
                category: "Git branches",
                severity: "Cleanup",
                diagnosis: "A RunWield worktree branch exists without a matching saved attempt.",
                nextSteps: [
                    "Inspect the branch for unmerged work before deleting it.",
                    "Delete the branch only after confirming it is stale or already published.",
                ],
            };
        case "duplicate_worktree_id":
        case "duplicate_live_attempt":
        case "registry_plan_id_not_found":
        case "registry_plan_identity_mismatch":
        case "registry_missing_plan_id":
            return {
                category: "Worktree registry",
                severity: "Critical",
                diagnosis: "Saved worktree records do not agree with Plan identity or active attempts.",
                nextSteps: [
                    "Do not start another attempt for this Plan until the saved worktree record is understood.",
                    "Use load-plan or the relevant recovery flow to re-bind the attempt; recreate only if the worktree is disposable.",
                ],
            };
        case "missing_worktree_path":
            return {
                category: "Worktree registry",
                severity: issue.repairable ? "Cleanup" : "Critical",
                diagnosis: issue.repairable
                    ? "A completed saved attempt points at a worktree path that no longer exists."
                    : "An active or recoverable attempt points at a missing worktree path.",
                nextSteps: issue.repairable
                    ? [
                        "Run plans doctor --repair to remove this stale saved attempt.",
                        "No source work should be lost because the attempt is already complete.",
                    ]
                    : [
                        "Find whether the worktree was moved, deleted, or never created.",
                        "Recover the path or explicitly abandon the attempt through RunWield after confirming there is no work to save.",
                    ],
            };
        case "archived_plan_with_recoverable_attempt":
            return {
                category: "Archived Plans",
                severity: "Needs attention",
                diagnosis: "An archived Plan still claims there is recoverable worktree state.",
                nextSteps: [
                    "Restore the Plan from archived status before acting on the attempt.",
                    "Resolve, merge, or abandon the attempt, then archive the Plan again when it is settled.",
                ],
            };
        default:
            return {
                category: "Other drift",
                severity: "Needs attention",
                diagnosis: "RunWield found Plan or worktree state that does not match the expected state.",
                nextSteps: [
                    "Read the detail above and inspect the named Plan or worktree before making changes.",
                    "Run plans doctor again after repairing the underlying state.",
                ],
            };
    }
}

function summarizeIssueSeverities(issues: DoctorIssue[]): string {
    const severityCounts = issues.reduce((counts, issue) => {
        const severity = getIssueGuidance(issue).severity;
        counts.set(severity, (counts.get(severity) || 0) + 1);
        return counts;
    }, new Map<IssueGuidance["severity"], number>());
    return ["Critical", "Needs attention", "Cleanup"].map((severity) =>
        `${severity}: ${severityCounts.get(severity as IssueGuidance["severity"]) || 0}`
    ).join(" · ");
}

function _formatDoctorReport(issues: DoctorIssue[]) {
    const byCategory = new Map<string, DoctorIssue[]>();
    for (const issue of issues) {
        const guidance = getIssueGuidance(issue);
        const categoryIssues = byCategory.get(guidance.category) || [];
        categoryIssues.push(issue);
        byCategory.set(guidance.category, categoryIssues);
    }

    const lines = [
        `[RunWield] Plans doctor diagnosis: ${issues.length} issue${issues.length === 1 ? "" : "s"} found.`,
        `Summary: ${summarizeIssueSeverities(issues)}`,
        "",
    ];

    for (const [category, categoryIssues] of byCategory) {
        lines.push(`${category}`);
        lines.push("-".repeat(category.length));
        categoryIssues.forEach((issue, index) => {
            const guidance = getIssueGuidance(issue);
            const affected = [
                issue.planName ? `Plan: ${issue.planName}` : undefined,
                issue.worktreeId ? `Worktree: ${issue.worktreeId}` : undefined,
            ].filter(Boolean).join(" · ");
            lines.push(`${index + 1}. [${guidance.severity}] ${issue.kind}`);
            if (affected) lines.push(`   Affected: ${affected}`);
            lines.push(`   Diagnosis: ${guidance.diagnosis}`);
            lines.push(`   Detail: ${issue.message}`);
            lines.push("   Next steps:");
            for (const step of guidance.nextSteps) lines.push(`   - ${step}`);
            if (issue.commands?.length) {
                lines.push(issue.commands.length === 1 ? "   Run:" : "   Run one of:");
                for (const command of issue.commands) lines.push(`     ${command}`);
            }
            if (issue.repairSummary) lines.push(`   Repair: ${issue.repairSummary}`);
            else if (issue.repairable) lines.push("   Repair: Safe automated repair is available with --repair.");
            lines.push("");
        });
    }

    if (issues.some((issue) => issue.repairable)) {
        lines.push(
            `[RunWield] Some of this is safe for RunWield to fix by itself. Run: ${CLI_BIN} plans doctor --repair`,
        );
    }
    return lines.join("\n").trimEnd();
}

function _formatDoctorRepairReport(repaired: number, remainingIssues: DoctorIssue[]): string {
    const lines = [
        `[RunWield] Applied ${repaired} safe repair${repaired === 1 ? "" : "s"}.`,
        `[RunWield] ${remainingIssues.length} problem${remainingIssues.length === 1 ? " remains" : "s remain"}.`,
    ];
    if (remainingIssues.length > 0) {
        lines.push(`Summary: ${summarizeIssueSeverities(remainingIssues)}`);
    }
    lines.push(`For the full diagnosis, run: ${CLI_BIN} plans doctor`);
    return lines.join("\n");
}

async function collectPlanIssues(
    projectRoot: string,
    root: string,
    prefix: string[],
    issues: DoctorIssue[],
    planIds: Map<string, string>,
) {
    try {
        for await (const entry of Deno.readDir(join(root, ...prefix))) {
            const entryPath = join(root, ...prefix, entry.name);
            const isPlanPath = entry.name.endsWith(".md");
            const planName = isPlanPath ? [...prefix, entry.name.replace(/\.md$/, "")].join("/") : "";
            if (entry.isDirectory) {
                if (isPlanPath) {
                    issues.push({
                        kind: "non_regular_plan_path",
                        planName,
                        message: `${entryPath} is a directory, not a regular Plan markdown file.`,
                    });
                } else if (!(prefix.length === 0 && entry.name === "archived")) {
                    await collectPlanIssues(projectRoot, root, [...prefix, entry.name], issues, planIds);
                }
                continue;
            }
            if (entry.isSymlink && isPlanPath) {
                issues.push({
                    kind: "non_regular_plan_path",
                    planName,
                    message: `${entryPath} is a symlink, not a regular Plan markdown file.`,
                });
                continue;
            }
            if (!isPlanPath) continue;
            if (isEpicArtifactPlanName(planName)) continue;
            const result = await inspectPlanFileStrict(entryPath);
            if (result.kind === "malformed") {
                issues.push({
                    kind: "malformed_plan",
                    planName,
                    message: result.error.message,
                    commands: [`git diff -- ${entryPath}`, `git checkout -- ${entryPath}`],
                });
            } else if (result.kind !== "loaded") {
                issues.push({
                    kind: `plan_${result.kind}`,
                    planName,
                    message: "message" in result
                        ? result.message
                        : "error" in result
                        ? result.error.message
                        : entryPath,
                });
            } else {
                collectPendingControllerIssues(planName, result.pendingControllerRepairs, issues);
            }
        }
    } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
}

function collectPendingControllerIssues(
    planName: string,
    pendingRepairs: readonly string[] | undefined,
    issues: DoctorIssue[],
) {
    for (const repair of pendingRepairs || []) {
        const kind = repair === "import_legacy_state" ? "controller_import_pending" : "obsolete_controller_recovery";
        if (issues.some((issue) => issue.kind === kind && issue.planName === planName)) continue;
        issues.push(
            repair === "import_legacy_state"
                ? {
                    kind,
                    planName,
                    message:
                        `${planName} has legacy runtime fields that the controller can import on the next normal Plan load. Doctor left them unchanged.`,
                    commands: [`${CLI_BIN} load-plan ${planName}`, `${CLI_BIN} plans doctor --check`],
                }
                : {
                    kind,
                    planName,
                    message:
                        `${planName} has an obsolete controller recovery hint because the worktree registry now owns its attempt. Doctor left it unchanged.`,
                    commands: [`${CLI_BIN} load-plan ${planName}`, `${CLI_BIN} plans doctor --check`],
                },
        );
    }
}

function collectPlanAttributeIssues(
    plan: { name: string; attrs: Record<string, unknown> },
    issues: DoctorIssue[],
    planIds: Map<string, string>,
    options: { archived?: boolean } = {},
) {
    const planName = options.archived ? `archived/${plan.name}` : plan.name;
    const planId = typeof plan.attrs.planId === "string" ? plan.attrs.planId : "";
    if (!planId) {
        issues.push({
            kind: "missing_plan_id",
            planName,
            repairable: !options.archived,
            message: `Plan ${planName} has no stable planId.`,
            commands: options.archived ? [] : [`${CLI_BIN} plans doctor --repair`],
        });
    } else {
        const existing = planIds.get(planId);
        if (existing) {
            issues.push({
                kind: "duplicate_plan_id",
                planName,
                message: `Plan ${planName} and ${existing} both use planId ${planId}.`,
            });
        } else {
            planIds.set(planId, planName);
        }
    }
}

type LoadedPlanInspection = Extract<Awaited<ReturnType<typeof inspectPlanFileStrict>>, { kind: "loaded" }>;

interface ArchivedPlanInspection {
    name: string;
    path: string;
    attrs: LoadedPlanInspection["attrs"];
}

async function collectArchivedPlanParseIssues(
    projectRoot: string,
    issues: DoctorIssue[],
    planIds: Map<string, string>,
) {
    const archivedRoot = join(getPlansDir(projectRoot), "archived");
    const plans: ArchivedPlanInspection[] = [];

    async function visit(prefix: string[]) {
        try {
            for await (const entry of Deno.readDir(join(archivedRoot, ...prefix))) {
                const entryPath = join(archivedRoot, ...prefix, entry.name);
                const isPlanPath = entry.name.endsWith(".md");
                if (entry.isDirectory) {
                    if (!isPlanPath) await visit([...prefix, entry.name]);
                    continue;
                }
                if (!isPlanPath || entry.isSymlink) continue;
                const planName = [...prefix, entry.name.replace(/\.md$/, "")].join("/");
                if (isEpicArtifactPlanName(planName)) continue;
                try {
                    const parsed = await inspectPlanFileStrict(entryPath);
                    if (parsed.kind !== "loaded") {
                        if (parsed.kind === "malformed") throw parsed.error;
                        throw new Error("Archived Plan could not be read.");
                    }
                    collectPlanAttributeIssues({ name: planName, attrs: parsed.attrs }, issues, planIds, {
                        archived: true,
                    });
                    collectPendingControllerIssues(`archived/${planName}`, parsed.pendingControllerRepairs, issues);
                    plans.push({ name: planName, path: entryPath, attrs: parsed.attrs });
                } catch (error) {
                    issues.push({
                        kind: "malformed_archived_plan",
                        planName,
                        message: `Archived Plan ${planName} is malformed: ${
                            error instanceof Error ? error.message : String(error)
                        }`,
                    });
                }
            }
        } catch (error) {
            if (!(error instanceof Deno.errors.NotFound)) throw error;
        }
    }
    await visit([]);
    return plans;
}

/**
 * Turn one unresolved journal into something a person can act on.
 *
 * The record is RunWield's own bookkeeping, so "unresolved_transition
 * 4f2a-…: worktree_registry_updated" is not a report, it is a receipt for a
 * problem the user did not cause. Name the Plan, say which effect lacks evidence
 * and why, and give the commands that either resolve it or show what to inspect.
 * Uncertain records stay intact until Plan Recovery closes them with evidence or
 * explicit user attestation.
 */
function capitalize(text: string): string {
    return text ? `${text[0].toUpperCase()}${text.slice(1)}` : text;
}

function describeUnresolvedTransition(reconciliation: TransitionReconciliation): DoctorIssue {
    const unproven = (reconciliation.effects || []).filter((effect) => effect.verdict && !effect.verdict.settled);
    const commands: string[] = [];
    if (reconciliation.resolvable) {
        // Nothing to investigate: --repair is the whole answer, so anything else here
        // is noise that makes a solved problem look like a decision.
        commands.push(`${CLI_BIN} plans doctor --repair`);
    } else {
        if (reconciliation.planName) commands.push(`${CLI_BIN} load-plan ${reconciliation.planName}`);
        for (const action of reconciliation.recoveryActions || []) {
            if (action.command && !commands.includes(action.command)) commands.push(action.command);
        }
        for (const effect of unproven) {
            const proof = (effect.proof || {}) as Record<string, unknown>;
            if (typeof proof.path === "string") commands.push(`git -C ${proof.path} status --short`);
            if (typeof proof.targetBranch === "string" && typeof proof.sealedExecutionCommit === "string") {
                commands.push(`git branch --contains ${proof.sealedExecutionCommit}`);
                commands.push(`git log --oneline ${proof.targetBranch} -5`);
            }
        }
        if (reconciliation.path) commands.push(`cat ${reconciliation.path}`);
    }
    const detail = reconciliation.resolvable
        ? `Everything it recorded is accounted for: ${reconciliation.reason}.`
        : unproven.length > 0
        // Already effect-prefixed by reconciliation, so it reads as a clause.
        ? `Waiting on ${reconciliation.reason}.`
        : `${capitalize(reconciliation.reason)}.`;
    return {
        kind: "unresolved_transition",
        planName: reconciliation.planName,
        repairable: reconciliation.resolvable,
        message: `${reconciliation.operation || "A Plan update"} on ${
            reconciliation.planName || "an unnamed Plan"
        } stopped before RunWield could confirm the outcome. ${detail}`,
        commands: [...new Set(commands)],
        repairSummary: reconciliation.resolvable
            ? "--repair closes this record; the repository already proves it is finished."
            : "Left in place on purpose: closing it without proof could hide unpublished or unsaved work. " +
                "Resolve it through load-plan; Plan Recovery can record an explicit user attestation when proof is unavailable.",
    };
}

/**
 * Journals written inside an execution worktree.
 *
 * Some retry paths run their transaction with the worktree as the project root, so
 * their records land in the worktree's own `.wld/`. Nothing else looks there:
 * `plans doctor` scans the primary checkout, so such a record is invisible while
 * still blocking the retry that would clear it. Surfacing them is the difference
 * between "retry does nothing, no idea why" and a named file.
 */
async function collectWorktreeJournalIssues(
    projectRoot: string,
    entries: RegistryEntry[],
    repair: boolean,
): Promise<Array<{ issue?: DoctorIssue; repaired?: boolean }>> {
    const results: Array<{ issue?: DoctorIssue; repaired?: boolean }> = [];
    for (const entry of entries) {
        if (entry.path === projectRoot) continue;
        const journalDir = getTransitionJournalDir(entry.path);
        if (!(await Deno.stat(journalDir).then((stat) => stat.isDirectory).catch(() => false))) continue;
        const reconciliations = await reconcileTransitionRecoveryRecords(entry.path, {
            apply: repair,
            diagnostic: !repair,
        }).catch(() => []);
        for (const reconciliation of reconciliations) {
            if (reconciliation.resolved) {
                results.push({ repaired: true });
                continue;
            }
            const issue = describeUnresolvedTransition(reconciliation);
            results.push({
                issue: {
                    ...issue,
                    kind: "unresolved_transition_in_worktree",
                    worktreeId: entry.id,
                    message:
                        `${issue.message} This record lives inside the execution worktree at ${entry.path}, so it blocks retries that run there.`,
                },
            });
        }
    }
    return results;
}

/**
 * Plan lock files left behind by a process that died holding one.
 *
 * A live lock is heartbeat-refreshed, so an untouched one is either abandoned or
 * about to be reclaimed automatically. The automatic path costs the next command a
 * long wait first, and its timeout message is a raw lock path, so reporting and
 * clearing these is strictly kinder than letting them expire. Deleting an
 * abandoned lock file destroys nothing: RunWield owns the file, and it holds no
 * state beyond "someone was here".
 */
async function collectStalePlanLockIssues(
    projectRoot: string,
    repair: boolean,
): Promise<Array<{ issue?: DoctorIssue; repaired?: boolean }>> {
    const lockDir = resolveProjectRuntimeLayout(projectRoot).selected.planLocksDir;
    const results: Array<{ issue?: DoctorIssue; repaired?: boolean }> = [];
    try {
        for await (const entry of Deno.readDir(lockDir)) {
            if (!entry.isFile || !entry.name.endsWith(".lock")) continue;
            const path = join(lockDir, entry.name);
            const snapshot = await readLockFileSnapshot(path);
            if (!snapshot) continue;
            if (isLockHolderUnattributable(snapshot.text)) continue;
            if (!await isLockHolderGone(snapshot.text)) continue;
            if (repair) {
                const current = await readLockFileSnapshot(path);
                if (!current || !await isLockHolderGone(current.text)) continue;
                if (await removeLockFileIfSnapshotMatches(path, snapshot)) results.push({ repaired: true });
                continue;
            }
            results.push({
                issue: {
                    kind: "stale_plan_lock",
                    repairable: true,
                    message: `Plan lock ${path} was left by a recorded holder that is proven gone.`,
                    commands: [`${CLI_BIN} plans doctor --repair`],
                    repairSummary: "--repair rechecks and removes only this unchanged, proven-dead lock.",
                },
            });
        }
    } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
    return results;
}

async function runPlansDoctorPass(projectRoot: string, repair: boolean, layout: ProjectRuntimeLayout) {
    const issues: DoctorIssue[] = [];
    let repaired = 0;

    for (const warning of await inspectRunWieldGitignore(layout.primary.checkoutRoot)) {
        if (warning.kind === "broad_wld_ignore") {
            issues.push({ kind: warning.kind, message: warning.message });
        }
    }

    // Abandoned locks are cleared before anything else, because much of the scan
    // below acquires those same locks. Diagnosing lock trouble after taking a lock
    // means doctor waits on the exact file it exists to clean up — the one command
    // the user was told to run would be the one that hangs.
    for (const lockIssue of await collectStalePlanLockIssues(projectRoot, repair)) {
        if (lockIssue.repaired) repaired += 1;
        else if (lockIssue.issue) issues.push(lockIssue.issue);
    }

    const discoveredPlanIds = new Map<string, string>();
    await collectPlanIssues(projectRoot, getPlansDir(projectRoot), [], issues, discoveredPlanIds);
    const archivedPlans = await collectArchivedPlanParseIssues(projectRoot, issues, discoveredPlanIds);

    // Read the registry without enforcing invariants first. A violated invariant
    // must not blind the report: the per-entry facts below are what the user needs
    // in order to act, and they are exactly what a throwing read would discard.
    const inspection = await inspectWorktreeRegistryAtPath(layout.primary.worktreeRegistryPath);
    const gitWorktreePaths = await listGitWorktreePaths(projectRoot);
    if (inspection.readError) {
        issues.push({
            kind: "registry_integrity_error",
            message: `Worktree registry file could not be read: ${inspection.readError.message}`,
            commands: ["git worktree list --porcelain"],
        });
    }
    for (const integrityIssue of inspection.integrityIssues) {
        issues.push({
            kind: integrityIssue.kind,
            message: integrityIssue.message,
            worktreeId: integrityIssue.ids[0],
            commands: [
                ...integrityIssue.ids.map((id) => {
                    const entry = inspection.entries.find((candidate) => candidate.id === id);
                    return entry ? `git -C ${entry.path} status --short` : `git worktree list --porcelain`;
                }),
                `${CLI_BIN} load-plan ${
                    inspection.entries.find((entry) => integrityIssue.ids.includes(entry.id))?.planName || "<plan>"
                }`,
            ],
        });
    }
    const entries = inspection.entries;

    // Retire the journals whose records repository facts prove are finished. Until
    // one is cleared it blocks every later transition on its Plan, so leaving a
    // provably-settled record in place would strand the Plan over RunWield's own
    // bookkeeping.
    const proveEffect = buildEffectProver(
        projectRoot,
        { registryEntries: entries, gitWorktreePaths },
        { diagnostic: !repair },
    );
    const reconciliations = await reconcileTransitionRecoveryRecords(projectRoot, {
        apply: repair,
        proveEffect,
        diagnostic: !repair,
    });
    for (const reconciliation of reconciliations) {
        if (reconciliation.resolved) {
            repaired += 1;
            continue;
        }
        issues.push(describeUnresolvedTransition(reconciliation));
    }
    for (const worktreeJournal of await collectWorktreeJournalIssues(projectRoot, entries, repair)) {
        if (worktreeJournal.repaired) repaired += 1;
        else if (worktreeJournal.issue) issues.push(worktreeJournal.issue);
    }
    if (repair && inspection.integrityIssues.length === 0 && !inspection.readError) {
        // Persist the v1→v2 migration only once the file is known to be consistent;
        // migrating around a conflict is how a readable registry becomes unreadable.
        await listEntries(projectRoot, { migrate: true }).catch(() => []);
    }
    const canonicalRoot = await Deno.realPath(projectRoot).catch(() => projectRoot);
    const registryPaths = new Set(
        await Promise.all(
            entries.map((entry) => Deno.realPath(entry.path).catch(() => entry.path)),
        ),
    );
    for (const path of gitWorktreePaths) {
        const canonicalPath = await Deno.realPath(path).catch(() => path);
        if (canonicalPath !== canonicalRoot && !registryPaths.has(canonicalPath)) {
            issues.push({
                kind: "orphan_git_worktree",
                message:
                    `Git has a worktree at ${path} that no RunWield attempt claims. It may be yours, or the remains of an attempt RunWield lost track of.`,
                commands: [
                    `git -C ${path} status --short`,
                    `git -C ${path} log --oneline -5`,
                    `git worktree remove ${path}`,
                ],
                repairSummary:
                    "Never removed automatically: an unclaimed worktree is the one place uncommitted work can be hiding. " +
                    "The status command above tells you whether anything is there.",
            });
        }
    }
    const registryBranches = new Set(entries.map((entry) => entry.branch).filter(Boolean));
    for (
        const branch of await runGitLines(projectRoot, [
            "for-each-ref",
            "--format=%(refname:short)",
            `refs/heads/${WORKTREE_BRANCH_PREFIX}`,
        ])
    ) {
        if (!registryBranches.has(branch)) {
            issues.push({
                kind: "orphan_worktree_branch",
                message:
                    `Branch ${branch} was created by RunWield for an execution attempt that is no longer in the registry.`,
                commands: [
                    `git log --oneline ${branch} -10`,
                    `git branch --contains ${branch}`,
                    `git branch -d ${branch}`,
                ],
                repairSummary:
                    "Never deleted automatically. `git branch -d` (lower-case d) refuses to delete unmerged work, " +
                    "so it is the safe way to clear this once you have looked at the log.",
            });
        }
    }

    const diagnosticEntries = await Promise.all(entries.map(async (entry) => {
        if (entry.status !== "abandoned") return entry;
        const controller = await readControllerRecordAtPath(layout.primary.controllerPlansDir, {
            planId: entry.planId,
            planName: entry.planName,
        });
        return controller?.state.documentWorktreeId === entry.id ? { ...entry, documentSelected: true } : entry;
    }));
    const identityDocuments = await inspectPlanIdentityDocuments(projectRoot, diagnosticEntries);
    for (const parent of [...identityDocuments]) {
        const targetBranch = typeof parent.attrs.targetBranch === "string" ? parent.attrs.targetBranch.trim() : "";
        if (!targetBranch || !isProjectPlan(parent.attrs)) continue;
        let children: Awaited<ReturnType<typeof inspectTargetBranchPlansByParent>>;
        try {
            children = await inspectTargetBranchPlansByParent(projectRoot, targetBranch, parent.name);
        } catch {
            issues.push({
                kind: "target_branch_inspection_error",
                planName: parent.name,
                message:
                    `Could not inspect authoritative target branch ${targetBranch} for child Plans of ${parent.name}. Child state is unknown; the local branch is not a safe substitute.`,
                commands: [
                    `git ls-remote --heads origin refs/heads/${targetBranch.replace(/^origin\//, "")}`,
                    `${CLI_BIN} plans doctor --check`,
                ],
            });
            continue;
        }
        for (const child of children) {
            const existing = identityDocuments.findIndex((plan) =>
                plan.name === child.name || Boolean(child.attrs.planId && plan.attrs.planId === child.attrs.planId)
            );
            if (existing >= 0) identityDocuments.splice(existing, 1, child);
            else identityDocuments.push(child);
        }
    }
    if (repair) {
        for (const plan of identityDocuments) {
            if (plan.attrs.planId) continue;
            const exists = await Deno.stat(plan.path).then((stat) => stat.isFile).catch(() => false);
            if (!exists) continue;
            const documentRoot = getPlanDocumentRoot(plan.path);
            const lockDir = resolveProjectRuntimeLayout(documentRoot).selected.planLocksDir;
            const hasLock = await Array.fromAsync(Deno.readDir(lockDir))
                .then((locks) => locks.some((lock) => lock.isFile && lock.name.endsWith(".lock")))
                .catch((error) => {
                    if (error instanceof Deno.errors.NotFound) return false;
                    throw error;
                });
            if (hasLock) continue;
            const inspected = await inspectPlanFileStrict(plan.path);
            if (inspected.kind !== "loaded" || inspected.pendingControllerRepairs.length > 0) continue;
            const resource = await ensurePlanIdentity(documentRoot, plan.name);
            if (!resource.planId) continue;
            plan.attrs = resource.attrs;
            repaired += 1;
        }
    }
    const inspectedIdentityDocuments = await Promise.all(identityDocuments.map(async (plan) => {
        const inspected = await inspectPlanFileStrict(plan.path);
        return inspected.kind === "loaded" && "attrs" in inspected
            ? { ...plan, attrs: inspected.attrs, pendingControllerRepairs: inspected.pendingControllerRepairs }
            : { ...plan, pendingControllerRepairs: [] };
    }));
    for (const plan of inspectedIdentityDocuments) {
        collectPlanAttributeIssues(plan, issues, discoveredPlanIds);
        collectPendingControllerIssues(plan.name, plan.pendingControllerRepairs, issues);
    }
    for (
        const plan of [
            ...inspectedIdentityDocuments,
            ...archivedPlans.map((plan) => ({ ...plan, name: `archived/${plan.name}` })),
        ]
    ) {
        const reviewedCandidate = plan.attrs.status === "reviewed" &&
            Boolean(plan.attrs.validatedCommit || plan.attrs.deliveryEvidence?.mode === "worktree_merge");
        if (!reviewedCandidate && !["validated", "verified", "user_verified"].includes(plan.attrs.status || "")) {
            continue;
        }
        if (!isPlannedChangeClassification(plan.attrs.classification)) continue;
        const evidence = plan.attrs.deliveryEvidence;
        const legacy = evidence?.mode === "worktree_merge" ? evidence : undefined;
        const commit = plan.attrs.validatedCommit || legacy?.executionCommit;
        const targetBranch = plan.attrs.targetBranch || legacy?.targetBranch;
        // Older documents may make no Git publication claim at all. Missing
        // disposable metadata alone is not a new publication failure.
        if (!commit && !targetBranch) continue;
        const liveAttempt = entries.some((entry) =>
            entry.status !== "abandoned" &&
            (plan.attrs.planId && entry.planId
                ? entry.planId === plan.attrs.planId
                : entry.planName === plan.name.replace(/^archived\//, ""))
        );
        // A committed archive with no unfinished attempt is intentionally retired
        // history. Do not turn a deleted integration branch into a repair request.
        // Still diagnose archives with active attempts or uncommitted changes.
        if (
            !inspection.readError && inspection.integrityIssues.length === 0 &&
            plan.name.startsWith("archived/") && !liveAttempt &&
            await isCommittedArchive(projectRoot, plan.name, plan.path).catch(() => false)
        ) continue;
        {
            const markdown = await Deno.readTextFile(plan.path).catch(() => undefined);
            const publication = await verifyRecordedPublication(
                projectRoot,
                plan.attrs,
                markdown === undefined ? undefined : { planName: plan.name, markdown },
            ).catch(() => ({ published: false, unavailable: true }));
            if (publication.unavailable) {
                issues.push({
                    kind: "publication_inspection_error",
                    planName: plan.name,
                    message: `${plan.name} records publication${
                        targetBranch ? ` to ${targetBranch}` : ""
                    }, but RunWield could not inspect that authority. Publication is unknown; local ancestry is not proof.`,
                    commands: [
                        "git remote -v",
                        ...(targetBranch ? [`git branch -vv --list ${targetBranch.replace(/^origin\//, "")}`] : []),
                        ...(commit ? [`git show --stat ${commit}`] : []),
                        `${CLI_BIN} plans doctor --check`,
                    ],
                    repairSummary: "Not repaired automatically: restore remote access, then run Doctor again.",
                });
                continue;
            }
            if (!publication.published) {
                issues.push({
                    kind: "uncertain_publication",
                    planName: plan.name,
                    message: `${plan.name} passed validation${commit ? ` at ${commit}` : ""}, but publication${
                        targetBranch ? ` to ${targetBranch}` : ""
                    } could not be confirmed. The target may have been removed, rewritten, or be unavailable.`,
                    commands: commit && targetBranch
                        ? [
                            `git log --oneline ${targetBranch} -10`,
                            `git branch --all --contains ${commit}`,
                            `git show --stat ${commit}`,
                        ]
                        : [],
                    repairSummary: "No branches, commits, or Plan status were changed by this check.",
                });
            }
        }
    }
    // Archived Plans keep their planId and can still own a recoverable attempt,
    // so resolving ids from active Plans alone reports a healthy archived attempt
    // as a dangling reference. Track both, and remember which is which.
    const planIdOwners = new Map<string, { name: string; archived: boolean }>();
    for (const plan of identityDocuments) {
        if (!plan.attrs.planId) continue;
        const owners = identityDocuments.filter((candidate) => candidate.attrs.planId === plan.attrs.planId);
        if (owners.length === 1) planIdOwners.set(plan.attrs.planId, { name: plan.name, archived: false });
    }
    for (const plan of archivedPlans) {
        const planId = (plan.attrs as { planId?: unknown }).planId;
        if (typeof planId === "string" && !planIdOwners.has(planId)) {
            planIdOwners.set(planId, { name: plan.name, archived: true });
        }
    }
    const activeByPlan = new Map();
    for (const entry of entries) {
        // Attempts whose planId is set are checked by inspectWorktreeRegistry, which
        // sees the whole file at once. Only the legacy shape — a live attempt with no
        // stable id — needs a name-keyed check here, and only that shape is reported,
        // so a conflict is never listed twice.
        if (!entry.planId && entry.status !== "abandoned") {
            const prior = activeByPlan.get(entry.planName);
            if (prior) {
                issues.push({
                    kind: "duplicate_live_attempt",
                    planName: entry.planName,
                    worktreeId: entry.id,
                    message:
                        `Plan ${entry.planName} has two unfinished attempts recorded under its name with no stable id: ${prior} and ${entry.id}. RunWield will not guess which one is current.`,
                    commands: [
                        `git -C ${entry.path} status --short`,
                        `${CLI_BIN} load-plan ${entry.planName}`,
                    ],
                });
            } else {
                activeByPlan.set(entry.planName, entry.id);
            }
        }
        if (entry.planId && !planIdOwners.has(entry.planId)) {
            issues.push({
                kind: "registry_plan_id_not_found",
                planName: entry.planName,
                worktreeId: entry.id,
                message:
                    `Registry attempt ${entry.id} belongs to planId ${entry.planId}, but no Plan (active or archived) carries that id — the Plan file was probably renamed or deleted outside RunWield.`,
                commands: [
                    `grep -rl "${entry.planId}" docs/plans/`,
                    `git -C ${entry.path} status --short`,
                    `git log --oneline ${entry.branch} -5`,
                ],
            });
        } else if (entry.planId && planIdOwners.get(entry.planId)?.name !== entry.planName) {
            // planId is the stable authority and planName is display evidence, so a
            // disagreement is provable one-directional drift: the Plan that owns the
            // id names the attempt. Rewriting the cached name touches no Git state.
            const owner = planIdOwners.get(entry.planId);
            const renamable = Boolean(owner && !owner.archived);
            issues.push({
                kind: "registry_plan_identity_mismatch",
                planName: entry.planName,
                worktreeId: entry.id,
                repairable: renamable,
                message: renamable
                    ? `Registry attempt ${entry.id} still calls its Plan ${entry.planName}, but planId ${entry.planId} belongs to ${owner?.name} — the Plan was renamed.`
                    : `Registry attempt ${entry.id} still calls its Plan ${entry.planName}, but planId ${entry.planId} belongs to archived Plan ${owner?.name}.`,
                commands: renamable
                    ? [`${CLI_BIN} plans doctor --repair`]
                    : [`${CLI_BIN} plans restore ${owner?.name}`, `${CLI_BIN} load-plan ${owner?.name}`],
                repairSummary: renamable
                    ? `--repair updates the cached name to ${owner?.name}. Nothing else changes: planId is the authority, and no path, branch, or Git state is touched.`
                    : "Restore the archived Plan before touching the attempt, so the attempt has an owner that can resolve it.",
            });
            if (repair && renamable && owner) {
                await reconcileEntryIdentity(projectRoot, entry.id, { planName: owner.name });
                repaired += 1;
            }
        }
        if (!entry.planId) {
            // Bind a legacy entry only when exactly one Plan's worktreeId names
            // this exact attempt. That back-pointer is real evidence; matching on
            // Plan name is not, and name-based migration cannot resolve an entry
            // whose cached name has drifted. Ambiguity is left for a human.
            const claimants = identityDocuments.filter((plan) =>
                plan.attrs.worktreeId === entry.id && plan.attrs.planId
            );
            const claimant = claimants.length === 1 ? claimants[0] : undefined;
            issues.push({
                kind: "registry_missing_plan_id",
                planName: entry.planName,
                worktreeId: entry.id,
                repairable: Boolean(claimant),
                message: claimant
                    ? `Registry attempt ${entry.id} predates stable Plan ids, and Plan ${claimant.name} already points at this exact attempt.`
                    : claimants.length > 1
                    ? `Registry attempt ${entry.id} predates stable Plan ids and ${claimants.length} Plans claim it: ${
                        claimants.map((plan) => plan.name).join(", ")
                    }. Only one Plan can own an attempt.`
                    : `Registry attempt ${entry.id} predates stable Plan ids and no Plan points at it, so RunWield cannot tell which Plan it belongs to.`,
                commands: claimant ? [`${CLI_BIN} plans doctor --repair`] : [
                    `git -C ${entry.path} status --short`,
                    `git log --oneline ${entry.branch} -5`,
                    `grep -rln "worktreeId: \\"${entry.id}\\"" docs/plans/`,
                ],
                repairSummary: claimant
                    ? `--repair records planId ${claimant.attrs.planId} on the attempt. That is a metadata write only; the worktree, branch, and Plan file are untouched.`
                    : claimants.length > 1
                    ? "Remove the stale worktreeId from whichever Plan does not own this attempt, then re-run --repair."
                    : "Inspect the branch above. If it holds work you want, resolve it through load-plan; if not, the attempt can be abandoned there.",
            });
            if (repair && claimant) {
                await reconcileEntryIdentity(projectRoot, entry.id, {
                    planId: claimant.attrs.planId,
                    ...(claimant.name !== entry.planName ? { planName: claimant.name } : {}),
                });
                repaired += 1;
            }
        }
        try {
            const stat = await Deno.stat(entry.path);
            if (!stat.isDirectory) throw new Error("not a directory");
        } catch {
            const safelyPrunable = entry.status === "abandoned" || entry.publication?.phase === "cleanup_complete";
            issues.push({
                kind: "missing_worktree_path",
                planName: entry.planName,
                worktreeId: entry.id,
                repairable: safelyPrunable,
                message: safelyPrunable
                    ? `Registry attempt ${entry.id} points at ${entry.path}, which no longer exists. Its cleanup is already settled, so this is leftover bookkeeping.`
                    : `Registry attempt ${entry.id} is ${entry.status} but its worktree ${entry.path} is gone, so RunWield cannot reach the work it recorded.`,
                commands: safelyPrunable ? [`${CLI_BIN} plans doctor --repair`] : [
                    `git log --oneline ${entry.branch} -10`,
                    `git worktree list --porcelain`,
                    `${CLI_BIN} load-plan ${entry.planName}`,
                ],
                repairSummary: safelyPrunable
                    ? "--repair drops the registry row. The attempt was already settled, so no work can be lost."
                    : `The branch ${entry.branch} still holds any committed work from this attempt — check it before abandoning. ` +
                        "If the directory was deleted but the branch is intact, load-plan can merge or recreate from it.",
            });
            if (repair && safelyPrunable) {
                await pruneEntry(projectRoot, entry.id);
                repaired += 1;
            }
        }
    }

    for (const archived of archivedPlans) {
        const status = typeof archived.attrs.worktreeStatus === "string" ? archived.attrs.worktreeStatus : "";
        if (status && !["none", "merged", "abandoned"].includes(status)) {
            issues.push({
                kind: "archived_plan_with_recoverable_attempt",
                planName: archived.name,
                message:
                    `Archived Plan ${archived.name} still records recoverable worktreeStatus ${status}; restore and resolve the attempt before archival is considered settled.`,
            });
        }
    }

    return { issues, repaired };
}

/** Committed archives are history, not an instruction to restart an old delivery. */
async function isCommittedArchive(projectRoot: string, planName: string, path: string): Promise<boolean> {
    const result = await new Deno.Command("git", {
        cwd: projectRoot,
        args: ["show", `HEAD:docs/plans/${planName}.md`],
        stdout: "piped",
        stderr: "null",
    }).output();
    return result.success && new TextDecoder().decode(result.stdout) === await Deno.readTextFile(path);
}

export async function runPlansDoctor(projectRoot: string, repair = true) {
    const inspected = await inspectProjectRuntimeLayout(projectRoot);
    if (inspected.kind === "blocked") return { issues: [migrationBlockedIssue(inspected)], repaired: 0 };
    if (inspected.kind === "pending" && !repair) {
        const ignoreIssues: DoctorIssue[] = (await inspectRunWieldGitignore(inspected.layout.primary.checkoutRoot))
            .filter((warning) => warning.kind === "broad_wld_ignore")
            .map((warning) => ({ kind: warning.kind, message: warning.message }));
        return {
            issues: [{
                kind: "runtime_adoption_pending",
                message:
                    `Safe adoption is pending for ${inspected.layout.primary.internalRoot}. No runtime files were changed or scanned.`,
            }, ...ignoreIssues],
            repaired: 0,
        };
    }
    let layout: ProjectRuntimeLayout;
    try {
        layout = repair ? await enterProjectRuntime(projectRoot) : inspected.layout;
    } catch (error) {
        if (!(error instanceof ProjectRuntimeEntryRefusedError)) throw error;
        return {
            issues: [migrationBlockedIssue({
                kind: "blocked",
                reason: error.reason,
                message: error.message,
                paths: [],
                ...(error.securityAction ? { securityAction: error.securityAction } : {}),
            })],
            repaired: 0,
        };
    }
    if (!repair) return await runPlansDoctorPass(projectRoot, false, layout);
    let repaired = 0;
    let lastIssueKey = "";
    for (let pass = 0; pass < 8; pass += 1) {
        const result = await runPlansDoctorPass(projectRoot, true, layout);
        repaired += result.repaired;
        const remaining = await runPlansDoctorPass(projectRoot, false, layout);
        if (remaining.issues.length === 0) return { issues: [], repaired };
        const issueKey = remaining.issues.map((issue) =>
            `${issue.kind}:${issue.planName || ""}:${issue.worktreeId || ""}`
        ).sort().join("|");
        if (result.repaired === 0 || issueKey === lastIssueKey) return { issues: remaining.issues, repaired };
        lastIssueKey = issueKey;
    }
    const remaining = await runPlansDoctorPass(projectRoot, false, layout);
    return { issues: remaining.issues, repaired };
}

export async function runPlansDoctorCommand(
    argv: string[],
    _options: PlansDoctorCommandOptions = {},
) {
    const parsed = parseArgs(argv, { boolean: ["help", "repair", "check"], alias: { h: "help" } });
    if (parsed.help) {
        printHelp();
        return;
    }
    const checkOnly = Boolean(parsed.check);
    const projectRoot = getCwd();
    const result = await runPlansDoctor(projectRoot, !checkOnly);
    if (checkOnly) {
        console.log(
            result.issues.length === 0
                ? doctorCheckMessage(result.issues.length)
                : `${_formatDoctorReport(result.issues)}\n[RunWield] No files changed.`,
        );
        return;
    }
    const adoptionIssue = result.issues.some((issue) =>
        issue.kind === "runtime_migration_blocked" || issue.kind === "runtime_adoption_pending"
    );
    console.log(
        result.issues.length === 0
            ? doctorCleanMessage(result.repaired)
            : adoptionIssue
            ? _formatDoctorReport(result.issues)
            : doctorNeedsHelpMessage(result.repaired, result.issues.length),
    );
}
