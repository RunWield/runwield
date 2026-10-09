import { readdir, readFile } from "node:fs/promises";
import { kill, platform } from "node:process";

interface ProcessExit {
    code: number | null;
}

/** Identity and completion of a real detached child owned by the caller. */
export interface OwnedLinuxGroupLeader {
    pid: number;
    status: Promise<ProcessExit>;
}

/**
 * Stop a remote-owned Linux process group. Its leader must be a live process
 * spawned with `detached: true` by the caller. Never signal the group after
 * its leader exits: the group number could later belong to another owner.
 * Check actual group membership, not just the direct child's status.
 */
export async function terminateOwnedLinuxGroup(child: OwnedLinuxGroupLeader, graceMs = 5_000): Promise<boolean> {
    if (platform !== "linux") throw new Error("Remote group termination requires Linux");
    let leaderExited = false;
    const status = child.status.then(() => {
        leaderExited = true;
    });
    await Promise.race([status, Promise.resolve()]);
    if (!leaderExited) {
        try {
            kill(-child.pid, "SIGTERM");
        } catch { /* Process may have exited. */ }
    }
    const members = async (): Promise<number[]> => {
        const result: number[] = [];
        for (const entry of await readdir("/proc", { withFileTypes: true })) {
            if (!/^\d+$/.test(entry.name)) continue;
            try {
                const stat = await readFile(`/proc/${entry.name}/stat`, "utf8");
                const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
                if (Number(fields[2]) === child.pid && fields[0] !== "Z" && fields[0] !== "X") {
                    result.push(Number(entry.name));
                }
            } catch (error) {
                if (error instanceof Error && "code" in error && (error.code === "EACCES" || error.code === "EPERM")) {
                    // A restricted /proc cannot prove the group is empty.
                    return [child.pid];
                }
                if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
            }
        }
        return result;
    };
    const until = Date.now() + graceMs;
    let remaining = await members();
    while (remaining.length && Date.now() < until) {
        await new Promise((resolve) => setTimeout(resolve, Math.min(50, until - Date.now())));
        remaining = await members();
    }
    if (remaining.length && !leaderExited) {
        // The leader still owns the group identity, so a forced group signal
        // cannot target a reused number. A timeout alone never grants takeover.
        try {
            kill(-child.pid, "SIGKILL");
        } catch { /* Exit raced with signal. */ }
        const forcedUntil = Date.now() + 2_000;
        while (remaining.length && Date.now() < forcedUntil) {
            await new Promise((resolve) => setTimeout(resolve, 50));
            remaining = await members();
        }
    }
    // A process stuck in uninterruptible sleep can outlive either deadline.
    // Return uncertainty and let the caller stop dependent work immediately.
    if (remaining.length) return false;
    let exitTimer: ReturnType<typeof setTimeout> | undefined;
    try {
        await Promise.race([
            status,
            new Promise<void>((resolve) => {
                exitTimer = setTimeout(resolve, 1_000);
            }),
        ]);
    } finally {
        if (exitTimer !== undefined) clearTimeout(exitTimer);
    }
    return leaderExited;
}
