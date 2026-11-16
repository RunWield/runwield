import { createRemoteWorkspaceApp } from "../../ui/workspace/server.js";
import { serveHttp } from "../http-server.ts";
import { parseWorkRecordMarkdown } from "../work-records/markdown.js";
import { captureForegroundProcess } from "../captured-process.ts";
import { equal, ok, deepEqual, rejects } from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, chmod, readdir, stat, readFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { getHomeDir } from "../../constants.js";
import { withProcessGlobalTestLock } from "../../testing/process-global-lock.ts";
import { defineCommittedGitFixture, git } from "../git-test-fixture.ts";
import { startRemoteControlService } from "./control.ts";
import { ProjectStoreClient } from "./project-store-client.ts";
import type { ProjectStoreBinding } from "../../plan-store/index.ts";

const gitFixture = defineCommittedGitFixture({ "README.md": "Remote source\n" });

export async function qualifyManagedStoreActivation(
    remoteTarget: boolean,
    copyDocuments: boolean,
    recordParent: boolean,
): Promise<void> {
    await withProcessGlobalTestLock(async () => {
        const root = await realpath(await gitFixture.checkout());
        const temporary = await mkdtemp(join(tmpdir(), "managed-store-activation-"));
        const remoteHome = join(temporary, "remote-home");
        const bin = join(temporary, "bin");
        await mkdir(remoteHome);
        await mkdir(bin);
        if (remoteTarget) {
            const upstream = join(temporary, "upstream.git");
            await git(root, ["clone", "--bare", root, upstream]);
            await git(root, ["remote", "add", "origin", upstream]);
            await git(root, ["config", "branch.main.remote", "origin"]);
            await git(root, ["config", "branch.main.merge", "refs/heads/main"]);
        }
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
        const collaboration = createRemoteWorkspaceApp({ mode: "remote" });
        const collaborationServer = serveHttp(
            { hostname: "127.0.0.1", port: 0, onListen: () => {} },
            collaboration.handler(),
        );
        if (collaborationServer.addr.transport !== "tcp") throw new Error("Collaboration fixture requires TCP.");
        const collaborationUrl = `http://127.0.0.1:${collaborationServer.addr.port}`;
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
            equal((await readdir(remoteHome)).length, 0);
            equal(
                (
                    await fetch(`${endpoint}/project-store/admit`, {
                        method: "POST",
                        headers,
                        body: JSON.stringify({ cwd: "/another-target" }),
                    })
                ).status,
                400,
            );
            const mountedResources = join(temporary, "mounted-resources");
            await mkdir(mountedResources);
            const publicJourney = await captureForegroundProcess(process.execPath, {
                cwd: root,
                args: [new URL("./managed-store-client.ts", import.meta.url).pathname],
                env: {
                    ...process.env,
                    HOME: remoteHome,
                    WLD_TEST_SANDBOX_HOME: remoteHome,
                    MNEMOTECA_DB_PATH: join(remoteHome, "mnemoteca.db"),
                },
                stdinText:
                    JSON.stringify({
                        cwd: root,
                        copyDocuments,
                        recordParent,
                        collaborationUrl,
                        connection: { port: control.port, credential: control.credential },
                        resources: {
                            globalRoot: mountedResources,
                            personalOwner: { kind: "managed-remote", identity: getHomeDir() },
                        },
                    }) + "\n",
            });
            equal(publicJourney.code, 0, new TextDecoder().decode(publicJourney.stderr));
            const publicResult: {
                retainedRecordId: string;
                retainedPlanId: string;
                retainedAttemptId: string;
                retainedExecutionCwd: string;
                planId: string;
                attemptId: string;
                recordId: string;
                executionCwd: string;
                registryPath: string;
                legacyRuntime: string;
            } = JSON.parse(new TextDecoder().decode(publicJourney.stdout));
            ok(publicResult.planId);
            ok(publicResult.attemptId);
            ok(publicResult.executionCwd.startsWith(`${remoteHome}/.wld/`));
            await rejects(stat(publicResult.executionCwd), { code: "ENOENT" });
            equal(
                await git(remoteTarget ? join(temporary, "upstream.git") : root, ["show", "main:managed-code.txt"]),
                "delivered code",
            );
            ok(publicResult.registryPath.startsWith(`${remoteHome}/.wld/projects/`));
            ok((await stat(publicResult.registryPath)).isFile());
            await rejects(stat(join(root, ".wld", "internal")), { code: "ENOENT" });
            await rejects(stat(join(publicResult.legacyRuntime, "internal")), { code: "ENOENT" });
            const response = await fetch(`${endpoint}/project-store/admit`, { method: "POST", headers });
            equal(response.status, 200);
            const binding: ProjectStoreBinding = await response.json();
            const client = new ProjectStoreClient(endpoint, control.credential, binding);
            await rejects(stat(publicResult.retainedExecutionCwd), { code: "ENOENT" });
            equal(
                await git(remoteTarget ? join(temporary, "upstream.git") : root, ["show", "main:resumed-sentinel.txt"]),
                "Original execution resumed.",
            );
            const retained = (
                await client.execute({
                    kind: "read-retained-execution",
                    reference: publicResult.retainedPlanId,
                    attemptId: publicResult.retainedAttemptId,
                })
            ).result;
            ok("retainedExecution" in retained && retained.retainedExecution?.cleanupComplete);
            ok("retainedExecution" in retained && retained.retainedExecution?.controller.state.verifiedAt);

            if (recordParent) {
                const parentText = await git(remoteTarget ? join(temporary, "upstream.git") : root, [
                    "show",
                    "main:docs/plans/retained-parent.md",
                ]);
                ok(parentText.includes("status: user_verified") || parentText.includes('status: "user_verified"'));
                ok(parentText.includes("Accepted original parent."));
            }
            const retainedRecords = (await client.execute({ kind: "record-catalog" })).result;
            ok(
                "recordResources" in retainedRecords &&
                    retainedRecords.recordResources.some(
                        (record) =>
                            record.attrs.recordId === publicResult.retainedRecordId &&
                            record.attrs.status === "approved",
                    ),
            );
            ok(publicResult.recordId);
            const recorded = await client.execute({
                kind: "read-record",
                planId: publicResult.planId,
                recordId: publicResult.recordId,
            });
            ok("records" in recorded.result);
            equal(recorded.result.records.length, 1);
            equal(parseWorkRecordMarkdown(recorded.result.records[0].markdown).attrs.status, "approved");
            const matches = await client.execute({
                kind: "search-records",
                planId: publicResult.planId,
                query: "Managed delivery",
                limit: 10,
            });
            ok(
                "records" in matches.result &&
                    matches.result.records.some((record) => record.recordId === publicResult.recordId),
            );
            ok(
                (
                    await stat(
                        join(
                            getHomeDir(),
                            ".wld",
                            "projects",
                            binding.projectId,
                            "internal",
                            "work-records",
                            "index.sqlite3",
                        ),
                    )
                ).isFile(),
            );
            await rejects(stat(join(remoteHome, ".wld", "projects", binding.projectId, "work-records")), {
                code: "ENOENT",
            });
            await rejects(stat(join(remoteHome, ".wld", "projects", binding.projectId, "internal", "work-records")), {
                code: "ENOENT",
            });
            const planId = randomUUID();
            const authored = await client.execute({
                kind: "author-plan",
                operationId: randomUUID(),
                planId,
                input: {
                    planName: "managed",
                    contextMarkdown: "# Laptop Plan\n",
                    definition: { targetBranch: "main" },
                },
            });
            equal("status" in authored.result && authored.result.status, "completed");
            const listed = await client.execute({ kind: "list-plans" });
            ok("plans" in listed.result);
            equal(listed.result.plans.length, 9);
            ok(listed.result.plans.some((plan) => plan.attrs.planId === planId));
            for (const event of ["review_approved", "readiness_passed"] as const) {
                const document = await client.execute({ kind: "read", planId, resource: "context.md" });
                ok("revision" in document.result);
                await client.execute({
                    kind: "record-event",
                    event,
                    operationId: randomUUID(),
                    planId,
                    expectedRevision: document.result.revision!,
                });
            }
            const ready = await client.execute({ kind: "read", planId, resource: "context.md" });
            ok("revision" in ready.result);
            const reservation = {
                kind: "reserve-execution" as const,
                operationId: randomUUID(),
                planId,
                expectedRevision: ready.result.revision!,
                reservation: { targetBranch: "main" },
            };
            const reserved = await client.execute(reservation);
            ok("attemptId" in reserved.result && reserved.result.attemptId);
            deepEqual(await client.execute(reservation), reserved);
            const ownerPath = join(
                getHomeDir(),
                ".wld",
                "projects",
                binding.projectId,
                "plans",
                "managed",
                "context.md",
            );
            equal(await readFile(ownerPath, "utf8"), "# Laptop Plan\n");
            await rejects(stat(join(remoteHome, ".wld", "projects", binding.projectId, "plans")), {
                code: "ENOENT",
            });
        } finally {
            if (healthTimer) clearInterval(healthTimer);
            await control.close();
            await collaborationServer.shutdown();
            collaboration.adapter.close();
            if (previousPath === undefined) delete process.env.PATH;
            else process.env.PATH = previousPath;
        }
    });
}
