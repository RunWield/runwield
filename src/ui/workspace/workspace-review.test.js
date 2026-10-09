import { assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { encodeGuidedReviewMetadata } from "../../cmd/guided-review/protocol.ts";

import { PLAN_UI_TOKEN_HEADER } from "../../constants.js";
import { RUNWIELD_ROOT } from "../../../runtime-root.js";
import { workspaceMetadata as _workspaceMetadata } from "./server/plan-adapter.js";

import {
    createReviewWorkspaceApp,
    createWorkspaceApp,
    hasWorkspaceToken,
    startReviewWorkspaceServer,
} from "./server.js";

import {
    createReviewAgentState,
    reviewAgentApi,
    runConfiguredGuideCommand,
} from "./routes/api/review-agent-handlers.js";

import {
    registerReviewDecisionPromise,
    resolveReviewDecision,
    unregisterReviewDecision,
} from "./routes/api/review-handlers.js";
import { withProcessGlobalTestLock } from "../../testing/process-global-lock.ts";
import { makeToolProjectFixture, withWorkflowMetricsFixture } from "../../testing/workflow-metrics-fixture.ts";

// Anchored to the shared runtime root, not Deno.cwd(): test realms share one
// process, so a concurrent file's chdir would otherwise pin this to its temp
// directory.
const TEST_PROJECT_ROOT = RUNWIELD_ROOT;
const REVIEW_AGENT_PROJECT_ROOT = makeToolProjectFixture("runwield-workspace-review-agent-");
const GUIDE_EVENT_PREFIX = "RUNWIELD_GUIDED_REVIEW_EVENT ";

const UNUSED_GUIDE_COMMAND = () => Promise.reject(new Error("Fixture guide command should not run."));

function makeGuideJson(title = "Fixture guide") {
    return JSON.stringify({
        schemaVersion: "1.0",
        title,
        sections: [{
            title: "Core",
            role: "core",
            blocks: [{ type: "diff", file: "src/a.js", summary: "Review the changed export." }],
        }],
        everythingElse: [],
    });
}

function makeGuideReviewPayload() {
    return {
        rawPatch:
            "diff --git a/src/a.js b/src/a.js\n--- a/src/a.js\n+++ b/src/a.js\n@@ -1 +1,2 @@\n export const a = 1;\n+export const b = 2;\n",
    };
}

function shellQuote(value) {
    return `'${value.replaceAll("'", "'\\''")}'`;
}

async function runReviewGuideJob(state) {
    const launch = await reviewAgentApi(
        new Request("http://localhost/api/agents/jobs", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ provider: "guide" }),
        }),
        new URL("http://localhost/api/agents/jobs"),
        state,
    );
    if (!launch) throw new Error("expected job launch response");
    const { job } = await launch.json();
    await state.jobs.get(job.id)?.done;
    return state.jobs.get(job.id)?.info;
}

Deno.test("workspace token accepts query or header and rejects missing tokens", () => {
    assertEquals(hasWorkspaceToken(new Request("http://localhost/?token=abc"), "abc"), true);
    assertEquals(
        hasWorkspaceToken(new Request("http://localhost/", { headers: { [PLAN_UI_TOKEN_HEADER]: "abc" } }), "abc"),
        true,
    );
    assertEquals(hasWorkspaceToken(new Request("http://localhost/"), "abc"), false);
});

Deno.test("workspace static assets bypass token checks for tokenized pages", async () => {
    const app = createWorkspaceApp({ cwd: Deno.cwd(), token: "secret" }).handler();
    for (const path of ["/tokens.css", "/components.css", "/workspace.css", "/theme.css", "/brand/logo.svg"]) {
        const response = await app(new Request(`http://localhost${path}`));
        assertEquals(response.status, 200);
    }
});

Deno.test("review request forwarding does not inherit Deno.serve's legacy abort signal", async () => {
    const script = `
        import { rebuildRequestWithHeaders } from "./src/ui/workspace/server.js";
        const server = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen() {} }, (request) => {
            rebuildRequestWithHeaders(request, new Headers(request.headers));
            return new Response("ok");
        });
        await fetch(\`http://127.0.0.1:\${server.addr.port}\`);
        await server.shutdown();
    `;
    const output = await new Deno.Command(Deno.execPath(), {
        args: ["eval", script],
        cwd: TEST_PROJECT_ROOT,
        stdout: "piped",
        stderr: "piped",
    }).output();

    assertEquals(output.success, true);
    const stderr = new TextDecoder().decode(output.stderr).split("\n").filter((line) => {
        if (line.includes("Download")) return false;
        return !line.includes("Blocking") || !line.includes("waiting for file lock on node_modules directory");
    }).join("\n");
    assertEquals(stderr, "");
});

Deno.test("review server reports stdout through its output callback", async () => {
    /** @type {Array<{ stream: "stdout" | "stderr", text: string }>} */
    const output = [];
    const server = startReviewWorkspaceServer({
        cwd: Deno.cwd(),
        token: "review-output",
        reviewPayload: { plan: "# Plan" },
        reviewType: "plan",
        onOutput: (entry) => output.push(entry),
    });

    await server.stop();

    assertEquals(output.length, 1);
    assertEquals(output[0].stream, "stdout");
    assertStringIncludes(output[0].text, "Listening on http://127.0.0.1:");
});

Deno.test("review page accepts Unicode Plan payloads", async () => {
    const token = "review-secret";
    const app = createReviewWorkspaceApp({
        cwd: Deno.cwd(),
        token,
        reviewPayload: { plan: "# Café 🚀\n", planPath: "docs/plans/café.md" },
        reviewType: "plan",
    }).handler();

    const response = await app(new Request(`http://localhost/review/plan?token=${token}`));
    assertEquals(response.status < 500, true);
});

Deno.test("artifact read page receives authenticated read-only payload", async () => {
    const token = "read-secret";
    const app = createReviewWorkspaceApp({
        cwd: Deno.cwd(),
        token,
        reviewPayload: {
            surface: "artifact-read",
            markdown: "# Work Record\n\n## Summary\n\nRead-only.",
            artifactKind: "work-record",
            title: "Work Record",
            artifactPath: "docs/work-records/work-record.md",
            notices: ["NOTICE: superseded"],
        },
        reviewType: "plan",
    }).handler();

    const unauthorized = await app(new Request("http://localhost/review/plan"));
    assertEquals(unauthorized.status, 401);

    const response = await app(new Request(`http://localhost/review/plan?token=${token}`));
    assertEquals(response.status < 500, true);
    const html = await response.text();
    assertStringIncludes(html, "artifact-read");
    assertStringIncludes(html, "NOTICE: superseded");
});

