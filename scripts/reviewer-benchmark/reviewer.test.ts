import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fauxAssistantMessage, fauxText, fauxToolCall, type FauxResponseFactory } from "@earendil-works/pi-ai";
import { withRuntimeCommandFixture } from "../../src/cmd/testing/runtime-command-fixture.ts";
import { getModelRegistry } from "../../src/shared/models/model-registry.ts";
import { setExactProjectCustomSetting } from "../../src/shared/settings.js";
import { getWorkflowMetricsFilePath } from "../../src/shared/workflow/metrics.js";
import { parseDiffFiles } from "../../src/shared/workflow/review-diff-tool.js";
import { loadFixture } from "./fixtures.ts";
import { materializeFixture } from "./materialize.ts";
import type { MaterializedProject } from "./materialize.ts";
import { runFixtureReview } from "./reviewer.ts";
import { corpusPath, rawGit, inspectionSteps } from "./test-fixtures.ts";

interface UsageMetric {
    event: string;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
}

const fixturePath = join(corpusPath, "RV-D04");
const finding = {
    resolved: false,
    status: "new" as const,
    title: "A cached value crosses the tenant boundary",
    requirement: "Cache isolation",
    evidence: "src/browser.ts: a shared key returns the previous tenant's result",
    rejectionReason: "",
};
const advisory = { title: "Keep cache behavior documented", detail: "The public contract should state its lifetime." };

function approveSteps(project: MaterializedProject): FauxResponseFactory[] {
    return [
        ...inspectionSteps(project.diffText),
        () =>
            fauxAssistantMessage(
                fauxToolCall("review_complete", {
                    approved: true,
                    feedback: "No blocking defect found.",
                    findings: [],
                    advisories: [advisory],
                }),
            ),
    ];
}

