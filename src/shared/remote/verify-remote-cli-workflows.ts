/**
 * Qualification only. Drives the unchanged release CLI through verify-remote-reviews.ts.
 * No runtime client, recovery API, publication receipt writer, or personal HOME is used.
 * Artifacts and all scratch evidence are retained. A failed assertion is never a pass.
 */
import { equal, ok } from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFile, mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import { Terminal } from "@xterm/headless";
import type { FileSessionManifest } from "../session/file-session-store-types.ts";

interface DriverStart {
    root: string;
    remote: string;
    buildId: string;
}
interface Qualification extends DriverStart {
    home: string;
    launcherPid: number;
    sshPids: number[];
    sftpPids: number[];
}
interface LauncherExit {
    pid: number;
    exitCode: number;
    terminationRequested: boolean;
    observedAt: number;
}
interface StopEvidence extends LauncherExit {
    requestedAt: number;
    detectionSeconds: number;
}
interface OwnedRemote {
    pids: number[];
    sockets: string[];
    mounts: string[];
}
interface Progress {
    outcome?: string;
    message?: string;
    checks?: { ci?: string };
}
interface TranscriptEntry {
    type?: string;
    customType?: string;
    data?: { validationProgress?: Progress };
}
const journeys = ["delivery", "validation-cut", "publication-proven", "publication-uncertain"];
const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;
const delay = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
function ssh(shell: string): string {
    return execFileSync("/usr/bin/ssh", ["-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=15", "sct", shell], {
        encoding: "utf8",
        timeout: 30_000,
        maxBuffer: 4 * 1024 * 1024,
    }).trim();
}
async function wait<T>(check: () => T | Promise<T>, label: string, timeout = 240_000): Promise<NonNullable<T>> {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
        const result = await check();
        if (result) return result as NonNullable<T>;
        await delay(500);
    }
    throw new Error(`Timeout: ${label}`);
}
async function text(path: string): Promise<string> {
    return await readFile(path, "utf8").catch((error) => {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return "";
        throw error;
    });
}
async function files(root: string): Promise<string[]> {
    const entries = await readdir(root, { withFileTypes: true }).catch((error) => {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
        throw error;
    });
    const nested = await Promise.all(
        entries.map((entry) => (entry.isDirectory() ? files(join(root, entry.name)) : [join(root, entry.name)])),
    );
    return nested.flat();
}
async function savedSession(home: string, id?: string) {
    const paths = (await files(join(home, ".wld", "sessions"))).filter((path) => path.endsWith("/manifest.json"));
    for (const path of paths) {
        const manifestText = await readFile(path, "utf8");
        const manifest: FileSessionManifest = JSON.parse(manifestText);
        if (id && manifest.runwieldSessionId !== id) continue;
        const current = manifest.segments.find((segment) => segment.segmentId === manifest.currentSegmentId);
        ok(current, "Committed current segment exists");
        ok(current.transcriptPath.startsWith(home + "/"), "Session bytes belong to the disposable laptop HOME");
        const observed = await readFile(current.transcriptPath);
        const bytes = manifest.generation ? observed.subarray(0, manifest.generation.byteLength) : observed;
        // A concurrent save can replace the manifest. Retry rather than accepting uncommitted bytes.
        if (manifest.generation && createHash("sha256").update(bytes).digest("hex") !== manifest.generation.digestHex)
            continue;
        for (const segment of manifest.segments.filter((entry) => entry.sealedDigestHex)) {
            ok(segment.transcriptPath.startsWith(home + "/"));
            const sealed = (await readFile(segment.transcriptPath)).subarray(0, segment.sealedByteLength!);
            equal(createHash("sha256").update(sealed).digest("hex"), segment.sealedDigestHex);
        }
        // A running operation has fsynced saves beyond its last committed generation.
        // Keep those bytes distinct from a completed checkpoint; fault cuts need the saved tail.
        if (!observed.length || observed.at(-1) !== 10 || (await readFile(path, "utf8")) !== manifestText) continue;
        const contents = observed.toString("utf8");
        const committed = Boolean(manifest.generation && observed.length === manifest.generation.byteLength);
        const entries: TranscriptEntry[] = contents
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line));
        const progress = entries.filter((entry) => entry.data?.validationProgress).at(-1)?.data?.validationProgress;
        return { path, manifest, contents, committed, progress };
    }
    return undefined;
}
async function approve(url: string, plan = false): Promise<void> {
    const page = new URL(url);
    const token = page.searchParams.get("token");
    ok(token);
    const decision = new URL("/api/review/decision", page);
    const response = await fetch(decision, {
        method: "POST",
        headers: { "content-type": "application/json", "x-runwield-review-token": token },
        body: JSON.stringify({
            approved: true,
            ...(plan
                ? { approvalAction: "run", executionAgent: "engineer", collaborationRecommendation: "autonomous" }
                : {}),
        }),
    });
    equal(response.status, 200, await response.text());
}