Deno.test("artifact read Close resolves review exit without approval", async () => {
    const token = "read-close-secret";
    const app = createReviewWorkspaceApp({
        cwd: Deno.cwd(),
        token,
        reviewPayload: { surface: "artifact-read", markdown: "# Plan", artifactKind: "plan", title: "Plan" },
        reviewType: "plan",
    }).handler();
    const { promise } = registerReviewDecisionPromise(token);

    const response = await app(
        new Request(`http://localhost/api/review/exit?token=${token}`, {
            method: "POST",
            headers: { "x-runwield-review-token": token, "content-type": "application/json" },
            body: JSON.stringify({ reviewType: "plan" }),
        }),
    );

    assertEquals(response.status, 200);
    assertEquals(await promise, { approved: false, feedback: "", exit: true });
    unregisterReviewDecision(token);
});

Deno.test("Plan review surfaces do not expose Guided Review APIs", async () => {
    const token = "plan-review-secret";
    const reviewApp = createReviewWorkspaceApp({
        cwd: Deno.cwd(),
        token,
        reviewPayload: { plan: "# Plan" },
        reviewType: "plan",
    });
    const app = reviewApp.handler();

    const capabilities = await app(
        new Request(`http://localhost/api/agents/capabilities?token=${token}`, {
            headers: { "x-runwield-review-token": token },
        }),
    );
    assertEquals(capabilities.status, 404);

    const guide = await app(
        new Request(`http://localhost/api/guide/job-1?token=${token}`, {
            headers: { "x-runwield-review-token": token },
        }),
    );
    assertEquals(guide.status, 404);

    const widget = await app(
        new Request(`http://localhost/api/review/widgets/widget/index.html?token=${token}`, {
            headers: { "x-runwield-review-token": token },
        }),
    );
    assertEquals(widget.status, 404);
    await reviewApp.cleanup();
});

