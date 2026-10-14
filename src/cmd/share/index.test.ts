import { test } from "node:test";
import { readFile as fsReadFile, stat as fsStat } from "node:fs/promises";
import { assertEquals, assertRejects, assertStringIncludes } from "../../testing/assertions.ts";
import { withRuntimeCommandFixture } from "../testing/runtime-command-fixture.ts";
import { createSessionRuntime } from "../../shared/session/session-runtime.ts";
import { type GitHubCliPort, runShareCommand } from "./index.ts";

interface GitHubInvocation {
    args: string[];
    exportedSession?: string;
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

function createGitHubFixture(options: { failAt?: "version" | "auth" | "gist"; emptyUrl?: boolean } = {}): {
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
                if (stage === "gist") invocation.exportedSession = await fsReadFile(args.at(-1) || "", "utf8");
                if (options.failAt === stage) {
                    return { success: false, stdout: "", stderr: `${stage} failed` };
                }
                return {
                    success: true,
                    stdout: stage === "gist" && !options.emptyUrl ? "https://gist.example/fixture\n" : "ok\n",
                    stderr: "",
                };
            },
        },
    };
}

async function assertRemoved(path: string): Promise<void> {
    await assertRejects(() => fsStat(path), Error, "ENOENT");
}

test("share exports a real persisted Runtime session for the external GitHub CLI", async () => {
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

            assertEquals(github.invocations.slice(0, 2).map((invocation) => invocation.args), [
                ["--version"],
                ["auth", "status"],
            ]);
            const gistInvocation = github.invocations[2];
            assertEquals(gistInvocation.args.slice(0, 3), ["gist", "create", "--public=false"]);
            assertStringIncludes(gistInvocation.exportedSession || "", '"type":"session"');
            assertStringIncludes(ui.messages[0].message, "Session shared successfully!");
            assertStringIncludes(ui.messages[0].message, "https://gist.example/fixture");
            await assertRemoved(gistInvocation.args[3]);
        } finally {
            runtime.closeSession(created.sessionId);
        }
    });
});

test("share reports GitHub CLI preflight failures before exporting the real session", async () => {
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
            runtime.closeSession(created.sessionId);
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
            const exportedPath = github.invocations[2].args[3];
            await assertRemoved(exportedPath);
            assertStringIncludes(ui.messages[0].message, "gh gist create failed: gist failed");
            assertEquals(ui.messages[0].error, true);
        } finally {
            runtime.closeSession(created.sessionId);
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
