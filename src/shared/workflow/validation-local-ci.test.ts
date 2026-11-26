import { test } from "node:test";
import { tmpdir } from "node:os";
import {
    mkdtemp as fsMkdtemp,
    mkdir as fsMkdir,
    readFile as fsReadFile,
    readdir as fsReaddir,
    realpath as fsRealpath,
    rm as fsRm,
    stat as fsStat,
    utimes as fsUtimes,
    writeFile as fsWriteFile,
} from "node:fs/promises";
import process from "node:process";
import { assertEquals, assertStringIncludes } from "../../testing/assertions.ts";
import { join } from "node:path";

import { HostedSession } from "@runwield/session-runtime/host";
import { getExactProjectCustomSetting, setCustomSetting, setExactProjectCustomSetting } from "../settings.ts";
import { defineGitFixture, git } from "../git-test-fixture.ts";
import { runLocalCI } from "./validation-local-ci.ts";
import { resolveProjectRuntimeLayout } from "../project-runtime-layout.ts";
import { createSessionRuntimeEvent } from "@runwield/session-runtime/events";

const IS_WINDOWS = process.platform === "win32";

const linkedWorktreeCiRepo = defineGitFixture(async (repoPath) => {
    await fsWriteFile(join(repoPath, "README.md"), "base\n");
    await git(repoPath, ["add", "."]);
    await git(repoPath, ["commit", "-m", "base"]);
});

function processAlive(pid: number): boolean {
    try {
        process.kill(pid, "SIGCONT");
        return true;
    } catch {
        return false;
    }
}

/**
 * Poll until the OS no longer reports a process with this pid. The wrapper
 * shell's exit settles before its SIGKILLed descendants are reaped, so a
 * single immediate probe can still observe them — and under CI load the
 * window is wide enough to fail a one-shot check.
 */
async function waitForProcessDeath(pid: number, timeoutMs = 5000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (!processAlive(pid)) return true;
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return !processAlive(pid);
}

async function makeCiProject(command: string): Promise<{ cwd: string; hostedSession: HostedSession }> {
    const cwd = await fsMkdtemp(join(tmpdir(), "runwield-local-ci-"));
    await setCustomSetting("verification_command", command, "project", cwd);
    return { cwd, hostedSession: new HostedSession({ id: "local-ci-test", cwd }) };
}

test("runLocalCI reports the real exit code and captured output", async () => {
    const { cwd, hostedSession } = await makeCiProject("printf ci-ok; exit 0");
    try {
        const result = await runLocalCI({ hostedSession, cwd });
        assertEquals(result.kind, "completed");
        if (result.kind !== "completed") throw new Error("CI should complete.");
        assertEquals(result.exitCode, 0);
        assertStringIncludes(result.output, "ci-ok");
        assertEquals(result.output.includes("Output truncated"), false);
        assertEquals(await fsReadFile(validationLogPath(result.output), "utf8"), "ci-ok");
    } finally {
        await fsRm(cwd, { recursive: true }).catch(() => {});
    }
});

test("runLocalCI returns an operational failure when no validation command is available", async () => {
    const cwd = await fsMkdtemp(join(tmpdir(), "runwield-local-ci-missing-"));
    const hostedSession = new HostedSession({ id: "local-ci-missing-test", cwd });
    try {
        const result = await runLocalCI({ hostedSession, cwd });
        assertEquals(result.kind, "operational_failure");
        if (result.kind !== "operational_failure") throw new Error("CI should report an operational failure.");
        assertEquals(result.failure.code, "local_process/command_missing");
        assertEquals(result.failure.recoveryClass, "missing_information");
        assertEquals(await existingValidationLogs(cwd), []);
    } finally {
        await fsRm(cwd, { recursive: true }).catch(() => {});
    }
});

test("runLocalCI exact-project mode reloads the settings file before each run", async () => {
    const cwd = await fsMkdtemp(join(tmpdir(), "runwield-local-ci-exact-reload-"));
    const settingsPath = join(cwd, ".wld", "settings.json");
    const hostedSession = new HostedSession({ id: "local-ci-exact-reload-test", cwd });
    try {
        setExactProjectCustomSetting("verification_command", "printf cache-a", cwd);
        const first = await runLocalCI({ hostedSession, cwd, settingsPolicy: "exact-project" });
        assertEquals(first.kind, "completed");
        if (first.kind !== "completed") throw new Error("CI should complete.");
        assertStringIncludes(first.output, "cache-a");

        const previousStat = await fsStat(settingsPath);
        await fsWriteFile(settingsPath, JSON.stringify({ verification_command: "printf cache-b" }, null, 2));
        await fsUtimes(settingsPath, previousStat.atime ?? new Date(0), previousStat.mtime ?? new Date(0));

        const second = await runLocalCI({ hostedSession, cwd, settingsPolicy: "exact-project" });
        assertEquals(second.kind, "completed");
        if (second.kind !== "completed") throw new Error("CI should complete.");
        assertStringIncludes(second.output, "cache-b");
    } finally {
        await fsRm(cwd, { recursive: true }).catch(() => {});
    }
});