Deno.test("review guide and widget APIs require token and serve explainer state", async () => {
    const token = "guide-secret";
    const reviewApp = createReviewWorkspaceApp({
        cwd: Deno.cwd(),
        token,
        reviewType: "code",
        reviewPayload: {
            rawPatch:
                "diff --git a/src/a.js b/src/a.js\n--- a/src/a.js\n+++ b/src/a.js\n@@ -1 +1,2 @@\n export const a = 1;\n+export const b = 2;\n",
            guidedReviewFixture: {
                schemaVersion: "1.0",
                title: "Fixture guide",
                sections: [{
                    title: "Fixture",
                    role: "core",
                    blocks: [
                        { type: "diff", file: "src/a.js", summary: "Check the fixture diff." },
                        {
                            type: "widget",
                            id: "fixture",
                            entry: "index.html",
                            title: "Fixture",
                            html:
                                '<!doctype html><link rel="stylesheet" href="widget.css"><img src="asset.svg" alt="fixture"><script src="widget.js"></script>',
                            assets: [
                                {
                                    name: "asset.svg",
                                    contentType: "image/svg+xml",
                                    content: '<svg xmlns="http://www.w3.org/2000/svg"></svg>',
                                },
                                {
                                    name: "widget.css",
                                    contentType: "text/css",
                                    content: "img{width:16px}",
                                },
                                {
                                    name: "widget.js",
                                    contentType: "application/javascript",
                                    content: "document.body.dataset.ready = 'true';",
                                },
                            ],
                        },
                    ],
                }],
                everythingElse: [],
            },
        },
    });
    const app = reviewApp.handler();

    const denied = await app(new Request("http://localhost/api/agents/capabilities"));
    assertEquals(denied.status, 401);

    const launch = await app(
        new Request("http://localhost/api/agents/jobs", {
            method: "POST",
            headers: { "content-type": "application/json", "x-runwield-review-token": token },
            body: JSON.stringify({ provider: "guide" }),
        }),
    );
    assertEquals(launch.status, 202);
    const { job } = await launch.json();

    let guide;
    for (let attempt = 0; attempt < 100; attempt += 1) {
        guide = await app(
            new Request(`http://localhost/api/guide/${job.id}`, {
                headers: { "x-runwield-review-token": token },
            }),
        );
        if (guide.status === 200) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assertEquals(guide.status, 200);
    const guideJson = await guide.json();
    assertEquals(guideJson.schemaVersion, "1.0");
    const widgetId = guideJson.sections[0].blocks.find((/** @type {any} */ block) => block.type === "widget").id;

    const widget = await app(
        new Request(`http://localhost/api/review/widgets/${widgetId}/index.html`, {
            headers: { "x-runwield-review-token": token },
        }),
    );
    assertEquals(widget.status, 200);
    const csp = widget.headers.get("content-security-policy") || "";
    assertStringIncludes(csp, "connect-src 'none'");
    assertStringIncludes(csp, "navigate-to 'none'");
    assertStringIncludes(csp, `http://localhost/api/review/widgets/${widgetId}/widget.css`);
    assertStringIncludes(csp, `http://localhost/api/review/widgets/${widgetId}/widget.js`);
    assertEquals(csp.includes("img-src 'self'"), false);
    const deniedAsset = await app(new Request(`http://localhost/api/review/widgets/${widgetId}/asset.svg`));
    assertEquals(deniedAsset.status, 401);
    const asset = await app(
        new Request(`http://localhost/api/review/widgets/${widgetId}/asset.svg`, {
            headers: { referer: `http://localhost/api/review/widgets/${widgetId}/index.html?token=${token}` },
        }),
    );
    assertEquals(asset.status, 200);
    assertEquals(asset.headers.get("content-type"), "image/svg+xml");
    const css = await app(
        new Request(`http://localhost/api/review/widgets/${widgetId}/widget.css`, {
            headers: { referer: `http://localhost/api/review/widgets/${widgetId}/index.html?token=${token}` },
        }),
    );
    assertEquals(css.status, 200);
    assertEquals(css.headers.get("content-type"), "text/css");
    const js = await app(
        new Request(`http://localhost/api/review/widgets/${widgetId}/widget.js`, {
            headers: { referer: `http://localhost/api/review/widgets/${widgetId}/index.html?token=${token}` },
        }),
    );
    assertEquals(js.status, 200);
    assertEquals(js.headers.get("content-type"), "application/javascript");
    await reviewApp.cleanup();
});

Deno.test("review guide jobs prefer WLD over external agent host CLIs", async () => {
    // Mutates PATH, which every concurrently-running test's subprocesses inherit.
    await withProcessGlobalTestLock(async () => {
        const previousPath = Deno.env.get("PATH");
        const previousCommand = Deno.env.get("RUNWIELD_GUIDED_REVIEW_COMMAND");
        const previousModel = Deno.env.get("RUNWIELD_GUIDED_REVIEW_MODEL");
        const binDir = await Deno.makeTempDir();
        try {
            for (const command of ["wld", "claude"]) {
                const commandPath = `${binDir}/${command}`;
                await Deno.writeTextFile(commandPath, "#!/bin/sh\necho '{}'\n");
                await Deno.chmod(commandPath, 0o755);
            }
            Deno.env.set("PATH", previousPath ? `${binDir}:${previousPath}` : binDir);
            Deno.env.delete("RUNWIELD_GUIDED_REVIEW_COMMAND");
            Deno.env.delete("RUNWIELD_GUIDED_REVIEW_MODEL");

            const state = createReviewAgentState({
                cwd: REVIEW_AGENT_PROJECT_ROOT,
                token: "wld-token",
                reviewPayload: {
                    rawPatch:
                        "diff --git a/src/a.js b/src/a.js\n--- a/src/a.js\n+++ b/src/a.js\n@@ -1 +1,2 @@\n export const a = 1;\n+export const b = 2;\n",
                    guidedReviewFixture: {
                        schemaVersion: "1.0",
                        title: "WLD guide",
                        sections: [{
                            title: "Core",
                            role: "core",
                            blocks: [{ type: "diff", file: "src/a.js" }],
                        }],
                        everythingElse: [],
                    },
                },
                runGuideCommand: runConfiguredGuideCommand,
            });

            const launch = await reviewAgentApi(
                new Request("http://localhost/api/agents/jobs", {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({ provider: "guide" }),
                }),
                new URL("http://localhost/api/agents/jobs"),
                state,
            );
            assertEquals(launch?.status, 202);
            if (!launch) throw new Error("expected job launch response");
            const { job } = await launch.json();
            await state.jobs.get(job.id)?.done;

            assertEquals(job.command, ["wld", "guided-review"]);
            assertEquals(job.engine, "wld");
            assertEquals(job.model, "wld");
            await state.widgets.cleanup();
        } finally {
            if (previousPath === undefined) Deno.env.delete("PATH");
            else Deno.env.set("PATH", previousPath);
            if (previousCommand === undefined) Deno.env.delete("RUNWIELD_GUIDED_REVIEW_COMMAND");
            else Deno.env.set("RUNWIELD_GUIDED_REVIEW_COMMAND", previousCommand);
            if (previousModel === undefined) Deno.env.delete("RUNWIELD_GUIDED_REVIEW_MODEL");
            else Deno.env.set("RUNWIELD_GUIDED_REVIEW_MODEL", previousModel);
            await Deno.remove(binDir, { recursive: true });
        }
    });
});

Deno.test("default review guide usage frames update a running job and remain after completion", async () => {
    // Mutates PATH, which every concurrently-running test's subprocesses inherit.
    await withProcessGlobalTestLock(async () => {
        const previousPath = Deno.env.get("PATH");
        const previousCommand = Deno.env.get("RUNWIELD_GUIDED_REVIEW_COMMAND");
        const previousModel = Deno.env.get("RUNWIELD_GUIDED_REVIEW_MODEL");
        const fixtureRoot = await Deno.makeTempDir({ prefix: "runwield-guide-usage-route-" });
        const binDir = join(fixtureRoot, "bin");
        const gatePath = join(fixtureRoot, "release");
        const commandPath = join(binDir, "wld");
        try {
            await Deno.mkdir(binDir, { recursive: true });
            const firstFrame = `${GUIDE_EVENT_PREFIX}${
                JSON.stringify({
                    version: 1,
                    type: "usage",
                    usage: {
                        inputTokens: 1200,
                        outputTokens: 200,
                        cacheReadTokens: 30,
                        cacheWriteTokens: 4,
                        costUsd: 0.1,
                    },
                })
            }`;
            const secondFrame = `${GUIDE_EVENT_PREFIX}${
                JSON.stringify({
                    version: 1,
                    type: "usage",
                    usage: {
                        inputTokens: 40,
                        outputTokens: 50,
                        cacheReadTokens: 70,
                        cacheWriteTokens: 6,
                        costUsd: 0.025,
                    },
                })
            }`;
            await Deno.writeTextFile(
                commandPath,
                [
                    "#!/bin/sh",
                    `echo '${firstFrame}' >&2`,
                    `echo '${secondFrame}' >&2`,
                    `echo '${
                        encodeGuidedReviewMetadata({
                            provider: "test-provider",
                            model: "test-model",
                            thinkingLevel: "high",
                        }).trim()
                    }' >&2`,
                    `while [ ! -f '${gatePath}' ]; do sleep 0.05; done`,
                    `cat <<'JSON'`,
                    makeGuideJson("Usage guide"),
                    "JSON",
                    "",
                ].join("\n"),
            );
            await Deno.chmod(commandPath, 0o755);
            Deno.env.set("PATH", previousPath ? `${binDir}:${previousPath}` : binDir);
            Deno.env.delete("RUNWIELD_GUIDED_REVIEW_COMMAND");
            Deno.env.delete("RUNWIELD_GUIDED_REVIEW_MODEL");

            const state = createReviewAgentState({
                cwd: REVIEW_AGENT_PROJECT_ROOT,
                token: "usage-token",
                reviewPayload: makeGuideReviewPayload(),
                runGuideCommand: runConfiguredGuideCommand,
            });
            const launch = await reviewAgentApi(
                new Request("http://localhost/api/agents/jobs", {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({ provider: "guide" }),
                }),
                new URL("http://localhost/api/agents/jobs"),
                state,
            );
            assertEquals(launch?.status, 202);
            if (!launch) throw new Error("expected job launch response");
            const { job } = await launch.json();

            let runningJob = null;
            for (let attempt = 0; attempt < 100; attempt += 1) {
                const jobsResponse = await reviewAgentApi(
                    new Request("http://localhost/api/agents/jobs"),
                    new URL("http://localhost/api/agents/jobs"),
                    state,
                );
                const jobs = await jobsResponse?.json();
                runningJob = jobs.jobs.find((candidate) => candidate.id === job.id);
                if (runningJob?.cost?.usd === 0.125) break;
                await new Promise((resolve) => setTimeout(resolve, 20));
            }
            assertEquals(runningJob?.status, "running");
            assertEquals(runningJob?.usageState, "available");
            assertEquals(runningJob?.tokens, {
                inputTokens: 1240,
                outputTokens: 250,
                cacheReadTokens: 100,
                cacheWriteTokens: 10,
                costUsd: 0.125,
            });
            assertEquals(runningJob?.cost, { usd: 0.125 });

            await Deno.writeTextFile(gatePath, "ok");
            await state.jobs.get(job.id)?.done;
            const doneJob = state.jobs.get(job.id)?.info;
            assertEquals(doneJob?.status, "done");
            assertEquals(doneJob?.usageState, "available");
            assertEquals(doneJob?.tokens, runningJob?.tokens);
            assertEquals(doneJob?.providerName, "test-provider");
            assertEquals(doneJob?.model, "test-model");
            assertEquals(doneJob?.thinkingLevel, "high");
            await state.widgets.cleanup();
        } finally {
            if (previousPath === undefined) Deno.env.delete("PATH");
            else Deno.env.set("PATH", previousPath);
            if (previousCommand === undefined) Deno.env.delete("RUNWIELD_GUIDED_REVIEW_COMMAND");
            else Deno.env.set("RUNWIELD_GUIDED_REVIEW_COMMAND", previousCommand);
            if (previousModel === undefined) Deno.env.delete("RUNWIELD_GUIDED_REVIEW_MODEL");
            else Deno.env.set("RUNWIELD_GUIDED_REVIEW_MODEL", previousModel);
            await Deno.remove(fixtureRoot, { recursive: true });
        }
    });
});

Deno.test("review guide jobs keep reported zero usage available", async () => {
    const state = createReviewAgentState({
        cwd: REVIEW_AGENT_PROJECT_ROOT,
        token: "zero-usage-token",
        reviewPayload: makeGuideReviewPayload(),
        runGuideCommand: (_prompt, _signal, _cwd, progress) => {
            progress?.onUsage?.({
                inputTokens: 0,
                outputTokens: 0,
                cacheReadTokens: 0,
                cacheWriteTokens: 0,
                costUsd: 0,
            });
            return Promise.resolve({ stdout: makeGuideJson("Zero usage guide"), provider: "wld", model: "wld" });
        },
    });
    const launch = await reviewAgentApi(
        new Request("http://localhost/api/agents/jobs", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ provider: "guide" }),
        }),
        new URL("http://localhost/api/agents/jobs"),
        state,
    );
    if (!launch) throw new Error("expected job launch response");
    const { job } = await launch.json();
    await state.jobs.get(job.id)?.done;
    const doneJob = state.jobs.get(job.id)?.info;
    assertEquals(doneJob?.status, "done");
    assertEquals(doneJob?.usageState, "available");
    assertEquals(doneJob?.tokens, {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUsd: 0,
    });
    assertEquals(doneJob?.cost, { usd: 0 });
    await state.widgets.cleanup();
});

