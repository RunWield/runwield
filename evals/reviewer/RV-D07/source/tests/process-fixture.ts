import { existsSync } from "node:fs";
import { setTimeout } from "node:timers/promises";

export function alive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
        // An inaccessible or terminating group is not proof of absence. Keep waiting for ESRCH.
        if ((error as NodeJS.ErrnoException).code === "EPERM") return true;
        throw error;
    }
}

export async function waitFor(check: () => boolean): Promise<void> {
    const deadline = Date.now() + 10000;
    while (!check()) {
        if (Date.now() > deadline) throw new Error("Process handshake did not settle");
        await setTimeout(5);
    }
}

export async function stopGroup(pid: number): Promise<void> {
    const deadline = Date.now() + 10000;
    while (alive(-pid)) {
        try {
            process.kill(-pid, "SIGKILL");
        } catch (error) {
            if (!["ESRCH", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
        }
        if (Date.now() > deadline) throw new Error("Process group cleanup did not settle");
        await setTimeout(5);
    }
}

export async function within<T>(work: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof globalThis.setTimeout> | undefined;
    try {
        return await Promise.race([
            work,
            new Promise<never>((_, reject) => {
                timer = globalThis.setTimeout(() => reject(new Error("Command did not settle")), 10000);
            }),
        ]);
    } finally {
        if (timer !== undefined) clearTimeout(timer);
    }
}

export async function ready(path: string): Promise<void> {
    await waitFor(() => existsSync(path));
}
