import { test } from "node:test";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { captureScriptProcess } from "./script-process.ts";
import { assertEquals, assertStringIncludes } from "../src/testing/assertions.ts";

async function runFixture(file: string, reports: string, extra: string[] = []) {
    const result = await captureScriptProcess(process.execPath, {
        args: ["scripts/run-tests.js", "--report-dir", reports, "--isolated", file, ...extra],
        env: { WLD_TEST_CONCURRENCY: "1" },
        stdout: "piped",
        stderr: "piped",
    });
    return {
        code: result.code,
        output: new TextDecoder().decode(result.stdout) + new TextDecoder().decode(result.stderr),
        summary: JSON.parse(await readFile(join(reports, "run.json"), "utf8")),
        reports: (await readdir(reports)).filter((name) => name.endsWith(".xml")),
    };
}

const passingTest =
    'import {test} from "node:test"; import assert from "node:assert/strict"; test("actual assertion", () => assert.equal(2 + 2, 4));\n';

test("zero-test files and successful early exits fail without fresh JUnit evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "runwield-test-evidence-"));
    try {
        const file = join(root, "fixture.test.js");
        for (const [name, source] of [
            ["empty", "// no tests remain\n"],
            ["early-exit", "process.exit(0);\n"],
            ["inside-test-exit", 'import {test} from "node:test"; test("interrupted", () => process.exit(0));\n'],
        ]) {
            await writeFile(file, source);
            const result = await runFixture(file, join(root, name));
            assertEquals(result.code, 1, result.output);
            assertEquals(result.summary.failed, 1);
            assertEquals(result.summary.passed, 0);
            assertEquals(result.reports, []);
            assertStringIncludes(result.output, "Missing or invalid fresh JUnit test evidence");
        }
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("reusing a report directory cannot retain passing XML after an early exit", async () => {
    const root = await mkdtemp(join(tmpdir(), "runwield-test-evidence-reuse-"));
    try {
        const file = join(root, "fixture.test.js");
        const reports = join(root, "reports");
        await writeFile(file, passingTest);
        const first = await runFixture(file, reports);
        assertEquals(first.code, 0, first.output);
        assertEquals(first.summary.passed, 1);
        assertEquals(first.reports.length, 1);
        assertStringIncludes(await readFile(join(reports, first.reports[0]), "utf8"), 'name="actual assertion"');
        await writeFile(join(reports, "unrelated.txt"), "keep");

        await writeFile(file, "process.exit(0);\n");
        const second = await runFixture(file, reports);
        assertEquals(second.code, 1, second.output);
        assertEquals(second.reports, []);
        assertEquals(second.summary.failed, 1);
        assertEquals(second.summary.passed, 0);
        assertEquals(await readFile(join(reports, "unrelated.txt"), "utf8"), "keep");
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("fail-fast removes old reports for files that were never scheduled", async () => {
    const root = await mkdtemp(join(tmpdir(), "runwield-test-evidence-fast-"));
    try {
        const reports = join(root, "reports");
        const first = join(root, "a.test.js");
        await writeFile(first, passingTest);
        await writeFile(join(root, "b.test.js"), passingTest);
        const passed = await runFixture(root, reports);
        assertEquals(passed.code, 0, passed.output);
        assertEquals(passed.reports.length, 2);
        await writeFile(first, "process.exit(0);\n");
        const failed = await runFixture(root, reports, ["--fail-fast"]);
        assertEquals(failed.code, 1, failed.output);
        assertEquals(failed.summary.failed, 1);
        assertEquals(failed.summary.skipped, 1);
        assertEquals(failed.reports, []);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("registered skipped tests retain their report but do not count as passing files", async () => {
    const root = await mkdtemp(join(tmpdir(), "runwield-test-evidence-skip-"));
    try {
        const file = join(root, "fixture.test.js");
        await writeFile(file, 'import {test} from "node:test"; test.skip("deliberately skipped", () => {});\n');
        const result = await runFixture(file, join(root, "reports"));
        assertEquals(result.code, 0, result.output);
        assertEquals(result.summary.passed, 0);
        assertEquals(result.summary.skipped, 1);
        assertEquals(result.summary.failed, 0);
        assertEquals(result.reports.length, 1);
        assertStringIncludes(result.output, "0 files passed | 0 failed | 1 skipped");
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