Deno.test("custom review guide commands do not interpret stderr usage-like text", async () => {
    await withProcessGlobalTestLock(async () => {
        const previousCommand = Deno.env.get("RUNWIELD_GUIDED_REVIEW_COMMAND");
        const fixtureRoot = await Deno.makeTempDir({ prefix: "runwield-custom-guide-route-" });
        const commandPath = join(fixtureRoot, "custom-guide");
        try {
            await Deno.writeTextFile(
                commandPath,
                [
                    "#!/bin/sh",
                    "cat >/dev/null",
                    `echo '${GUIDE_EVENT_PREFIX}{"version":1,"type":"usage","usage":{"inputTokens":999}}' >&2`,
                    "cat <<'JSON'",
                    makeGuideJson("Custom guide"),
                    "JSON",
                    "",
                ].join("\n"),
            );
            await Deno.chmod(commandPath, 0o755);
            Deno.env.set("RUNWIELD_GUIDED_REVIEW_COMMAND", shellQuote(commandPath));

            const state = createReviewAgentState({
                cwd: REVIEW_AGENT_PROJECT_ROOT,
                token: "custom-no-usage-token",
                reviewPayload: makeGuideReviewPayload(),
                runGuideCommand: runConfiguredGuideCommand,
            });
            const doneJob = await runReviewGuideJob(state);
            assertEquals(doneJob?.status, "done");
            assertEquals(doneJob?.providerName, "custom");
            assertEquals(doneJob?.usageState, "unavailable");
            assertEquals(doneJob?.tokens, null);
            assertEquals(doneJob?.cost, null);
            await state.widgets.cleanup();
        } finally {
            if (previousCommand === undefined) Deno.env.delete("RUNWIELD_GUIDED_REVIEW_COMMAND");
            else Deno.env.set("RUNWIELD_GUIDED_REVIEW_COMMAND", previousCommand);
            await Deno.remove(fixtureRoot, { recursive: true });
        }
    });
});

