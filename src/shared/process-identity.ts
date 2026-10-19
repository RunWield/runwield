/** Process birth evidence for durable validation ownership, separate from numeric PID existence. */
import { execFile } from "node:child_process";
import { readFile, readlink } from "node:fs/promises";
import process from "node:process";

export type ProcessIdentity = {
    key: string;
    startedAt?: string;
};

function query(command: string, args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
        execFile(
            command,
            args,
            { timeout: 5_000, maxBuffer: 16_384, env: { ...process.env, LC_ALL: "C", TZ: "UTC" } },
            (error, stdout) => {
                if (error) reject(error);
                else resolve(stdout.trim());
            },
        );
    });
}

async function readStartTime(pid: number): Promise<string | undefined> {
    const value =
        process.platform === "win32"
            ? await query("powershell.exe", [
                  "-NoLogo",
                  "-NoProfile",
                  "-NonInteractive",
                  "-Command",
                  `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o')`,
              ])
            : await query("ps", ["-p", String(pid), "-o", "lstart="]);
    // ps emits no timezone; request UTC explicitly rather than relying on the JS runtime
    // and system command agreeing about the local timezone. PowerShell already emits UTC.
    const timestamp = Date.parse(process.platform === "win32" ? value : `${value} UTC`);
    return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : undefined;
}

/** Unavailable OS evidence stays unknown; it must never authorize taking over a live owner. */
export async function readProcessIdentity(pid: number): Promise<ProcessIdentity | undefined> {
    if (!Number.isInteger(pid) || pid <= 0) return undefined;
    try {
        if (process.platform === "linux") {
            const [stat, boot, namespace] = await Promise.all([
                readFile(`/proc/${pid}/stat`, "utf8"),
                readFile("/proc/sys/kernel/random/boot_id", "utf8"),
                readlink(`/proc/${pid}/ns/pid`),
            ]);
            // comm may contain spaces and closing parentheses; fields after its final ')' begin at field 3.
            const ticks = stat
                .slice(stat.lastIndexOf(")") + 2)
                .trim()
                .split(/\s+/)[19];
            if (!/^\d+$/.test(ticks || "") || !boot.trim() || !namespace) return undefined;
            return {
                key: `linux:${boot.trim()}:${namespace}:${ticks}`,
                startedAt: await readStartTime(pid).catch(() => undefined),
            };
        }
        const startedAt = await readStartTime(pid);
        return startedAt ? { key: `${process.platform}:${startedAt}`, startedAt } : undefined;
    } catch {
        return undefined;
    }
}

/**
 * Keep live/unknown owners; reclaim only a missing PID or positive evidence of a different birth.
 * Legacy checkpoints have no key, so compare their write time with the process birth instead.
 */
export async function isRecordedProcessAlive(
    pid: number,
    recordedAt: string,
    identity?: ProcessIdentity,
): Promise<boolean> {
    if (!Number.isInteger(pid) || pid <= 0) return true;
    try {
        process.kill(pid, 0);
    } catch (error) {
        return !(error instanceof Error && "code" in error && error.code === "ESRCH");
    }
    const writtenAt = Date.parse(recordedAt);
    const current = await readProcessIdentity(pid);
    if (!current) return true;
    if (identity?.key) return identity.key === current.key;
    // ps exposes whole seconds. Require an unambiguous later birth for legacy records.
    return !(current.startedAt && Number.isFinite(writtenAt) && Date.parse(current.startedAt) > writtenAt + 1_000);
}
