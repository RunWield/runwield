import { assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";

import { HostedSession } from "../session/hosted-session.js";
import { getExactProjectCustomSetting, setCustomSetting, setExactProjectCustomSetting } from "../settings.js";
import { defineGitFixture, git } from "../git-test-fixture.ts";
import { runLocalCI } from "./validation-local-ci.ts";

const IS_WINDOWS = Deno.build.os === "windows";

const linkedWorktreeCiRepo = defineGitFixture(async (repoPath) => {
    await Deno.writeTextFile(join(repoPath, "README.md"), "base\n");
    await git(repoPath, ["add", "."]);
    await git(repoPath, ["commit", "-m", "base"]);
});

function processAlive(pid: number): boolean {
    try {
        Deno.kill(pid, "SIGCONT");
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
    const cwd = await Deno.makeTempDir({ prefix: "runwield-local-ci-" });
    await setCustomSetting("verification_command", command, "project", cwd);
    return { cwd, hostedSession: new HostedSession({ id: "local-ci-test", cwd }) };
}

Deno.test("runLocalCI reports the real exit code and captured output", async () => {
    const { cwd, hostedSession } = await makeCiProject("printf ci-ok; exit 0");
    try {
        const result = await runLocalCI({ hostedSession, cwd });
        assertEquals(result.kind, "completed");
        if (result.kind !== "completed") throw new Error("CI should complete.");
        assertEquals(result.exitCode, 0);
        assertStringIncludes(result.output, "ci-ok");
    } finally {
        await Deno.remove(cwd, { recursive: true }).catch(() => {});
    }
});

Deno.test("runLocalCI returns an operational failure when no validation command is available", async () => {
    const cwd = await Deno.makeTempDir({ prefix: "runwield-local-ci-missing-" });
    const hostedSession = new HostedSession({ id: "local-ci-missing-test", cwd });
    try {
        const result = await runLocalCI({ hostedSession, cwd });
        assertEquals(result.kind, "operational_failure");
        if (result.kind !== "operational_failure") throw new Error("CI should report an operational failure.");
        assertEquals(result.failure.code, "local_process/command_missing");
        assertEquals(result.failure.recoveryClass, "missing_information");
    } finally {
        await Deno.remove(cwd, { recursive: true }).catch(() => {});
    }
});

Deno.test("runLocalCI exact-project mode reloads the settings file before each run", async () => {
    const cwd = await Deno.makeTempDir({ prefix: "runwield-local-ci-exact-reload-" });
    const settingsPath = join(cwd, ".wld", "settings.json");
    const hostedSession = new HostedSession({ id: "local-ci-exact-reload-test", cwd });
    try {
        setExactProjectCustomSetting("verification_command", "printf cache-a", cwd);
        const first = await runLocalCI({ hostedSession, cwd, settingsPolicy: "exact-project" });
        assertEquals(first.kind, "completed");
        if (first.kind !== "completed") throw new Error("CI should complete.");
        assertStringIncludes(first.output, "cache-a");

        const previousStat = await Deno.stat(settingsPath);
        await Deno.writeTextFile(
            settingsPath,
            JSON.stringify({ verification_command: "printf cache-b" }, null, 2),
        );
        await Deno.utime(
            settingsPath,
            previousStat.atime ?? new Date(0),
            previousStat.mtime ?? new Date(0),
        );

        const second = await runLocalCI({ hostedSession, cwd, settingsPolicy: "exact-project" });
        assertEquals(second.kind, "completed");
        if (second.kind !== "completed") throw new Error("CI should complete.");
        assertStringIncludes(second.output, "cache-b");
    } finally {
        await Deno.remove(cwd, { recursive: true }).catch(() => {});
    }
});

Deno.test("runLocalCI exact-project mode uses the linked worktree command and cwd", async () => {
    const primaryRoot = await linkedWorktreeCiRepo.checkout({ prefix: "runwield-local-ci-primary-" });
    const worktreePath = `${primaryRoot}-ci-worktree`;
    const primaryMarker = join(primaryRoot, "primary-marker.txt");
    const worktreeMarker = join(worktreePath, "worktree-marker.txt");
    const cwdMarker = join(worktreePath, "cwd-marker.txt");
    try {
        await git(primaryRoot, ["worktree", "add", "-b", "local-ci-side", worktreePath, "main"]);
        await setCustomSetting(
            "verification_command",
            `printf primary > ${JSON.stringify(primaryMarker)}`,
            "project",
            primaryRoot,
        );
        setExactProjectCustomSetting(
            "verification_command",
            `printf worktree > ${JSON.stringify(worktreeMarker)}; pwd > ${JSON.stringify(cwdMarker)}`,
            worktreePath,
        );
        const hostedSession = new HostedSession({ id: "local-ci-exact-worktree-test", cwd: worktreePath });

        const result = await runLocalCI({ hostedSession, cwd: worktreePath, settingsPolicy: "exact-project" });

        assertEquals(result.kind, "completed");
        if (result.kind !== "completed") throw new Error("CI should complete.");
        assertEquals(await Deno.readTextFile(worktreeMarker), "worktree");
        assertEquals(
            await Deno.realPath((await Deno.readTextFile(cwdMarker)).trim()),
            await Deno.realPath(worktreePath),
        );
        assertEquals(await Deno.readTextFile(primaryMarker).catch(() => "absent"), "absent");
    } finally {
        await git(primaryRoot, ["worktree", "remove", "--force", worktreePath]).catch(() => {});
        await Deno.remove(primaryRoot, { recursive: true }).catch(() => {});
    }
});

Deno.test("runLocalCI inherits an uncommitted project command and preserves checkout-local settings and repairs", async () => {
    const primaryRoot = await linkedWorktreeCiRepo.checkout({ prefix: "runwield-local-ci-inherit-" });
    const worktreePath = `${primaryRoot}-ci-worktree`;
    try {
        await setCustomSetting("verification_command", "printf inherited; exit 1", "project", primaryRoot);
        await setCustomSetting("codereview", "ask", "project", primaryRoot);
        await git(primaryRoot, ["worktree", "add", "-b", "local-ci-inherit", worktreePath, "main"]);
        setExactProjectCustomSetting("codereview", "none", worktreePath);
        const hostedSession = new HostedSession({ id: "local-ci-inherit", cwd: worktreePath });

        const first = await runLocalCI({ hostedSession, cwd: worktreePath, settingsPolicy: "exact-project" });
        assertEquals(first.kind, "completed");
        if (first.kind !== "completed") throw new Error("Inherited command must run without user input.");
        assertEquals(first.exitCode, 1);
        assertStringIncludes(first.output, "inherited");
        assertEquals(getExactProjectCustomSetting("verification_command", worktreePath), "printf inherited; exit 1");
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
        assertEquals(getExactProjectCustomSetting("verification_command", primaryRoot), "printf inherited; exit 1");
    } finally {
        await git(primaryRoot, ["worktree", "remove", "--force", worktreePath]).catch(() => {});
        await Deno.remove(primaryRoot, { recursive: true }).catch(() => {});
    }
});

Deno.test("CI process start failure does not dispatch implementation repair", async () => {
    const tooLargeForProcessArguments = `printf never-starts ${"x".repeat(3_000_000)}`;
    const { cwd, hostedSession } = await makeCiProject(tooLargeForProcessArguments);
    try {
        const result = await runLocalCI({ hostedSession, cwd });

        assertEquals(result.kind, "operational_failure");
        if (result.kind !== "operational_failure") throw new Error("CI should report an operational failure.");
        assertEquals(result.failure.code, "local_process/process_start_failed");
        assertEquals(result.failure.recoveryClass, "missing_information");
        assertStringIncludes(result.output, "Failed to spawn validation process:");
    } finally {
        await Deno.remove(cwd, { recursive: true }).catch(() => {});
    }
});

Deno.test("runLocalCI keeps output bounded and says so when the tail is truncated", async () => {
    const { cwd, hostedSession } = await makeCiProject("yes ci-flood | head -c 1300000");
    try {
        const result = await runLocalCI({ hostedSession, cwd });
        assertEquals(result.kind, "completed");
        if (result.kind !== "completed") throw new Error("CI should complete.");
        assertEquals(result.exitCode, 0);
        assertStringIncludes(result.output, "[RunWield] stdout truncated;");
    } finally {
        await Deno.remove(cwd, { recursive: true }).catch(() => {});
    }
});

Deno.test({
    name: "runLocalCI cancellation through the HostedSession kills the whole CI process tree",
    ignore: IS_WINDOWS,
    fn: async () => {
        const cwd = await Deno.makeTempDir({ prefix: "runwield-local-ci-" });
        const pidFile = `${cwd}/descendant.pid`;
        await setCustomSetting("verification_command", `sleep 30 & echo $! > ${pidFile}; wait`, "project", cwd);
        const hostedSession = new HostedSession({ id: "local-ci-cancel-test", cwd });
        let descendantPid = 0;
        try {
            const resultPromise = runLocalCI({ hostedSession, cwd });
            while (!descendantPid) {
                await new Promise((resolve) => setTimeout(resolve, 10));
                descendantPid = Number(await Deno.readTextFile(pidFile).then((text) => text.trim(), () => "")) || 0;
            }
            assertEquals(processAlive(descendantPid), true, "CI descendant should be running before cancellation");

            hostedSession.cancelActiveInteractions();
            const result = await resultPromise;

            assertEquals(result.kind, "canceled");
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
            if (descendantPid && processAlive(descendantPid)) Deno.kill(descendantPid, "SIGKILL");
            await Deno.remove(cwd, { recursive: true }).catch(() => {});
        }
    },
});

Deno.test("runLocalCI preserves cancellation while saving a newly answered command", async () => {
    const cwd = await Deno.makeTempDir({ prefix: "runwield-local-ci-" });
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
        assertEquals(await Deno.stat(`${cwd}/should-not-run`).catch(() => null), null);
        assertEquals(hostedSession.getActiveInteractions().size, 0);
    } finally {
        hostedSession.dispose();
        await Deno.remove(cwd, { recursive: true });
    }
});