Deno.test("failed default review guide commands report subprocess stderr and keep partial usage", async () => {
    await withProcessGlobalTestLock(async () => {
        const previousPath = Deno.env.get("PATH");
        const previousCommand = Deno.env.get("RUNWIELD_GUIDED_REVIEW_COMMAND");
        const previousModel = Deno.env.get("RUNWIELD_GUIDED_REVIEW_MODEL");
        const fixtureRoot = await Deno.makeTempDir({ prefix: "runwield-failed-guide-route-" });
        const binDir = join(fixtureRoot, "bin");
        const commandPath = join(binDir, "wld");
        try {
            await Deno.mkdir(binDir, { recursive: true });
            const usageFrame = `${GUIDE_EVENT_PREFIX}${
                JSON.stringify({
                    version: 1,
                    type: "usage",
                    usage: {
                        inputTokens: 5,
                        outputTokens: 6,
                        cacheReadTokens: 7,
                        cacheWriteTokens: 8,
                        costUsd: 0.009,
                    },
                })
            }`;
            await Deno.writeTextFile(
                commandPath,
                [
                    "#!/bin/sh",
                    "cat >/dev/null",
                    `echo '${usageFrame}' >&2`,
                    "echo 'plain provider failure' >&2",
                    "exit 9",
                    "",
                ].join("\n"),
            );
            await Deno.chmod(commandPath, 0o755);
            Deno.env.set("PATH", previousPath ? `${binDir}:${previousPath}` : binDir);
            Deno.env.delete("RUNWIELD_GUIDED_REVIEW_COMMAND");
            Deno.env.delete("RUNWIELD_GUIDED_REVIEW_MODEL");

            const state = createReviewAgentState({
                cwd: REVIEW_AGENT_PROJECT_ROOT,
                token: "failed-usage-token",
                reviewPayload: makeGuideReviewPayload(),
                runGuideCommand: runConfiguredGuideCommand,
            });
            const failedJob = await runReviewGuideJob(state);
            assertEquals(failedJob?.status, "failed");
            assertEquals(failedJob?.error, "plain provider failure");
            assertEquals(failedJob?.usageState, "available");
            assertEquals(failedJob?.tokens, {
                inputTokens: 5,
                outputTokens: 6,
                cacheReadTokens: 7,
                cacheWriteTokens: 8,
                costUsd: 0.009,
            });
            assertEquals(failedJob?.cost, { usd: 0.009 });
            await state.widgets.cleanup();
        } finally {
            if (previousPath === undefined) Deno.env.delete("PATH");
            else Deno.env.set("PATH", previousPath);
            if (previousCommand === undefined) Deno.env.delete("RUNWIELD_GUIDED_REVIEW_COMMAND");
            else Deno.env.set("RUNWIELD_GUIDED_REVIEW_COMMAND", previousCommand);
            if (previousModel === undefined) Deno.env.delete("RUNWIELD_GUIDED_REVIEW_MODEL");
            else Deno.env.set("RUNWIELD_GUIDED_REVIEW_MODEL", previousModel);
            await Deno.remove(fixtureRoot, { recursive: true });
        }
    });
});

Deno.test("default review guide commands fail clearly on malformed usage frames", async () => {
    await withProcessGlobalTestLock(async () => {
        const previousPath = Deno.env.get("PATH");
        const previousCommand = Deno.env.get("RUNWIELD_GUIDED_REVIEW_COMMAND");
        const previousModel = Deno.env.get("RUNWIELD_GUIDED_REVIEW_MODEL");
        const fixtureRoot = await Deno.makeTempDir({ prefix: "runwield-malformed-guide-route-" });
        const binDir = join(fixtureRoot, "bin");
        const commandPath = join(binDir, "wld");
        try {
            await Deno.mkdir(binDir, { recursive: true });
            await Deno.writeTextFile(
                commandPath,
                [
                    "#!/bin/sh",
                    "cat >/dev/null",
                    `echo '${GUIDE_EVENT_PREFIX}{"version":1,"type":"usage","usage":{"inputTokens":999}}' >&2`,
                    "cat <<'JSON'",
                    makeGuideJson("Malformed frame guide"),
                    "JSON",
                    "",
                ].join("\n"),
            );
            await Deno.chmod(commandPath, 0o755);
            Deno.env.set("PATH", previousPath ? `${binDir}:${previousPath}` : binDir);
            Deno.env.delete("RUNWIELD_GUIDED_REVIEW_COMMAND");
            Deno.env.delete("RUNWIELD_GUIDED_REVIEW_MODEL");

            const state = createReviewAgentState({
                cwd: REVIEW_AGENT_PROJECT_ROOT,
                token: "malformed-frame-token",
                reviewPayload: makeGuideReviewPayload(),
                runGuideCommand: runConfiguredGuideCommand,
            });
            const failedJob = await runReviewGuideJob(state);
            assertEquals(failedJob?.status, "failed");
            assertStringIncludes(String(failedJob?.error || ""), "Malformed Guided Review usage frame");
            assertStringIncludes(String(failedJob?.error || ""), "outputTokens");
            assertEquals(failedJob?.usageState, "unavailable");
            assertEquals(failedJob?.tokens, null);
            await state.widgets.cleanup();
        } finally {
            if (previousPath === undefined) Deno.env.delete("PATH");
            else Deno.env.set("PATH", previousPath);
            if (previousCommand === undefined) Deno.env.delete("RUNWIELD_GUIDED_REVIEW_COMMAND");
            else Deno.env.set("RUNWIELD_GUIDED_REVIEW_COMMAND", previousCommand);
            if (previousModel === undefined) Deno.env.delete("RUNWIELD_GUIDED_REVIEW_MODEL");
            else Deno.env.set("RUNWIELD_GUIDED_REVIEW_MODEL", previousModel);
            await Deno.remove(fixtureRoot, { recursive: true });
        }
    });
});

