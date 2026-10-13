import { execPath, platform } from "node:process";
import { captureForegroundProcess } from "../captured-process.ts";
import { mkdtemp as fsMkdtemp, readFile as fsReadFile, rm as fsRm, writeFile as fsWriteFile } from "node:fs/promises";
import { test } from "node:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { assertEquals, assertRejects, assertStringIncludes } from "../../testing/assertions.ts";
import { HostedSession } from "./hosted-session.js";
import { BackgroundTasks } from "./background-tasks.ts";
import { createRunWieldReadToolDefinition } from "../../tools/read.js";

async function fixture() {
    const cwd = await fsMkdtemp(join(tmpdir(), "portable-fixture-"));
    const session = new HostedSession({ id: crypto.randomUUID(), cwd });
    return {
        cwd,
        session,
        command: async (source: string) => {
            const script = join(cwd, `${crypto.randomUUID()}.mjs`);
            await fsWriteFile(script, source);
            return [execPath, ...["--no-env-file", "--no-install"], script]
                .map((value) => (platform === "win32" ? `"${value}"` : `'${value.replaceAll("'", "'\"'\"'")}'`))
                .join(" ");
        },
        tasks: session.backgroundTasks as BackgroundTasks,
        cleanup: async () => {
            await session.backgroundTasks.cancelAllAndSuppress();
            await fsRm(cwd, { recursive: true });
        },
    };
}

test("shell start returns before exit and publishes a final result after its logs close", async () => {
    const f = await fixture();
    try {
        const task = f.tasks.startShell({
            command: await f.command(
                'process.stdout.write("ready\\n"); await new Promise(r => setTimeout(r, 300)); process.stderr.write("done\\n");',
            ),
            cwd: f.cwd,
        });
        assertEquals(task.state, "running");
        const final = await f.tasks.wait(task.task_id);
        assertEquals(final.state, "completed");
        assertEquals(final.exit_code, 0);
        assertEquals(final.byte_count, 11);
        assertEquals(final.line_count, 2);
        assertStringIncludes(final.output ?? "", "ready");
        assertStringIncludes(final.output ?? "", "done");
        assertEquals(await fsReadFile(final.log_path, "utf8"), "ready\n");
        assertEquals(await fsReadFile(final.err_log_path, "utf8"), "done\n");
        assertEquals(f.tasks.pendingCompletions().length, 1);
        f.tasks.acknowledge(task.task_id);
        assertEquals(f.tasks.pendingCompletions().length, 0);
    } finally {
        await f.cleanup();
    }
});

test("five running tasks hold slots until settlement; other Sessions cannot control them", async () => {
    const a = await fixture();
    const b = await fixture();
    try {
        const sleeper = await a.command("await new Promise(r => setTimeout(r, 20000));");
        const starts = Array.from({ length: 5 }, () => a.tasks.startShell({ command: sleeper, cwd: a.cwd }));
        assertEquals(a.tasks.activeCount, 5);
        try {
            a.tasks.startShell({ command: "echo extra", cwd: a.cwd });
            throw new Error("Sixth start succeeded");
        } catch (error) {
            assertStringIncludes(String(error), "maximum is 5");
        }
        await assertRejects(() => b.tasks.cancel(starts[0].task_id), Error, "Unknown background task");
        const cancelled = await a.tasks.cancel(starts[0].task_id);
        assertEquals(cancelled.state, "cancelled");
        assertEquals((await a.tasks.cancel(starts[0].task_id)).state, "cancelled");
        assertEquals(a.tasks.activeCount, 4);
        assertEquals(
            (await b.tasks.wait(b.tasks.startShell({ command: "echo independent", cwd: b.cwd }).task_id)).state,
            "completed",
        );
    } finally {
        await a.cleanup();
        await b.cleanup();
    }
});

