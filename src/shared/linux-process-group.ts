import { readdir, readFile } from "node:fs/promises";
import { kill, pid, platform } from "node:process";
import { createRequire } from "node:module";

interface SubreaperSymbols {
    prctl(option: number, value: number, arg3: number, arg4: number, arg5: number): number;
}
interface SubreaperLibrary {
    symbols: SubreaperSymbols;
    close(): void;
}
interface NativeFunction {
    args: string[];
    returns: string;
}
interface SubreaperFFI {
    dlopen(path: string, symbols: Record<string, NativeFunction>): SubreaperLibrary;
}

/** Keep orphaned remote work under the supervisor, not init. Call before spawning. */
export function setChildSubreaper(): void {
    if (platform !== "linux") throw new Error("Remote supervisor requires Linux");
    try {
        const ffi: SubreaperFFI = createRequire(import.meta.url)("bun:ffi");
        const library = ffi.dlopen("libc.so.6", {
            prctl: { args: ["i32", "u64", "u64", "u64", "u64"], returns: "i32" },
        });
        try {
            if (library.symbols.prctl(36 /* PR_SET_CHILD_SUBREAPER */, 1, 0, 0, 0) !== 0)
                throw new Error("prctl failed");
        } finally {
            library.close();
        }
    } catch (cause) {
        throw new Error("Remote supervisor cannot own its subprocesses: PR_SET_CHILD_SUBREAPER failed", { cause });
    }
}

interface LinuxProcess {
    pid: number;
    parent: number;
    session: number;
    start: string;
    state: string;
}

async function readLinuxProcess(processId: number): Promise<LinuxProcess | undefined> {
    try {
        const stat = await readFile(`/proc/${processId}/stat`, "utf8");
        const fields = stat
            .slice(stat.lastIndexOf(")") + 2)
            .trim()
            .split(/\s+/);
        const parent = Number(fields[1]);
        const session = Number(fields[3]);
        if (!fields[19] || !Number.isInteger(parent) || !Number.isInteger(session)) {
            throw new Error(`Invalid process stat for ${processId}`);
        }
        return { pid: processId, parent, session, start: fields[19], state: fields[0] };
    } catch (error) {
        if (
            error instanceof Error &&
            "code" in error &&
            ["ENOENT", "ESRCH", "EACCES", "EPERM"].includes(String(error.code))
        ) {
            // Other-user processes hidden by /proc are outside the remote ownership contract.
            return undefined;
        }
        throw error;
    }
}

function descendantChain(child: LinuxProcess, processes: Map<number, LinuxProcess>): string | undefined {
    const visited = new Set<number>();
    const identities: string[] = [];
    let current: LinuxProcess | undefined = child;
    while (current && !visited.has(current.pid)) {
        identities.push(`${current.pid}:${current.start}:${current.parent}`);
        if (current.pid === pid) return identities.join("/");
        visited.add(current.pid);
        current = processes.get(current.parent);
    }
    return undefined;
}

/**
 * Stop the calling subreaper's live descendants, including adopted orphans.
 * Exclude its own session before unmount; include it after mount cleanup.
 * No waitpid: Bun retains ownership of its direct children's exit statuses.
 */
export async function terminateOwnedLinuxDescendants(includeOwnSession: boolean): Promise<boolean> {
    if (platform !== "linux") throw new Error("Remote descendant termination requires Linux");
    try {
        const owner = await readLinuxProcess(pid);
        if (!owner) return false;
        const gracefulUntil = Date.now() + 5_000;
        const forcedUntil = gracefulUntil + 2_000;
        const terminated = new Set<string>();
        while (true) {
            const entries = await readdir("/proc");
            const records = await Promise.all(
                entries.filter((entry) => /^\d+$/.test(entry)).map((entry) => readLinuxProcess(Number(entry))),
            );
            const processes = new Map(
                records.filter((record): record is LinuxProcess => !!record).map((record) => [record.pid, record]),
            );
            const descendants = records.filter(
                (record): record is LinuxProcess =>
                    !!record &&
                    record.pid !== pid &&
                    !["Z", "X", "x"].includes(record.state) &&
                    (includeOwnSession || record.session !== owner.session) &&
                    descendantChain(record, processes) !== undefined,
            );
            if (!descendants.length) return true;
            if (Date.now() >= forcedUntil) return false;
            for (const child of descendants) {
                const identity = `${child.pid}:${child.start}`;
                const force = Date.now() >= gracefulUntil;
                if (!force && terminated.has(identity)) continue;
                // Re-read the whole ancestry immediately before signalling. A reused pid
                // or a changed parent chain is reconsidered only on the next scan.
                const fresh = new Map<number, LinuxProcess>();
                let current: LinuxProcess | undefined = await readLinuxProcess(child.pid);
                while (current && !fresh.has(current.pid)) {
                    fresh.set(current.pid, current);
                    if (current.pid === pid) break;
                    current = await readLinuxProcess(current.parent);
                }
                const candidate = fresh.get(child.pid);
                if (
                    !candidate ||
                    candidate.session !== child.session ||
                    descendantChain(candidate, fresh) !== descendantChain(child, processes)
                )
                    continue;
                try {
                    kill(child.pid, force ? "SIGKILL" : "SIGTERM");
                } catch (error) {
                    if (!(error instanceof Error && "code" in error && ["ESRCH", "EPERM"].includes(String(error.code))))
                        throw error;
                    // A visible but unsignalable descendant remains in subsequent scans.
                }
                terminated.add(identity);
            }
            await new Promise((resolve) => setTimeout(resolve, 50));
        }
    } catch {
        // A failed scan cannot confirm that owned work stopped.
        return false;
    }
}

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
        } catch {
            /* Process may have exited. */
        }
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
        } catch {
            /* Exit raced with signal. */
        }
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