test("runLocalCI exact-project mode uses the linked worktree command and cwd", async () => {
    const primaryRoot = await linkedWorktreeCiRepo.checkout({ prefix: "runwield-local-ci-primary-" });
    const worktreePath = `${primaryRoot}-ci-worktree`;
    const primaryMarker = join(primaryRoot, "primary-marker.txt");
    const worktreeMarker = join(worktreePath, "worktree-marker.txt");
    const cwdMarker = join(worktreePath, "cwd-marker.txt");
    try {
        await git(primaryRoot, ["worktree", "add", "-b", "local-ci-side", worktreePath, "main"]);
        await setCustomSetting(
            "verification_command",
            IS_WINDOWS
                ? `<nul set /p "=primary" > "${primaryMarker}"`
                : `printf primary > ${JSON.stringify(primaryMarker)}`,
            "project",
            primaryRoot,
        );
        setExactProjectCustomSetting(
            "verification_command",
            IS_WINDOWS
                ? `<nul set /p "=worktree" > "${worktreeMarker}" & cd > "${cwdMarker}"`
                : `printf worktree > ${JSON.stringify(worktreeMarker)}; pwd > ${JSON.stringify(cwdMarker)}`,
            worktreePath,
        );
        const hostedSession = new HostedSession({ id: "local-ci-exact-worktree-test", cwd: worktreePath });

        const result = await runLocalCI({ hostedSession, cwd: worktreePath, settingsPolicy: "exact-project" });

        assertEquals(result.kind, "completed");
        if (result.kind !== "completed") throw new Error("CI should complete.");
        const logPath = validationLogPath(result.output);
        assertEquals(logPath.startsWith(resolveProjectRuntimeLayout(worktreePath).selected.validationLogsDir), true);
        assertEquals(logPath.startsWith(resolveProjectRuntimeLayout(primaryRoot).selected.validationLogsDir), false);
        assertEquals((await fsStat(logPath)).isFile(), true);
        assertEquals(await fsReadFile(worktreeMarker, "utf8"), "worktree");
        assertEquals(await fsRealpath((await fsReadFile(cwdMarker, "utf8")).trim()), await fsRealpath(worktreePath));
        assertEquals(await fsReadFile(primaryMarker, "utf8").catch(() => "absent"), "absent");
    } finally {
        await git(primaryRoot, ["worktree", "remove", "--force", worktreePath]).catch(() => {});
        await fsRm(primaryRoot, { recursive: true }).catch(() => {});
    }
});

test("runLocalCI inherits an uncommitted project command and preserves checkout-local settings and repairs", async () => {
    const primaryRoot = await linkedWorktreeCiRepo.checkout({ prefix: "runwield-local-ci-inherit-" });
    const worktreePath = `${primaryRoot}-ci-worktree`;
    const inheritedCommand = IS_WINDOWS ? "echo inherited & exit /b 1" : "printf inherited; exit 1";
    try {
        await setCustomSetting("verification_command", inheritedCommand, "project", primaryRoot);
        await setCustomSetting("codereview", "ask", "project", primaryRoot);
        await git(primaryRoot, ["worktree", "add", "-b", "local-ci-inherit", worktreePath, "main"]);
        setExactProjectCustomSetting("codereview", "none", worktreePath);
        const hostedSession = new HostedSession({ id: "local-ci-inherit", cwd: worktreePath });

        const first = await runLocalCI({ hostedSession, cwd: worktreePath, settingsPolicy: "exact-project" });
        assertEquals(first.kind, "completed");
        if (first.kind !== "completed") throw new Error("Inherited command must run without user input.");
        assertEquals(first.exitCode, 1);
        assertStringIncludes(first.output, "inherited");
        assertEquals(getExactProjectCustomSetting("verification_command", worktreePath), inheritedCommand);
        assertEquals(getExactProjectCustomSetting("codereview", worktreePath), "none");

        setExactProjectCustomSetting("verification_command", "printf repaired", worktreePath);
        const resumedSession = new HostedSession({ id: "local-ci-inherit-resumed", cwd: worktreePath });
        const second = await runLocalCI({
            hostedSession: resumedSession,
            cwd: worktreePath,
            settingsPolicy: "exact-project",
        });
        assertEquals(second.kind, "completed");
        if (second.kind !== "completed") throw new Error("Repaired command must run without user input.");
        assertEquals(second.exitCode, 0);
        assertStringIncludes(second.output, "repaired");
        assertEquals(getExactProjectCustomSetting("verification_command", primaryRoot), inheritedCommand);
    } finally {
        await git(primaryRoot, ["worktree", "remove", "--force", worktreePath]).catch(() => {});
        await fsRm(primaryRoot, { recursive: true }).catch(() => {});
    }
});

