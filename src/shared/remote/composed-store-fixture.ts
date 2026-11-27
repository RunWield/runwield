import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { equal } from "node:assert/strict";
import { defineCommittedGitFixture, git } from "../git-test-fixture.ts";
import { startRemoteControlService } from "./control.ts";
import { getHomeDir } from "../../constants.ts";
import { captureForegroundProcess } from "@runwield/resources/process";
import type { RemoteInteractiveConfig } from "./entry.ts";
import { writeManagedStoreSshFixture } from "./managed-store-ssh-fixture.ts";

const repository = defineCommittedGitFixture({ "README.md": "Composed remote owner\n" });
export async function composedRemoteFixture(allowRecoveryFaults = false) {
    const root = await realpath(await repository.checkout());
    const temporary = await realpath(await mkdtemp(join(tmpdir(), "composed-remote-")));
    const remoteHome = join(temporary, "remote-home");
    const bin = join(temporary, "bin");
    const upstream = join(temporary, "upstream.git");
    await mkdir(remoteHome);
    await mkdir(bin);
    await git(root, ["clone", "--bare", root, upstream]);
    await git(root, ["remote", "add", "origin", upstream]);
    await git(root, ["config", "branch.main.remote", "origin"]);
    await git(root, ["config", "branch.main.merge", "refs/heads/main"]);
    const recoveryFaultPath = join(temporary, "recovery-fault.json");
    const disabledSshLogPath = join(temporary, "disabled-ssh.log");
    await writeManagedStoreSshFixture(bin, remoteHome, {
        disabledSshLogPath,
        recoveryFaultPath: allowRecoveryFaults ? recoveryFaultPath : undefined,
    });
    const previousPath = process.env.PATH;
    process.env.PATH = `${bin}:${previousPath}`;
    const build = { buildId: "a".repeat(64), protocol: 1 };
    const control = startRemoteControlService(
        build,
        {
            baseDir: join(temporary, "laptop-sessions"),
            targetLabel: `fixture-host:${root}`,
            target: {
                host: { hostname: "fixture-host", user: "developer", port: 22, hostKeyFingerprint: "SHA256:verified" },
                cwd: root,
                home: remoteHome,
                os: "Linux",
                arch: "x86_64",
                gitRoot: root,
                gitDir: join(root, ".git"),
                gitCommonDir: join(root, ".git"),
                primaryRoot: root,
                isWorktree: false,
            },
        },
        undefined,
        "",
        { host: "fixture-host", cwd: root, remoteHome, executable: "/verified/runtime/wld" },
    );
    const endpoint = `http://127.0.0.1:${control.port}`;
    const headers = { Authorization: `Bearer ${control.credential}` };
    for (const action of ["handshake", "readiness"])
        equal(
            (
                await fetch(`${endpoint}/${action}`, {
                    method: "POST",
                    headers,
                    body: action === "handshake" ? JSON.stringify(build) : undefined,
                })
            ).status,
            200,
        );
    const health = setInterval(() => {
        void fetch(`${endpoint}/health`, { method: "POST", headers }).catch(() => {});
    }, 1000);
    const mounted = join(temporary, "mounted");
    await mkdir(mounted);
    const input: Pick<RemoteInteractiveConfig, "cwd" | "resources" | "connection"> = {
        cwd: root,
        connection: { port: control.port, credential: control.credential },
        resources: { globalRoot: mounted, personalOwner: { kind: "managed-remote", identity: getHomeDir() } },
    };
    let stopped = false;
    async function disconnect() {
        if (stopped) return;
        stopped = true;
        clearInterval(health);
        await control.close();
    }
    async function runRaw(command: string, port = control.port, attemptId?: string) {
        return await captureForegroundProcess(process.execPath, {
            cwd: root,
            args: [
                new URL("./composed-store-process.ts", import.meta.url).pathname,
                command,
                JSON.stringify({ ...input, connection: { ...input.connection, port }, attemptId }),
            ],
            env: {
                ...process.env,
                HOME: remoteHome,
                WLD_TEST_SANDBOX_HOME: remoteHome,
                MNEMOTECA_DB_PATH: join(remoteHome, "mnemoteca.db"),
            },
        });
    }
    return {
        root,
        remoteHome,
        upstream,
        recoveryFaultPath,
        input,
        endpoint,
        headers,
        runRaw,
        async interruptRecreateAfterGitAdd() {
            const executable = Bun.which("git");
            if (!executable) throw new Error("Fixture requires Git.");
            const wrapper = join(bin, "git");
            const boundary = join(temporary, "interrupted-git-add.json");
            const configuration = { executable, boundary };
            await writeFile(
                wrapper,
                `#!/usr/bin/env python3
import json, os, signal, subprocess, sys
config = json.loads(${JSON.stringify(JSON.stringify(configuration))})
args = sys.argv[1:]
result = subprocess.run([config['executable'], *args])
if result.returncode == 0 and args[:3] == ['worktree', 'add', '-b']:
    with open(config['boundary'], 'w') as marker:
        json.dump({'branch': args[3], 'path': args[4], 'baseCommit': args[5]}, marker)
    os.kill(os.getppid(), signal.SIGKILL)
sys.exit(result.returncode)
`,
                { mode: 0o700 },
            );
            try {
                const interrupted = await runRaw("managed-recovery-recreate");
                const marker = await readFile(boundary, "utf8").catch((cause) => {
                    throw new Error(
                        `Recovery did not reach Git creation: ${new TextDecoder().decode(interrupted.stderr)}`,
                        {
                            cause,
                        },
                    );
                });
                const worktree: { branch: string; path: string; baseCommit: string } = JSON.parse(marker);
                return { interrupted, worktree };
            } finally {
                await rm(wrapper);
            }
        },
        async withoutSsh<Result>(run: () => Promise<Result>) {
            await writeFile(disabledSshLogPath, "");
            try {
                const result = await run();
                equal(await readFile(disabledSshLogPath, "utf8"), "", "Ordinary Plan read attempted SSH");
                return result;
            } finally {
                await rm(disabledSshLogPath);
            }
        },
        async run(command: string, port?: number, attemptId?: string) {
            const result = await runRaw(command, port, attemptId);
            equal(result.code, 0, new TextDecoder().decode(result.stderr));
            return new TextDecoder().decode(result.stdout).trim();
        },
        disconnect,
        async cleanup() {
            await disconnect();
            if (previousPath === undefined) delete process.env.PATH;
            else process.env.PATH = previousPath;
            await rm(root, { recursive: true, force: true });
            await rm(temporary, { recursive: true, force: true });
        },
    };
}
