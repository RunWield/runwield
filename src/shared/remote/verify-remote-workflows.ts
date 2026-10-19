/**
 * Live, opt-in sct qualification: bun run src/shared/remote/verify-remote-workflows.ts [compiled-client]
 * Deploys matching source with owned Bun 1.4.3 by default. WLD_LIVE_SOURCE=0 selects standalone artifacts:
 * first the production CLI save check, then the scripted workflow client. WLD_LIVE_PRODUCTION_BINARY reuses a CLI build.
 * WLD_LIVE_REMOTE_ROOT reuses this script's owned scratch; WLD_LIVE_JOURNEYS selects comma-separated journeys.
 * Only synthetic model responses are scripted. Session ownership and all workflow machinery are production code.
 */
import { ok as assert, deepStrictEqual, equal } from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, readFile, chmod, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { compileBun } from "../../../scripts/compile-bun.ts";
import { getCwd } from "../../constants.js";
import { collectProcessOutput } from "../../testing/subprocess-output.ts";
import { spawnNativeProcess } from "../foreground-process.ts";
import { serveHttp } from "../http-server.ts";
import { withRuntimeCommandFixture } from "../../cmd/testing/runtime-command-fixture.ts";
import { openFileSessionStore } from "../session/file-session-store.ts";
import { startRemoteControlService } from "./control.ts";
import { RemoteSessionControl } from "./session-control-client.ts";
import { processLines } from "./remote-runtime-lines.ts";
import { customEntry, makeControlFixture } from "./session-save-test-fixture.ts";
import type { RuntimeClientCommand, RuntimeClientReport } from "./remote-runtime-test-client.ts";
import type { RuntimeFixture, RuntimeProcess } from "./remote-runtime-test-fixture.ts";
import { deliveryPlan, scriptReviewAndRecord, snapshotProjectTree } from "./remote-runtime-workflows-fixture.ts";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";

