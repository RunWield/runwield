import { assertEquals } from "../../testing/assertions.ts";
import { Buffer } from "node:buffer";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { openNativeFileLock } from "../native-file-lock.ts";
import { drainWorkflowMetrics, getWorkflowMetricsFilePath, recordWorkflowMetric } from "./metrics.js";
import { collectProcessOutput } from "../../testing/subprocess-output.ts";
import { runtimeSourceArgs } from "../../testing/runtime-source-args.ts";
import { spawnNativeProcess } from "../foreground-process.ts";
import { getCwd } from "../../constants.js";
import { test } from "node:test";
import process from "node:process";
import { withWorkflowMetricsFixture } from "../../testing/workflow-metrics-fixture.ts";

test("a producer lost after a flushed call start leaves no fabricated terminal row", async () => {
    await withWorkflowMetricsFixture(async ({ projectRoot, readMetrics }) => {
        const metricsModule = new URL("./metrics.js", import.meta.url).href;
        const script = `const { recordWorkflowMetric, drainWorkflowMetrics } = await import(${JSON.stringify(
            metricsModule,
        )});
            await recordWorkflowMetric({ v: 2, category: "tool_usage", event: "tool_call_started",
                recorderId: "crashed_execution", seq: 0, executionId: "crashed_execution",
                callId: "lost_call", toolName: "read" }, (await import("node:process")).argv.slice(2)[0]);
            await drainWorkflowMetrics();
            (await import("node:process")).exit(0);`;
        const child = spawnNativeProcess(process.execPath, {
            args: runtimeSourceArgs(["run", "-A", "--no-check", "-", projectRoot]),
            stdin: "piped",
            stdout: "piped",
            stderr: "piped",
            cwd: getCwd(),
        });
        const writer = child.stdin.getWriter();
        await writer.write(new TextEncoder().encode(script));
        await writer.close();
        const status = await collectProcessOutput(child);
        assertEquals(status.success, true, new TextDecoder().decode(status.stderr));
        const rows = await readMetrics();
        assertEquals(
            rows.map((row) => [row.event, row.callId]),
            [["tool_call_started", "lost_call"]],
        );
    });
});

