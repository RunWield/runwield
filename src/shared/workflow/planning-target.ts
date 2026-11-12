import { stat as fsStat } from "node:fs/promises";
import { captureForegroundProcess } from "../captured-process.ts";
import { resolvePublicationUpstream } from "../publication-target.ts";
import { effectiveDeliveryBranch } from "./plan-branch.ts";

export interface PlanningPlanAttributes {
    planId?: string;
    targetBranch?: string;
    deliveryBranch?: string;
}

export class TargetBranchSnapshotUnavailableError extends Error {
    constructor(targetBranch: string) {
        super(`Local target branch evidence is unavailable: ${targetBranch}.`);
        this.name = "TargetBranchSnapshotUnavailableError";
    }
}

export async function pathExists(path: string): Promise<boolean> {
    try {
        await fsStat(path);
        return true;
    } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
        throw error;
    }
}

export function targetBranchForPlan(attrs: PlanningPlanAttributes): string {
    const targetBranch = effectiveDeliveryBranch(attrs) || "";
    if (!targetBranch) throw new Error("Epic child planning requires a targetBranch.");
    return targetBranch;
}

export async function runGit(cwd: string, args: string[]): Promise<string> {
    const output = await captureForegroundProcess("git", { cwd, args, env: { GIT_NO_LAZY_FETCH: "1" } });
    const stdout = new TextDecoder().decode(output.stdout);
    const stderr = new TextDecoder().decode(output.stderr);
    if (!output.success) {
        if (["rev-parse", "ls-tree"].includes(args[0])) throw new TargetBranchSnapshotUnavailableError(args[1]);
        throw new Error(`git ${args.join(" ")} failed: ${stderr || stdout}`.trim());
    }
    return stdout;
}

export async function gitRefExists(projectRoot: string, ref: string): Promise<boolean> {
    const result = await captureForegroundProcess("git", {
        cwd: projectRoot,
        env: { GIT_NO_LAZY_FETCH: "1" },
        args: ["rev-parse", "--verify", "--quiet", ref],
    });
    return result.success;
}

/** Preserve cached origin history for read-only lookups without overriding an explicit local remote. */
export async function cachedTargetRemote(projectRoot: string, branch: string): Promise<string | undefined> {
    const upstream = await resolvePublicationUpstream(projectRoot, branch);
    if (upstream) return upstream.remote;
    const configured = await captureForegroundProcess("git", {
        cwd: projectRoot,
        env: { GIT_NO_LAZY_FETCH: "1" },
        args: ["config", "--get", `branch.${branch}.remote`],
    });
    return configured.code === 1 ? "origin" : undefined;
}

/** Read only locally available target evidence. */
export async function resolveExistingTargetSnapshot(projectRoot: string, targetBranch: string) {
    const target = targetBranch.trim();
    if (!target || target === "HEAD" || target.startsWith("refs/")) {
        throw new Error(`Invalid target branch name: ${targetBranch}`);
    }
    const branch = target.startsWith("origin/") ? target.slice("origin/".length) : target;
    const remote = await cachedTargetRemote(projectRoot, branch);
    const remoteRef = remote ? `refs/remotes/${remote}/${branch}` : "";
    const baseRef =
        remoteRef && (await gitRefExists(projectRoot, remoteRef))
            ? remoteRef
            : (await gitRefExists(projectRoot, `refs/heads/${branch}`))
              ? `refs/heads/${branch}`
              : "";
    if (!baseRef) throw new TargetBranchSnapshotUnavailableError(targetBranch);
    const commit = (await runGit(projectRoot, ["rev-parse", `${baseRef}^{commit}`])).trim();
    return { baseRef: commit, baseBranch: branch, targetRef: baseRef };
}

/** Explicit workflow preparation owns remote refresh. */
export async function prepareExistingTargetSnapshot(projectRoot: string, targetBranch: string) {
    const branch = targetBranch.trim().replace(/^origin\//, "");
    if (!branch || branch === "HEAD" || branch.startsWith("refs/")) {
        throw new Error(`Invalid target branch name: ${targetBranch}`);
    }
    const upstream = await resolvePublicationUpstream(projectRoot, branch);
    if (upstream) {
        const fetched = await captureForegroundProcess("git", {
            cwd: projectRoot,
            args: ["fetch", upstream.remote, `+refs/heads/${branch}:refs/remotes/${upstream.remote}/${branch}`],
        });
        if (!fetched.success && !new TextDecoder().decode(fetched.stderr).includes("couldn't find remote ref")) {
            throw new Error(
                `Could not refresh target branch ${upstream.remote}/${branch}. Planning was stopped before Planner starts.`,
            );
        }
        if (!fetched.success) {
            // A removed remote branch must not leave a stale remote-tracking ref authoritative.
            if (!(await gitRefExists(projectRoot, `refs/heads/${branch}`))) {
                throw new TargetBranchSnapshotUnavailableError(targetBranch);
            }
            const commit = (await runGit(projectRoot, ["rev-parse", `refs/heads/${branch}^{commit}`])).trim();
            return { baseRef: commit, baseBranch: branch, targetRef: `refs/heads/${branch}` };
        }
        return await resolveExistingTargetSnapshot(projectRoot, targetBranch);
    }
    const localRef = `refs/heads/${branch}`;
    if (!(await gitRefExists(projectRoot, localRef))) throw new TargetBranchSnapshotUnavailableError(targetBranch);
    const commit = (await runGit(projectRoot, ["rev-parse", `${localRef}^{commit}`])).trim();
    return { baseRef: commit, baseBranch: branch, targetRef: localRef };
}

/** Only the primary checkout on the named target can supply unpublished family edits. */
export async function isPrimaryTargetCheckout(projectRoot: string, targetBranch: string): Promise<boolean> {
    const branch = targetBranch.trim().replace(/^origin\//, "");
    const current = await captureForegroundProcess("git", {
        cwd: projectRoot,
        env: { GIT_NO_LAZY_FETCH: "1" },
        args: ["symbolic-ref", "--quiet", "HEAD"],
    });
    return current.success && new TextDecoder().decode(current.stdout).trim() === `refs/heads/${branch}`;
}
