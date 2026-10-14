import { test } from "node:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { execPath } from "node:process";
import { type CapturedProcessOutput, captureForegroundProcess } from "../../shared/captured-process.ts";
import { mkdir as fsMkdir, rm as fsRm } from "node:fs/promises";
import { assertEquals, assertStringIncludes } from "../../testing/assertions.ts";
import { join } from "node:path";
import { runQuitCommand } from "./index.ts";

const decoder = new TextDecoder();

function removeDenoLockNotice(stderr: string): string {
    return stderr
        .split("\n")
        .filter((line) => line !== "Blocking waiting for file lock on node_modules directory")
        .join("\n");
}

async function runQuitChild(): Promise<CapturedProcessOutput> {
    const fixtureRoot = await mkdtemp(join(tmpdir(), "runwield-quit-command-"));
    const homeDir = join(fixtureRoot, "home");
    const projectRoot = join(fixtureRoot, "project");
    await Promise.all([fsMkdir(homeDir, { recursive: true }), fsMkdir(projectRoot, { recursive: true })]);
    const moduleUrl = import.meta.resolve("./index.ts");
    const source = [
        `import { runQuitCommand } from ${JSON.stringify(moduleUrl)};`,
        "await runQuitCommand([], {",
        "  editor: { setText(text) { console.log(`editor:${JSON.stringify(text)}`); } },",
        "  tui: { requestRender() { console.log('rendered'); } },",
        "});",
    ].join("\n");
    try {
        return await captureForegroundProcess(execPath, {
            args: ["--eval", source],
            cwd: projectRoot,
            env: {
                HOME: homeDir,
                WLD_TEST_SANDBOX_HOME: homeDir,
            },
        });
    } finally {
        await fsRm(fixtureRoot, { recursive: true }).catch(() => {});
    }
}

test("quit command no-ops without interactive surfaces", async () => {
    await runQuitCommand([], {});
});

test("quit command clears external UI surfaces and performs real delayed TUI shutdown", async () => {
    const result = await runQuitChild();
    const stdout = decoder.decode(result.stdout);

    assertEquals(result.code, 0);
    assertStringIncludes(stdout, 'editor:""');
    assertStringIncludes(stdout, "rendered");
    assertStringIncludes(stdout, "\x1b]0;\x07");
    assertEquals(removeDenoLockNotice(decoder.decode(result.stderr)), "");
});