async function launch(archives: string, version: string, remote: string, home: string, evidence: string) {
    const log = join(evidence, "driver.log");
    const bin = join(evidence, "bin");
    await mkdir(bin);
    // Only the exact supervisor launch receives scratch Git configuration. Every
    // other SSH call keeps its original argv, stdin and environment untouched.
    await writeFile(
        join(bin, "ssh"),
        `#!/usr/bin/python3\nimport os,sys,shlex,re,json\nargs=sys.argv[1:]\nif len(args)>=3 and args[-3:-1]==['--','sct']:\n try: words=shlex.split(args[-1])\n except ValueError: words=[]\n if len(words)==5 and words[0]=='exec' and words[2]=='--remote-supervisor' and words[3].isdigit() and re.fullmatch(r'/tmp/wld-remote-[a-f0-9]{32}',words[4]):\n  args[-1]='exec env GIT_CONFIG_GLOBAL='+shlex.quote(${JSON.stringify(remote + "/qualification/gitconfig")})+' '+args[-1][5:]\n  with open(${JSON.stringify(join(evidence, "supervisor-injection.jsonl"))},'a') as log: log.write(json.dumps(args)+'\\n')\nos.execv('/usr/bin/ssh',['/usr/bin/ssh',*args])\n`,
        { mode: 0o700 },
    );
    const child = spawn(
        process.execPath,
        [join(import.meta.dir, "verify-remote-reviews.ts"), "--archives", archives, version, remote, home],
        {
            env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, WLD_QUALIFY_PROVIDER: "synthetic" },
            stdio: ["ignore", "pipe", "pipe"],
        },
    );
    // Drain both pipes for the whole subprocess lifetime, including shutdown diagnostics.
    let logging = Promise.resolve();
    const capture = (chunk: Buffer) => {
        logging = logging.then(() => appendFile(log, chunk));
    };
    child.stdout.on("data", capture);
    child.stderr.on("data", capture);
    const exited = new Promise<void>((done) => child.once("exit", () => done()));
    let start: DriverStart;
    try {
        start = await wait(
            async () => {
                const first = (await text(log)).split("\n").find((line) => line.startsWith('{"root":'));
                if (first) return JSON.parse(first) as DriverStart;
                ok(child.exitCode === null && child.signalCode === null, `Reviews driver exited: ${await text(log)}`);
                return undefined;
            },
            "reviews driver start",
            180_000,
        );
    } catch (error) {
        child.kill("SIGTERM");
        await Promise.race([exited, delay(30_000)]);
        await logging;
        throw error;
    }
    equal(start.remote, remote);
    const screen = new Terminal({ cols: 150, rows: 40, scrollback: 10000, allowProposedApi: true });
    let offset = 0;
    async function render() {
        const terminal = await readFile(join(start.root, "terminal.log")).catch((error) => {
            if (error instanceof Error && "code" in error && error.code === "ENOENT") return Buffer.alloc(0);
            throw error;
        });
        if (terminal.length > offset) {
            await new Promise<void>((done) => screen.write(terminal.subarray(offset), done));
            offset = terminal.length;
        }
        const buffer = screen.buffer.active;
        const visible = Array.from({ length: screen.rows }, (_, row) =>
            buffer.getLine(buffer.viewportY + row)?.translateToString(true),
        ).join("\n");
        const history = Array.from({ length: buffer.length }, (_, row) =>
            buffer.getLine(row)?.translateToString(true),
        ).join("\n");
        await writeFile(join(evidence, "screen.txt"), visible);
        if (visible.trim()) await writeFile(join(evidence, "last-live-screen.txt"), visible);
        await writeFile(join(evidence, "rendered-terminal.txt"), history);
        return { visible, history };
    }
    async function send(input: string) {
        await appendFile(join(start.root, "input"), input);
    }
    async function shown(pattern: RegExp, label: string, timeout = 240_000) {
        return await wait(
            async () => {
                const result = await render();
                ok(
                    child.exitCode === null && child.signalCode === null,
                    `Reviews driver exited while waiting for ${label}: ${result.visible}`,
                );
                return pattern.test(result.history) && result;
            },
            label,
            timeout,
        );
    }
    async function interactive() {
        await shown(/Theme:/, "completed boot banner", 180_000);
        let nextProbe = 0;
        await wait(
            async () => {
                const frame = await render();
                ok(child.exitCode === null && child.signalCode === null, "Driver exited before input acknowledgement");
                if (/Keyboard shortcuts/.test(frame.visible)) return true;
                if (Date.now() >= nextProbe) {
                    // Early input can precede installation of the keyboard-help binding.
                    await send("\x15");
                    await delay(250);
                    await send("?");
                    nextProbe = Date.now() + 3000;
                }
                return false;
            },
            "keyboard-help input acknowledgement",
            60_000,
        );
        await send("\x1b");
        await delay(1000);
    }
    async function showWorkflowStage(pattern: RegExp, label: string) {
        let nextTab = 0;
        await wait(
            async () => {
                const frame = await render();
                ok(child.exitCode === null && child.signalCode === null, `Driver exited before ${label}`);
                if (pattern.test(frame.visible)) return true;
                if (Date.now() >= nextTab) {
                    await send("\x1d");
                    nextTab = Date.now() + 2000;
                }
                return false;
            },
            label,
            60_000,
        );
    }
    async function qualification(): Promise<Qualification> {
        return JSON.parse(await readFile(join(start.root, "qualification.json"), "utf8"));
    }
    async function ownership(): Promise<OwnedRemote> {
        const q = await qualification();
        const rows = execFileSync("/bin/ps", ["-axo", "pid=,args="], { encoding: "utf8" })
            .split("\n")
            .filter((line) => q.sshPids.includes(Number(line.trim().split(/\s+/)[0])));
        const sockets = [...new Set(rows.join("\n").match(/\/tmp\/wld-remote-[a-f0-9]{32}/g) || [])];
        ok(sockets.length, "Owned SSH socket directories are known");
        const probe = `import os,json,re
sockets=${JSON.stringify(sockets)}
processes={}
for name in os.listdir('/proc'):
 if not name.isdigit(): continue
 try:
  command=open('/proc/'+name+'/cmdline','rb').read().decode().split('\\0')
  parent=int(open('/proc/'+name+'/stat').read().split(') ')[1].split()[1])
  processes[int(name)]=(parent,command)
 except (FileNotFoundError,PermissionError,ProcessLookupError): pass
owned={pid for pid,(parent,command) in processes.items() if '--remote-supervisor' in command and any(socket in command for socket in sockets)}
for _ in range(30):
 following=owned|{pid for pid,(parent,command) in processes.items() if parent in owned}
 if following==owned: break
 owned=following
mounts=sorted({path for pid in owned for arg in processes[pid][1] for path in re.findall(r'/tmp/wld-sftp-[A-Za-z0-9]+',arg)})
print(json.dumps(dict(pids=sorted(owned),sockets=sockets,mounts=mounts)))`;
        const owned: OwnedRemote = JSON.parse(ssh(`python3 -c ${quote(probe)}`));
        ok(owned.pids.length && owned.mounts.length, "Owned remote processes and SSHFS mounts are known");
        await writeFile(join(evidence, "owned-remote.json"), JSON.stringify(owned, null, 2));
        return owned;
    }
    let stopped = false;
    let stopEvidence: StopEvidence | undefined;
    async function stop(cut: boolean) {
        if (stopped) return stopEvidence;
        stopped = true;
        let requestedAt: number;
        try {
            ok(
                child.exitCode === null && child.signalCode === null,
                "Release CLI must be live before the requested stop",
            );
            if (cut) {
                const q = await qualification();
                const rows = execFileSync("/bin/ps", ["-axo", "pid=,args="], { encoding: "utf8" }).split("\n");
                const owned: OwnedRemote = JSON.parse(await readFile(join(evidence, "owned-remote.json"), "utf8"));
                const transports = rows.filter(
                    (row) =>
                        q.sshPids.includes(Number(row.trim().split(/\s+/)[0])) &&
                        row.includes("--remote-supervisor") &&
                        owned.sockets.some((socket) => row.includes(socket)),
                );
                ok(transports.length, "Cut only this launcher's supervisor SSH transport");
                requestedAt = Date.now();
                for (const row of transports) process.kill(Number(row.trim().split(/\s+/)[0]), "SIGKILL");
            } else {
                await send("\x1b");
                await delay(1000);
                await send("\x15");
                await delay(250);
                requestedAt = Date.now();
                await send("/exit\n");
            }
            await wait(() => child.exitCode !== null || child.signalCode !== null, "driver shutdown", 45_000);
            const receipt: LauncherExit = JSON.parse(await readFile(join(start.root, "launcher-exit.json"), "utf8"));
            equal(receipt.pid, (await qualification()).launcherPid);
            equal(receipt.terminationRequested, false, "Exit must not depend on helper termination");
            if (!cut) equal(receipt.exitCode, 0, "Supported /exit must end the release launcher successfully");
            const detectionSeconds = receipt.observedAt - requestedAt / 1000;
            ok(Number.isFinite(detectionSeconds) && detectionSeconds >= 0, "Matched launcher exit has a measured time");
            stopEvidence = { ...receipt, requestedAt, detectionSeconds };
            return stopEvidence;
        } finally {
            if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
            await Promise.race([exited, delay(30_000)]);
            await logging;
            await render();
            screen.dispose();
        }
    }
    return { ...start, send, shown, interactive, showWorkflowStage, render, qualification, ownership, stop };
}
type Driver = Awaited<ReturnType<typeof launch>>;