Deno.test("review guide jobs ground provider prompt in Plan payload", async () => {
    const previousCommand = Deno.env.get("RUNWIELD_GUIDED_REVIEW_COMMAND");
    Deno.env.set("RUNWIELD_GUIDED_REVIEW_COMMAND", "test-guide-command");
    try {
        let capturedPrompt = "";
        const state = createReviewAgentState({
            cwd: REVIEW_AGENT_PROJECT_ROOT,
            token: "prompt-token",
            reviewPayload: {
                rawPatch:
                    "diff --git a/src/a.js b/src/a.js\n--- a/src/a.js\n+++ b/src/a.js\n@@ -1 +1,2 @@\n export const a = 1;\n+export const b = 2;\n",
                gitRef: "review target",
                planContent: "# Plan\nShip the user-facing explanation.",
                planAttrs: { classification: "FEATURE", complexity: "HIGH" },
            },
            runGuideCommand: (prompt) => {
                capturedPrompt = prompt;
                return Promise.resolve({
                    stdout: JSON.stringify({
                        schemaVersion: "1.0",
                        title: "Prompt guide",
                        sections: [{
                            title: "Core",
                            role: "core",
                            blocks: [{ type: "diff", file: "src/a.js" }],
                        }],
                        everythingElse: [],
                    }),
                    provider: "test-provider",
                    model: "test-model",
                });
            },
        });

        const launch = await reviewAgentApi(
            new Request("http://localhost/api/agents/jobs", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ provider: "guide" }),
            }),
            new URL("http://localhost/api/agents/jobs"),
            state,
        );
        assertEquals(launch?.status, 202);
        if (!launch) throw new Error("expected job launch response");
        const { job } = await launch.json();
        await state.jobs.get(job.id)?.done;

        assertStringIncludes(capturedPrompt, "# Plan");
        assertStringIncludes(capturedPrompt, "Ship the user-facing explanation.");
        assertStringIncludes(capturedPrompt, '"classification": "FEATURE"');
        await state.widgets.cleanup();
    } finally {
        if (previousCommand === undefined) Deno.env.delete("RUNWIELD_GUIDED_REVIEW_COMMAND");
        else Deno.env.set("RUNWIELD_GUIDED_REVIEW_COMMAND", previousCommand);
    }
});

Deno.test("review guide jobs record generation result metrics", async () => {
    await withWorkflowMetricsFixture(async ({ projectRoot, readMetrics }) => {
        const state = createReviewAgentState({
            cwd: projectRoot,
            token: "metric-token",
            reviewPayload: {
                rawPatch:
                    "diff --git a/src/a.js b/src/a.js\n--- a/src/a.js\n+++ b/src/a.js\n@@ -1 +1,2 @@\n export const a = 1;\n+export const b = 2;\n",
                guidedReviewFixture: {
                    schemaVersion: "1.0",
                    title: "Metric guide",
                    sections: [{
                        title: "Core",
                        role: "core",
                        blocks: [{ type: "diff", file: "src/a.js" }],
                    }],
                    everythingElse: [],
                },
            },
            runGuideCommand: UNUSED_GUIDE_COMMAND,
        });

        const launch = await reviewAgentApi(
            new Request("http://localhost/api/agents/jobs", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ provider: "guide" }),
            }),
            new URL("http://localhost/api/agents/jobs"),
            state,
        );
        assertEquals(launch?.status, 202);
        if (!launch) throw new Error("expected job launch response");
        const { job } = await launch.json();
        await state.jobs.get(job.id)?.done;

        const metrics = await readMetrics();
        assertEquals(metrics.length, 1);
        assertEquals(metrics[0].category, "validation");
        assertEquals(metrics[0].event, "guided_review_generation_result");
        assertEquals(metrics[0].details?.status, "done");
        assertEquals(metrics[0].details?.sectionCount, 1);
        await state.widgets.cleanup();
    });
});

Deno.test("review guide failure metrics redact provider error details", async () => {
    await withWorkflowMetricsFixture(async ({ projectRoot, readMetrics }) => {
        const state = createReviewAgentState({
            cwd: projectRoot,
            token: "metric-token",
            reviewPayload: {
                rawPatch:
                    "diff --git a/src/a.js b/src/a.js\n--- a/src/a.js\n+++ b/src/a.js\n@@ -1 +1,2 @@\n export const a = 1;\n+export const b = 2;\n",
                guidedReviewFixture: {
                    schemaVersion: "1.0",
                    title: "Bad guide",
                    sections: [{
                        title: "Core",
                        role: "core",
                        blocks: [{ type: "diff", file: "/Users/example/secret.js" }],
                    }],
                    everythingElse: [],
                },
            },
            runGuideCommand: UNUSED_GUIDE_COMMAND,
        });

        const launch = await reviewAgentApi(
            new Request("http://localhost/api/agents/jobs", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ provider: "guide" }),
            }),
            new URL("http://localhost/api/agents/jobs"),
            state,
        );
        assertEquals(launch?.status, 202);
        if (!launch) throw new Error("expected job launch response");
        const { job } = await launch.json();
        await state.jobs.get(job.id)?.done;

        const [metric] = await readMetrics();
        const details = metric.details || {};
        assertEquals(details.status, "failed");
        assertEquals(details.hasError, true);
        assertEquals(details.errorKind, "schema_invalid");
        assertEquals("error" in details, false);
        assertEquals(JSON.stringify(details).includes("/Users/example/secret.js"), false);
        await state.widgets.cleanup();
    });
});

Deno.test("review decisions wait until a user decision or explicit cancellation", async () => {
    const token = "review-no-timeout-secret";
    const { promise } = registerReviewDecisionPromise(token);
    try {
        const earlyResult = await Promise.race([
            promise.then(() => "resolved"),
            new Promise((resolve) => setTimeout(() => resolve("pending"), 20)),
        ]);

        assertEquals(earlyResult, "pending");
        assertEquals(resolveReviewDecision(token, { approved: false, feedback: "done" }), true);
        assertEquals(await promise, { approved: false, feedback: "done" });
    } finally {
        unregisterReviewDecision(token);
    }
});

Deno.test("review API accepts review token header before workspace app token gate", async () => {
    const token = "review-secret";
    const { promise } = registerReviewDecisionPromise(token);
    try {
        const app = createReviewWorkspaceApp({
            cwd: Deno.cwd(),
            token,
            reviewPayload: {},
            reviewType: "code",
        }).handler();

        const response = await app(
            new Request("http://localhost/api/review/feedback", {
                method: "POST",
                headers: {
                    "content-type": "application/json",
                    "x-runwield-review-token": token,
                },
                body: JSON.stringify({ approved: false, feedback: "fix annotations" }),
            }),
        );

        assertEquals(response.status, 200);
        assertEquals(await promise, {
            approved: false,
            feedback: "fix annotations",
            annotations: [],
            agentSwitch: undefined,
        });
    } finally {
        unregisterReviewDecision(token);
    }
});

