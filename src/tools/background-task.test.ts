import { execPath, platform } from "node:process";
import {
    mkdtemp as fsMkdtemp,
    readFile as fsReadFile,
    rm as fsRm,
    stat as fsStat,
    writeFile as fsWriteFile,
} from "node:fs/promises";
import { test } from "node:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { assertEquals, assertStringIncludes } from "../testing/assertions.ts";
import { HostedSession } from "../shared/session/hosted-session.js";
import { createBackgroundTaskTool } from "./background-task.ts";

test("background_task starts real shell work and controls it through the owning Session", async () => {
    const cwd = await fsMkdtemp(join(tmpdir(), "portable-fixture-"));
    const session = new HostedSession({ id: crypto.randomUUID(), cwd });
    const tool = createBackgroundTaskTool({
        hostedSession: session,
        cwd,
        allowShellStart: true,
    });
    try {
        const release = join(cwd, "release");
        const marker = join(cwd, "completed");
        const script = join(cwd, "background.mjs");
        await fsWriteFile(
            script,
            `
import { existsSync, writeFileSync } from "node:fs";
process.stdout.write("ready\\n");
while (!existsSync(${JSON.stringify(release)})) await new Promise(r => setTimeout(r, 20));
writeFileSync(${JSON.stringify(marker)}, "complete");
process.stdout.write("complete");
`,
        );
        const command = [execPath, ...["--no-env-file", "--no-install"], script]
            .map((value) => (platform === "win32" ? `"${value}"` : `'${value.replaceAll("'", "'\"'\"'")}'`))
            .join(" ");
        const start = await tool.execute(
            "start",
            {
                action: "start",
                command,
            },
            new AbortController().signal,
            () => {},
            {} as never,
        );
        assertEquals(start.details?.state, "running");
        const id = start.details?.task_id ?? "";
        const status = await tool.execute(
            "status",
            { action: "status", task_id: id },
            new AbortController().signal,
            () => {},
            {} as never,
        );
        assertEquals(status.details?.task_id, id);
        assertEquals(status.details?.state, "running");
        for (let index = 0; index < 100 && session.backgroundTasks.status(id).byte_count === 0; index++) {
            await new Promise((resolve) => setTimeout(resolve, 10));
        }
        assertEquals(session.backgroundTasks.status(id).byte_count, 6);
        assertEquals(
            await fsStat(marker).then(
                () => true,
                () => false,
            ),
            false,
        );
        await fsWriteFile(release, "go");
        await session.backgroundTasks.wait(id);
        assertEquals(await fsReadFile(marker, "utf8"), "complete");
        const result = await tool.execute(
            "status",
            { action: "status", task_id: id },
            new AbortController().signal,
            () => {},
            {} as never,
        );
        assertEquals(result.details?.output, "ready\ncomplete");
        assertEquals(result.details?.state, "completed");
    } finally {
        await session.backgroundTasks.cancelAllAndSuppress();
        await fsRm(cwd, { recursive: true });
    }
});

test("background_task denies shell start without effective bash authority but permits task controls", async () => {
    const cwd = await fsMkdtemp(join(tmpdir(), "portable-fixture-"));
    const session = new HostedSession({ id: crypto.randomUUID(), cwd });
    const tool = createBackgroundTaskTool({
        hostedSession: session,
        cwd,
        allowShellStart: false,
    });
    try {
        const rejected = await tool.execute(
            "start",
            { action: "start", command: "echo forbidden" },
            new AbortController().signal,
            () => {},
            {} as never,
        );
        assertEquals(rejected.details, null);
        if (rejected.content[0].type !== "text") throw new Error("Expected text error");
        assertStringIncludes(rejected.content[0].text, "bash authority");
        const id = session.backgroundTasks.startShell({
            command: "echo allowed",
            cwd,
        }).task_id;
        await session.backgroundTasks.wait(id);
        assertEquals(
            (
                await tool.execute(
                    "status",
                    { action: "status", task_id: id },
                    new AbortController().signal,
                    () => {},
                    {} as never,
                )
            ).details?.state,
            "completed",
        );
        assertEquals(
            (
                await tool.execute(
                    "cancel",
                    { action: "cancel", task_id: id },
                    new AbortController().signal,
                    () => {},
                    {} as never,
                )
            ).details?.state,
            "completed",
        );
    } finally {
        await session.backgroundTasks.cancelAllAndSuppress();
        await fsRm(cwd, { recursive: true });
    }
});

test("restricted background starts share the foreground command policy without blocking controls", async () => {
    const cwd = await fsMkdtemp(join(tmpdir(), "runwield-bg-restricted-"));
    const session = new HostedSession({ id: crypto.randomUUID(), cwd });
    const cwdCommand = platform === "win32" ? "cd" : "pwd";
    const tool = createBackgroundTaskTool({
        hostedSession: session,
        cwd,
        allowShellStart: true,
        allowedCommands: [cwdCommand],
    });
    const call = (action: "start" | "status", command?: string, task_id?: string) =>
        tool.execute("task", { action, command, task_id }, new AbortController().signal, () => {}, {} as never);
    try {
        const denied = await call(
            "start",
            `${cwdCommand} && ${platform === "win32" ? "type nul >" : "touch"} sentinel`,
        );
        assertEquals(denied.details, null);
        if (denied.content[0].type !== "text") throw new Error("Expected policy error");
        assertStringIncludes(denied.content[0].text, "report a blocker");
        assertEquals(
            await fsStat(`${cwd}/sentinel`).then(
                () => true,
                () => false,
            ),
            false,
        );
        const started = await call("start", cwdCommand);
        const id = started.details?.task_id ?? "";
        await session.backgroundTasks.wait(id);
        assertStringIncludes(
            ((await call("status", undefined, id)).details?.output ?? "").replaceAll("\\", "/"),
            cwd.replaceAll("\\", "/"),
        );
        const deniedAll = createBackgroundTaskTool({
            hostedSession: session,
            cwd,
            allowShellStart: true,
            allowedCommands: [],
        });
        const control = await deniedAll.execute(
            "control",
            { action: "status", task_id: id },
            new AbortController().signal,
            () => {},
            {} as never,
        );
        assertEquals(control.details?.state, "completed");
    } finally {
        await session.backgroundTasks.cancelAllAndSuppress();
        await fsRm(cwd, { recursive: true });
    }
});
