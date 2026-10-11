import { assertEquals } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import { type CiTaskName, type CiTaskResult, PRE_TEST_TASKS, runCi } from "./run-ci.ts";

Deno.test("CI collects all failures by default and supports explicit fail-fast", async () => {
    const root = await Deno.makeTempDir({ prefix: "ci-command-fixture-" });
    try {
        const tasks = Object.fromEntries(PRE_TEST_TASKS.map((name) => [name, "deno eval 'void 0'"]));
        await Deno.writeTextFile(
            join(root, "deno.json"),
            JSON.stringify({
                tasks: {
                    ...tasks,
                    "test:all:suite": "deno run -A check-args.ts",
                    "test:suite": "deno run -A check-args.ts",
                },
            }),
        );
        await Deno.writeTextFile(
            join(root, "check-args.ts"),
            'await Deno.writeTextFile("args.json", JSON.stringify(Deno.args)); Deno.exit(7);\n',
        );
        for (const flags of [[], ["--fail-fast"], ["--source-only", "--fail-fast"]]) {
            const output = await new Deno.Command(Deno.execPath(), {
                args: ["run", "-A", fromFileUrl(new URL("./run-ci.ts", import.meta.url)), ...flags],
                cwd: root,
                stdout: "piped",
                stderr: "piped",
            }).output();
            assertEquals(output.code, 7);
            assertEquals(
                JSON.parse(await Deno.readTextFile(join(root, "args.json"))),
                flags.includes("--fail-fast") ? ["--fail-fast"] : [],
            );
        }
    } finally {
        await Deno.remove(root, { recursive: true });
    }
});

interface DeferredTask {
    promise: Promise<CiTaskResult>;
    resolve: (result: CiTaskResult) => void;
}

function deferredTask(): DeferredTask {
    let resolveTask: (result: CiTaskResult) => void = () => {};
    const promise = new Promise<CiTaskResult>((resolve) => {
        resolveTask = resolve;
    });
    return { promise, resolve: resolveTask };
}

async function flushPromises(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
}

Deno.test("runCi starts every pre-test task before waiting and keeps test behind the barrier", async () => {
    const starts: CiTaskName[] = [];
    const tasks = new Map<CiTaskName, DeferredTask>();
    const resultPromise = runCi((taskName) => {
        starts.push(taskName);
        const deferred = deferredTask();
        tasks.set(taskName, deferred);
        return deferred.promise;
    });

    await flushPromises();
    assertEquals(starts, [...PRE_TEST_TASKS]);

    for (const taskName of PRE_TEST_TASKS.slice(0, -1)) {
        tasks.get(taskName)?.resolve({ name: taskName, code: 0 });
    }
    await flushPromises();
    assertEquals(starts, [...PRE_TEST_TASKS]);

    const lastPreTest = PRE_TEST_TASKS.at(-1);
    if (!lastPreTest) throw new Error("PRE_TEST_TASKS must not be empty");
    tasks.get(lastPreTest)?.resolve({ name: lastPreTest, code: 0 });
    await flushPromises();
    assertEquals(starts, [...PRE_TEST_TASKS, "test:all:suite"]);

    tasks.get("test:all:suite")?.resolve({ name: "test:all:suite", code: 0 });
    assertEquals(await resultPromise, { exitCode: 0, failures: [] });
});

Deno.test("runCi starts one test after a successful pre-test wave", async () => {
    const starts: CiTaskName[] = [];
    const result = await runCi((taskName) => {
        starts.push(taskName);
        return Promise.resolve({ name: taskName, code: 0 });
    });

    assertEquals(starts, [...PRE_TEST_TASKS, "test:all:suite"]);
    assertEquals(result, { exitCode: 0, failures: [] });
});

Deno.test("runCi reports all failed pre-test tasks and skips test", async () => {
    const starts: CiTaskName[] = [];
    const failed = new Map<CiTaskName, number>([
        ["lint", 2],
        ["doc-links:check", 3],
    ]);

    const result = await runCi((taskName) => {
        starts.push(taskName);
        return Promise.resolve({ name: taskName, code: failed.get(taskName) ?? 0 });
    });

    assertEquals(starts, [...PRE_TEST_TASKS]);
    assertEquals(result, {
        exitCode: 1,
        failures: [
            { name: "lint", code: 2 },
            { name: "doc-links:check", code: 3 },
        ],
    });
});

Deno.test("runCi converts a process-start error into a failed pre-test result and waits for siblings", async () => {
    const starts: CiTaskName[] = [];
    const tasks = new Map<CiTaskName, DeferredTask>();
    const resultPromise = runCi((taskName) => {
        starts.push(taskName);
        if (taskName === "snip:check") throw new Error("could not start subprocess");
        const deferred = deferredTask();
        tasks.set(taskName, deferred);
        return deferred.promise;
    });

    await flushPromises();
    assertEquals(starts, [...PRE_TEST_TASKS]);

    for (const taskName of PRE_TEST_TASKS) {
        if (taskName === "snip:check") continue;
        const exitCode = taskName === "seams:check" ? 4 : 0;
        tasks.get(taskName)?.resolve({ name: taskName, code: exitCode });
    }

    assertEquals(await resultPromise, {
        exitCode: 1,
        failures: [
            { name: "snip:check", code: 1 },
            { name: "seams:check", code: 4 },
        ],
    });
    assertEquals(starts.includes("test:all:suite"), false);
});

Deno.test("runCi preserves a failed test exit code", async () => {
    const result = await runCi((taskName) =>
        Promise.resolve({
            name: taskName,
            code: taskName === "test:all:suite" ? 7 : 0,
        })
    );

    assertEquals(result, {
        exitCode: 7,
        failures: [{ name: "test:all:suite", code: 7 }],
    });
});

Deno.test("source-only CI supports the independently required Golden job", async () => {
    const starts: CiTaskName[] = [];
    const result = await runCi((name) => {
        starts.push(name);
        return Promise.resolve({ name, code: 0 });
    }, { sourceOnly: true });
    assertEquals(starts, [...PRE_TEST_TASKS, "test:suite"]);
    assertEquals(result, { exitCode: 0, failures: [] });
});
