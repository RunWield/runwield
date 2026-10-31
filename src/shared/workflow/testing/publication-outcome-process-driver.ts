import type { spawn } from "bun";
import fsPromises from "node:fs/promises";
import { readFileSync } from "node:fs";
import { mock } from "bun:test";
import { controllerRecordPath } from "../controller-registry.ts";
import { getWorkflowMetricsFilePath } from "../metrics.js";
import type { PublicationAttempt } from "../publication-attempt.ts";
import process from "node:process";
import { cleanupStoredPublication, loadPublicationAttempt } from "../publication-machine.ts";

const [projectRoot, boundary, supplied] = process.argv.slice(2);
const attempt: PublicationAttempt | null = supplied
    ? JSON.parse(supplied)
    : await loadPublicationAttempt(projectRoot, "attempt-demo");
if (!attempt) throw new Error("Publication fixture is missing");

// Interrupt at the real Git subprocess boundary, without replacing publication
// storage, transition logic, or journal writes.
interface FixtureSpawnOptions {
    cmd: string[];
}
interface FixtureRuntime {
    spawn(options: FixtureSpawnOptions): ReturnType<typeof spawn>;
}
const runtime = Reflect.get(globalThis, "Bun") as FixtureRuntime;
const nativeSpawn = runtime.spawn.bind(runtime);
let metadataReads = 0;
let injectedFaults = 0;
runtime.spawn = (options) => {
    const [executable, ...args] = options.cmd;
    if (
        executable === "git" &&
        (boundary === "before"
            ? args[0] === "merge-base"
            : boundary === "after" && args[0] === "worktree" && args[1] === "remove")
    ) {
        process.kill(process.pid, "SIGKILL");
    }
    if (executable === "git" && args[0] === "show" && args[1] === `${attempt.artifactCommit}:docs/plans/demo.md`) {
        metadataReads++;
        const redundantRead = metadataReads === (boundary.endsWith("early") ? 1 : 2);
        if (boundary.startsWith("metadata-") && redundantRead) {
            injectedFaults++;
            if (boundary.includes("throw")) throw new Error("private filesystem diagnostic must not be retained");
            return nativeSpawn({
                ...options,
                cmd: [
                    process.execPath,
                    "-e",
                    `await Bun.sleep(5500); const child = Bun.spawn(${JSON.stringify(options.cmd)}, {stdin:"ignore", stdout:"inherit", stderr:"inherit"}); process.exit(await child.exited);`,
                ],
            });
        }
    }
    return nativeSpawn(options);
};
let coverageFaults = 0;
let coverageFaultStarted = 0;
const nativeReadFile = fsPromises.readFile;
const controllerPath = controllerRecordPath(projectRoot, { planId: attempt.planId, planName: attempt.planName });
const readFileWithFault = async (...args: Parameters<typeof nativeReadFile>) => {
    if (args[0] === controllerPath && boundary.startsWith("coverage-")) {
        let recorded = false;
        try {
            recorded = readFileSync(getWorkflowMetricsFilePath(projectRoot), "utf8").includes(
                '"event":"publication_confirmed"',
            );
        } catch {
            /* The journal has not been created yet. */
        }
        if (recorded) {
            coverageFaults++;
            coverageFaultStarted ||= Date.now();
            if (boundary.includes("throw")) throw new Error("private controller filesystem diagnostic");
            await new Promise((resolve) => setTimeout(resolve, 5500));
        }
    }
    return await nativeReadFile(...args);
};
if (boundary.startsWith("coverage-"))
    mock.module("node:fs/promises", () => ({ ...fsPromises, readFile: readFileWithFault }));
const started = Date.now();
const result = await cleanupStoredPublication(projectRoot, attempt);
console.log(
    JSON.stringify({
        complete: result.complete,
        attempt: result.attempt,
        elapsedMs: Date.now() - started,
        metadataReads,
        injectedFaults,
        coverageFaults,
        afterCoverageFaultMs: coverageFaultStarted ? Date.now() - coverageFaultStarted : null,
    }),
);
