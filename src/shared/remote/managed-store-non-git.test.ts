import { test } from "node:test";
import { equal, ok, rejects } from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, chmod, stat, realpath } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getHomeDir } from "../../constants.js";
import { withProcessGlobalTestLock } from "../../testing/process-global-lock.ts";
import { captureForegroundProcess } from "../captured-process.ts";
import { startRemoteControlService } from "./control.ts";
import type { ProjectStoreBinding } from "../../plan-store/index.ts";

for (const homeEntry of [false, true]) {
    test(`managed non-Git validation completes through its laptop owner (remote home ${homeEntry})`, async () => {
        await withProcessGlobalTestLock(async () => {
            const temporary = await realpath(await mkdtemp(join(tmpdir(), "managed-non-git-")));
            const remoteHome = join(temporary, "remote-home");
            const root = homeEntry ? remoteHome : join(temporary, "project");
            const bin = join(temporary, "bin");
            await Promise.all([mkdir(remoteHome), mkdir(bin), ...(homeEntry ? [] : [mkdir(root)])]);
            // Replace only OpenSSH transport. Its reply comes from the real remote private entry in another process.
            const configuration = {
                bun: process.execPath,
                cli: new URL("../../cli.ts", import.meta.url).pathname,
                remoteHome,
            };
            await writeFile(
                join(bin, "ssh"),
                `#!/usr/bin/env python3
import json, os, subprocess, sys
config = json.loads(${JSON.stringify(JSON.stringify(configuration))})
request = json.loads(sys.stdin.readline())
env = dict(os.environ, HOME=config['remoteHome'], WLD_TEST_SANDBOX_HOME=config['remoteHome'], MNEMOTECA_DB_PATH=os.path.join(config['remoteHome'], 'mnemoteca.db'))
key = 'transfer' if 'transfer' in request else 'proof' if 'proof' in request else 'admission'
flag = '--remote-runtime-transfer' if key == 'transfer' else '--remote-publication-proof' if key == 'proof' else '--remote-project-admission'
result = subprocess.run([config['bun'], config['cli'], flag], input=json.dumps(request[key]) + '\\n', text=True, env=env)
sys.exit(result.returncode)
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
            let healthTimer: ReturnType<typeof setInterval> | undefined;
            try {
                for (const action of ["handshake", "readiness"]) {
                    const response = await fetch(`${endpoint}/${action}`, {
                        method: "POST",
                        headers,
                        body: action === "handshake" ? JSON.stringify(build) : undefined,
                    });
                    equal(response.status, 200);
                }
                healthTimer = setInterval(() => {
                    void fetch(`${endpoint}/health`, { method: "POST", headers }).catch(() => {});
                }, 1000);
                const mountedResources = join(temporary, "mounted-resources");
                await mkdir(mountedResources);
                const result = await captureForegroundProcess(process.execPath, {
                    cwd: root,
                    args: [new URL("./managed-store-non-git-client.ts", import.meta.url).pathname],
                    env: {
                        ...process.env,
                        HOME: remoteHome,
                        WLD_TEST_SANDBOX_HOME: remoteHome,
                        MNEMOTECA_DB_PATH: join(remoteHome, "mnemoteca.db"),
                    },
                    stdinText:
                        JSON.stringify({
                            cwd: root,
                            connection: { port: control.port, credential: control.credential },
                            resources: {
                                globalRoot: mountedResources,
                                personalOwner: { kind: "managed-remote", identity: getHomeDir() },
                            },
                        }) + "\n",
                });
                equal(result.code, 0, new TextDecoder().decode(result.stderr));
                const completed: { planId: string; recordId: string } = JSON.parse(
                    new TextDecoder().decode(result.stdout),
                );
                ok(completed.planId);
                ok(completed.recordId);
                const admitted = await fetch(`${endpoint}/project-store/admit`, { method: "POST", headers });
                equal(admitted.status, 200);
                const binding: ProjectStoreBinding = await admitted.json();
                ok(
                    (
                        await stat(join(getHomeDir(), ".wld/projects", binding.projectId, "plans/in-place/context.md"))
                    ).isFile(),
                );
                for (const path of [
                    join(root, ".git"),
                    join(root, "docs/plans"),
                    join(remoteHome, ".wld/projects", binding.projectId, "plans"),
                    join(remoteHome, ".wld/projects", binding.projectId, "work-records"),
                ])
                    await rejects(stat(path), { code: "ENOENT" });
            } finally {
                if (healthTimer) clearInterval(healthTimer);
                await control.close();
                if (previousPath === undefined) delete process.env.PATH;
                else process.env.PATH = previousPath;
            }
        });
    });
}
