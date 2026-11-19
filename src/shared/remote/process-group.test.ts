import { assertEquals } from "../../testing/assertions.ts";
import { ok as assert } from "node:assert/strict";
import { terminateOwnedLinuxGroup } from "../linux-process-group.ts";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, readlink, rm, writeFile } from "node:fs/promises";
import process from "node:process";
import { text } from "node:stream/consumers";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { kill, platform } from "node:process";
import { test } from "node:test";

const linux = platform === "linux";

interface ChildStatus {
    code: number | null;
}

async function startProcess(command: string, args: string[], detached = false) {
    const child = spawn(command, args, { detached, stdio: "ignore" });
    await once(child, "spawn");
    assert(child.pid);
    const status = new Promise<ChildStatus>((resolve, reject) => {
        child.once("exit", (code) => resolve({ code }));
        child.once("error", reject);
    });
    return { pid: child.pid, status, kill: child.kill.bind(child) };
}

async function running(pid: number): Promise<boolean> {
    try {
        const stat = await readFile(`/proc/${pid}/stat`, "utf8");
        const state = stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3);
        return state !== "Z" && state !== "X";
    } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
        throw error;
    }
}

async function groupFixture(ignoreTerm: boolean, exitLeader = false) {
    const directory = await mkdtemp(join(tmpdir(), "runwield-process-group-"));
    const pidFile = `${directory}/descendant`;
    const script = `${ignoreTerm ? 'trap "" TERM; ' : ""}sleep 30 & echo $! > "$1"; ${exitLeader ? "exit 0" : "wait"}`;
    const child = await startProcess("sh", ["-c", script, "sh", pidFile], true);
    let descendant = 0;
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
        descendant = Number(await readFile(pidFile, "utf8").catch(() => ""));
        if (descendant && (await running(descendant))) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
    if (!descendant) throw new Error("Child did not start a descendant");
    return { child, descendant, directory };
}

test(
    "remote-owned process cleanup confirms child and grandchild exit without stopping an unrelated process",
    {
        skip: !linux,
    },
    async () => {
        const { child, descendant, directory } = await groupFixture(false);
        const unrelated = await startProcess("sleep", ["30"]);
        try {
            assertEquals(await terminateOwnedLinuxGroup(child), true);
            assertEquals(await running(child.pid), false);
            assertEquals(await running(descendant), false);
            assert(await running(unrelated.pid));
        } finally {
            if (await running(child.pid)) child.kill("SIGKILL");
            if (await running(descendant)) kill(descendant, "SIGKILL");
            if (await running(unrelated.pid)) unrelated.kill("SIGKILL");
            await Promise.all([child.status, unrelated.status]);
            await rm(directory, { recursive: true });
        }
    },
);

test(
    "remote-owned process cleanup forces a blocked child and grandchild after the graceful deadline",
    { skip: !linux },
    async () => {
        const { child, descendant, directory } = await groupFixture(true);
        try {
            const started = Date.now();
            const pending = terminateOwnedLinuxGroup(child, 1_000);
            await new Promise((resolve) => setTimeout(resolve, 50));
            assert(await running(child.pid), "leader must survive during the graceful interval");
            assert(await running(descendant), "descendant must survive during the graceful interval");
            assertEquals(await pending, true);
            assert(Date.now() - started >= 1_000);
            assertEquals(await running(child.pid), false);
            assertEquals(await running(descendant), false);
        } finally {
            if (await running(child.pid)) child.kill("SIGKILL");
            if (await running(descendant)) kill(descendant, "SIGKILL");
            await child.status;
            await rm(directory, { recursive: true });
        }
    },
);

test(
    "remote group cleanup reports uncertainty after its leader has exited without signaling descendants",
    {
        skip: !linux,
    },
    async () => {
        const { child, descendant, directory } = await groupFixture(false, true);
        try {
            await child.status;
            assert(await running(descendant));
            assertEquals(await terminateOwnedLinuxGroup(child, 0), false);
            assert(await running(descendant), "a departed leader does not authorize another group signal");
        } finally {
            if (await running(descendant)) kill(descendant, "SIGKILL");
            await child.status;
            await rm(directory, { recursive: true });
        }
    },
);

