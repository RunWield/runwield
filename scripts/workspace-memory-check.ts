import { removeExecutableFixtureDirectory } from "../src/testing/runtime-executable-fixture.ts";
import { captureScriptProcess } from "./script-process.ts";
import { getCwd } from "../src/constants.js";
import { type NativeProcess, spawnNativeProcess } from "../src/shared/foreground-process.ts";
import { mkdir as fsMkdir, mkdtemp as fsMkdtemp, rm as fsRm, stat as fsStat } from "node:fs/promises";
import { tmpdir } from "node:os";
import process from "node:process";
// Run isolated source and standalone renderer, saved-operation, and combined workloads.
import { join, resolve } from "node:path";
import { compileBun } from "./compile-bun.ts";
import { sha256File } from "./build-metadata.js";

interface Sample {
    type: string;
    label: string;
    heapUsed: number;
    external: number;
    rss: number;
    responses: number;
    standalone: boolean;
    scenario?: string;
    completed?: number;
    pages?: number;
}

interface Result {
    samples: Sample[];
    stdout: string;
}

const decoder = new TextDecoder();
const fixturePath = resolve("scripts/workspace-memory-fixture.ts");
const sourcePath = resolve("dist/workspace-bun/server/entry.mjs");
const timeoutMs = 210_000;

async function run(
    command: string,
    args: string[],
    env?: Record<string, string>,
    timeout = timeoutMs,
): Promise<Result> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort("timeout"), timeout);
    try {
        const output = await captureScriptProcess(command, {
            args,
            env,
            signal: controller.signal,
            stdout: "piped",
            stderr: "piped",
        });
        const stdout = decoder.decode(output.stdout);
        const stderr = decoder.decode(output.stderr);
        if (!output.success) {
            throw new Error(`INCOMPLETE: ${command} ${args.join(" ")} exited ${output.code}\n${stdout}\n${stderr}`);
        }
        return {
            stdout,
            samples: stdout
                .split("\n")
                .filter(Boolean)
                .map((line) => JSON.parse(line))
                .filter((entry) => entry.type === "sample"),
        };
    } catch (error) {
        if (controller.signal.aborted) throw new Error(`INCOMPLETE: subprocess exceeded ${timeout} ms: ${command}`);
        throw error;
    } finally {
        clearTimeout(timer);
    }
}

async function isolatedRoot(): Promise<{ root: string; env: Record<string, string> }> {
    const root = await fsMkdtemp(join(tmpdir(), "runwield-workspace-memory-"));
    const home = join(root, "home");
    await fsMkdir(home);
    return {
        root,
        env: {
            HOME: home,
            MNEMOTECA_DB_PATH: join(root, "memory.sqlite3"),
            WLD_MEMORY_FIXTURE_ROOT: root,
            WLD_WORKSPACE_DISABLE_BUILT_SERVER: "0",
        },
    };
}

async function compiledBinary(root: string): Promise<string> {
    const output = join(
        root,
        process.platform === "win32" ? "workspace-memory-fixture.exe" : "workspace-memory-fixture",
    );
    // Use the production payload builder with the real diagnostic entrypoint.
    await compileBun(output, undefined, undefined, undefined, "scripts/workspace-memory-fixture.ts");
    return output;
}

function assertSamples(result: Result, gc: boolean, standalone: boolean, scenario: string): void {
    const samples = result.samples;
    if (samples.length !== 3 || samples.map((s) => s.label).join(",") !== "baseline,batch-1,batch-2") {
        throw new Error(`INCOMPLETE: expected baseline and two complete batches: ${result.stdout}`);
    }
    if (samples.some((s) => s.standalone !== standalone || s.rss >= 1024 ** 3)) {
        throw new Error(`INCOMPLETE: wrong runtime or RSS guard: ${result.stdout}`);
    }
    if (scenario === "renderer") {
        const batchSize = samples[1].responses - samples[0].responses;
        if (batchSize < 70 || samples[2].responses - samples[1].responses !== batchSize) {
            throw new Error(`INCOMPLETE: request counts differ: ${result.stdout}`);
        }
    } else if (
        samples.some((s) => s.scenario !== scenario) ||
        samples.map((s) => s.completed).join(",") !== "0,10,20" ||
        samples.map((s) => s.pages).join(",") !== (scenario === "combined" ? "12,132,252" : "0,0,0")
    ) {
        throw new Error(`INCOMPLETE: fixed operation/page batches differ: ${result.stdout}`);
    }
    if (gc && samples[2].external - samples[1].external > 4 * 1024 ** 2) {
        throw new Error(`Retained external buffers grew more than 4 MiB: ${result.stdout}`);
    }
    if (gc && samples[2].heapUsed - samples[1].heapUsed > 10 * 1024 ** 2) {
        throw new Error(`Retained heap grew more than 10 MiB: ${result.stdout}`);
    }
}

