#!/usr/bin/env -S deno run -A

import { runWithSnip, writeSnipCommandResult } from "./run-with-snip.ts";

export const PRE_TEST_TASKS = [
    "submodules:check",
    "snip:check",
    "check",
    "workspace:check",
    "lint",
    "language-policy:check",
    "seams:check",
    "doc-links:check",
    "docs:check",
    "skills:sync:check",
    // The suites below skip the build their everyday tasks run first; building
    // here overlaps it with the checks instead of serializing it before tests.
    "workspace:build",
] as const;

export type CiTaskName = typeof PRE_TEST_TASKS[number] | "test:suite" | "test:all:suite";

export interface CiTaskResult {
    name: CiTaskName;
    code: number;
    elapsedMs?: number;
}

export interface CiResult {
    exitCode: number;
    failures: CiTaskResult[];
}

export type ExecuteCiTask = (taskName: CiTaskName) => Promise<CiTaskResult>;

function failedStartResult(taskName: CiTaskName): CiTaskResult {
    return { name: taskName, code: 1 };
}

async function settleTask(taskName: CiTaskName, executeTask: ExecuteCiTask): Promise<CiTaskResult> {
    try {
        return await executeTask(taskName);
    } catch {
        return failedStartResult(taskName);
    }
}

function failedTasks(results: CiTaskResult[]): CiTaskResult[] {
    return results.filter((result) => result.code !== 0);
}

function printFailureSummary(failures: CiTaskResult[]): void {
    if (failures.length === 0) return;
    console.error("CI failed tasks:");
    for (const failure of failures) {
        console.error(`- ${failure.name}: exit ${failure.code}`);
    }
}

export interface CiOptions {
    sourceOnly?: boolean;
}

export async function runCi(executeTask: ExecuteCiTask, options: CiOptions = {}): Promise<CiResult> {
    const preTestRuns = PRE_TEST_TASKS.map((taskName) => settleTask(taskName, executeTask));
    const preTestResults = await Promise.all(preTestRuns);
    const preTestFailures = failedTasks(preTestResults);

    if (preTestFailures.length > 0) {
        printFailureSummary(preTestFailures);
        return { exitCode: 1, failures: preTestFailures };
    }

    const testResult = await settleTask(options.sourceOnly ? "test:suite" : "test:all:suite", executeTask);
    const testFailures = failedTasks([testResult]);
    printFailureSummary(testFailures);
    return { exitCode: testResult.code, failures: testFailures };
}

async function executeDenoTask(taskName: CiTaskName, failFast: boolean): Promise<CiTaskResult> {
    const start = performance.now();
    const args = ["task", "-q", taskName];
    if (failFast && (taskName === "test:suite" || taskName === "test:all:suite")) args.push("--fail-fast");
    const result = await runWithSnip("deno", args, {
        stdin: "inherit",
        failureLabel: `ci ${taskName}`,
        quietOnSuccess: true,
    });
    await writeSnipCommandResult(result);
    return { name: taskName, code: result.code, elapsedMs: performance.now() - start };
}

function formatElapsed(elapsedMs: number): string {
    if (elapsedMs < 1000) return `${Math.round(elapsedMs)}ms`;
    return `${(elapsedMs / 1000).toFixed(1)}s`;
}

if (import.meta.main) {
    if (Deno.args.some((arg) => arg !== "--source-only" && arg !== "--fail-fast")) {
        throw new Error("usage: deno task ci [--source-only] [--fail-fast]");
    }
    const start = performance.now();
    const timings: CiTaskResult[] = [];
    const result = await runCi(async (name) => {
        const task = await executeDenoTask(name, Deno.args.includes("--fail-fast"));
        timings.push(task);
        return task;
    }, { sourceOnly: Deno.args.includes("--source-only") });
    await Deno.mkdir(".ci-cache", { recursive: true });
    await Deno.writeTextFile(
        ".ci-cache/ci-timings.json",
        JSON.stringify(
            {
                elapsedMs: performance.now() - start,
                tasks: timings,
            },
            null,
            2,
        ) + "\n",
    );
    if (result.exitCode === 0) console.log(`CI passed (${formatElapsed(performance.now() - start)})`);
    Deno.exit(result.exitCode);
}
