import { assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";

import { getExactProjectCustomSetting } from "../settings.js";
import { resolveValidationCommand, runValidationCommand, saveValidationCommand } from "./validation-local-ci.ts";

Deno.test("Session-free validation returns command_missing without prompting or starting a command", async () => {
    const cwd = await Deno.makeTempDir({ prefix: "runwield-validation-command-" });
    try {
        let starts = 0;
        for (const settingsPolicy of ["ordinary-project", "exact-project"] as const) {
            const result = await runValidationCommand({
                cwd,
                settingsPolicy,
                onCommandStart: () => starts++,
            });
            assertEquals(result, { kind: "command_missing" });
        }
        assertEquals(starts, 0);
    } finally {
        await Deno.remove(cwd, { recursive: true });
    }
});

Deno.test("Session-free validation saves an answer and runs it with ordinary or exact settings", async () => {
    const cwd = await Deno.makeTempDir({ prefix: "runwield-validation-command-" });
    try {
        await saveValidationCommand(cwd, "  printf ci-failed; exit 7  ", "exact-project");
        assertEquals(await resolveValidationCommand(cwd), "printf ci-failed; exit 7");
        assertEquals(getExactProjectCustomSetting("verification_command", cwd), "printf ci-failed; exit 7");
        for (const settingsPolicy of ["ordinary-project", "exact-project"] as const) {
            const commands: string[] = [];
            const result = await runValidationCommand({
                cwd,
                settingsPolicy,
                onCommandStart: (command) => commands.push(command),
            });
            assertEquals(commands, ["printf ci-failed; exit 7"]);
            assertEquals(result.kind, "completed");
            if (result.kind !== "completed") throw new Error("Validation must complete.");
            assertEquals(result.exitCode, 7);
            assertStringIncludes(result.output, "ci-failed");
        }
        await Deno.writeTextFile(
            join(cwd, ".wld", "settings.json"),
            JSON.stringify({ verification_command: "printf reloaded" }),
        );
        const result = await runValidationCommand({ cwd, settingsPolicy: "exact-project" });
        assertEquals(result.kind, "completed");
        if (result.kind !== "completed") throw new Error("Validation must complete.");
        assertEquals(result.exitCode, 0);
        assertStringIncludes(result.output, "reloaded");
    } finally {
        await Deno.remove(cwd, { recursive: true });
    }
});

Deno.test("Session-free validation does not start a command with an aborted signal", async () => {
    const cwd = await Deno.makeTempDir({ prefix: "runwield-validation-command-" });
    try {
        await saveValidationCommand(cwd, "touch should-not-run");
        const controller = new AbortController();
        controller.abort();
        let starts = 0;
        const result = await runValidationCommand({
            cwd,
            signal: controller.signal,
            onCommandStart: () => starts++,
        });
        assertEquals(result, { kind: "canceled", output: "Validation canceled." });
        assertEquals(starts, 0);
        assertEquals(await Deno.stat(join(cwd, "should-not-run")).catch(() => null), null);
    } finally {
        await Deno.remove(cwd, { recursive: true });
    }
});