// A separate process is the subreaper and sweep root, never this test runner.
const descendantFixture = String.raw`
import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { setChildSubreaper, terminateOwnedLinuxDescendants } from "MODULE";
setChildSubreaper();
const mode = process.argv[2];
const live = async (pid: number) => {
    try {
        const stat = await readFile('/proc/' + pid + '/stat', 'utf8');
        return !['Z', 'X'].includes(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0]);
    } catch (error) {
        if (error.code === 'ENOENT') return false;
        throw error;
    }
};
const waitPid = async (name: string) => {
    const until = Date.now() + 5000;
    while (Date.now() < until) {
        const pid = Number(await readFile(name, 'utf8').catch(() => ''));
        if (pid && await live(pid)) return pid;
        await Bun.sleep(20);
    }
    throw new Error('missing fixture pid: ' + name);
};
if (mode === 'sessions') {
    // The own-session parent must stay alive throughout phase 1. Its child is
    // outside that session and cannot be found by a direct-child-only sweep.
    const own = spawn('python3', ['-c', "import os,time;\nif os.fork() == 0:\n os.setsid()\n open('nested', 'w').write(str(os.getpid()))\n os.execlp('sleep', 'sleep', '60')\ntime.sleep(60)"], { stdio: 'ignore' });
    await writeFile('own', String(own.pid));
    const nested = await waitPid('nested');
    const nestedStat = (await readFile('/proc/' + nested + '/stat', 'utf8')).split(') ')[1].split(' ');
    if (Number(nestedStat[1]) !== own.pid || Number(nestedStat[3]) !== nested) throw new Error('nested ancestry not ready');
    spawn('sh', ['-c', 'trap "" TERM; echo $$ > detached; exec sleep 60'], { detached: true, stdio: 'ignore' });
    const daemon = spawn('python3', ['-c', "import os;\nif os.fork(): os._exit(0)\nos.setsid()\nif os.fork(): os._exit(0)\nopen('orphan', 'w').write(str(os.getpid()))\nos.execlp('nohup', 'nohup', 'sleep', '60')"], { stdio: 'ignore' });
    const detached = await waitPid('detached');
    const orphan = await waitPid('orphan');
    // Wait for adoption, not just daemon startup.
    const until = Date.now() + 5000;
    let adopted = false;
    while (Date.now() < until) {
        const stat = await readFile('/proc/' + orphan + '/stat', 'utf8');
        if (Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]) === process.pid) { adopted = true; break; }
        await Bun.sleep(20);
    }
    if (!adopted) throw new Error('daemon was not adopted');
    const phase1 = await terminateOwnedLinuxDescendants(false);
    const after1 = { own: await live(own.pid), nested: await live(nested), detached: await live(detached), orphan: await live(orphan) };
    const phase2 = await terminateOwnedLinuxDescendants(true);
    console.log(JSON.stringify({ phase1, phase2, after1, ownAfter2: await live(own.pid) }));
} else {
    spawn('sh', ['-c', 'trap \'sleep 60 & echo $! > late\' TERM; echo $$ > detached; while :; do sleep 1; done'], { detached: true, stdio: 'ignore' });
    const detached = await waitPid('detached');
    const stopped = await terminateOwnedLinuxDescendants(false);
    const late = Number(await readFile('late', 'utf8'));
    console.log(JSON.stringify({ stopped, shell: await live(detached), late: await live(late) }));
}
process.exit(0);
`;

for (const mode of ["sessions", "late-fork"]) {
    test(`remote descendant cleanup stops ${mode} without stopping unrelated work`, { skip: !linux }, async () => {
        const directory = await mkdtemp(join(tmpdir(), "runwield-descendants-"));
        const source = join(directory, "fixture.ts");
        await writeFile(
            source,
            descendantFixture.replace("MODULE", new URL("../linux-process-group.ts", import.meta.url).pathname),
        );
        const unrelated = await startProcess("sleep", ["60"]);
        const fixture = spawn(process.execPath, [source, mode], {
            cwd: directory,
            env: { ...process.env, BUN_FEATURE_FLAG_NO_ORPHANS: "0" },
            stdio: ["ignore", "pipe", "pipe"],
        });
        const status = once(fixture, "exit", { signal: AbortSignal.timeout(20_000) });
        const stdout = text(fixture.stdout);
        const stderr = text(fixture.stderr);
        try {
            const [code] = await status;
            assertEquals(code, 0, await stderr);
            const result = JSON.parse(await stdout);
            if (mode === "sessions") {
                assertEquals(result, {
                    phase1: true,
                    phase2: true,
                    after1: { own: true, nested: false, detached: false, orphan: false },
                    ownAfter2: false,
                });
            } else {
                assertEquals(result, { stopped: true, shell: false, late: false });
            }
            assert(await running(unrelated.pid), "another process under the same user must survive");
        } finally {
            for (const name of ["own", "nested", "detached", "orphan", "late"]) {
                const pid = Number(await readFile(join(directory, name), "utf8").catch(() => ""));
                if (pid && (await running(pid))) {
                    // Only this fixture uses its private cwd. Do not signal a reused pid.
                    const cwd = await readlink(`/proc/${pid}/cwd`).catch(() => "");
                    if (cwd === directory) {
                        try {
                            kill(pid, "SIGKILL");
                        } catch (error) {
                            assert(error instanceof Error && "code" in error && error.code === "ESRCH", String(error));
                        }
                    }
                }
            }
            if (fixture.pid && (await running(fixture.pid))) fixture.kill("SIGKILL");
            unrelated.kill("SIGKILL");
            await unrelated.status;
            await rm(directory, { recursive: true });
        }
    });
}