test("two local producers preserve saved observations and report lock budget skips", async () => {
    await withWorkflowMetricsFixture(async ({ projectRoot, readMetrics }) => {
        const metricsModule = new URL("./metrics.js", import.meta.url).href;
        const script = `const { recordWorkflowMetric, drainWorkflowMetrics } = await import(${JSON.stringify(
            metricsModule,
        )});
            const { existsSync, writeFileSync } = await import("node:fs");
            const { join } = await import("node:path");
            const [project, producer] = (await import("node:process")).argv.slice(2);
            writeFileSync(join(project, producer + ".ready"), "ready");
            const deadline = performance.now() + 10000;
            while (!existsSync(join(project, "producers.start"))) {
                if (performance.now() >= deadline) throw new Error("Producer start barrier timed out");
                await new Promise((resolve) => setTimeout(resolve, 10));
            }
            const outcomes = [];
            for (let seq = 0; seq < 64; seq++) {
                outcomes.push(await recordWorkflowMetric({ v: 2, category: "command", event: "command_started",
                    recorderId: (await import("node:process")).argv.slice(2)[1], commandId: (await import("node:process")).argv.slice(2)[1], seq, command: "help",
                    kind: "builtin", sourceSurface: "tui" }, (await import("node:process")).argv.slice(2)[0]));
            }
            await drainWorkflowMetrics();
            console.log(JSON.stringify(outcomes));`;
        const run = (id: string) =>
            spawnNativeProcess(process.execPath, {
                args: runtimeSourceArgs(["run", "-A", "--no-check", "-", projectRoot, id]),
                stdin: "piped",
                stdout: "piped",
                stderr: "piped",
                cwd: getCwd(),
            });
        const children = [run("producer_one"), run("producer_two")];
        const pending = Promise.all(
            children.map(async (child) => {
                const input = child.stdin.getWriter();
                await input.write(new TextEncoder().encode(script));
                await input.close();
                return collectProcessOutput(child);
            }),
        );
        const deadline = performance.now() + 10000;
        while (
            !children.every((_, index) =>
                existsSync(join(projectRoot, ["producer_one", "producer_two"][index] + ".ready")),
            )
        ) {
            if (performance.now() >= deadline) {
                await pending;
                throw new Error("Both producer processes did not become ready");
            }
            await new Promise((resolve) => setTimeout(resolve, 10));
        }
        await writeFile(join(projectRoot, "producers.start"), "start");
        const results = await pending;
        for (const result of results) assertEquals(result.success, true, new TextDecoder().decode(result.stderr));
        const outcomes = results.flatMap((result, index) => {
            const reported = JSON.parse(new TextDecoder().decode(result.stdout));
            assertEquals(reported.length, 64);
            for (const [seq, outcome] of reported.entries()) {
                assertEquals(outcome.recorderId, index === 0 ? "producer_one" : "producer_two");
                assertEquals(outcome.seq, seq);
                assertEquals(typeof outcome.persisted, "boolean");
                assertEquals(typeof outcome.eventId, "string");
                if (!outcome.persisted) assertEquals(outcome.reason, "lock_timeout");
            }
            return reported;
        });
        assertEquals(new Set(outcomes.map((outcome) => outcome.eventId)).size, 128);
        const saved = outcomes.filter((outcome) => outcome.persisted).map(({ persisted: _persisted, ...row }) => row);
        assertEquals(saved.length > 0, true);
        const rows = await readMetrics().catch(async (error) => {
            const raw = await readFile(getWorkflowMetricsFilePath(projectRoot), "utf8");
            const lines = raw.trim().split("\n");
            const invalid = lines.findIndex((line) => {
                try {
                    JSON.parse(line);
                    return false;
                } catch {
                    return true;
                }
            });
            throw new Error(
                `Invalid producer JSONL: bytes=${Buffer.byteLength(raw)}, lines=${lines.length}, newline=${raw.endsWith("\n")}, invalidLine=${invalid}, excerpt=${JSON.stringify(lines[invalid]?.slice(-160))}`,
                { cause: error },
            );
        });
        assertEquals(rows.length, saved.length);
        for (const row of saved)
            assertEquals(
                rows.find((record) => record.eventId === row.eventId),
                row,
            );
    });
});

test("metrics remain bounded under an external writer lock and resume after release", async () => {
    await withWorkflowMetricsFixture(async ({ projectRoot, readMetrics }) => {
        const filePath = getWorkflowMetricsFilePath(projectRoot);
        await mkdir(dirname(filePath), { recursive: true });
        const lock = openNativeFileLock(join(dirname(filePath), ".journal.guard"));
        lock.lockSync(true);
        let held = true;
        try {
            await recordWorkflowMetric(
                {
                    v: 2,
                    category: "command",
                    event: "command_started",
                    recorderId: "contended",
                    commandId: "contended",
                    seq: 0,
                    command: "help",
                    kind: "builtin",
                    sourceSurface: "tui",
                },
                projectRoot,
            );
            await drainWorkflowMetrics(2500);
            assertEquals(await readMetrics(), []);
            lock.close();
            held = false;
            await recordWorkflowMetric(
                {
                    v: 2,
                    category: "command",
                    event: "command_started",
                    recorderId: "resumed",
                    commandId: "resumed",
                    seq: 0,
                    command: "help",
                    kind: "builtin",
                    sourceSurface: "tui",
                },
                projectRoot,
            );
            const rows = await readMetrics();
            assertEquals(
                rows.map((row) => row.recorderId),
                ["resumed"],
            );
        } finally {
            if (held) lock.close();
        }
    });
});
