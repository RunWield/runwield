import { test } from "node:test";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { delimiter, join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { assertEquals, assertStringIncludes } from "../../testing/assertions.ts";
import { withWorkflowMetricsFixture } from "../../testing/workflow-metrics-fixture.ts";
import { captureForegroundProcess } from "../../shared/captured-process.ts";
import { writeRuntimeExecutableFixture } from "../../testing/runtime-executable-fixture.ts";

// A compiled parent must not dispatch its private commands to a different installed wld.
test("compiled review jobs use their owning executable instead of wld on PATH", async () => {
    await withWorkflowMetricsFixture(async ({ projectRoot }) => {
        const handler = fileURLToPath(new URL("./routes/api/review-agent-handlers.js", import.meta.url));
        const entry = join(projectRoot, "parent.ts");
        await writeFile(
            entry,
            `
import { runWldJobCommand } from ${JSON.stringify(handler)};
if (process.argv[2]) {
    for await (const chunk of process.stdin) {}
    console.log(JSON.stringify({ owner: "parent", command: process.argv[2] }));
} else {
    for (const command of ["ai-review", "guided-review"]) {
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
        const result = await captureForegroundProcess(executable, {
            args: [],
            cwd: projectRoot,
            timeoutMs: 10_000,
            env: {
                ...process.env,
                PATH: `${bin}${delimiter}${process.env.PATH || ""}`,
                RUNWIELD_GUIDED_REVIEW_COMMAND: "",
                RUNWIELD_AI_REVIEW_COMMAND: "",
            },
        });
        assertEquals(result.success, true, new TextDecoder().decode(result.stderr));
        const stdout = new TextDecoder().decode(result.stdout);
        assertStringIncludes(stdout, '{"owner":"parent","command":"ai-review"}');
        assertStringIncludes(stdout, '{"owner":"parent","command":"guided-review"}');
        assertEquals(stdout.includes("stale installation"), false);
    });
});