test("CI process start failure does not dispatch implementation repair", async () => {
    const tooLargeForProcessArguments = `printf never-starts ${"x".repeat(3_000_000)}`;
    const { cwd, hostedSession } = await makeCiProject(tooLargeForProcessArguments);
    try {
        const result = await runLocalCI({ hostedSession, cwd });

        assertEquals(result.kind, "operational_failure");
        if (result.kind !== "operational_failure") throw new Error("CI should report an operational failure.");
        assertEquals(result.failure.code, "local_process/process_start_failed");
        assertEquals(result.failure.recoveryClass, "missing_information");
        assertEquals(await existingValidationLogs(cwd), []);
        assertStringIncludes(result.output, "Failed to spawn validation process:");
    } finally {
        await fsRm(cwd, { recursive: true }).catch(() => {});
    }
});

test("runLocalCI keeps output bounded and says so when the tail is truncated", async () => {
    const { cwd, hostedSession } = await makeCiProject("yes ci-flood | head -c 1300000");
    try {
        const result = await runLocalCI({ hostedSession, cwd });
        assertEquals(result.kind, "completed");
        if (result.kind !== "completed") throw new Error("CI should complete.");
        assertEquals(result.exitCode, 0);
        assertStringIncludes(result.output, "[RunWield] Output truncated;");
    } finally {
        await fsRm(cwd, { recursive: true }).catch(() => {});
    }
});

test(
    "runLocalCI cancellation through the HostedSession kills the whole CI process tree",
    { skip: IS_WINDOWS },
    async () => {
        const cwd = await fsMkdtemp(join(tmpdir(), "runwield-local-ci-"));
        const pidFile = `${cwd}/descendant.pid`;
        await setCustomSetting("verification_command", `sleep 30 & echo $! > ${pidFile}; wait`, "project", cwd);
        const hostedSession = new HostedSession({ id: "local-ci-cancel-test", cwd });
        let descendantPid = 0;
        try {
            const resultPromise = runLocalCI({ hostedSession, cwd });
            while (!descendantPid) {
                await new Promise((resolve) => setTimeout(resolve, 10));
                descendantPid =
                    Number(
                        await fsReadFile(pidFile, "utf8").then(
                            (text) => text.trim(),
                            () => "",
                        ),
                    ) || 0;
            }
            assertEquals(processAlive(descendantPid), true, "CI descendant should be running before cancellation");

            hostedSession.cancelActiveInteractions();
            const result = await resultPromise;

            assertEquals(result.kind, "canceled");
            assertEquals((await fsStat(validationLogPath(result.output))).isFile(), true);
            assertEquals(
                await waitForProcessDeath(descendantPid),
                true,
                "cancellation must kill CI's whole process tree",
            );
            assertEquals(
                hostedSession.getActiveInteractions().size,
                0,
                "the active interaction is released once the tree has settled",
            );
        } finally {
            if (descendantPid && processAlive(descendantPid)) process.kill(descendantPid, "SIGKILL");
            await fsRm(cwd, { recursive: true }).catch(() => {});
        }
    },
);

test("runLocalCI preserves cancellation while saving a newly answered command", async () => {
    const cwd = await fsMkdtemp(join(tmpdir(), "runwield-local-ci-"));
    const hostedSession = new HostedSession({ id: "command-save-cancel", cwd });
    try {
        hostedSession.setInteractionAdapter({
            supportsInteraction: () => true,
            requestInteraction: () => ({ outcome: "text", value: "touch should-not-run" }),
        });
        hostedSession.subscribeRuntimeEvents((event) => {
            if (event.type === "interaction_resolved") hostedSession.cancelActiveInteractions();
        });
        const result = await runLocalCI({ hostedSession, cwd, settingsPolicy: "exact-project" });
        assertEquals(result.kind, "canceled");
        assertEquals(getExactProjectCustomSetting("verification_command", cwd), "touch should-not-run");
        assertEquals(await fsStat(`${cwd}/should-not-run`).catch(() => null), null);
        assertEquals(hostedSession.getActiveInteractions().size, 0);
    } finally {
        hostedSession.dispose();
        await fsRm(cwd, { recursive: true });
    }
});

async function existingValidationLogs(cwd: string): Promise<string[]> {
    try {
        return await fsReaddir(resolveProjectRuntimeLayout(cwd).selected.validationLogsDir);
    } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
        throw error;
    }
}