test("another host process has its own slots and cannot control this process's task ID", async () => {
    const f = await fixture();
    const script = `${f.cwd}/another-host.ts`;
    try {
        const sleeper = await f.command("await new Promise(r => setTimeout(r, 20000));");
        const childCommand = await f.command('process.stdout.write("child");');
        const parents = Array.from({ length: 5 }, () => f.tasks.startShell({ command: sleeper, cwd: f.cwd }));
        const hostedSessionUrl = new URL("./hosted-session.js", import.meta.url).href;
        await fsWriteFile(
            script,
            `
import { HostedSession } from ${JSON.stringify(hostedSessionUrl)};
import { argv } from "node:process";
const [id, cwd, foreignId] = argv.slice(2);
const session = new HostedSession({ id, cwd });
try {
    let refused = false;
    try { session.backgroundTasks.status(foreignId); } catch { refused = true; }
    const own = session.backgroundTasks.startShell({ command: ${JSON.stringify(childCommand)}, cwd });
    const result = await session.backgroundTasks.wait(own.task_id);
    console.log(JSON.stringify({ refused, output: result.output, state: result.state }));
} finally { await session.dispose(); }
`,
        );
        const output = await captureForegroundProcess(execPath, {
            args: [...["--no-env-file", "--no-install"], script, f.session.id, f.cwd, parents[0].task_id],
            cwd: f.cwd,
        });
        assertEquals(output.code, 0, new TextDecoder().decode(output.stderr));
        assertEquals(JSON.parse(new TextDecoder().decode(output.stdout)), {
            refused: true,
            output: "child",
            state: "completed",
        });
        assertEquals(f.tasks.activeCount, 5);
    } finally {
        await f.cleanup();
    }
});

test("output at exactly 8192 UTF-8 bytes is inline and empty output is explicit", async () => {
    const f = await fixture();
    try {
        const exact = await f.tasks.wait(
            f.tasks.startShell({
                command: await f.command('process.stdout.write("é" + "x".repeat(8190));'),
                cwd: f.cwd,
            }).task_id,
        );
        assertEquals(exact.byte_count, 8192);
        assertEquals(exact.output?.length, 8191);
        assertEquals(exact.output?.startsWith("é"), true);
        const empty = await f.tasks.wait(f.tasks.startShell({ command: await f.command(""), cwd: f.cwd }).task_id);
        assertEquals(empty.output, "(No output.)");
    } finally {
        await f.cleanup();
    }
});

test("presented output removes terminal control bytes without changing its log", async () => {
    const f = await fixture();
    try {
        const final = await f.tasks.wait(
            f.tasks.startShell({
                command: await f.command('process.stdout.write("\\u001b[31mred\\u001b[0m\\n");'),
                cwd: f.cwd,
            }).task_id,
        );
        assertEquals(final.output, "red\n");
        assertEquals(await fsReadFile(final.log_path, "utf8"), "\u001b[31mred\u001b[0m\n");
    } finally {
        await f.cleanup();
    }
});

test("large UTF-8 output uses the complete log; a final unterminated line counts", async () => {
    const f = await fixture();
    try {
        const final = await f.tasks.wait(
            f.tasks.startShell({
                command: await f.command('process.stdout.write("é" + "x".repeat(8191));'),
                cwd: f.cwd,
            }).task_id,
        );
        assertEquals(final.byte_count, 8193);
        assertEquals(final.line_count, 1);
        assertEquals(final.output, undefined);
        assertEquals((await fsReadFile(final.log_path, "utf8")).length, 8192);
        const read = createRunWieldReadToolDefinition(f.cwd);
        const displayed = await read.execute(
            "read-task-log",
            { path: final.log_path },
            new AbortController().signal,
            () => {},
            {} as never,
        );
        const text = displayed.content.find((block) => block.type === "text");
        assertStringIncludes(text?.text || "", "x".repeat(8191));
    } finally {
        await f.cleanup();
    }
});

test("timeout and nonzero exit release slots", async () => {
    const f = await fixture();
    try {
        const timed = await f.tasks.wait(
            f.tasks.startShell({
                command: await f.command("await new Promise(r => setTimeout(r, 20000));"),
                cwd: f.cwd,
                timeoutMs: 30,
            }).task_id,
        );
        assertEquals(timed.state, "timed_out");
        const failed = await f.tasks.wait(f.tasks.startShell({ command: "exit 7", cwd: f.cwd }).task_id);
        assertEquals(failed.state, "failed");
        assertEquals(failed.exit_code, 7);
        assertEquals(f.tasks.activeCount, 0);
    } finally {
        await f.cleanup();
    }
});
