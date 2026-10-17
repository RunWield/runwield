import type { spawn } from "bun";
import process from "node:process";
import { cleanupStoredPublication, loadPublicationAttempt } from "../publication-machine.ts";

const [projectRoot, boundary] = process.argv.slice(2);
const attempt = await loadPublicationAttempt(projectRoot, "attempt-demo");
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
    return nativeSpawn(options);
};
await cleanupStoredPublication(projectRoot, attempt);
