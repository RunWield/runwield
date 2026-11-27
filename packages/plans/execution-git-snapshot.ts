import { captureForegroundProcess } from "@runwield/resources/process";
import { parsePlanFrontMatter, parsePlanTextStrict, type PlanTextLoaded } from "./format.ts";

export class TargetBranchSnapshotUnavailableError extends Error {
    constructor(
        targetBranch: string,
        readonly reason: "missing_ref" | "unreadable" = "unreadable",
    ) {
        super(`Local target branch evidence is unavailable: ${targetBranch}.`);
        this.name = "TargetBranchSnapshotUnavailableError";
    }
}

interface RecordedExecutionPlan {
    planName: string;
    planId?: string;
    baseCommit: string;
    branch: string;
}

interface RescueCandidate {
    commit: string;
    refs: string[];
}

interface SelectedExecutionSnapshot {
    kind: "recorded" | "rescue";
    commit: string;
    sourceRef: string;
}

type ExecutionSnapshotSelection =
    SelectedExecutionSnapshot | { kind: "missing" } | { kind: "recorded_branch_conflict" };

const RESCUED_EXECUTION_STATUSES = new Set([
    "in_progress",
    "failed",
    "implemented",
    "validated_ci",
    "reviewed",
    "validated",
]);

async function readGit(cwd: string, args: string[]) {
    const output = await captureForegroundProcess("git", { cwd, args, env: { GIT_NO_LAZY_FETCH: "1" } });
    return { code: output.code, stdout: new TextDecoder().decode(output.stdout) };
}

async function readCommittedPlanMarkdown(
    projectRoot: string,
    commit: string,
    planPath: string,
): Promise<string | null> {
    const shown = await readGit(projectRoot, ["show", `${commit}:${planPath}`]);
    if (shown.code === 0) return shown.stdout;
    const listed = await readGit(projectRoot, ["ls-tree", commit, "--", planPath]);
    if (listed.code !== 0 || listed.stdout.trim()) throw new TargetBranchSnapshotUnavailableError(commit);
    return null;
}

async function commitContainsExecutionPlan(
    projectRoot: string,
    attempt: RecordedExecutionPlan,
    commit: string,
    requireExecutionStatus: boolean,
): Promise<boolean> {
    const markdown = await readCommittedPlanMarkdown(projectRoot, commit, `docs/plans/${attempt.planName}.md`);
    if (markdown === null) return false;
    try {
        const parsed = parsePlanFrontMatter(markdown.trim());
        if (!attempt.planId || parsed.attrs.planId !== attempt.planId) return false;
        if (requireExecutionStatus && !RESCUED_EXECUTION_STATUSES.has(String(parsed.attrs.status || ""))) return false;
    } catch {
        return false;
    }
    if (attempt.baseCommit) {
        const ancestor = await readGit(projectRoot, ["merge-base", "--is-ancestor", attempt.baseCommit, commit]);
        if (ancestor.code !== 0) return false;
    }
    return true;
}

async function findUniqueRescueCandidate(
    projectRoot: string,
    attempt: RecordedExecutionPlan,
): Promise<RescueCandidate | null> {
    const refsResult = await readGit(projectRoot, [
        "for-each-ref",
        "--format=%(refname)%00%(objectname)",
        "refs/heads",
        "refs/remotes",
    ]);
    if (refsResult.code !== 0) return null;
    const candidatesByCommit = new Map<string, RescueCandidate>();
    for (const line of refsResult.stdout.trim().split("\n").filter(Boolean)) {
        const [ref = "", commit = ""] = line.split("\0");
        if (!ref || !commit || /\/HEAD$/.test(ref)) continue;
        if (!(await commitContainsExecutionPlan(projectRoot, attempt, commit, true))) continue;
        const existing = candidatesByCommit.get(commit);
        if (existing) existing.refs.push(ref);
        else candidatesByCommit.set(commit, { commit, refs: [ref] });
    }
    const candidates = [...candidatesByCommit.values()];
    const tips: RescueCandidate[] = [];
    for (const candidate of candidates) {
        let superseded = false;
        for (const other of candidates) {
            if (candidate.commit === other.commit) continue;
            const ancestor = await readGit(projectRoot, [
                "merge-base",
                "--is-ancestor",
                candidate.commit,
                other.commit,
            ]);
            if (ancestor.code === 0) {
                superseded = true;
                break;
            }
        }
        if (!superseded) tips.push(candidate);
    }
    return tips.length === 1 ? tips[0] : null;
}

/** Resolve local execution evidence. Repair also checks rescue refs to explain a conflicting recorded branch. */
export async function findMissingExecutionSnapshot(
    projectRoot: string,
    attempt: RecordedExecutionPlan,
    purpose: "read" | "repair",
): Promise<ExecutionSnapshotSelection> {
    const recordedRef = `refs/heads/${attempt.branch}`;
    const recorded = await readGit(projectRoot, ["rev-parse", "--verify", recordedRef]);
    if (recorded.code === 0) {
        const commit = recorded.stdout.trim();
        if (await commitContainsExecutionPlan(projectRoot, attempt, commit, false))
            return { kind: "recorded", commit, sourceRef: recordedRef };
        if (purpose === "read") return { kind: "recorded_branch_conflict" };
    }
    const candidate = await findUniqueRescueCandidate(projectRoot, attempt);
    if (!candidate) return { kind: "missing" };
    if (recorded.code === 0) return { kind: "recorded_branch_conflict" };
    const sourceRef = candidate.refs.find((ref) => ref.startsWith("refs/heads/")) || candidate.refs[0];
    return { kind: "rescue", commit: candidate.commit, sourceRef };
}

/** Read recoverable execution evidence without recreating its checkout or changing refs. */
export async function readMissingExecutionPlan(
    projectRoot: string,
    attempt: RecordedExecutionPlan,
): Promise<PlanTextLoaded | null> {
    const snapshot = await findMissingExecutionSnapshot(projectRoot, attempt, "read");
    if (snapshot.kind !== "recorded" && snapshot.kind !== "rescue") return null;
    const relativePath = `docs/plans/${attempt.planName}.md`;
    const markdown = await readCommittedPlanMarkdown(projectRoot, snapshot.commit, relativePath);
    if (markdown === null) return null;
    const parsed = await parsePlanTextStrict(markdown, `${snapshot.commit}:${relativePath}`);
    if (parsed.kind === "malformed") throw parsed.error;
    return parsed;
}
