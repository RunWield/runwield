import { test } from "node:test";
import { ok as assert, throws } from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { assertEquals } from "../../testing/assertions.ts";
import { runtimeSourceArgs } from "../../testing/runtime-source-args.ts";
import { spawnNativeProcess } from "../../shared/foreground-process.ts";
import { attachedValidationFixture } from "../../shared/attached/validation-test-fixture.ts";
import { CLI_PATH, DENO_CONFIG_PATH, EVIDENCE, spawnAttachedCli } from "../../shared/attached/attached-test-fixture.ts";
import { saveValidationCommand } from "../../shared/workflow/validation-local-ci.ts";

test("MCP stdin EOF stops owned CI without a failure and fresh validation reruns it", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mcp-ci-shutdown-"));
    const pidFile = join(directory, "ci.pid");
    const fixture = await attachedValidationFixture({
        command: `echo $$ > ${JSON.stringify(pidFile)}; exec sleep 600`,
    });
    const child = spawnNativeProcess(process.execPath, {
        args: runtimeSourceArgs([
            "run",
            "-A",
            "--quiet",
            "--no-check",
            "--config",
            DENO_CONFIG_PATH,
            CLI_PATH,
            "attached",
            "mcp",
        ]),
        cwd: fixture.root,
        stdin: "piped",
        stdout: "piped",
        stderr: "piped",
    });
    const stdout = new Response(child.stdout).text();
    const stderr = new Response(child.stderr).text();
    const writer = child.stdin.getWriter();
    let pid = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        const workflow = await fixture.status();
        const messages = [
            {
                jsonrpc: "2.0",
                id: 1,
                method: "initialize",
                params: {
                    protocolVersion: "2025-11-25",
                    capabilities: {},
                    clientInfo: { name: "claude-code", version: EVIDENCE.hostVersion },
                },
            },
            { jsonrpc: "2.0", method: "notifications/initialized" },
            {
                jsonrpc: "2.0",
                id: 2,
                method: "tools/call",
                params: {
                    name: "start_validation",
                    arguments: {
                        workflowId: workflow.workflowId,
                        expectedRevision: workflow.revision,
                        operationId: "shutdown-validation",
                        payload: {},
                    },
                },
            },
        ];
        for (const message of messages) await writer.write(new TextEncoder().encode(JSON.stringify(message) + "\n"));
        const deadline = Date.now() + 15_000;
        while (!pid && Date.now() < deadline) {
            try {
                pid = Number(await readFile(pidFile, "utf8"));
            } catch (error) {
                if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
            }
            if (!pid) await new Promise((resolve) => setTimeout(resolve, 25));
        }
        assert(pid > 0, "CI did not start");
        await writer.close();
        const status = await Promise.race([
            child.status,
            new Promise<never>((_resolve, reject) => {
                timer = setTimeout(() => reject(new Error("MCP and CI kept running after EOF")), 15_000);
            }),
        ]);
        clearTimeout(timer);
        assertEquals(status.code, 0, await stderr);
        throws(() => process.kill(pid, 0), { code: "ESRCH" });
        assertEquals((await fixture.evidence()).filter((entry) => entry.kind === "ci").length, 0);
        assertEquals((await fixture.metrics()).includes('"ci_attempt"'), false);
        await saveValidationCommand(fixture.cwd, "exit 0", "exact-project");
        await saveValidationCommand(fixture.root, "exit 0", "exact-project");
        const current = await fixture.status();
        const resumed = await spawnAttachedCli("start_validation", fixture.root, {
            workflowId: fixture.workflowId,
            expectedRevision: current.revision,
            operationId: "resume-validation",
            evidence: EVIDENCE,
            payload: {},
        });
        assert(
            resumed.result.ok &&
                resumed.result.workflow.nextAction.kind === "validation" &&
                resumed.result.workflow.nextAction.request.kind === "reviewer",
            JSON.stringify(resumed),
        );
        const evidence = (await fixture.evidence()).filter((entry) => entry.kind === "ci");
        assertEquals(evidence.length, 1);
        assertEquals(JSON.stringify(evidence).includes("canceled"), false);
    } finally {
        clearTimeout(timer);
        await writer.close().catch(() => {});
        if (pid) {
            try {
                process.kill(pid, "SIGKILL");
            } catch {
                /* Already exited. */
            }
        }
        try {
            child.kill("SIGKILL");
        } catch {
            /* Already exited. */
        }
        await child.status;
        await Promise.all([stdout, stderr]);
        await fixture.close();
        await rm(directory, { recursive: true });
    }
});