Deno.test("Code review approval preserves comments and attached images", async () => {
    const token = "code-approval-secret";
    const { promise } = registerReviewDecisionPromise(token);
    try {
        const app = createReviewWorkspaceApp({
            cwd: Deno.cwd(),
            token,
            reviewPayload: {},
            reviewType: "code",
        }).handler();
        const annotations = [{
            id: "code-approval-comment",
            type: "comment",
            scope: "general",
            filePath: "",
            lineStart: 0,
            lineEnd: 0,
            side: "new",
            text: "Keep this implementation detail.",
            images: [{ path: "/tmp/code-approval.png", name: "code-approval" }],
        }];

        const response = await app(
            new Request("http://localhost/api/review/feedback", {
                method: "POST",
                headers: {
                    "content-type": "application/json",
                    "x-runwield-review-token": token,
                },
                body: JSON.stringify({
                    approved: true,
                    feedback: "# Code Review Feedback\n\nKeep this implementation detail.",
                    annotations,
                }),
            }),
        );

        assertEquals(response.status, 200);
        assertEquals(await promise, {
            approved: true,
            feedback: "# Code Review Feedback\n\nKeep this implementation detail.",
            annotations,
            images: [{ path: "/tmp/code-approval.png", name: "code-approval" }],
            agentSwitch: undefined,
        });
    } finally {
        unregisterReviewDecision(token);
    }
});

Deno.test("Plan review feedback preserves all annotations and the edited Plan", async () => {
    const token = "plan-feedback-secret";
    const { promise } = registerReviewDecisionPromise(token);
    try {
        const app = createReviewWorkspaceApp({
            cwd: Deno.cwd(),
            token,
            reviewPayload: {},
            reviewType: "plan",
        }).handler();
        const annotations = [
            {
                id: "annotation-1",
                type: "COMMENT",
                text: "Clarify this section.",
                images: [{ path: "/tmp/annotated.png", name: "annotated" }],
            },
            { id: "annotation-2", type: "DELETION", text: "Remove this sentence." },
        ];
        const globalAttachments = [{ path: "/tmp/reference.png", name: "reference" }];

        const response = await app(
            new Request("http://localhost/api/review/deny", {
                method: "POST",
                headers: {
                    "content-type": "application/json",
                    "x-runwield-review-token": token,
                },
                body: JSON.stringify({
                    feedback: "# Plan Feedback\n\nClarify this section.",
                    annotations,
                    globalAttachments,
                    plan: "# Edited Plan\n",
                    planSave: { enabled: true, path: "docs/plans/edited.md" },
                }),
            }),
        );

        assertEquals(response.status, 200);
        assertEquals(await promise, {
            approved: false,
            feedback: "# Plan Feedback\n\nClarify this section.",
            annotations,
            globalAttachments,
            images: [
                { path: "/tmp/reference.png", name: "reference" },
                { path: "/tmp/annotated.png", name: "annotated" },
            ],
            plan: "# Edited Plan\n",
            savedPath: "docs/plans/edited.md",
        });
    } finally {
        unregisterReviewDecision(token);
    }
});

Deno.test("Plan approval preserves annotations, global images, and the edited Plan", async () => {
    const token = "plan-approval-secret";
    const { promise } = registerReviewDecisionPromise(token);
    try {
        const app = createReviewWorkspaceApp({
            cwd: Deno.cwd(),
            token,
            reviewPayload: {},
            reviewType: "plan",
        }).handler();
        const annotations = [{
            id: "approval-annotation",
            type: "COMMENT",
            text: "Keep the command wording.",
            images: [{ path: "/tmp/approval-inline.png", name: "approval-inline" }],
        }];
        const globalAttachments = [{ path: "/tmp/approval-global.png", name: "approval-global" }];

        const response = await app(
            new Request("http://localhost/api/review/decision", {
                method: "POST",
                headers: {
                    "content-type": "application/json",
                    "x-runwield-review-token": token,
                },
                body: JSON.stringify({
                    approved: true,
                    feedback: "# Approval annotations\n\nKeep the command wording.",
                    annotations,
                    globalAttachments,
                    approvalAction: "run",
                    plan: "# Approved edited Plan\n",
                    planSave: { enabled: true, path: "docs/plans/approved.md" },
                }),
            }),
        );

        assertEquals(response.status, 200);
        assertEquals(await promise, {
            approved: true,
            feedback: "# Approval annotations\n\nKeep the command wording.",
            annotations,
            globalAttachments,
            images: [
                { path: "/tmp/approval-global.png", name: "approval-global" },
                { path: "/tmp/approval-inline.png", name: "approval-inline" },
            ],
            plan: "# Approved edited Plan\n",
            savedPath: "docs/plans/approved.md",
            approvalAction: "run",
            agentSwitch: undefined,
            permissionMode: undefined,
        });
    } finally {
        unregisterReviewDecision(token);
    }
});

Deno.test("Plan approval transports canonical FEATURE execution policy", async () => {
    const token = "plan-policy-secret";
    const { promise } = registerReviewDecisionPromise(token);
    try {
        const app = createReviewWorkspaceApp({
            cwd: Deno.cwd(),
            token,
            reviewPayload: { classification: "FEATURE", frontmatter: { classification: "FEATURE" } },
            reviewType: "plan",
        }).handler();

        const response = await app(
            new Request("http://localhost/api/review/decision", {
                method: "POST",
                headers: {
                    "content-type": "application/json",
                    "x-runwield-review-token": token,
                },
                body: JSON.stringify({
                    approvalAction: "run",
                    executionAgent: "frontend-engineer",
                    collaborationRecommendation: "pair",
                }),
            }),
        );

        assertEquals(response.status, 200);
        assertEquals(await promise, {
            approved: true,
            annotations: [],
            approvalAction: "run",
            executionAgent: "frontend-engineer",
            collaborationRecommendation: "pair",
            feedback: undefined,
            plan: undefined,
            savedPath: undefined,
            agentSwitch: undefined,
            permissionMode: undefined,
        });
    } finally {
        unregisterReviewDecision(token);
    }
});

