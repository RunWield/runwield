import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { withRuntimeCommandFixture } from "../../src/cmd/testing/runtime-command-fixture.ts";
import { captureForegroundProcess } from "../../src/shared/captured-process.ts";
import { main } from "../run-reviewer-benchmark.ts";
import { checkoutRoot } from "./configuration.ts";
import { materializeFixture } from "./materialize.ts";
import { readRun } from "./records.ts";
import { selectCases } from "./run.ts";
import { inspectionSteps } from "./test-fixtures.ts";

test("the executable prints help without model credentials", async () => {
    const result = await captureForegroundProcess("bun", {
        cwd: checkoutRoot,
        args: ["scripts/run-reviewer-benchmark.ts", "--help"],
        timeoutMs: 30000,
    });
    assert.equal(result.code, 0);
    const help = new TextDecoder().decode(result.stdout);
    assert.match(help, /--scenarios smoke\|all\|RV-D04,RV-D05\|RV-D04\/A,RV-D04\/B/);
    assert.doesNotMatch(help, /smoke benchmark/);
});

for (const args of [
    ["invalid"],
    ["run", "extra"],
    ["score"],
    ["score", "directory", "--resume"],
    ["run", "--timeout-ms", "no"],
    ["run", "--timeout-ms", "0"],
    ["run", "--unrecognized"],
]) {
    test(`CLI rejects invalid arguments ${args.join(" ")}`, async () => {
        await assert.rejects(main(args));
    });
}

test("the CLI runs the real Reviewer into the default home directory, resumes, then scores without a model call", async () => {
    await withRuntimeCommandFixture(
        "benchmark-cli-",
        async (runtime) => {
            const selected = await selectCases("RV-D04/B");
            const project = await materializeFixture(selected[0].fixture, "B");
            try {
                runtime.setModelResponseFactories([
                    ...inspectionSteps(project.diffText),
                    () =>
                        fauxAssistantMessage(
                            fauxToolCall("review_complete", {
                                approved: true,
                                feedback: "",
                                findings: [],
                                advisories: [],
                            }),
                        ),
                ]);
            } finally {
                await project.cleanup();
            }
            await main([
                "run",
                "--scenarios",
                "RV-D04/B",
                "--model",
                "runtime-command-fixture/alternate-model",
                "--timeout-ms",
                "10000",
            ]);
            const root = join(runtime.homeDir, ".wld/reviewer-eval");
            const directories = await readdir(root);
            assert.equal(directories.length, 1);
            const out = join(root, directories[0]);
            const saved = await readRun(out);
            assert.equal(saved.results[0].kind, "complete");
            assert.deepEqual(
                saved.manifest.cases.map((entry) => entry.caseId),
                ["RV-D04/B"],
            );
            assert.equal(saved.manifest.timeoutMs, 10000);
            assert.equal(saved.results[0].model, "alternate-model");
            let modelCalls = 0;
            runtime.setModelResponseFactory(() => {
                modelCalls++;
                throw new Error("Saved results need no model call");
            });
            await main([
                "run",
                "--scenarios",
                "RV-D04/B",
                "--out",
                out,
                "--resume",
                "--timeout-ms",
                "10000",
                "--model",
                "runtime-command-fixture/alternate-model",
            ]);
            await main(["score", out]);
            assert.equal(modelCalls, 0);
            const summary = await readFile(join(out, "summary.md"), "utf8");
            assert.match(summary, /Decision accuracy: 1\/1/);
            assert.match(summary, /pending adjudication/);
        },
        { additionalModels: [{ id: "alternate-model", name: "Explicit CLI model" }] },
    );
});