async function measure(scenario: "renderer" | "operations" | "combined"): Promise<void> {
    await fsStat(sourcePath);
    const { root } = await isolatedRoot();
    try {
        const binary = await compiledBinary(root);
        const hash = await sha256File(binary);
        console.log(
            JSON.stringify({
                type: "artifact",
                path: binary,
                sha256: hash,
                source: sourcePath,
                sourceSha256: await sha256File(sourcePath),
            }),
        );
        for (const [label, command, standalone] of [
            ["source", process.execPath, false],
            ["compiled", binary, true],
        ] as const) {
            for (const gc of [true, false]) {
                const workload =
                    scenario === "renderer" ? [] : [scenario === "combined" ? "--combined" : "--operations"];
                const args = standalone
                    ? ["--measure", ...workload, ...(gc ? ["--gc"] : [])]
                    : [fixturePath, "--measure", ...workload, ...(gc ? ["--gc"] : [])];
                const isolated = await isolatedRoot();
                try {
                    const result = await run(command, args, isolated.env);
                    assertSamples(result, gc, standalone, scenario);
                    console.log(
                        JSON.stringify({
                            type: "outcome",
                            scenario,
                            mode: label,
                            flags: gc ? "forced-gc" : "production-default",
                            samples: result.samples,
                        }),
                    );
                } finally {
                    await fsRm(isolated.root, { recursive: true });
                }
            }
        }
    } finally {
        await removeExecutableFixtureDirectory(root);
    }
}

async function serve(): Promise<void> {
    const { root, env } = await isolatedRoot();
    let child: NativeProcess | undefined;
    try {
        const binary = await compiledBinary(root);
        child = spawnNativeProcess(binary, {
            args: ["--serve"],
            cwd: getCwd(),
            stdin: "null",
            env,
            stdout: "piped",
            stderr: "inherit",
        });
        const reader = child.stdout.getReader();
        const first = await Promise.race([
            reader.read(),
            new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Fixture startup timeout")), 60_000)),
        ]);
        const line = decoder.decode(first.value).split("\n")[0];
        const listening = JSON.parse(line);
        if (listening.type !== "listening" || !listening.url) throw new Error(`Fixture did not start: ${line}`);
        console.log(`Fixture URL: ${listening.url}/`);
        console.log(`Fixture routes: ${JSON.stringify(listening.routes)}`);
        console.log(`Memory samples: ${listening.url}/__memory`);
        console.log(`Shutdown: kill -INT ${process.pid} (or Ctrl-C)`);
        const onInterrupt = () => child?.kill("SIGTERM");
        process.on("SIGINT", onInterrupt);
        process.on("SIGTERM", onInterrupt);
        try {
            await child.status;
        } finally {
            process.off("SIGINT", onInterrupt);
            process.off("SIGTERM", onInterrupt);
        }
    } finally {
        if (child) {
            try {
                child.kill("SIGTERM");
            } catch {
                /* already exited */
            }
            await child.status;
        }
        await removeExecutableFixtureDirectory(root);
    }
}

if (import.meta.main) {
    const arg = process.argv.slice(2).join(" ");
    if (arg === "--scenario renderer" || arg === "--scenario operations" || arg === "--scenario combined") {
        await measure(arg.split(" ")[1] as "renderer" | "operations" | "combined");
    } else if (arg === "--serve-fixture") await serve();
    else throw new Error("Usage: --scenario renderer|operations|combined | --serve-fixture");
}
