import { runPlansDoctor, type DoctorIssue } from "../../plan-store/index.ts";
export { runPlansDoctor } from "../../plan-store/index.ts";

import { admitProjectWithIdentityChoice } from "../../ui/tui/project-identity-entry.ts";

import { confirmMissingManagedProjectDirectory, confirmProjectDirectory } from "../../ui/tui/directory-warning.ts";
/**
 * @module cmd/plans/doctor
 * Report and safely repair Plan/worktree lifecycle drift.
 */

import { parseArgs } from "../../shared/cli-args.ts";

import { CLI_BIN, getCwd } from "../../constants.js";

import { inspectProjectRuntimeLayout, resolveProjectRuntimeLayout } from "../../shared/project-runtime-layout.ts";

import { doctorCheckMessage, doctorCleanMessage, doctorNeedsHelpMessage } from "./doctor-messages.ts";
import { inspectWorktreeRegistryAtPath } from "../../shared/worktree-registry.js";

interface IssueGuidance {
    category: string;
    severity: "Critical" | "Needs attention" | "Cleanup";
    diagnosis: string;
    nextSteps: string[];
}

type PlansDoctorCommandOptions = Record<never, never>;

const READ_ONLY_DOCTOR_FLAG = "--check";

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
    return ["Critical", "Needs attention", "Cleanup"]
        .map((severity) => `${severity}: ${severityCounts.get(severity as IssueGuidance["severity"]) || 0}`)
        .join(" · ");
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
            ]
                .filter(Boolean)
                .join(" · ");
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

export async function runPlansDoctorCommand(argv: string[], _options: PlansDoctorCommandOptions = {}) {
    const parsed = parseArgs(argv, { boolean: ["help", "repair", "check"], alias: { h: "help" } });
    if (parsed.help) {
        printHelp();
        return;
    }
    const checkOnly = Boolean(parsed.check);
    const projectRoot = getCwd();
    const layout = resolveProjectRuntimeLayout(projectRoot);
    for (const root of new Set([projectRoot, layout.primary.checkoutRoot])) {
        if (!(await confirmProjectDirectory(root))) return;
    }
    // Runtime adoption and doctor repairs can write inside registered checkouts.
    // Inspect their roots before entering the runtime, including missing targets.
    const inspection = await inspectProjectRuntimeLayout(projectRoot);
    const registry = await inspectWorktreeRegistryAtPath(layout.primary.worktreeRegistryPath);
    const adoptionRoots = inspection.kind === "pending" ? inspection.selectedCheckoutRoots : [];
    for (const root of new Set([...adoptionRoots, ...registry.entries.map((entry) => entry.path)])) {
        if (!(await confirmMissingManagedProjectDirectory(root))) return;
    }
    if (!checkOnly && inspection.kind !== "blocked" && !(await admitProjectWithIdentityChoice(projectRoot))) return;
    const result = await runPlansDoctor(projectRoot, !checkOnly);
    if (checkOnly) {
        console.log(
            result.issues.length === 0
                ? doctorCheckMessage(result.issues.length)
                : `${_formatDoctorReport(result.issues)}\n[RunWield] No files changed.`,
        );
        return;
    }
    const adoptionIssue = result.issues.some(
        (issue) => issue.kind === "runtime_migration_blocked" || issue.kind === "runtime_adoption_pending",
    );
    console.log(
        result.issues.length === 0
            ? doctorCleanMessage(result.repaired)
            : adoptionIssue
              ? _formatDoctorReport(result.issues)
              : doctorNeedsHelpMessage(result.repaired, result.issues.length),
    );
}
