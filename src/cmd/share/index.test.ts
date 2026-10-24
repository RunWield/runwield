import { test } from "node:test";
import { readFile as fsReadFile, readdir, rename, stat as fsStat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { assertEquals, assertRejects, assertStringIncludes } from "../../testing/assertions.ts";
import { withRuntimeCommandFixture } from "../testing/runtime-command-fixture.ts";
import { createSessionRuntime } from "../../shared/session/session-runtime.ts";
import { type GitHubCliPort, runShareCommand } from "./index.ts";

interface GitHubInvocation {
    args: string[];
    exportedSession?: string;
    exportedHtml?: string;
    directoryMode?: number;
}

interface ShareUi {
    messages: Array<{ message: string; error?: boolean }>;
    uiAPI: Pick<import("../../ui/tui/types.js").UiAPI, "appendSystemMessage">;
}

function createUi(): ShareUi {
    const messages: Array<{ message: string; error?: boolean }> = [];
    return {
        messages,
        uiAPI: {
            appendSystemMessage: (message, error) => messages.push({ message, error }),
        },
    };
}

function createGitHubFixture(options: { failAt?: "version" | "auth" | "gist"; gistOutput?: string } = {}): {
    invocations: GitHubInvocation[];
    port: GitHubCliPort;
} {
    const invocations: GitHubInvocation[] = [];
    return {
        invocations,
        port: {
            run: async (args) => {
                const invocation: GitHubInvocation = { args: [...args] };
                invocations.push(invocation);
                const stage = args[0] === "--version" ? "version" : args[0] === "auth" ? "auth" : "gist";
                if (stage === "gist") {
                    invocation.exportedSession = await fsReadFile(args.at(-1) || "", "utf8");
                    invocation.exportedHtml = await fsReadFile(args.at(-2) || "", "utf8");
                    invocation.directoryMode = (await fsStat(dirname(args.at(-1) || ""))).mode & 0o777;
                }
                if (options.failAt === stage) {
                    return { success: false, stdout: "", stderr: `${stage} failed` };
                }
                return {
                    success: true,
                    stdout: stage === "gist" ? (options.gistOutput ?? "https://gist.github.com/fixture\n") : "ok\n",
                    stderr: "",
                };
            },
        },
    };
}

async function assertRemoved(path: string): Promise<void> {
    await assertRejects(() => fsStat(path), Error, "ENOENT");
}

test("share uploads complete Session HTML and JSON in one secret Gist", async () => {
    await withRuntimeCommandFixture("share-command-", async ({ projectRoot }) => {
        const runtime = createSessionRuntime();
        const created = await runtime.createInteractiveSession({ cwd: projectRoot, mode: "new" });
        const github = createGitHubFixture();
        const ui = createUi();
        try {
            await runShareCommand([], {
                sessionId: created.sessionId,
                sessionRuntime: runtime,
                uiAPI: ui.uiAPI,
                githubCli: github.port,
            });

            assertEquals(
                github.invocations.slice(0, 2).map((invocation) => invocation.args),
                [["--version"], ["auth", "status"]],
            );
            const gistInvocation = github.invocations[2];
            assertEquals(gistInvocation.args.slice(0, 3), ["gist", "create", "--public=false"]);
            assertEquals(gistInvocation.args[3], "--desc");
            assertEquals(gistInvocation.args[4], "RunWield Session — RunWield Session");
            assertEquals(
                gistInvocation.args.slice(5).map((path) => basename(path)),
                ["runwield-session.html", "runwield-session.json"],
            );
            assertEquals(gistInvocation.directoryMode, 0o700);
            assertEquals(JSON.parse(gistInvocation.exportedSession || "").format, "runwield.session-export");
            assertEquals((gistInvocation.exportedHtml || "").startsWith("<!doctype html>"), true);
            assertStringIncludes(ui.messages[0].message, "Session shared successfully!");
            assertStringIncludes(ui.messages[0].message, "https://gist.github.com/fixture");
            assertStringIncludes(
                ui.messages[0].message,
                "https://gistpreview.github.io/?fixture/runwield-session.html",
            );
            await assertRemoved(dirname(gistInvocation.args[5]));
        } finally {
            await runtime.closeSession(created.sessionId);
        }
    });
});

test("share reports GitHub CLI preflight failures before exporting the Session", async () => {
    await withRuntimeCommandFixture("share-preflight-", async ({ projectRoot }) => {
        const runtime = createSessionRuntime();
        const created = await runtime.createInteractiveSession({ cwd: projectRoot, mode: "new" });
        try {
            const missing = createGitHubFixture({ failAt: "version" });
            const missingUi = createUi();
            assertEquals(
                await runShareCommand([], {
                    sessionId: created.sessionId,
                    sessionRuntime: runtime,
                    uiAPI: missingUi.uiAPI,
                    githubCli: missing.port,
                }),
                "failed",
            );
            assertEquals(missing.invocations.length, 1);
            assertStringIncludes(missingUi.messages[0].message, "not installed");

            const unauthenticated = createGitHubFixture({ failAt: "auth" });
            const authUi = createUi();
            await runShareCommand([], {
                sessionId: created.sessionId,
                sessionRuntime: runtime,
                uiAPI: authUi.uiAPI,
                githubCli: unauthenticated.port,
            });
            assertEquals(unauthenticated.invocations.length, 2);
            assertStringIncludes(authUi.messages[0].message, "not authenticated");
        } finally {
            await runtime.closeSession(created.sessionId);
        }
    });
});

test("share cleans the real exported fixture when gist creation fails", async () => {
    await withRuntimeCommandFixture("share-gist-failure-", async ({ projectRoot }) => {
        const runtime = createSessionRuntime();
        const created = await runtime.createInteractiveSession({ cwd: projectRoot, mode: "new" });
        const github = createGitHubFixture({ failAt: "gist" });
        const ui = createUi();
        try {
            await runShareCommand([], {
                sessionId: created.sessionId,
                sessionRuntime: runtime,
                uiAPI: ui.uiAPI,
                githubCli: github.port,
            });
            const exportedPath = github.invocations[2].args[5];
            await assertRemoved(dirname(exportedPath));
            assertStringIncludes(ui.messages[0].message, "gh gist create failed: gist failed");
            assertEquals(ui.messages[0].error, true);
        } finally {
            await runtime.closeSession(created.sessionId);
        }
    });
});

test("share requires UI and a real active Runtime session", async () => {
    await assertRejects(
        () => runShareCommand([], { githubCli: createGitHubFixture().port }),
        Error,
        "UI API is required",
    );

    const ui = createUi();
    const github = createGitHubFixture();
    await runShareCommand([], {
        uiAPI: ui.uiAPI,
        sessionRuntime: createSessionRuntime(),
        sessionId: "missing",
        githubCli: github.port,
    });
    assertEquals(ui.messages, [{ message: "Error: No active session found.", error: true }]);
    assertEquals(github.invocations, []);
});

for (const gistOutput of ["", "not a URL", "https://example.com/not-a-gist"]) {
    test(`share rejects unconfirmed Gist output ${JSON.stringify(gistOutput)} and removes temporary files`, async () => {
        await withRuntimeCommandFixture("share-unconfirmed-", async ({ projectRoot }) => {
            const runtime = createSessionRuntime();
            const created = await runtime.createInteractiveSession({ cwd: projectRoot, mode: "new" });
            const github = createGitHubFixture({ gistOutput });
            const ui = createUi();
            try {
                assertEquals(
                    await runShareCommand([], {
                        sessionId: created.sessionId,
                        sessionRuntime: runtime,
                        uiAPI: ui.uiAPI,
                        githubCli: github.port,
                    }),
                    "failed",
                );
                assertStringIncludes(ui.messages[0].message, "Failed to get Gist URL");
                assertEquals(ui.messages[0].error, true);
                await assertRemoved(dirname(github.invocations[2].args[5]));
            } finally {
                await runtime.closeSession(created.sessionId);
            }
        });
    });
}

test("share does not restore a missing Session Manifest before export", async () => {
    await withRuntimeCommandFixture("share-read-only-", async ({ projectRoot, homeDir, setModelResponse }) => {
        setModelResponse("Recorded reply.");
        const runtime = createSessionRuntime();
        const created = await runtime.createInteractiveSession({ cwd: projectRoot, mode: "new" });
        const github = createGitHubFixture();
        const ui = createUi();
        let manifestPath = "";
        try {
            await runtime.promptUserTurn(created.sessionId, {
                initialRequest: "Save this Session.",
                agentName: "operator",
            });
            const root = join(homeDir, ".wld", "sessions");
            const manifests = (await readdir(root, { recursive: true })).filter((path) =>
                path.endsWith("/manifest.json"),
            );
            assertEquals(manifests.length, 1);
            manifestPath = join(root, manifests[0]);
            await rename(manifestPath, `${manifestPath}.held`);
            assertEquals(
                await runShareCommand([], {
                    sessionId: created.sessionId,
                    sessionRuntime: runtime,
                    uiAPI: ui.uiAPI,
                    githubCli: github.port,
                }),
                "failed",
            );
            await assertRemoved(manifestPath);
            assertEquals(github.invocations.length, 2);
        } finally {
            if (manifestPath) await rename(`${manifestPath}.held`, manifestPath);
            await runtime.closeSession(created.sessionId);
        }
    });
});
