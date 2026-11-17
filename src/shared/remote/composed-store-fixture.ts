import { mkdir, mkdtemp, writeFile, chmod, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { equal } from "node:assert/strict";
import { defineCommittedGitFixture, git } from "../git-test-fixture.ts";
import { startRemoteControlService } from "./control.ts";
import { getHomeDir } from "../../constants.js";
import { captureForegroundProcess } from "../captured-process.ts";
import type { RemoteInteractiveConfig } from "./entry.ts";

const repository = defineCommittedGitFixture({ "README.md": "Composed remote owner\n" });
export async function composedRemoteFixture() {
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
    const configuration = { bun: process.execPath, cli: new URL("../../cli.ts", import.meta.url).pathname, remoteHome };
    await writeFile(
        join(bin, "ssh"),
        `#!/usr/bin/env python3
import json, os, subprocess, sys
config = json.loads(${JSON.stringify(JSON.stringify(configuration))})
request = json.loads(sys.stdin.readline())
env = dict(os.environ, HOME=config['remoteHome'], WLD_TEST_SANDBOX_HOME=config['remoteHome'], MNEMOTECA_DB_PATH=os.path.join(config['remoteHome'], 'mnemoteca.db'))
key = 'transfer' if 'transfer' in request else 'proof' if 'proof' in request else 'admission'
flag = '--remote-runtime-transfer' if key == 'transfer' else '--remote-publication-proof' if key == 'proof' else '--remote-project-admission'
sys.exit(subprocess.run([config['bun'], config['cli'], flag], input=json.dumps(request[key]) + '\\n', text=True, env=env).returncode)
`,
    );
    await chmod(join(bin, "ssh"), 0o700);
    const previousPath = process.env.PATH;
    process.env.PATH = `${bin}:${previousPath}`;
    const build = { buildId: "a".repeat(64), protocol: 1 };
    const control = startRemoteControlService(build, undefined, undefined, "", {
        host: "fixture-host",
        cwd: root,
        remoteHome,
        executable: "/verified/runtime/wld",
    });
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
        input,
        endpoint,
        headers,
        runRaw,
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