// Script only the OS boundary in a separate process. Each scan has a valid
// /proc listing, but the first listing and its stat reads straddle a fork/exit.
const changingTreeFixture = String.raw`
import { mock } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:process';
const mode = process.argv[2];
let scan = 0;
let signalled = false;
let now = 0;
Date.now = () => now;
const parent = 900001;
const child = 900002;
const stat = (id: number, ppid: number, state = 'S') => {
    const fields = Array(20).fill('0');
    fields[0] = state;
    fields[1] = String(ppid);
    fields[3] = String(id);
    fields[19] = String(id);
    return id + ' (fixture) ' + fields.join(' ');
};
mock.module('node:process', () => ({ ...os, platform: 'linux', kill: (id: number) => {
    if (id !== child) throw new Error('unexpected signal: ' + id);
    signalled = true;
} }));
mock.module('node:fs/promises', () => ({ ...fs,
    readdir: async () => {
        scan++;
        now += 1000;
        if (mode.startsWith('denied-')) return [String(os.pid), String(child), '900003'];
        if (mode === 'empty-tree') return [];
        if (mode === 'changing-tree') return [String(os.pid), String(parent + scan)];
        if (mode === 'unreadable-tree' || (scan === 1 && mode === 'missing-parent')) return [String(os.pid), String(parent), String(child)];
        return [String(os.pid), ...(scan === 1 ? [String(parent)] : [String(child)])];
    },
    readFile: async (path: string) => {
        const id = Number(path.split('/')[2]);
        if (id === os.pid) return stat(os.pid, 1);
        if (mode.startsWith('denied-')) {
            if (id === 900003) throw Object.assign(new Error('permission denied'), { code: mode.split('-')[1] });
            return stat(child, os.pid, signalled ? 'Z' : 'S');
        }
        if (mode === 'changing-tree') return stat(id, os.pid, 'Z');
        if (id === parent) {
            // A child can retain the old ppid in this scan even though its
            // parent has already disappeared by the time we read that stat.
            if (mode === 'missing-parent' || mode === 'unreadable-tree') throw Object.assign(new Error('gone'), { code: 'ENOENT' });
            return stat(parent, os.pid, 'Z');
        }
        return stat(child, mode === 'unreadable-tree' || scan === 1 ? parent : os.pid, signalled ? 'Z' : 'S');
    },
}));
const { terminateOwnedLinuxDescendants } = await import('MODULE');
const confirmed = await terminateOwnedLinuxDescendants(!mode.endsWith('-phase1'));
console.log(JSON.stringify({ confirmed, signalled }));
`;

for (const mode of [
    "zombie-parent",
    "missing-parent",
    "changing-tree",
    "unreadable-tree",
    "empty-tree",
    "denied-EACCES-phase1",
    "denied-EACCES-phase2",
    "denied-EPERM-phase1",
    "denied-EPERM-phase2",
]) {
    test(`remote descendant cleanup confirms only a stable complete tree: ${mode}`, async () => {
        const directory = await mkdtemp(join(tmpdir(), "runwield-changing-tree-"));
        const source = join(directory, "fixture.ts");
        let fixture: ReturnType<typeof spawn> | undefined;
        try {
            await writeFile(
                source,
                changingTreeFixture.replace("MODULE", new URL("../linux-process-group.ts", import.meta.url).pathname),
            );
            const child = spawn(process.execPath, [source, mode], { stdio: ["ignore", "pipe", "pipe"] });
            fixture = child;
            const status = once(child, "exit", { signal: AbortSignal.timeout(10_000) });
            const stdout = text(child.stdout);
            const stderr = text(child.stderr);
            const [code] = await status;
            assertEquals(code, 0, await stderr);
            const canConfirm = mode === "zombie-parent" || mode === "missing-parent" || mode.startsWith("denied-");
            assertEquals(JSON.parse(await stdout), { confirmed: canConfirm, signalled: canConfirm });
        } finally {
            fixture?.kill("SIGKILL");
            await rm(directory, { recursive: true });
        }
    });
}
