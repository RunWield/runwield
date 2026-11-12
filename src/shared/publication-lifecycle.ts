import {
    finalizePublicationLifecycle,
    checkLocalPublicationMetadata,
    readPublishedWorkRecordIndex,
} from "../plan-store/index.ts";
export { finalizePublicationLifecycle, hasFinalizedPublicationLifecycle } from "../plan-store/index.ts";
import { tmpdir } from "node:os";
import { mkdtemp } from "node:fs/promises";
import { captureForegroundProcess } from "./captured-process.ts";
import { rm as fsRm } from "node:fs/promises";
/** Finalize only the Plan and Work Record documents owned by a sealed delivery. */
import { join } from "node:path";

import { syncWorkRecordToIndex } from "./work-records/index-adapter.ts";
import type { WorkRecordMnemotecaPort } from "./work-records/mnemoteca-port.ts";

async function git(cwd: string, args: string[]): Promise<string> {
    const result = await captureForegroundProcess("git", { cwd, args });
    if (!result.success) throw new Error(new TextDecoder().decode(result.stderr));
    return new TextDecoder().decode(result.stdout).trim();
}

/** A failed listing must stop publication, not imply that the branch is unchecked out. */
async function localPublicationCheckout(cwd: string, targetBranch: string): Promise<string | null> {
    const listing = await git(cwd, ["worktree", "list", "--porcelain", "-z"]);
    for (const entry of listing.split("\0\0")) {
        const fields = entry.split("\0");
        if (!fields.includes(`branch refs/heads/${targetBranch}`)) continue;
        const checkout = fields.find((field) => field.startsWith("worktree "));
        if (!checkout) throw new Error(`Cannot identify the checkout holding ${targetBranch}.`);
        return checkout.slice("worktree ".length);
    }
    return null;
}

export async function recoverLocalPublicationLifecycle(
    cwd: string,
    targetBranch: string,
    sealedCommit: string,
): Promise<void> {
    const branch = await git(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"]).catch(() => "");
    if (branch !== targetBranch) return;
    const message = await git(cwd, ["show", "-s", "--format=%B", "HEAD"]);
    if (!message.split("\n").includes(`RunWield-Delivery-Candidate: ${sealedCommit}`)) return;
    const paths = await checkLocalPublicationMetadata(cwd, "HEAD^", "HEAD");
    if (paths.length) await git(cwd, ["restore", "--source=HEAD", "--staged", "--worktree", "--", ...paths]);
}

/** Build metadata in a disposable checkout, then advance exactly the selected local branch. */
export async function finalizeLocalPublicationLifecycle(
    cwd: string,
    targetBranch: string,
    planName: string,
    sealedCommit: string,
    allowedPlanPaths: string[],
): Promise<string> {
    const checkout = await localPublicationCheckout(cwd, targetBranch);
    if (checkout) await recoverLocalPublicationLifecycle(checkout, targetBranch, sealedCommit);
    const before = await git(cwd, ["rev-parse", `refs/heads/${targetBranch}`]);
    const temporary = await mkdtemp(join(tmpdir(), "runwield-delivery-metadata-"));
    let attached = false;
    try {
        await git(cwd, ["worktree", "add", "--detach", temporary, before]);
        attached = true;
        const paths = await finalizePublicationLifecycle(
            temporary,
            planName,
            sealedCommit,
            allowedPlanPaths,
            targetBranch,
        );
        if (!paths.length) return before;
        await git(temporary, ["add", "--", ...paths]);
        await git(temporary, [
            "commit",
            "-m",
            `Record verified delivery for ${planName}`,
            "-m",
            `RunWield-Delivery-Candidate: ${sealedCommit}`,
        ]);
        const commit = await git(temporary, ["rev-parse", "HEAD"]);
        const targetCheckout = await localPublicationCheckout(cwd, targetBranch);
        if (targetCheckout) await checkLocalPublicationMetadata(targetCheckout, before, commit);
        await git(cwd, ["update-ref", `refs/heads/${targetBranch}`, commit, before]);
        if (targetCheckout) await recoverLocalPublicationLifecycle(targetCheckout, targetBranch, sealedCommit);
        return commit;
    } finally {
        if (attached) await git(cwd, ["worktree", "remove", "--force", temporary]);
        else await fsRm(temporary, { recursive: true });
    }
}

/** Derive the index and observed Plan classifications from the same confirmed published bytes. */
export async function indexPublishedWorkRecords(
    projectRoot: string,
    gitRoot: string,
    commit: string,
    planPaths: string[],
    mnemotecaPort: WorkRecordMnemotecaPort,
    sourcePlanCommit = commit,
): Promise<Map<string, string>> {
    const { planKinds, records } = await readPublishedWorkRecordIndex(
        projectRoot,
        gitRoot,
        commit,
        planPaths,
        sourcePlanCommit,
    );
    for (const record of records) await syncWorkRecordToIndex(projectRoot, record, { mnemotecaPort });
    return planKinds;
}