async function cleaned(driver: Driver, owned: OwnedRemote, sleeper: number): Promise<void> {
    const q = await driver.qualification();
    const pids = [q.launcherPid, ...q.sshPids, ...q.sftpPids].filter((pid) => pid > 0);
    await wait(
        () => {
            const processes = execFileSync("/bin/ps", ["-axo", "pid="], { encoding: "utf8" })
                .trim()
                .split(/\s+/)
                .map(Number);
            return pids.every((pid) => !processes.includes(pid));
        },
        "owned laptop process cleanup",
        45_000,
    );
    const paths = [...owned.sockets, ...owned.mounts, ...owned.pids.map((pid) => `/proc/${pid}`)];
    await wait(
        () => {
            const remaining: string[] = JSON.parse(
                ssh(
                    `python3 -c ${quote(
                        `import os,json;paths=${JSON.stringify(paths)};print(json.dumps([p for p in paths if os.path.exists(p)]))`,
                    )}`,
                ),
            );
            return remaining.length === 0;
        },
        "owned remote process, socket and mount cleanup",
        60_000,
    );
    equal(ssh(`ps -p ${sleeper} -o comm=`), "sleep", "Unrelated sleep survives");
}

export async function qualifyRemoteCliWorkflows(archivesInput: string, version: string): Promise<void> {
    equal(process.versions.bun, "1.4.3");
    equal(process.platform, "darwin", "This qualification covers the macOS laptop only");
    const archives = resolve(archivesInput);
    const evidence = await mkdtemp(join(tmpdir(), "wld-cli-workflows-"));
    console.log(JSON.stringify({ evidence, evidenceKind: "production-release-cli-pty", archives, version }));
    const selected = process.env.WLD_LIVE_JOURNEYS?.split(",") || journeys;
    ok(selected.length && selected.every((name) => journeys.includes(name)), "Unknown WLD_LIVE_JOURNEYS selection");
    let buildId = "";
    let failures = 0;
    for (const journey of selected) {
        const caseRoot = join(evidence, journey);
        await mkdir(caseRoot);
        const record = async (event: string, details: Record<string, string | number | boolean | string[]> = {}) => {
            const line = JSON.stringify({ at: new Date().toISOString(), journey, event, buildId, ...details });
            await appendFile(join(caseRoot, "evidence.jsonl"), line + "\n");
            console.log(line);
        };
        let driver: Driver | undefined;
        let owned: OwnedRemote | undefined;
        let sleeper = 0;
        let remote = "";
        let originHidden = false;
        try {
            remote = ssh("umask 077; mktemp -d /tmp/wld-remote-reviews-XXXXXXXXXX");
            ok(/^\/tmp\/wld-remote-reviews-[a-zA-Z0-9]+$/.test(remote));
            const scratch = `${remote}/qualification`;
            const origin = `${remote}-published.git`;
            // All configuration and hooks belong to this new fixture. No server profile is changed.
            ssh(
                `cd ${quote(remote)} && mkdir -p .wld qualification && git init -q -b main && git config user.email qualification@example.invalid && git config user.name Qualification && git config core.hooksPath /dev/null && printf 'remote-only sentinel\\n' > sentinel.txt && printf '# Remote document\\n' > document.md && printf '.wld/\\nqualification/\\n' > .gitignore && git add . && git commit -qm fixture && git init --bare -q ${quote(origin)} && git remote add origin ${quote(origin)} && git push -qu origin main`,
            );
            const verification =
                `printf 'ci\\n' >> ${quote(scratch + "/ci.log")}; test -s sentinel.txt || exit 1` +
                (journey === "validation-cut"
                    ? `; touch ${quote(scratch + "/ci-started")}; while [ ! -e ${quote(scratch + "/ci-release")} ]; do sleep 0.1; done; touch ${quote(scratch + "/ci-finished")}`
                    : "");
            ssh(
                `printf %s ${quote(JSON.stringify({ verification_command: verification, codereview: "always", worktree_setup_command: "" }))} > ${quote(remote + "/.wld/settings.json")}`,
            );
            // receive-pack calls post-receive after changing the bare ref but BEFORE the
            // sending git push returns. Thus onPublished cannot yet save its receipt.
            // Count every actual receive, including delivery, to detect same-ref replay.
            const hook =
                `#!/bin/sh\ncat >> ${quote(scratch + "/received-refs")}\nprintf 'push\\n' >> ${quote(scratch + "/push.log")}\n` +
                (journey.startsWith("publication")
                    ? `touch ${quote(scratch + "/publication-effect")}\nwhile [ ! -e ${quote(scratch + "/publication-release")} ]; do sleep 0.1; done\n`
                    : "");
            const prePush = `#!/bin/sh\nprintf 'attempt\\n' >> ${quote(scratch + "/push-attempts.log")}\n`;
            const globalGit = `[core]\n    hooksPath = ${scratch}/hooks\n`;
            ssh(
                `mkdir -p ${quote(scratch + "/hooks")} && printf %s ${quote(hook)} > ${quote(scratch + "/hooks/post-receive")} && printf %s ${quote(prePush)} > ${quote(scratch + "/hooks/pre-push")} && printf %s ${quote(globalGit)} > ${quote(scratch + "/gitconfig")} && chmod 700 ${quote(scratch + "/hooks/post-receive")} ${quote(scratch + "/hooks/pre-push")} && git --git-dir=${quote(origin)} config core.hooksPath ${quote(scratch + "/hooks")}`,
            );
            sleeper = Number(
                ssh(`nohup sleep 1800 >${quote(scratch + "/unrelated-sleep.log")} 2>&1 </dev/null & echo $!`),
            );
            ok(sleeper > 1);
            const home = join(caseRoot, "home");
            await mkdir(home);
            driver = await launch(archives, version, remote, home, caseRoot);
            if (buildId) equal(driver.buildId, buildId, "All cases use the same release build");
            buildId = driver.buildId;
            await record("start", { remote, home, root: driver.root, sleeper });
            await driver.shown(/Would you like to run \/init/, "fresh-project init offer", 180_000);
            owned = await driver.ownership();
            await driver.send("\x1b");
            await delay(1000);
            await driver.interactive();
            await driver.send("/agent planner\n");
            await delay(2000);
            await driver.send("Plan the remote sentinel delivery.\n");
            const reviewUrl = async (kind: string) => {
                const urls = (await text(join(driver!.root, "browser-urls"))).split("\n");
                return urls.find((url) => url.includes(`/review/${kind}?`));
            };
            const plan = await wait(() => reviewUrl("plan"), "laptop Plan Review");
            await driver.shown(/review|Review/, "visible Plan Review");
            await approve(plan, true);
            const session = await wait(() => savedSession(home), "laptop Session files");
            const id = session.manifest.runwieldSessionId;
            if (journey === "validation-cut") {
                await wait(
                    () => ssh(`test -e ${quote(scratch + "/ci-started")} && echo ready || true`) === "ready",
                    "verification gate",
                );
                const atCut = await wait(async () => {
                    const saved = await savedSession(home, id);
                    return (
                        saved?.manifest.generation &&
                        saved.progress?.outcome === "running" &&
                        saved.progress.checks?.ci === "running" &&
                        saved
                    );
                }, "saved running CI marker after the verification gate");
                await driver.showWorkflowStage(/Verification|Validation/, "visible validation stage");
                await writeFile(join(caseRoot, "cut-session.json"), JSON.stringify(atCut, null, 2));
            } else {
                const code = await wait(() => reviewUrl("code"), "laptop Code Review", 400_000);
                await driver.shown(/review|Review/, "visible Code Review");
                await approve(code);
                if (journey === "delivery") {
                    await driver.shown(/Session complete/, "completed Session", 400_000);
                    const delivered = await wait(async () => {
                        const saved = await savedSession(home, id);
                        return saved?.committed && saved.progress?.outcome === "verified" && saved;
                    }, "committed verified delivery");
                    await writeFile(join(caseRoot, "delivery-result-session.json"), JSON.stringify(delivered, null, 2));
                } else {
                    await wait(
                        () =>
                            ssh(`test -e ${quote(scratch + "/publication-effect")} && echo ready || true`) === "ready",
                        "post-receive publication effect",
                        400_000,
                    );
                    await driver.showWorkflowStage(/Publication/, "visible publication stage");
                    const atCut = await savedSession(home, id);
                    ok(
                        atCut?.manifest.generation && atCut.progress?.outcome === "running",
                        "Publication cut has saved running progress and a prior checkpoint",
                    );
                    ok(!atCut.contents.includes('"outcome":"verified"'), "Cut precedes durable verified result");
                    equal(ssh(`wc -l < ${quote(scratch + "/push.log")}`), "1");
                    await writeFile(join(caseRoot, "cut-session.json"), JSON.stringify(atCut, null, 2));
                }
                equal(ssh(`git --git-dir=${quote(origin)} show plan/remote-delivery:sentinel.txt`), "remote delivered");
                await record("publication-observed", {
                    sentinel: "remote delivered",
                    destination: origin,
                    ref: "plan/remote-delivery",
                });
            }
            const rolled = await savedSession(home, id);
            ok(rolled);
            await writeFile(join(caseRoot, "pre-cut-session.json"), JSON.stringify(rolled, null, 2));
            ok(rolled.manifest.generation, "The execution successor has a prior committed generation");
            ok(
                rolled.manifest.segments.some((segment) => segment.kind === "execution"),
                "Production CLI must roll over to an execution successor",
            );
            ok(
                rolled.manifest.segments.some((segment) => segment.kind === "planning" && segment.sealedDigestHex),
                "Planning predecessor is sealed",
            );
            const successor = rolled.manifest.currentSegmentId;
            await record("rollover", {
                id,
                successor,
                manifest: rolled.path,
                kinds: rolled.manifest.segments.map((segment) => segment.kind),
            });
            owned = await driver.ownership();
            await record("cut", {
                stage:
                    journey === "delivery"
                        ? "completed-after-rollover"
                        : journey === "validation-cut"
                          ? "ci-running"
                          : "bare-ref-updated-push-not-returned",
            });
            const cut = await driver.stop(true);
            ok(cut);
            ssh(`touch ${quote(scratch + "/ci-release")} ${quote(scratch + "/publication-release")}`);
            await cleaned(driver, owned, sleeper);
            await record("cut-cleanup", {
                ...cut,
                cleanupSeconds: (Date.now() - cut.requestedAt) / 1000,
                unrelatedSleepSurvived: true,
            });
            driver = undefined;
            owned = undefined;
            if (journey === "publication-uncertain") {
                // External destination outage, not removal or editing of RunWield's evidence.
                // The real pushed commit remains intact and is restored after observation.
                ssh(`mv ${quote(origin)} ${quote(origin + ".unavailable")}`);
                originHidden = true;
            }
            const counts = () =>
                ssh(
                    `printf 'ci='; wc -l < ${quote(scratch + "/ci.log")}; printf 'push='; if test -e ${quote(scratch + "/push.log")}; then wc -l < ${quote(scratch + "/push.log")}; else echo 0; fi; git --git-dir=${quote(originHidden ? origin + ".unavailable" : origin)} show-ref`,
                );
            const before = counts();
            const pushAttempts = () =>
                ssh(
                    `if test -e ${quote(scratch + "/push-attempts.log")}; then wc -l < ${quote(scratch + "/push-attempts.log")}; else echo 0; fi`,
                );
            const attemptsBefore = pushAttempts();
            if (journey !== "validation-cut")
                equal(attemptsBefore, "1", "Publication clone inherited the external pre-push observer");
            const reconnect = join(caseRoot, "reconnect");
            await mkdir(reconnect);
            driver = await launch(archives, version, remote, home, reconnect);
            equal(driver.buildId, buildId);
            await driver.interactive();
            owned = await driver.ownership();
            const providerBefore = (await text(join(driver.root, "provider.jsonl"))).split("\n").filter(Boolean).length;
            await driver.send("/resume\n");
            await driver.shown(/Select a session to resume:/, "production resume selector");
            await driver.send("\n");
            await driver.shown(/Conversation restored|conversation restored|Session restored/, "restored conversation");
            const expected = journey === "delivery" || journey === "publication-proven" ? "verified" : "paused";
            await wait(async () => {
                const rendered = await driver!.render();
                const confirmed =
                    /Publication confirmed|Published commit confirmed|Session complete/.test(rendered.visible) ||
                    (/✓\s*Publication/.test(rendered.visible) && /✓\s*Completion/.test(rendered.visible));
                return (expected === "verified" ? confirmed : /uncertain/.test(rendered.visible)) && rendered.visible;
            }, "visible recovery outcome");
            const resumed = await savedSession(home, id);
            ok(resumed);
            equal(resumed.manifest.currentSegmentId, successor, "Resume keeps the execution successor");
            // Recovery is an in-memory projection. Do not call it separately or require it
            // to rewrite the transcript. The rendered CLI is the observed recovery result.
            await writeFile(join(caseRoot, "resumed-session.json"), JSON.stringify(resumed, null, 2));
            await delay(5000);
            equal(counts(), before, "Reconnect and /resume do not replay CI or publication");
            equal(pushAttempts(), attemptsBefore, "Resume does not repeat even an up-to-date push");
            equal(
                (await text(join(driver.root, "provider.jsonl"))).split("\n").filter(Boolean).length,
                providerBefore,
                "Resume does not call the provider",
            );
            equal(await text(join(driver.root, remote.split("/").at(-1)!, "sentinel.txt")), "laptop-only sentinel\n");
            await record("resume-observed", {
                id,
                successor,
                outcome: expected,
                counts: before,
                automaticReplay: false,
                pushAttempts: attemptsBefore,
            });
            owned = await driver.ownership();
            const exit = await driver.stop(false);
            ok(exit);
            await cleaned(driver, owned, sleeper);
            await record("exit-cleanup", {
                ...exit,
                cleanupSeconds: (Date.now() - exit.requestedAt) / 1000,
                unrelatedSleepSurvived: true,
            });
            driver = undefined;
            owned = undefined;
            await record("PASS", {
                scope: "production CLI observation and per-connection cleanup",
                deliveryCompleted: journey === "delivery",
                remoteScratchRetained: remote,
            });
        } catch (error) {
            failures++;
            await record("FAIL", {
                error: error instanceof Error ? error.stack || error.message : String(error),
                remote,
            });
        } finally {
            // Always release only our external gates before waiting for owned teardown.
            if (remote)
                ssh(
                    `touch ${quote(remote + "/qualification/ci-release")} ${quote(remote + "/qualification/publication-release")}`,
                );
            if (driver) {
                try {
                    owned ||= await driver.ownership();
                } catch (error) {
                    failures++;
                    await record("ownership-FAIL", { error: String(error) });
                }
                try {
                    await driver.stop(false);
                    if (owned) {
                        await cleaned(driver, owned, sleeper);
                        await record("failure-cleanup-confirmed", { unrelatedSleepSurvived: true });
                    }
                } catch (error) {
                    failures++;
                    await record("cleanup-FAIL", { error: String(error) });
                }
            }
            if (originHidden)
                ssh(`mv ${quote(remote + "-published.git.unavailable")} ${quote(remote + "-published.git")}`);
            if (sleeper) {
                equal(ssh(`ps -p ${sleeper} -o comm=`), "sleep");
                ssh(`kill ${sleeper}`);
            }
        }
    }
    console.log(JSON.stringify({ evidence, buildId, selected, failures, evidenceKind: "production-release-cli-pty" }));
    if (failures) process.exitCode = 1;
}
