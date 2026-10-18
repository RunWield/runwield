import { captureScriptProcess } from "./script-process.ts";
import { runtimeSourceArgs } from "../src/testing/runtime-source-args.ts";
import { getCwd } from "../src/constants.js";
import {
    mkdtemp as fsMkdtemp,
    readFile as fsReadFile,
    rm as fsRm,
    stat as fsStat,
    writeFile as fsWriteFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { test } from "node:test";
import process from "node:process";
import { assertEquals, assertThrows } from "../src/testing/assertions.ts";
import { join } from "node:path";
import { parseRunnerArguments, selectTestShard } from "./run-tests.js";
import { mergeTestTimings, orderTestsByTiming, readTestTimings, writeTestTimings } from "./test-timings.js";

test("test runner parses scheduling controls without passing them to Deno", () => {
    const parsed = parseRunnerArguments([
        "--fail-fast",
        "--timings-file",
        ".ci-cache/golden-timings.json",
        "--isolated",
        "src/ui/tui/testing",
    ]);

    assertEquals(parsed.failFast, true);
    assertEquals(parsed.timingsFile?.endsWith(join(".ci-cache", "golden-timings.json")), true);
    assertEquals(parsed.rest, ["--isolated", "src/ui/tui/testing"]);
});

test("historical timings schedule slow files first and place new files near the median", () => {
    const root = "/repo";
    const files = ["fast.test.ts", "new.test.ts", "slow.test.ts", "middle.test.ts"].map((file) => join(root, file));
    const ordered = orderTestsByTiming(files, root, {
        "fast.test.ts": { durationMs: 10, runs: 3 },
        "middle.test.ts": { durationMs: 50, runs: 3 },
        "slow.test.ts": { durationMs: 100, runs: 3 },
    });

    assertEquals(
        ordered.map((file) => file.slice(root.length + 1)),
        ["slow.test.ts", "middle.test.ts", "new.test.ts", "fast.test.ts"],
    );
});

test("the first observation schedules slow files first without changing membership", () => {
    const root = "/repo";
    const files = ["a.test.ts", "b.test.ts"].map((file) => join(root, file));

    assertEquals(
        orderTestsByTiming(files, root, {
            "a.test.ts": { durationMs: 10, runs: 1 },
            "b.test.ts": { durationMs: 100, runs: 1 },
        }),
        [...files].reverse(),
    );
});

test("test timing history survives invalid cache data and merges recent observations", async () => {
    const root = await fsMkdtemp(join(tmpdir(), "runwield-test-timings-"));
    const path = join(root, "history.json");
    try {
        await fsWriteFile(path, "not json");
        assertEquals(await readTestTimings(path), {});

        const merged = mergeTestTimings({ "a.test.ts": { durationMs: 100, runs: 3 } }, [
            { file: "a.test.ts", durationMs: 200 },
            { file: "b.test.ts", durationMs: 40 },
        ]);
        await writeTestTimings(path, merged);

        assertEquals(await readTestTimings(path), {
            "a.test.ts": { durationMs: 125, runs: 4 },
            "b.test.ts": { durationMs: 40, runs: 1 },
        });
    } finally {
        await fsRm(root, { recursive: true });
    }
});

test("release fail-fast stops scheduling new isolated test files", async () => {
    const root = await fsMkdtemp(join(tmpdir(), "runwield-fail-fast-"));
    const marker = join(root, "later-ran");
    const firstMarker = join(root, "first-ran");
    try {
        await fsWriteFile(
            join(root, "a-failure.test.js"),
            `import {test} from "node:test"; import {writeFile} from "node:fs/promises";
            test("fails", async () => { await writeFile(${JSON.stringify(
                firstMarker,
            )}, "ran"); throw new Error("stop"); });\n`,
        );
        await fsWriteFile(
            join(root, "b-later.test.js"),
            `import {test} from "node:test"; import {writeFile} from "node:fs/promises";
            test("later", async () => { await writeFile(${JSON.stringify(marker)}, "ran"); });\n`,
        );
        const output = await captureScriptProcess(process.execPath, {
            args: process.versions.bun
                ? ["run", "--silent", "test:all:suite", "--fail-fast", "--isolated", root]
                : runtimeSourceArgs(["run", "-A", "scripts/run-tests.js", "--fail-fast", "--isolated", root]),
            cwd: getCwd(),
            env: { WLD_TEST_CONCURRENCY: "1" },
            stdout: "piped",
            stderr: "piped",
        });

        assertEquals(output.success, false);
        assertEquals(await fsReadFile(firstMarker, "utf8"), "ran");
        assertEquals(
            await fsStat(marker)
                .then(() => true)
                .catch(() => false),
            false,
        );
    } finally {
        await fsRm(root, { recursive: true });
    }
});

test("shards cover every file once regardless of discovery order or timing history", () => {
    const files = Array.from({ length: 37 }, (_, index) => `test-${index}.test.ts`);
    const shards = [1, 2, 3, 4].map((index) => selectTestShard([...files].reverse(), `${index}/4`));
    assertEquals(shards.flat().sort(), [...files].sort());
    assertEquals(new Set(shards.flat()).size, files.length);
    assertEquals(selectTestShard(files, "2/4"), shards[1]);
    assertEquals(selectTestShard([], "1/4"), []);
    for (const invalid of ["0/4", "5/4", "1/0", "1", "-1/2", "1/2.5"]) {
        assertThrows(() => selectTestShard(files, invalid), Error, "Invalid test shard");
    }
});