Deno.test("invalid Plan approval execution policy leaves review open for retry", async () => {
    const token = "plan-policy-retry-secret";
    const { promise } = registerReviewDecisionPromise(token);
    try {
        const app = createReviewWorkspaceApp({
            cwd: Deno.cwd(),
            token,
            reviewPayload: { classification: "FEATURE", frontmatter: { classification: "FEATURE" } },
            reviewType: "plan",
        }).handler();

        const invalid = await app(
            new Request("http://localhost/api/review/decision", {
                method: "POST",
                headers: {
                    "content-type": "application/json",
                    "x-runwield-review-token": token,
                },
                body: JSON.stringify({
                    approvalAction: "run",
                    executionAgent: "engineer",
                    collaborationRecommendation: "pair-programming",
                }),
            }),
        );
        assertEquals(invalid.status, 400);

        const valid = await app(
            new Request("http://localhost/api/review/decision", {
                method: "POST",
                headers: {
                    "content-type": "application/json",
                    "x-runwield-review-token": token,
                },
                body: JSON.stringify({
                    approvalAction: "later",
                    executionAgent: "engineer",
                    collaborationRecommendation: "autonomous",
                }),
            }),
        );

        assertEquals(valid.status, 200);
        assertEquals(await promise, {
            approved: true,
            annotations: [],
            approvalAction: "later",
            executionAgent: "engineer",
            collaborationRecommendation: "autonomous",
            feedback: undefined,
            plan: undefined,
            savedPath: undefined,
            agentSwitch: undefined,
            permissionMode: undefined,
        });
    } finally {
        unregisterReviewDecision(token);
    }
});

Deno.test("PROJECT Plan approval rejects execution policy fields without consuming the review", async () => {
    const token = "project-policy-secret";
    const { promise } = registerReviewDecisionPromise(token);
    try {
        const app = createReviewWorkspaceApp({
            cwd: Deno.cwd(),
            token,
            reviewPayload: { classification: "PROJECT", frontmatter: { classification: "PROJECT" } },
            reviewType: "plan",
        }).handler();

        const invalid = await app(
            new Request("http://localhost/api/review/decision", {
                method: "POST",
                headers: {
                    "content-type": "application/json",
                    "x-runwield-review-token": token,
                },
                body: JSON.stringify({
                    approvalAction: "decompose",
                    executionAgent: "frontend-engineer",
                    collaborationRecommendation: "pair",
                }),
            }),
        );
        assertEquals(invalid.status, 400);

        const validProjectApproval = await app(
            new Request("http://localhost/api/review/decision", {
                method: "POST",
                headers: {
                    "content-type": "application/json",
                    "x-runwield-review-token": token,
                },
                body: JSON.stringify({ approvalAction: "decompose" }),
            }),
        );

        assertEquals(validProjectApproval.status, 200);
        assertEquals(await promise, {
            approved: true,
            annotations: [],
            feedback: undefined,
            plan: undefined,
            savedPath: undefined,
            approvalAction: "decompose",
            agentSwitch: undefined,
            permissionMode: undefined,
        });
    } finally {
        unregisterReviewDecision(token);
    }
});

Deno.test("review image endpoints upload and serve an annotated image", async () => {
    const token = "review-image-secret";
    const app = createReviewWorkspaceApp({
        cwd: Deno.cwd(),
        token,
        reviewPayload: {},
        reviewType: "plan",
    }).handler();
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const formData = new FormData();
    formData.set("file", new File([bytes], "annotated.png", { type: "image/png" }));

    const upload = await app(
        new Request(`http://localhost/api/upload?token=${token}`, {
            method: "POST",
            body: formData,
        }),
    );
    assertEquals(upload.status, 200);
    const uploaded = await upload.json();

    try {
        const image = await app(
            new Request(`http://localhost/api/image?token=${token}&path=${encodeURIComponent(uploaded.path)}`),
        );
        assertEquals(image.status, 200);
        assertEquals(image.headers.get("content-type"), "image/png");
        assertEquals(new Uint8Array(await image.arrayBuffer()), bytes);
    } finally {
        await Deno.remove(uploaded.path).catch(() => {});
    }
});

Deno.test("code review host serves safe file content and disables unsupported open-in actions", async () => {
    const token = "review-file-secret";
    const cwd = await Deno.makeTempDir({ prefix: "runwield-review-files-" });
    await Deno.mkdir(`${cwd}/src`);
    await Deno.writeTextFile(`${cwd}/src/example.js`, "export const fixture = true;\n");
    const app = createReviewWorkspaceApp({
        cwd,
        token,
        reviewPayload: {},
        reviewType: "code",
    }).handler();
    const headers = { referer: `http://localhost/review/code?token=${token}` };

    try {
        const content = await app(
            new Request("http://localhost/api/file-content?path=src%2Fexample.js", { headers }),
        );
        assertEquals(content.status, 200);
        assertEquals(await content.json(), {
            oldContent: null,
            newContent: "export const fixture = true;\n",
            codeFile: true,
            contents: "export const fixture = true;\n",
            filepath: "src/example.js",
        });

        const relativeContent = await app(
            new Request(
                "http://localhost/api/file-content?path=..%2F..%2Fsrc%2Fexample.js&base=docs%2Fplans",
                { headers },
            ),
        );
        assertEquals(relativeContent.status, 200);
        assertEquals((await relativeContent.json()).filepath, "src/example.js");

        const traversal = await app(
            new Request("http://localhost/api/file-content?path=..%2Foutside.js", { headers }),
        );
        assertEquals(traversal.status, 403);

        const apps = await app(new Request("http://localhost/api/open-in/apps", { headers }));
        assertEquals(apps.status, 200);
        assertEquals(await apps.json(), { available: false, apps: [] });

        const config = await app(new Request("http://localhost/api/config", { method: "POST", headers }));
        assertEquals(config.status, 200);
        assertEquals(await config.json(), { ok: true });
    } finally {
        await Deno.remove(cwd, { recursive: true });
    }
});

Deno.test("review API returns 401 for invalid token and 404 for expired matching token", async () => {
    const app = createReviewWorkspaceApp({
        cwd: Deno.cwd(),
        token: "expected-review-token",
        reviewPayload: {},
        reviewType: "plan",
    }).handler();

    const invalidResponse = await app(
        new Request("http://localhost/api/review/decision", {
            method: "POST",
            headers: { "x-runwield-review-token": "wrong-review-token" },
        }),
    );
    assertEquals(invalidResponse.status, 401);

    const expiredResponse = await app(
        new Request("http://localhost/api/review/decision", {
            method: "POST",
            headers: { "x-runwield-review-token": "expected-review-token" },
        }),
    );
    assertEquals(expiredResponse.status, 404);
});
