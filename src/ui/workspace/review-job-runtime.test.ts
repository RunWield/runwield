import { test } from "node:test";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { delimiter, join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { assertEquals, assertStringIncludes } from "../../testing/assertions.ts";
import { withWorkflowMetricsFixture } from "../../testing/workflow-metrics-fixture.ts";
import { captureForegroundProcess } from "../../shared/captured-process.ts";
import { spawnForegroundProcess } from "../../shared/foreground-process.ts";
import { writeRuntimeExecutableFixture } from "../../testing/runtime-executable-fixture.ts";

// A compiled parent must not dispatch its private commands to a different installed wld.
test("compiled review jobs use their owning executable instead of wld on PATH", async () => {
    await withWorkflowMetricsFixture(async ({ projectRoot }) => {
        const handler = fileURLToPath(new URL("./routes/api/review-agent-handlers.ts", import.meta.url));
        const entry = join(projectRoot, "parent.ts");
        await writeFile(
            entry,
            `
import { runWldJobCommand } from ${JSON.stringify(handler)};
import { closeSync } from "node:fs";
import { strict as assert } from "node:assert";
if (process.argv[2]) {
    if (process.env.FIXTURE_CLOSE_STDIN === "1") closeSync(0);
    else for await (const chunk of process.stdin) {}
    console.log(JSON.stringify({ owner: "parent", command: process.argv[2] }));
} else {
    const command = process.env.FIXTURE_REVIEW_JOB;
    assert(command === "ai-review" || command === "guided-review");
    if (process.env.FIXTURE_CLOSE_STDIN === "1") {
        await assert.rejects(
            () => runWldJobCommand("review patch".repeat(262144), new AbortController().signal, process.cwd(), {}, command),
            { code: "EPIPE" },
        );
        console.log(command + " rejects incomplete prompt delivery");
    } else {
        const result = await runWldJobCommand("review patch", new AbortController().signal, process.cwd(), {}, command);
        console.log(result.stdout.trim());
    }
}
`,
        );
        const bin = join(projectRoot, "bin");
        await mkdir(bin);
        const stale = join(projectRoot, "stale.ts");
        await writeFile(stale, 'console.log(JSON.stringify({ owner: "stale installation" }));');
        await writeRuntimeExecutableFixture(join(bin, "wld"), stale);
        const executable = join(projectRoot, process.platform === "win32" ? "parent.exe" : "parent");
        const build = await captureForegroundProcess(process.execPath, {
            args: ["build", "--compile", entry, "--outfile", executable],
            cwd: projectRoot,
            timeoutMs: 60_000,
        });
        assertEquals(build.success, true, new TextDecoder().decode(build.stderr));
        // Give each compiled invocation its own bounded deadline and failure output.
        for (const command of ["ai-review", "guided-review"]) {
            for (const closeStdin of [false, true]) {
                const child = spawnForegroundProcess({
                    command: executable,
                    cwd: projectRoot,
                    timeoutMs: 30_000,
                    env: {
                        ...process.env,
                        PATH: `${bin}${delimiter}${process.env.PATH || ""}`,
                        RUNWIELD_GUIDED_REVIEW_COMMAND: "",
                        RUNWIELD_AI_REVIEW_COMMAND: "",
                        FIXTURE_REVIEW_JOB: command,
                        FIXTURE_CLOSE_STDIN: closeStdin ? "1" : "0",
                    },
                });
                const [result, stdout, stderr] = await Promise.all([
                    child.done,
                    new Response(child.stdout).text(),
                    new Response(child.stderr).text(),
                ]);
                assertEquals(
                    result.exitCode,
                    0,
                    `${command} (close stdin: ${closeStdin}) ended by ${result.terminatedBy ?? "exit"}\nstdout: ${stdout}\nstderr: ${stderr}`,
                );
                assertEquals(stdout.includes("stale installation"), false);
                assertStringIncludes(
                    stdout,
                    closeStdin
                        ? `${command} rejects incomplete prompt delivery`
                        : `{"owner":"parent","command":"${command}"}`,
                );
            }
        }
    });
});
