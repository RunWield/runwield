/**
 * @module shared/process-liveness
 * Whether the process that wrote a lock file is still running.
 *
 * A lock is a claim by a specific process. When that process is gone the claim is
 * void, and the only honest way to know is to ask the operating system — a
 * timestamp cannot distinguish "crashed a second ago" from "busy and holding it
 * legitimately". Waiting out a timeout instead means a crash makes RunWield
 * unusable for minutes over its own bookkeeping.
 *
 * Shared because the worktree registry lock and the Plan lock both need it and
 * previously disagreed: the registry reclaimed instantly from a dead holder while
 * Plan locks waited on file age.
 */

import { hostname } from "node:os";
import { kill } from "node:process";

/** Host identity recorded in a lock, so a pid is only trusted on the machine that wrote it. */
export function getLockHostname(): string {
    try {
        return hostname();
    } catch {
        return "";
    }
}

/**
 * Whether a pid is still running.
 *
 * Answers false for a pid this process cannot ask about, because an unknown holder
 * must never be assumed alive — that is what strands a Plan.
 */
export function isPidAlive(pid: number): Promise<boolean> {
    if (!Number.isInteger(pid) || pid <= 0) return Promise.resolve(false);
    try {
        // Signal zero probes existence without signaling the holder. Preserve the
        // previous external `kill -0` contract: an unqueryable pid returns false.
        kill(pid, 0);
        return Promise.resolve(true);
    } catch {
        return Promise.resolve(false);
    }
}

/**
 * Whether a lock file's recorded holder is provably gone.
 *
 * Requires positive evidence: the lock names a pid, it was written on this host,
 * and the operating system says that pid is not running. A lock from another host,
 * or one whose contents cannot be read, is never declared dead here — callers fall
 * back to an age check for those.
 */
export async function isLockHolderGone(contents: string): Promise<boolean> {
    let parsed;
    try {
        parsed = JSON.parse(contents);
    } catch {
        return false;
    }
    const pid = Number(parsed?.pid);
    const hostname = typeof parsed?.hostname === "string" ? parsed.hostname : "";
    if (!Number.isInteger(pid) || pid <= 0) return false;
    if (!hostname || hostname !== getLockHostname()) return false;
    return !(await isPidAlive(pid));
}

/**
 * Whether a lock file names no holder anyone can check.
 *
 * Locks written before holder identity was recorded, and files corrupted by a
 * crash mid-write, cannot be attributed to a process — so no amount of waiting
 * will ever prove them dead. Automatic reclaim stays conservative and lets those
 * age out, but an explicit repair may clear them: an unattributable lock is
 * RunWield's own leftover, and refusing to clean it up would leave the user
 * waiting on a file that can never resolve itself.
 */
export function isLockHolderUnattributable(contents: string): boolean {
    let parsed;
    try {
        parsed = JSON.parse(contents);
    } catch {
        return true;
    }
    if (!parsed || typeof parsed !== "object") return true;
    const pid = Number(parsed.pid);
    const hostname = parsed.hostname;
    if (!Number.isInteger(pid) || pid <= 0) return true;
    return typeof hostname !== "string" || hostname.length === 0;
}
