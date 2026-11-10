import { test } from "node:test";
import { tmpdir } from "node:os";
import { mkdtemp as fsMkdtemp, rm as fsRm, writeFile as fsWriteFile, stat as fsStat } from "node:fs/promises";
import { join } from "node:path";
import { assertEquals, assertStringIncludes } from "../../testing/assertions.ts";
import { getExactProjectCustomSetting } from "../settings.ts";
import { resolveValidationCommand, runValidationCommand, saveValidationCommand } from "./validation-local-ci.ts";

test("Session-free validation returns command_missing without prompting or starting a command", async () => {
    const cwd = await fsMkdtemp(join(tmpdir(), "runwield-validation-command-"));
    try {
        let starts = 0;
        for (const settingsPolicy of ["ordinary-project", "exact-project"] as const) {
            const result = await runValidationCommand({
                cwd,
                settingsPolicy,
                onCommandStart: () => {
                    starts++;
                },
            });
            assertEquals(result, { kind: "command_missing" });
        }
        assertEquals(starts, 0);
    } finally {
        await fsRm(cwd, { recursive: true });
    }
});

test("Session-free validation saves an answer and runs it with ordinary or exact settings", async () => {
    const cwd = await fsMkdtemp(join(tmpdir(), "runwield-validation-command-"));
    try {
        await saveValidationCommand(cwd, "  printf ci-failed; exit 7  ", "exact-project");
        assertEquals(await resolveValidationCommand(cwd), "printf ci-failed; exit 7");
        assertEquals(getExactProjectCustomSetting("verification_command", cwd), "printf ci-failed; exit 7");
        for (const settingsPolicy of ["ordinary-project", "exact-project"] as const) {
            const commands: string[] = [];
            const result = await runValidationCommand({
                cwd,
                settingsPolicy,
                onCommandStart: (command) => {
                    commands.push(command);
                },
            });
            assertEquals(commands, ["printf ci-failed; exit 7"]);
            assertEquals(result.kind, "completed");
            if (result.kind !== "completed") throw new Error("Validation must complete.");
            assertEquals(result.exitCode, 7);
            assertStringIncludes(result.output, "ci-failed");
        }
        await fsWriteFile(
            join(cwd, ".wld", "settings.json"),
            JSON.stringify({ verification_command: "printf reloaded" }),
        );
        const result = await runValidationCommand({ cwd, settingsPolicy: "exact-project" });
        assertEquals(result.kind, "completed");
        if (result.kind !== "completed") throw new Error("Validation must complete.");
        assertEquals(result.exitCode, 0);
        assertStringIncludes(result.output, "reloaded");
    } finally {
        await fsRm(cwd, { recursive: true });
    }
});

test("Session-free validation does not start a command with an aborted signal", async () => {
    const cwd = await fsMkdtemp(join(tmpdir(), "runwield-validation-command-"));
    try {
        await saveValidationCommand(cwd, "touch should-not-run");
        const controller = new AbortController();
        controller.abort();
        let starts = 0;
        const result = await runValidationCommand({
            cwd,
            signal: controller.signal,
            onCommandStart: () => {
                starts++;
            },
        });
        assertEquals(result, { kind: "canceled", output: "Validation canceled." });
        assertEquals(starts, 0);
        assertEquals(await fsStat(join(cwd, "should-not-run")).catch(() => null), null);
    } finally {
        await fsRm(cwd, { recursive: true });
    }
});

test("CI awaits candidate capture and honors cancellation during capture", async () => {
    const cwd = await fsMkdtemp(join(tmpdir(), "runwield-validation-candidate-"));
    try {
        await saveValidationCommand(cwd, "test -f candidate-captured; exit $?");
        const captured = await runValidationCommand({
            cwd,
            onCommandStart: async () => {
                await new Promise((resolve) => setTimeout(resolve, 10));
                await fsWriteFile(join(cwd, "candidate-captured"), "captured");
            },
        });
        assertEquals(captured.kind, "completed");
        if (captured.kind !== "completed") throw new Error("Validation must complete.");
        assertEquals(captured.exitCode, 0);
        await saveValidationCommand(cwd, "touch should-not-run");
        const controller = new AbortController();
        const canceled = await runValidationCommand({
            cwd,
            signal: controller.signal,
            onCommandStart: async () => {
                await new Promise((resolve) => setTimeout(resolve, 10));
                controller.abort();
            },
        });
        assertEquals(canceled.kind, "canceled");
        assertEquals(await fsStat(join(cwd, "should-not-run")).catch(() => null), null);
    } finally {
        await fsRm(cwd, { recursive: true });
    }
});