test("premature completion is refused, nudged, then returns the exact accepted finding", async () => {
    await withRuntimeCommandFixture("benchmark-review-gate-", async (runtime) => {
        const fixture = await loadFixture(fixturePath);
        const project = await materializeFixture(fixture, "A");
        let rejected = false;
        let nudged = false;
        const requests: string[] = [];
        const factories: FauxResponseFactory[] = [
            () => fauxAssistantMessage(fauxToolCall("review_complete", { approved: true })),
            (context) => {
                rejected = context.messages.some(
                    (message) =>
                        message.role === "toolResult" &&
                        message.content.some(
                            (block) =>
                                block.type === "text" &&
                                /Review is incomplete\. Read every remaining diff chunk/.test(block.text),
                        ),
                );
                return fauxAssistantMessage(fauxText("I have not completed the inspection."));
            },
            (context) => {
                nudged = JSON.stringify(context.messages).includes("No review_complete was accepted");
                return fauxAssistantMessage(fauxToolCall("review_diff", { command: "list" }));
            },
            ...inspectionSteps(project.diffText).slice(1),
            () =>
                fauxAssistantMessage(
                    fauxToolCall("review_complete", {
                        approved: false,
                        feedback: "",
                        findings: [finding],
                        advisories: [advisory],
                    }),
                ),
        ];
        runtime.setModelResponseFactories(
            factories.map((response) => (context, ...rest) => {
                requests.push(JSON.stringify(context));
                return response(context, ...rest);
            }),
        );
        try {
            const result = await runFixtureReview(project, fixture, { timeoutMs: 10000 });
            assert.equal(result.kind, "complete");
            assert.equal(rejected, true);
            assert.equal(nudged, true);
            assert.equal(result.nudgeAttempts, 1);
            assert.deepEqual(result.outcome, {
                outcome: "feedback",
                approved: false,
                feedback: `- ${finding.title}\n  Plan: ${finding.requirement}\n  Evidence: ${finding.evidence}`,
                findings: [{ id: undefined, ...finding }],
                advisories: [advisory],
                integrationNotes: [],
            });
            assert.equal(result.model, "fixture-model");
            assert.equal(result.provider, "runtime-command-fixture");
            assert.equal(result.toolCallCount, factories.length - 1);
            assert.equal(typeof result.tokens.input, "number");
            assert.ok(result.elapsedMs > 0);
            const journal = await readFile(getWorkflowMetricsFilePath(project.cwd), "utf8");
            const usage = journal
                .trim()
                .split("\n")
                .map((line) => JSON.parse(line) as UsageMetric)
                .filter((record) => record.event === "model_usage");
            assert.ok(usage.length > 0);
            assert.deepEqual(
                result.tokens,
                usage.reduce(
                    (total, record) => ({
                        input: total.input + record.inputTokens,
                        output: total.output + record.outputTokens,
                        cacheRead: total.cacheRead + record.cacheReadTokens,
                        cacheWrite: total.cacheWrite + record.cacheWriteTokens,
                    }),
                    { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                ),
            );
            for (const secret of [
                finding.title,
                finding.evidence,
                advisory.detail,
                project.planContent,
                project.diffText,
            ]) {
                assert.equal(journal.includes(secret), false);
            }
            const prompts = requests.join("\n");
            assert.equal(prompts.includes(fixture.packageDir), false);
            assert.equal(prompts.includes("oracle.yaml"), false);
            for (const defect of fixture.oracle.variants.A!.defects) {
                assert.equal(prompts.includes(defect.defectId), false);
                assert.equal(prompts.includes(defect.expectedFailureMarker), false);
            }
            assert.equal(
                await rawGit(project.cwd, ["diff", "--name-only", "main"]),
                parseDiffFiles(project.diffText)
                    .map((file) => `${file.path}\n`)
                    .sort()
                    .join(""),
            );
        } finally {
            await project.cleanup();
        }
    });
});

test("full inspection can approve with the supplied advisory", async () => {
    await withRuntimeCommandFixture("benchmark-review-approve-", async (runtime) => {
        const fixture = await loadFixture(fixturePath);
        const project = await materializeFixture(fixture, "B");
        runtime.setModelResponseFactories(approveSteps(project));
        try {
            const result = await runFixtureReview(project, fixture);
            assert.equal(result.kind, "complete");
            assert.equal(result.outcome?.approved, true);
            assert.deepEqual(result.outcome?.findings, []);
            assert.deepEqual(result.outcome?.advisories, [advisory]);
            assert.equal(result.nudgeAttempts, 0);
        } finally {
            await project.cleanup();
        }
    });
});

test("Reviewer selection is captured from the source preset and an explicit model overrides it", async () => {
    await withRuntimeCommandFixture(
        "benchmark-review-model-",
        async (runtime) => {
            setExactProjectCustomSetting("activeModelPreset", "review", runtime.projectRoot);
            setExactProjectCustomSetting(
                "modelPresets",
                {
                    review: {
                        agents: { reviewer: { model: "runtime-command-fixture/alternate-model", temperature: 0.4 } },
                    },
                },
                runtime.projectRoot,
            );
            const fixture = await loadFixture(fixturePath);
            for (const model of [undefined, "runtime-command-fixture/fixture-model"]) {
                const project = await materializeFixture(fixture, "B");
                const temperatures: (number | undefined)[] = [];
                runtime.setModelResponseFactories(
                    approveSteps(project).map((response) => (context, options, ...rest) => {
                        temperatures.push(options?.temperature);
                        return response(context, options, ...rest);
                    }),
                );
                try {
                    const result = await runFixtureReview(project, fixture, {
                        configurationRoot: runtime.projectRoot,
                        model,
                    });
                    assert.equal(result.kind, "complete");
                    assert.equal(result.model, model ? "fixture-model" : "alternate-model");
                    assert.ok(temperatures.length > 0 && temperatures.every((value) => value === 0.4));
                } finally {
                    await project.cleanup();
                }
            }
        },
        { additionalModels: [{ id: "alternate-model", name: "Alternate reviewer" }] },
    );
});

for (const prerequisite of ["missing model", "unknown model", "missing credentials"]) {
    test(`${prerequisite} rejects before any model turn`, async () => {
        await withRuntimeCommandFixture(
            "benchmark-review-prerequisite-",
            async (runtime) => {
                const fixture = await loadFixture(fixturePath);
                const project = await materializeFixture(fixture, "A");
                let calls = 0;
                runtime.setModelResponseFactory(() => {
                    calls += 1;
                    throw new Error("A prerequisite failure must not reach the model");
                });
                if (prerequisite === "missing credentials") {
                    await writeFile(join(runtime.homeDir, ".wld/auth.json"), "{}");
                    const path = join(runtime.homeDir, ".wld/models.json");
                    await writeFile(path, (await readFile(path, "utf8")).replace('"apiKey":"fixture-key",', ""));
                    await getModelRegistry().refresh();
                }
                try {
                    await assert.rejects(
                        runFixtureReview(project, fixture, {
                            ...(prerequisite === "unknown model"
                                ? { model: "runtime-command-fixture/missing-model" }
                                : {}),
                        }),
                        prerequisite === "missing credentials" ? /No API key/ : /No configured model|Unknown .*model/,
                    );
                    assert.equal(calls, 0);
                } finally {
                    await project.cleanup();
                }
            },
            { providerState: prerequisite === "missing model" ? "provider-no-model" : "default" },
        );
    });
}

test("missing completion pauses without inventing a verdict", async () => {
    await withRuntimeCommandFixture("benchmark-review-pause-", async (runtime) => {
        const fixture = await loadFixture(fixturePath);
        const project = await materializeFixture(fixture, "A");
        runtime.setModelResponseFactories(
            Array.from({ length: 4 }, () => () => fauxAssistantMessage(fauxText("I could not finish the review."))),
        );
        try {
            const result = await runFixtureReview(project, fixture);
            assert.equal(result.kind, "paused");
            assert.equal(result.outcome, undefined);
            assert.match(result.reason!, /Protocol correction budget is spent/);
            assert.equal(result.nudgeAttempts, 3);
        } finally {
            await project.cleanup();
        }
    });
});

test("provider failure pauses without inventing a verdict", async () => {
    await withRuntimeCommandFixture("benchmark-review-provider-", async (runtime) => {
        const fixture = await loadFixture(fixturePath);
        const project = await materializeFixture(fixture, "A");
        setExactProjectCustomSetting("retry.enabled", false, project.cwd);
        runtime.setModelResponseFactory(() => {
            throw new Error("Synthetic provider outage");
        });
        try {
            const result = await runFixtureReview(project, fixture);
            assert.equal(result.kind, "paused");
            assert.equal(result.outcome, undefined);
            assert.match(result.reason!, /provider|model/i);
            // The faux provider reports zero usage even for its error response.
            assert.deepEqual(result.tokens, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
        } finally {
            await project.cleanup();
        }
    });
});

test("timeout settles provider work before returning and a new project can complete", async () => {
    await withRuntimeCommandFixture("benchmark-review-timeout-", async (runtime) => {
        const fixture = await loadFixture(fixturePath);
        const first = await materializeFixture(fixture, "A");
        let calls = 0;
        let settled = false;
        runtime.setModelResponseFactory(async (_context, options) => {
            calls += 1;
            await new Promise<void>((resolve) => {
                if (options?.signal?.aborted) resolve();
                else options?.signal?.addEventListener("abort", () => resolve(), { once: true });
            });
            settled = true;
            return fauxAssistantMessage(fauxText("Canceled review"));
        });
        try {
            const result = await runFixtureReview(first, fixture, { timeoutMs: 300 });
            assert.equal(result.kind, "timeout");
            assert.equal(result.outcome, undefined);
            assert.equal(settled, true);
            assert.equal(calls, 1);
            assert.ok(result.elapsedMs >= 300);
            await new Promise((resolve) => setTimeout(resolve, 40));
            assert.equal(calls, 1);
        } finally {
            await first.cleanup();
        }
        const second = await materializeFixture(fixture, "B");
        runtime.setModelResponseFactories(approveSteps(second));
        try {
            const result = await runFixtureReview(second, fixture);
            assert.equal(result.kind, "complete");
            assert.equal(result.outcome?.approved, true);
        } finally {
            await second.cleanup();
        }
    });
});

test("timeout during setup starts no late model turn and leaves absent usage unavailable", async () => {
    await withRuntimeCommandFixture("benchmark-review-setup-timeout-", async (runtime) => {
        const fixture = await loadFixture(fixturePath);
        const project = await materializeFixture(fixture, "A");
        let calls = 0;
        runtime.setModelResponseFactory(() => {
            calls += 1;
            return fauxAssistantMessage(fauxText("Unexpected late turn"));
        });
        try {
            const result = await runFixtureReview(project, fixture, { timeoutMs: 1 });
            assert.equal(result.kind, "timeout");
            assert.deepEqual(result.tokens, {
                input: "unavailable",
                output: "unavailable",
                cacheRead: "unavailable",
                cacheWrite: "unavailable",
            });
            assert.equal(calls, 0);
            await new Promise((resolve) => setTimeout(resolve, 40));
            assert.equal(calls, 0);
        } finally {
            await project.cleanup();
        }
    });
});

test("a source-project default thinking level reaches the isolated Reviewer", async () => {
    await withRuntimeCommandFixture(
        "benchmark-review-default-thinking-",
        async (runtime) => {
            setExactProjectCustomSetting("defaultThinkingLevel", "high", runtime.projectRoot);
            const fixture = await loadFixture(fixturePath);
            const project = await materializeFixture(fixture, "B");
            const observed: (string | undefined)[] = [];
            runtime.setModelResponseFactories(
                approveSteps(project).map((factory) => (context, options, ...rest) => {
                    observed.push(options?.reasoning);
                    return factory(context, options, ...rest);
                }),
            );
            try {
                const result = await runFixtureReview(project, fixture, { configurationRoot: runtime.projectRoot });
                assert.equal(result.kind, "complete");
                assert.ok(observed.length > 0 && observed.every((level) => level === "high"));
            } finally {
                await project.cleanup();
            }
        },
        { reasoning: true },
    );
});