interface BuildMetadata {
    buildId: string;
}
async function main(): Promise<void> {
    const sourceRoot = getCwd();
    const evidenceRoot = await mkdtemp(join(tmpdir(), "wld-workflows-live-"));
    const evidence: string[] = [];
    type EvidenceValue = string | number | boolean | Record<string, string | number | boolean | string[]>;
    async function record(label: string, value: EvidenceValue) {
        const line = JSON.stringify({ at: new Date().toISOString(), label, value });
        evidence.push(line);
        await writeFile(join(evidenceRoot, "evidence.jsonl"), evidence.join("\n") + "\n");
        console.log(line);
    }
    function quote(text: string) {
        return `'${text.replaceAll("'", "'\\''")}'`;
    }
    async function within<T>(promise: Promise<T>, ms = 180000): Promise<T> {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            return await Promise.race([
                promise,
                new Promise<never>((_, reject) => {
                    timer = setTimeout(() => reject(new Error("Live qualification timeout")), ms);
                }),
            ]);
        } finally {
            clearTimeout(timer);
        }
    }
    async function command(executable: string, args: string[], input?: string) {
        const child = spawnNativeProcess(executable, {
            cwd: sourceRoot,
            args,
            stdin: input === undefined ? "null" : "piped",
            stdout: "piped",
            stderr: "piped",
        });
        try {
            if (input !== undefined) {
                const writer = child.stdin.getWriter();
                try {
                    await writer.write(new TextEncoder().encode(input));
                    await writer.close();
                } finally {
                    writer.releaseLock();
                }
            }
            const result = await within(collectProcessOutput(child), 300000);
            const stdout = new TextDecoder().decode(result.stdout);
            const stderr = new TextDecoder().decode(result.stderr);
            equal(result.code, 0, `${executable}: ${stderr}\n${stdout}`);
            return stdout;
        } finally {
            try {
                child.kill("SIGKILL");
            } catch {
                // The child can exit before cleanup sends its signal.
            }
            await child.status;
        }
    }
    const ssh = (shell: string) =>
        command("/usr/bin/ssh", ["-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "sct", shell]);
    const remoteJs = (code: string) => ssh(`/usr/bin/node --input-type=module -e ${quote(code)}`);
    const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
    async function freePort(remote = false) {
        if (remote)
            return Number(
                (
                    await remoteJs(
                        'const {createServer}=await import("node:net"); const s=createServer(); s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})',
                    )
                ).trim(),
            );
        const { createServer } = await import("node:net");
        const server = createServer();
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const address = server.address();
        assert(address && typeof address !== "string");
        await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
        return address.port;
    }
    async function startForward(args: string[]) {
        const child = spawnNativeProcess("/usr/bin/ssh", {
            cwd: sourceRoot,
            args: ["-N", "-T", "-o", "BatchMode=yes", "-o", "ExitOnForwardFailure=yes", ...args, "sct"],
            stdin: "null",
            stdout: "piped",
            stderr: "piped",
        });
        const output = collectProcessOutput(child);
        await delay(400);
        return {
            child,
            async close() {
                try {
                    child.kill("SIGTERM");
                } catch {
                    // The child can exit before cleanup sends its signal.
                }
                await within(output, 10000);
            },
        };
    }
    let remoteRoot = "";
    const sourceDeployment = process.env.WLD_LIVE_SOURCE !== "0";
    const binary = process.argv[2] || join(evidenceRoot, "client-linux-x64");
    try {
        await record("evidence-root", evidenceRoot);
        await record("runtime", {
            localBun: process.versions.bun || "",
            remote: (await ssh("uname -sm; /usr/bin/node --version; command -v sshfs; command -v git")).trim(),
        });
        if (!process.argv[2])
            await compileBun(
                binary,
                "bun-linux-x64",
                undefined,
                undefined,
                "src/shared/remote/remote-runtime-test-client.ts",
            );
        const hash = createHash("sha256")
            .update(await readFile(binary))
            .digest("hex");
        const metadata: BuildMetadata = JSON.parse(await readFile(`${binary}.build.json`, "utf8"));
        await record("compiled-current-runtime", { binary, sha256: hash, buildId: metadata.buildId });
        const remoteUser = (await ssh("id -un")).trim();
        const remoteHostKey = (await ssh("ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub")).trim().split(/\s/)[1];
        assert(remoteHostKey?.startsWith("SHA256:"));
        remoteRoot =
            process.env.WLD_LIVE_REMOTE_ROOT ||
            (await ssh("umask 077; mktemp -d /tmp/wld-workflows-live-XXXXXXXXXX")).trim();
        assert(/^\/tmp\/wld-workflows-live-[a-zA-Z0-9]+$/.test(remoteRoot));
        await record("owned-remote-root", remoteRoot);
        await chmod(binary, 0o700);
        await command("/usr/bin/rsync", ["-az", binary, `sct:${remoteRoot}/client`]);
        equal((await ssh(`sha256sum ${quote(remoteRoot + "/client")}`)).split(/\s/)[0], hash);
        if (!sourceDeployment) {
            const productionBinary = process.env.WLD_LIVE_PRODUCTION_BINARY || join(evidenceRoot, "wld-linux-x64");
            if (!process.env.WLD_LIVE_PRODUCTION_BINARY) await compileBun(productionBinary, "bun-linux-x64");
            const productionHash = createHash("sha256")
                .update(await readFile(productionBinary))
                .digest("hex");
            await chmod(productionBinary, 0o700);
            await command("/usr/bin/rsync", ["-az", productionBinary, `sct:${remoteRoot}/production-client`]);
            equal((await ssh(`sha256sum ${quote(remoteRoot + "/production-client")}`)).split(/\s/)[0], productionHash);
            const fixture = await makeControlFixture();
            let forward: Awaited<ReturnType<typeof startForward>> | undefined;
            try {
                await fixture.ready();
                const port = await freePort(true);
                forward = await startForward(["-R", `127.0.0.1:${port}:127.0.0.1:${fixture.control.port}`]);
                const home = `${remoteRoot}/production-home`;
                await ssh(`mkdir -p ${quote(home)}`);
                const contents = customEntry();
                const stdout = await command(
                    "/usr/bin/ssh",
                    [
                        "-T",
                        "-o",
                        "BatchMode=yes",
                        "sct",
                        `cd ${quote(remoteRoot)} && exec env -i HOME=${quote(home)} USERPROFILE=${quote(home)} TMPDIR=${quote(home)} PATH=/usr/local/bin:/usr/bin:/bin MNEMOTECA_DB_PATH=${quote(home + "/memory.db")} WLD_INTERNAL_PACKAGE_CHECK=1 ${quote(remoteRoot + "/production-client")} package-smoke remote-session-save`,
                    ],
                    JSON.stringify({
                        connection: {
                            baseUrl: `http://127.0.0.1:${port}`,
                            credential: fixture.control.credential,
                            operation: fixture.owner.operation,
                            timeoutMs: 5000,
                        },
                        contents,
                    }),
                );
                equal(fixture.owner.inspect().contents, fixture.initial + contents);
                equal(
                    fixture.store.inspectSessionActivation(fixture.session.runwieldSessionId).generation?.generation,
                    0,
                );
                await record("compiled-production-cli-save", {
                    binary: productionBinary,
                    sha256: productionHash,
                    stdout: stdout.trim(),
                    checkpointed: true,
                });
            } finally {
                await forward?.close();
                await fixture.close();
            }
        }
        // A pinned helper runtime is installed only inside the owned scratch tree.
        await ssh(
            `cd ${quote(remoteRoot)} && if [ ! -x bun-linux-x64/bun ]; then curl --fail --location --silent --show-error https://github.com/oven-sh/bun/releases/download/bun-v1.4.3/bun-linux-x64.zip -o bun.zip && unzip -q bun.zip; fi; ./bun-linux-x64/bun --version`,
        );
        await record("remote-pinned-bun", (await ssh(`${quote(remoteRoot + "/bun-linux-x64/bun")} --version`)).trim());
        if (sourceDeployment) {
            await command("/usr/bin/rsync", [
                "-az",
                "--checksum",
                "--exclude=.git",
                "--exclude=.ci-cache",
                "--exclude=docs-site",
                "--exclude=.wld",
                `${sourceRoot}/src`,
                `${sourceRoot}/scripts`,
                `${sourceRoot}/node_modules`,
                `${sourceRoot}/package.json`,
                `${sourceRoot}/runtime-root.js`,
                `${sourceRoot}/brand`,
                `${sourceRoot}/third_party`,
                `${sourceRoot}/tsconfig.json`,
                `sct:${remoteRoot}/source/`,
            ]);
            await record(
                "source-deployment",
                "Matching source and dependencies copied with checksums; remote runtime is owned Bun 1.4.3",
            );
        }
        for (const journey of ["delivery", "validation-cut", "publication-proven", "publication-uncertain"].filter(
            (name) => !process.env.WLD_LIVE_JOURNEYS || process.env.WLD_LIVE_JOURNEYS.split(",").includes(name),
        )) {
            await withRuntimeCommandFixture("live-workflow-owner-", async (local) => {
                const root = `${remoteRoot}/${journey}`;
                const project = `${root}/project`;
                const home = `${root}/home`;
                const resources = `${root}/resources`;
                const commandLog = `${home}/git-commands.log`;
                const upstream = `${root}/published.git`;
                await remoteJs(
                    `const {mkdir,writeFile,chmod,rm}=await import("node:fs/promises"); const root=${JSON.stringify(root)};await rm(root,{recursive:true,force:true}); for(const name of ["project/.wld","home/tmp","home/.wld","resources/agents","bin"])await mkdir(root+"/"+name,{recursive:true}); await writeFile(root+"/project/sentinel.txt",${JSON.stringify("remote initial\n")}); await writeFile(root+"/project/.gitignore",${JSON.stringify(".wld/\n")}); await writeFile(root+"/home/.wld/settings.json","remote profile must not be read"); await writeFile(root+"/bin/git",${JSON.stringify(`#!/bin/sh\nprintf '%s\\n' "$*" >> '${commandLog}'\nexec /usr/bin/git "$@"\n`)});await chmod(root+"/bin/git",448);`,
                );
                const git = (args: string[], cwd = project) =>
                    ssh(`cd ${quote(cwd)} && /usr/bin/git ${args.map(quote).join(" ")}`).then((s) => s.trim());
                await git(["init", "-b", "main"]);
                await git(["config", "user.name", "RunWield live fixture"]);
                await git(["config", "user.email", "fixture@localhost"]);
                await git(["add", "."]);
                await git(["commit", "-m", "Owned remote fixture"]);
                await git(["init", "--bare", upstream]);
                await git(["remote", "add", "origin", upstream]);
                await git(["push", "-u", "origin", "main"]);
                async function writeRemote(path: string, content: string) {
                    await remoteJs(
                        `await (await import("node:fs/promises")).writeFile(${JSON.stringify(path)},${JSON.stringify(content)})`,
                    );
                }
                async function readRemote(path: string) {
                    return await remoteJs(
                        `process.stdout.write(await (await import("node:fs/promises")).readFile(${JSON.stringify(path)},"utf8"))`,
                    );
                }
                const ciCommand = `printf 'ci\\n' >> '${home}/ci.log'`;
                await writeRemote(
                    `${project}/.wld/settings.json`,
                    JSON.stringify({
                        verification_command:
                            journey === "validation-cut"
                                ? `${ciCommand}; touch '${home}/ci-started'; while [ ! -e '${home}/ci-release' ]; do sleep 0.05; done; touch '${home}/ci-finished'`
                                : ciCommand,
                        codereview: "none",
                    }),
                );
                await command("/usr/bin/scp", [local.settingsPath, `sct:${resources}/settings.json`]);
                await writeRemote(
                    `${resources}/agents/remote-runtime.md`,
                    "---\nname: Remote Runtime\ndescription: Live remote delivery\ntools:\n    - read\n    - write\n    - delegate_agent\n    - background_task\n---\nUse project tools when asked, then answer.\n",
                );
                await writeFile(join(local.projectRoot, "sentinel.txt"), "laptop initial\n");
                await mkdir(join(local.projectRoot, "nested"));
                await writeFile(join(local.projectRoot, "nested/protected.txt"), "all laptop bytes protected\n");
                const laptopBefore = await snapshotProjectTree(local.projectRoot);
                const store = openFileSessionStore({ baseDir: join(local.homeDir, "laptop-history") });
                const identity = { buildId: metadata.buildId, protocol: 1 };
                const target = {
                    baseDir: store.path,
                    targetLabel: `sct:${project}`,
                    target: {
                        host: {
                            hostname: "sct",
                            user: remoteUser,
                            port: 22,
                            hostKeyFingerprint: remoteHostKey,
                        },
                        cwd: project,
                        home,
                        os: "Linux",
                        arch: "x86_64",
                        gitRoot: project,
                        gitDir: `${project}/.git`,
                        gitCommonDir: `${project}/.git`,
                        primaryRoot: project,
                        isWorktree: false,
                    },
                };
                let service = startRemoteControlService(identity, target);
                let publicationCut = false;
                let cutReached = false;
                let modelRequests = 0;
                let tunnel: Awaited<ReturnType<typeof startForward>> | undefined;
                const proxy = serveHttp({ hostname: "127.0.0.1", port: 0, onListen() {} }, async (request) => {
                    const path = new URL(request.url).pathname;
                    const body = request.method === "POST" ? await request.text() : undefined;
                    if (path === "/models/stream") modelRequests++;
                    if (path.startsWith("/session/")) {
                        const input = body ? JSON.parse(body) : {};
                        await appendFile(
                            join(evidenceRoot, `${journey}-bridge.jsonl`),
                            JSON.stringify({
                                at: new Date().toISOString(),
                                path,
                                kind: input.kind,
                                sequence: input.sequence,
                            }) + "\n",
                        );
                    }
                    if (publicationCut && path === "/session/request" && body) {
                        const input = JSON.parse(body);
                        if (input.kind === "append" && input.contents.includes('"outcome":"verified"')) {
                            // Cut the actual SSH transport before the result reaches the laptop owner.
                            await tunnel?.close();
                            tunnel = undefined;
                            cutReached = true;
                            return new Response("Transport cut before durable publication result", { status: 503 });
                        }
                    }
                    return await fetch(`http://127.0.0.1:${service.port}${path}`, {
                        method: request.method,
                        headers: request.headers,
                        body,
                    });
                });
                assert(proxy.addr.transport === "tcp");
                const remotePort = await freePort(true);
                const connection = { port: remotePort, credential: service.credential };
                const localConnection = { port: proxy.addr.port, credential: service.credential };
                const clients: RuntimeProcess[] = [];
                const heartbeat = setInterval(() => {
                    void fetch(`http://127.0.0.1:${service.port}/health`, {
                        method: "POST",
                        headers: { Authorization: `Bearer ${service.credential}` },
                    }).catch(() => {});
                }, 1000);
                async function ready() {
                    for (const [path, body] of [
                        ["handshake", JSON.stringify(identity)],
                        ["readiness", ""],
                    ]) {
                        const reply = await fetch(`http://127.0.0.1:${service.port}/${path}`, {
                            method: "POST",
                            headers: { Authorization: `Bearer ${service.credential}` },
                            body,
                        });
                        equal(reply.status, 200, await reply.text());
                    }
                    tunnel = await startForward(["-R", `127.0.0.1:${remotePort}:127.0.0.1:${localConnection.port}`]);
                    equal(
                        (
                            await ssh(`curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:${remotePort}/readiness`)
                        ).trim(),
                        "401",
                    );
                }
                async function start(): Promise<RuntimeProcess> {
                    if (service.status().closed) {
                        service = startRemoteControlService(identity, target);
                        connection.credential = localConnection.credential = service.credential;
                    }
                    if (!tunnel) await ready();
                    const pidPath = `${root}/client-${clients.length}.pid`;
                    const shell = `cd ${quote(project)} && echo $$ > ${quote(pidPath)} && exec env -i HOME=${quote(home)} WLD_TEST_SANDBOX_HOME=${quote(home)} TMPDIR=${quote(home + "/tmp")} MNEMOTECA_DB_PATH=${quote(home + "/memory.db")} PATH=${quote(root + "/bin:" + remoteRoot + "/bun-linux-x64:/usr/local/bin:/usr/bin:/bin")} ${sourceDeployment ? quote(remoteRoot + "/bun-linux-x64/bun") + " run --tsconfig-override " + quote(remoteRoot + "/source/tsconfig.json") + " " + quote(remoteRoot + "/source/src/shared/remote/remote-runtime-test-client.ts") : quote(remoteRoot + "/client")}`;
                    const child = spawnNativeProcess("/usr/bin/ssh", {
                        cwd: sourceRoot,
                        args: ["-T", "-o", "BatchMode=yes", "sct", shell],
                        stdin: "piped",
                        stdout: "piped",
                        stderr: "piped",
                    });
                    const writer = child.stdin.getWriter();
                    const reader = processLines(child.stdout);
                    const stderr = new Response(child.stderr).text();
                    let stopped = false;
                    const send = async (value: RuntimeClientCommand) => {
                        await writer.write(new TextEncoder().encode(JSON.stringify(value) + "\n"));
                    };
                    await writer.write(
                        new TextEncoder().encode(
                            JSON.stringify({
                                connection,
                                resources,
                                memoryCollection: "live-remote-workflows",
                                cwd: project,
                            }) + "\n",
                        ),
                    );
                    const client: RuntimeProcess = {
                        send,
                        async read() {
                            const next = await within(reader.read());
                            if (next.done) throw new Error(`Live Core exited: ${await stderr}`);
                            try {
                                const report: RuntimeClientReport = JSON.parse(next.value);
                                await writeFile(
                                    join(evidenceRoot, `${journey}-reports.jsonl`),
                                    (await readFile(join(evidenceRoot, `${journey}-reports.jsonl`), "utf8").catch(
                                        () => "",
                                    )) +
                                        next.value +
                                        "\n",
                                );
                                return report;
                            } catch (error) {
                                throw new Error(`Core output: ${next.value}`, { cause: error });
                            }
                        },
                        async terminate() {
                            if (stopped) return;
                            stopped = true;
                            await remoteJs(
                                `const fs=await import("node:fs/promises");try{const pid=Number((await fs.readFile(${JSON.stringify(pidPath)},"utf8")).trim());if(await fs.readlink("/proc/"+pid+"/exe")===${JSON.stringify(remoteRoot + (sourceDeployment ? "/bun-linux-x64/bun" : "/client"))})process.kill(pid,"SIGKILL")}catch(e){if(!["ENOENT","ESRCH"].includes(e.code))throw e}`,
                            );
                            try {
                                child.kill("SIGKILL");
                            } catch {
                                // The child can exit before cleanup sends its signal.
                            }
                            await child.status;
                            await reader.cancel().catch(() => {});
                            await writer.abort().catch(() => {});
                            await writeFile(join(evidenceRoot, `${journey}-stderr.txt`), await stderr);
                        },
                        async close() {
                            if (stopped) return;
                            await send({ kind: "close" });
                            await writer.close();
                            const result = await within(child.status, 20000);
                            stopped = true;
                            equal(result.code, 0, await stderr);
                            await reader.cancel().catch(() => {});
                        },
                    };
                    clients.push(client);
                    return client;
                }
                const f: RuntimeFixture = {
                    ...local,
                    remoteProject: project,
                    remoteHome: home,
                    remoteCommandLog: commandLog,
                    resources,
                    connection,
                    memoryCollection: "live-remote-workflows",
                    memoryRequests: [],
                    store,
                    control: new RemoteSessionControl(localConnection),
                    controls: [],
                    saves: [],
                    modelRequests: [],
                    mcpTraffic: [],
                    policy: {},
                    start,
                    async dropConnection() {
                        await tunnel?.close();
                        tunnel = undefined;
                        await service.close();
                    },
                };
                async function result(client: RuntimeProcess) {
                    let report = await client.read();
                    while (report.kind === "workflow-interaction") report = await client.read();
                    return report;
                }
                async function waitRemote(path: string) {
                    await within(
                        (async () => {
                            while (
                                (
                                    await remoteJs(
                                        `console.log(await (await import("node:fs/promises")).stat(${JSON.stringify(path)}).then(()=>true,()=>false))`,
                                    )
                                ).trim() !== "true"
                            )
                                await delay(100);
                        })(),
                    );
                }
                async function counts() {
                    return {
                        ci: (await readRemote(`${home}/ci.log`).catch(() => "")).trim().split("\n").filter(Boolean)
                            .length,
                        pushes: (await readRemote(commandLog).catch(() => ""))
                            .split("\n")
                            .filter((line) => line.startsWith("push ")).length,
                        models: modelRequests,
                        refs: await git(["show-ref"], upstream),
                    };
                }
                let hiddenEvidence: string[] = [];
                let savedSessionId: string | undefined;
                try {
                    let client = await start();
                    equal((await client.read()).kind, "ready");
                    local.setModelMessages([
                        fauxAssistantMessage(
                            fauxToolCall("write", { path: "docs/plans/remote-delivery.md", content: deliveryPlan }),
                        ),
                        fauxAssistantMessage(
                            fauxToolCall("plan_written", {
                                planName: "remote-delivery",
                                executionAgent: "engineer",
                                collaborationRecommendation: "autonomous",
                            }),
                        ),
                        fauxAssistantMessage(fauxText("Plan approved for remote execution.")),
                    ]);
                    await client.send({ kind: "workflow-plan" });
                    const review = await client.read();
                    equal(review.kind, "review-ready", JSON.stringify(review));
                    assert(review.reviewUrl);
                    const remoteReview = new URL(review.reviewUrl);
                    const token = remoteReview.searchParams.get("token");
                    assert(token);
                    const localPort = await freePort();
                    const reviewForward = await startForward([
                        "-L",
                        `127.0.0.1:${localPort}:127.0.0.1:${remoteReview.port}`,
                    ]);
                    await record(`${journey}:manual-review-forward`, {
                        command: `ssh -N -T -o BatchMode=yes -o ExitOnForwardFailure=yes -L 127.0.0.1:${localPort}:127.0.0.1:${remoteReview.port} sct`,
                        remoteReviewOrigin: remoteReview.origin,
                    });
                    try {
                        const response = await fetch(
                            `http://127.0.0.1:${localPort}/api/review/decision?token=${token}`,
                            {
                                method: "POST",
                                headers: { "content-type": "application/json", "x-runwield-review-token": token },
                                body: JSON.stringify({
                                    approved: true,
                                    approvalAction: "later",
                                    executionAgent: "engineer",
                                    collaborationRecommendation: "autonomous",
                                }),
                            },
                        );
                        equal(response.status, 200, await response.text());
                    } finally {
                        await reviewForward.close();
                    }
                    const planned = await client.read();
                    equal(planned.ok, true, planned.error || "");
                    assert(planned.savedId);
                    const id = planned.savedId;
                    savedSessionId = id;
                    equal(store.listSessionArtifacts(id)[0]?.kind, "plan");
                    equal(store.listSessionPlanAssociations(id)[0]?.planId, "remote-delivery-plan");
                    local.setModelMessages([
                        fauxAssistantMessage(
                            fauxToolCall("write", { path: "sentinel.txt", content: "remote implemented\n" }),
                        ),
                        fauxAssistantMessage(
                            fauxToolCall("task_completed", { message: "Implemented the remote change." }),
                        ),
                    ]);
                    await client.send({ kind: "workflow-execute" });
                    const execution = await result(client);
                    equal(execution.result?.executionComplete, true, JSON.stringify(execution));
                    const executionCwd = execution.result?.executionContext?.executionCwd;
                    assert(executionCwd);
                    assert(executionCwd.startsWith(home));
                    assert(executionCwd !== project);
                    await record(`${journey}:isolated-execution`, { id, project, executionCwd });
                    // Every journey disconnects after rollover and resumes through the production /resume command.
                    const segments = store.listSessionTranscriptSegments(id);
                    deepStrictEqual(
                        segments.map((s) => s.kind),
                        ["planning", "execution"],
                    );
                    await f.dropConnection();
                    await client.terminate();
                    client = await start();
                    await client.read();
                    await client.send({ kind: "resume-command", sessionId: id });
                    const resumed = await client.read();
                    equal(resumed.ok, true, resumed.error || "");
                    equal(resumed.savedId, id);
                    await client.send({ kind: "reload" });
                    const reloaded = await client.read();
                    equal(reloaded.ok, true, reloaded.error || "");
                    equal(reloaded.piSessionId, segments.at(-1)?.piSessionId);
                    await record(`${journey}:successor-resume`, {
                        id,
                        successor: reloaded.piSessionId || "",
                        lineage: segments.map((s) => s.kind),
                    });
                    const script = scriptReviewAndRecord(f, journey === "delivery");
                    if (journey.startsWith("publication")) publicationCut = true;
                    await client.send({ kind: "workflow-validate" });
                    if (journey === "validation-cut") {
                        await waitRemote(`${home}/ci-started`);
                        const saved = await readFile(store.getCurrentSessionSegment(id)!.transcriptPath, "utf8");
                        assert(saved.includes('"ci":"running"'));
                        assert(!saved.includes('"ci":"passed"'));
                        await f.dropConnection();
                        await client.terminate();
                        await writeRemote(`${home}/ci-release`, "release");
                        await waitRemote(`${home}/ci-finished`);
                    } else if (journey.startsWith("publication")) {
                        await within(
                            (async () => {
                                while (!cutReached) await delay(50);
                            })(),
                        );
                        await service.close();
                        await client.terminate();
                        publicationCut = false;
                        const saved = await readFile(store.getCurrentSessionSegment(id)!.transcriptPath, "utf8");
                        assert(!saved.includes('"outcome":"verified"'));
                        equal((await counts()).pushes, 1, "Publication must precede the missing result save");
                        if (journey === "publication-uncertain") {
                            hiddenEvidence = JSON.parse(
                                await remoteJs(
                                    `const fs=await import("node:fs/promises");const root=${JSON.stringify(home + "/project-runtime")};const paths=[${JSON.stringify(project + "/docs/plans/remote-delivery.md")}];async function walk(p){for(const e of await fs.readdir(p,{withFileTypes:true})){const f=p+"/"+e.name;if(e.isDirectory())await walk(f);else if(f.endsWith("worktrees.json")||f.includes("/controller/plans/"))paths.push(f)}}await walk(root);for(let i=0;i<paths.length;i++)await fs.rename(paths[i],${JSON.stringify(home)}+"/hidden-"+i);console.log(JSON.stringify(paths));`,
                                ),
                            );
                        }
                    } else {
                        const validated = await result(client);
                        equal(validated.result?.kind, "verified", JSON.stringify(validated));
                        equal(script.reviews(), 2);
                        equal(script.recordings(), 1);
                        equal(script.checklists(), 1);
                        equal((await counts()).ci, 2);
                        equal((await counts()).pushes, 1);
                    }
                    if (journey !== "delivery") {
                        const before = await counts();
                        client = await start();
                        await client.read();
                        await client.send({ kind: "resume-command", sessionId: id });
                        const loaded = await client.read();
                        equal(loaded.ok, true, loaded.error || "");
                        equal(
                            loaded.workflowContext?.validationProgress?.outcome,
                            journey === "publication-proven" ? "verified" : "paused",
                            JSON.stringify(loaded),
                        );
                        if (journey !== "publication-proven")
                            assert(
                                loaded.workflowContext?.validationProgress?.message?.includes("uncertain"),
                                JSON.stringify(loaded),
                            );
                        deepStrictEqual(
                            await counts(),
                            before,
                            "Reconnect must not replay CI, model calls, or publication",
                        );
                        await record(`${journey}:no-automatic-replay`, {
                            outcome: loaded.workflowContext?.validationProgress?.outcome || "",
                            ci: before.ci,
                            pushes: before.pushes,
                            models: before.models,
                            refs: before.refs,
                        });
                        // Explicit user choice: retry validation, or finish/confirm the publication from restored evidence.
                        if (hiddenEvidence.length)
                            await remoteJs(
                                `const fs=await import("node:fs/promises");const paths=${JSON.stringify(hiddenEvidence)};for(let i=0;i<paths.length;i++)await fs.rename(${JSON.stringify(home)}+"/hidden-"+i,paths[i]);`,
                            );
                        if (journey === "validation-cut") {
                            await client.send({ kind: "workflow-validate" });
                            const chosen = await result(client);
                            equal(chosen.result?.kind, "verified", JSON.stringify(chosen));
                            equal((await counts()).ci, 2, "One interrupted CI and one user-selected retry");
                        } else {
                            // User selects a read-only recheck, not another validation of an already delivered Plan.
                            await client.send({ kind: "reload" });
                            const checked = await client.read();
                            equal(checked.ok, true, checked.error || "");
                            equal(
                                checked.workflowContext?.validationProgress?.outcome,
                                "verified",
                                JSON.stringify(checked),
                            );
                            deepStrictEqual(
                                await counts(),
                                before,
                                "Recheck must retain the proven publication without replay",
                            );
                            local.setModelMessages([
                                fauxAssistantMessage(
                                    fauxText(
                                        "Confirmed the recovered publication. No validation, review, repair, Recorder, merge, or push was repeated.",
                                    ),
                                ),
                            ]);
                            await client.send({
                                kind: "turn",
                                text: "Confirm the recovered publication. Do not repeat validation, review, repair, Recorder, merge, or push.",
                            });
                            const confirmed = await client.read();
                            equal(confirmed.ok, true, JSON.stringify(confirmed));
                            deepStrictEqual(
                                await counts(),
                                { ...before, models: before.models + 1 },
                                "Only the user's confirmation turn may run",
                            );
                        }
                        equal((await counts()).pushes, 1, "Exactly one publication after explicit user choice");
                        equal(script.reviews(), 1);
                        equal(script.recordings(), 1);
                        equal(script.checklists(), 1);
                        await record(`${journey}:explicit-user-choice`, {
                            result: "verified",
                            ci: (await counts()).ci,
                            pushes: (await counts()).pushes,
                        });
                    }
                    const branch = execution.result?.executionContext?.triageMeta?.deliveryBranch || "main";
                    const delivered = await git(["show", `${branch}:sentinel.txt`], upstream);
                    equal(delivered, journey === "delivery" ? "remote delivered" : "remote implemented");
                    assert(
                        (await git(["ls-tree", "-r", "--name-only", branch], upstream)).includes("docs/work-records/"),
                    );
                    const saved = (await f.control.list(id))[0].contents || "";
                    await writeFile(join(evidenceRoot, `${journey}-saved-session.txt`), saved);
                    if (!journey.startsWith("publication")) {
                        assert(saved.includes('"label":"Work Record","outcome":"Created"'));
                        assert(saved.includes('"label":"AI Code Review","outcome":"Passed"'));
                    } else {
                        assert(saved.includes("Confirmed the recovered publication."));
                        assert(saved.includes('"semanticReview":"passed"'));
                    }
                    await client.close();
                    deepStrictEqual(
                        await snapshotProjectTree(local.projectRoot),
                        laptopBefore,
                        "The whole laptop project tree must be unchanged, without exclusions",
                    );
                    const remoteStorage = await remoteJs(
                        `const fs=await import("node:fs/promises");const found=[];async function walk(p){for(const e of await fs.readdir(p,{withFileTypes:true})){if(e.name===".git")continue;const f=p+"/"+e.name;if(e.isDirectory()){if(e.name==="sessions"||e.name==="session-store")found.push(f);await walk(f)}else if(e.name.endsWith(".jsonl"))found.push(f)}}await walk(${JSON.stringify(home)});await walk(${JSON.stringify(project)});console.log(JSON.stringify(found))`,
                    );
                    equal(remoteStorage.trim(), "[]");
                    await record(`${journey}:PASS`, {
                        id,
                        segments: store.listSessionTranscriptSegments(id).map((s) => s.kind),
                        wholeLaptopTreeUnchanged: true,
                        noRemoteSessionStorage: true,
                        ci: (await counts()).ci,
                        pushes: (await counts()).pushes,
                        modelRequests,
                    });
                } finally {
                    clearInterval(heartbeat);
                    await writeRemote(`${home}/ci-release`, "cleanup release").catch(() => {});
                    for (const client of clients) await client.terminate().catch(() => {});
                    await tunnel?.close();
                    await proxy.shutdown();
                    await service.close();
                    if (savedSessionId) {
                        const segments = store.listSessionTranscriptSegments(savedSessionId);
                        await writeFile(
                            join(evidenceRoot, `${journey}-segments.json`),
                            JSON.stringify(segments, null, 2),
                        );
                        for (const segment of segments)
                            await writeFile(
                                join(evidenceRoot, `${journey}-segment-${segment.kind}.jsonl`),
                                await readFile(segment.transcriptPath),
                            );
                    }
                    store.close();
                    await writeFile(
                        join(evidenceRoot, `${journey}-git-commands.log`),
                        await readRemote(commandLog).catch(() => ""),
                    );
                }
            });
        }
        await record("qualification", "PASS");
    } catch (error) {
        await record("qualification-error", error instanceof Error ? error.stack || error.message : String(error));
        process.exitCode = 1;
    } finally {
        if (remoteRoot) {
            // Preserve owned remote evidence on a failed run for concrete recovery and inspection.
            await record("remote-scratch-retained", remoteRoot);
        }
        await record("evidence-retained", evidenceRoot);
    }
}

await main();