function validationLogPath(output: string): string {
    const match = output.match(
        /Full validation output saved to (.+)\.\nRead it from the start to find the first failure\.$/,
    );
    if (!match) throw new Error(`Missing full log path: ${output}`);
    return match[1];
}

function assertBoundedTail(output: string): string {
    const tail = output.split("[RunWield]")[0];
    assertEquals(new TextEncoder().encode(tail).byteLength <= 16_384, true);
    assertEquals(tail.trimEnd().split("\n").length <= 200, true);
    return tail;
}

test("runLocalCI saves the first error and all output while delivering only a short tail", async () => {
    const command =
        "printf 'FIRST-ERROR\\n' >&2; sleep 0.05; i=1; while [ $i -le 2000 ]; do echo line-$i; i=$((i+1)); done; echo LAST-LINE; exit 7";
    const { cwd, hostedSession } = await makeCiProject(command);
    let toolOutput = "";
    hostedSession.setEventSink((draft: Parameters<typeof createSessionRuntimeEvent>[1]) => {
        const event = createSessionRuntimeEvent(hostedSession.id, draft);
        if (event.type === "tool_end") toolOutput = event.output;
    });
    try {
        const result = await runLocalCI({ hostedSession, cwd });
        if (result.kind !== "completed") throw new Error("CI should complete.");
        assertEquals(result.exitCode, 7);
        const tail = assertBoundedTail(result.output);
        assertStringIncludes(tail, "LAST-LINE");
        assertEquals(result.output.includes("FIRST-ERROR"), false);
        const path = validationLogPath(result.output);
        assertEquals(path.startsWith(resolveProjectRuntimeLayout(cwd).selected.validationLogsDir), true);
        const full = await fsReadFile(path, "utf8");
        const expected =
            "FIRST-ERROR\n" + Array.from({ length: 2000 }, (_, i) => `line-${i + 1}\n`).join("") + "LAST-LINE\n";
        assertEquals(full, expected);
        const bytes = result.output.match(/\((\d+) of (\d+) bytes\)/);
        if (!bytes) throw new Error("Missing truncation byte counts");
        assertEquals(Number(bytes[1]), new TextEncoder().encode(tail).byteLength);
        assertEquals(Number(bytes[2]), (await fsStat(path)).size);
        assertEquals(toolOutput, result.output);
        assertStringIncludes(toolOutput, path);
        assertStringIncludes(toolOutput, "LAST-LINE");
        assertEquals(toolOutput.includes("FIRST-ERROR"), false);
    } finally {
        hostedSession.dispose();
        await fsRm(cwd, { recursive: true });
    }
});

test("runLocalCI preserves observed stdout and stderr order in the full log", async () => {
    const command =
        "printf 'out-1\\n'; sleep 0.05; printf 'err-1\\n' >&2; sleep 0.05; printf 'out-2\\n'; sleep 0.05; printf 'err-2\\n' >&2";
    const { cwd, hostedSession } = await makeCiProject(command);
    try {
        const result = await runLocalCI({ hostedSession, cwd });
        if (result.kind !== "completed") throw new Error("CI should complete.");
        assertEquals(await fsReadFile(validationLogPath(result.output), "utf8"), "out-1\nerr-1\nout-2\nerr-2\n");
        assertEquals(result.output.startsWith("out-1\nerr-1\nout-2\nerr-2\n"), true);
    } finally {
        hostedSession.dispose();
        await fsRm(cwd, { recursive: true });
    }
});

test("runLocalCI bounds a 40 KB line without a newline", async () => {
    const { cwd, hostedSession } = await makeCiProject("printf '%040000d' 0");
    try {
        const result = await runLocalCI({ hostedSession, cwd });
        if (result.kind !== "completed") throw new Error("CI should complete.");
        assertBoundedTail(result.output);
        assertStringIncludes(result.output, "[RunWield] Output truncated;");
        assertEquals((await fsStat(validationLogPath(result.output))).size, 40_000);
    } finally {
        hostedSession.dispose();
        await fsRm(cwd, { recursive: true });
    }
});

test("runLocalCI preserves the command result when the full log cannot be saved", async () => {
    const { cwd, hostedSession } = await makeCiProject("printf real-failure; exit 9");
    try {
        const layout = resolveProjectRuntimeLayout(cwd).selected;
        await fsMkdir(layout.internalRoot, { recursive: true });
        await fsWriteFile(layout.validationLogsDir, "blocked");
        const result = await runLocalCI({ hostedSession, cwd });
        if (result.kind !== "completed") throw new Error("Log failure must not replace the command result.");
        assertEquals(result.exitCode, 9);
        assertStringIncludes(result.output, "real-failure");
        assertStringIncludes(result.output, "[RunWield] Full validation output could not be saved:");
    } finally {
        hostedSession.dispose();
        await fsRm(cwd, { recursive: true });
    }
});
