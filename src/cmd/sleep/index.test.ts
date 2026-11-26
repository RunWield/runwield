import { mkdtemp as fsMkdtemp, readFile as fsReadFile, rm as fsRm, writeFile as fsWriteFile } from "node:fs/promises";
import { test } from "node:test";
import { projects, ProjectIdentityEntryRequired } from "@runwield/projects";
import { tmpdir } from "node:os";
import { ok as assert, match as assertMatch } from "node:assert/strict";
import { assertEquals, assertRejects, assertStringIncludes } from "../../testing/assertions.ts";
import { join } from "node:path";
import { defineCommittedGitFixture, git } from "../../shared/git-test-fixture.ts";
import { withRuntimeCommandFixture } from "../testing/runtime-command-fixture.ts";
import { createInteractiveSessionRuntime as createSessionRuntime } from "@runwield/session-runtime/services";
import { RuntimeEventTypes } from "@runwield/session-runtime/events";
import {
    exportMnemotecaCollection,
    type InteractiveSessionPort,
    type MnemotecaPort,
    runSleepCommand,
} from "./index.ts";

async function admit(root: string): Promise<string> {
    const result = await projects.checkout.admit(root);
    if (result.kind !== "existing") throw new ProjectIdentityEntryRequired(result);
    return result.identity.projectId;
}

interface ExportInvocation {
    args: string[];
    outputPath: string;
}

interface MnemotecaFixture {
    port: MnemotecaPort;
    ensureCalls: number;
    exports: ExportInvocation[];
}

function createMnemotecaFixture(
    options: { exitCode?: number; omitOutput?: boolean; beforeExport?: () => void } = {},
): MnemotecaFixture {
    const fixture: MnemotecaFixture = {
        ensureCalls: 0,
        exports: [],
        port: {
            ensureAvailable: () => {
                fixture.ensureCalls += 1;
                return Promise.resolve();
            },
            run: async (args) => {
                options.beforeExport?.();
                const outputPath = args.at(-1) || "";
                fixture.exports.push({ args: [...args], outputPath });
                if (!options.omitOutput && !options.exitCode) {
                    await fsWriteFile(outputPath, '{"type":"mnemoteca-export"}\n');
                }
                const exitCode = options.exitCode || 0;
                return {
                    success: exitCode === 0,
                    code: exitCode,
                    stdout: new Uint8Array(),
                    stderr: exitCode === 0 ? new Uint8Array() : new TextEncoder().encode("export refused"),
                };
            },
        },
    };
    return fixture;
}

const UNEXPECTED_SESSION_PORT: InteractiveSessionPort = {
    startInteractiveSession: () => Promise.reject(new Error("interactive session must not start")),
};

async function captureConsole(run: () => void | Promise<void>): Promise<{ logs: string[]; errors: string[] }> {
    const logs: string[] = [];
    const errors: string[] = [];
    const originalLog = console.log;
    const originalError = console.error;
    console.log = (message = "") => logs.push(String(message));
    console.error = (message = "") => errors.push(String(message));
    try {
        await run();
    } finally {
        console.log = originalLog;
        console.error = originalError;
    }
    return { logs, errors };
}

test("sleep help uses the real command registry", async () => {
    const output = await captureConsole(() =>
        runSleepCommand(["--help"], {
            mnemotecaPort: createMnemotecaFixture().port,
            sessionPort: UNEXPECTED_SESSION_PORT,
        }),
    );
    assertStringIncludes(output.logs.join("\n"), "Usage (sleep):");
    assertStringIncludes(output.logs.join("\n"), "memory");
});

test("Mnemoteca export rejects subprocess failure and false success", async () => {
    const tempDir = await fsMkdtemp(join(tmpdir(), "runwield-sleep-export-failure-"));
    try {
        await assertRejects(
            () =>
                exportMnemotecaCollection(
                    "project",
                    join(tempDir, "failed.jsonl"),
                    createMnemotecaFixture({ exitCode: 7 }).port,
                ),
            Error,
            "export refused",
        );
        await assertRejects(
            () =>
                exportMnemotecaCollection(
                    "project",
                    join(tempDir, "missing.jsonl"),
                    createMnemotecaFixture({ omitOutput: true }).port,
                ),
            Error,
            "did not create the backup",
        );
    } finally {
        await fsRm(tempDir, { recursive: true });
    }
});

test("sleep backs up fixture memory before a real Runtime switches and runs Engineer", async () => {
    await withRuntimeCommandFixture("sleep-command-", async ({ homeDir, projectRoot, setModelResponse }) => {
        const projectId = await admit(projectRoot);
        setModelResponse("Memory maintenance complete.");
        const runtime = createSessionRuntime();
        const { sessionId } = await runtime.createSession({ cwd: projectRoot, agentName: "router" });
        const messages: string[] = [];
        const requests: string[] = [];
        const agentsAtBackup: Array<string | null> = [];
        const mnemoteca = createMnemotecaFixture({
            beforeExport: () => agentsAtBackup.push(runtime.getSessionSnapshot(sessionId)?.activeAgent || null),
        });
        runtime.subscribeSessionEvents(sessionId, (event) => {
            if (event.type === RuntimeEventTypes.USER_MESSAGE) requests.push(event.text);
        });
        try {
            await runSleepCommand([], {
                sessionId,
                sessionRuntime: runtime,
                uiAPI: { appendSystemMessage: (message) => messages.push(message) },
                mnemotecaPort: mnemoteca.port,
                sessionPort: UNEXPECTED_SESSION_PORT,
            });

            assertEquals(mnemoteca.ensureCalls, 1);
            assertEquals(mnemoteca.exports.length, 1);
            assertEquals(agentsAtBackup, ["router"]);
            const backupPath = mnemoteca.exports[0].outputPath;
            assertEquals(mnemoteca.exports[0].args, [
                "export",
                "--name",
                projectId,
                "--no-embeddings",
                "--output",
                backupPath,
            ]);
            assert(backupPath.startsWith(join(homeDir, ".wld")));
            assertMatch(backupPath, new RegExp(`${projectId}\\.sleep-backup-.*\\.jsonl$`));
            assertEquals(await fsReadFile(backupPath, "utf8"), '{"type":"mnemoteca-export"}\n');
            assertEquals(messages, [`[RunWield] Memory backup created before sleep mode: ${backupPath}`]);
            assertEquals(runtime.getSessionSnapshot(sessionId)?.activeAgent, "engineer");
            assertEquals(requests.length, 1);
            assertStringIncludes(requests[0], await fsReadFile(new URL("./prompt.md", import.meta.url), "utf8"));
            assertStringIncludes(requests[0], `Immutable pre-maintenance backup: ${backupPath}`);
            assertStringIncludes(requests[0], "Session artifact directory:");
        } finally {
            runtime.closeSession(sessionId);
        }
    });
});

test("sleep can be the first prompt in a new deferred-persistence Session", async () => {
    await withRuntimeCommandFixture(
        "sleep-command-first-prompt-",
        async ({ homeDir, projectRoot, setModelResponse }) => {
            await admit(projectRoot);
            setModelResponse("Memory maintenance complete.");
            const runtime = createSessionRuntime();
            const { sessionId } = await runtime.createSession({
                cwd: projectRoot,
                agentName: "router",
                deferPersistenceUntilFirstMessage: true,
            });
            const mnemoteca = createMnemotecaFixture();
            try {
                assertEquals(runtime.getSessionSnapshot(sessionId)?.sessionManagerId, null);

                await runSleepCommand([], {
                    sessionId,
                    sessionRuntime: runtime,
                    uiAPI: { appendSystemMessage: () => {} },
                    mnemotecaPort: mnemoteca.port,
                    sessionPort: UNEXPECTED_SESSION_PORT,
                });

                assertEquals(typeof runtime.getSessionSnapshot(sessionId)?.sessionManagerId, "string");
                assertEquals(runtime.getSessionSnapshot(sessionId)?.activeAgent, "engineer");
                assertEquals(mnemoteca.exports.length, 1);
                assert(mnemoteca.exports[0].outputPath.startsWith(join(homeDir, ".wld")));
            } finally {
                await runtime.closeSession(sessionId);
            }
        },
    );
});

test("sleep leaves a real Runtime on its current Agent when external backup fails", async () => {
    await withRuntimeCommandFixture("sleep-command-failure-", async ({ projectRoot }) => {
        await admit(projectRoot);
        const runtime = createSessionRuntime();
        const { sessionId } = await runtime.createSession({ cwd: projectRoot, agentName: "router" });
        const mnemoteca = createMnemotecaFixture({ exitCode: 7 });
        const messages: string[] = [];
        try {
            await assertRejects(
                () =>
                    runSleepCommand([], {
                        sessionId,
                        sessionRuntime: runtime,
                        uiAPI: { appendSystemMessage: (message) => messages.push(message) },
                        mnemotecaPort: mnemoteca.port,
                        sessionPort: UNEXPECTED_SESSION_PORT,
                    }),
                Error,
                "export refused",
            );
            assertEquals(runtime.getSessionSnapshot(sessionId)?.activeAgent, "router");
            assertEquals(messages, []);
        } finally {
            runtime.closeSession(sessionId);
        }
    });
});

const memoryGitFixture = defineCommittedGitFixture();

test("sleep maintains the admitted Project collection from a worktree", async () => {
    await withRuntimeCommandFixture("sleep-worktree-", async ({ setModelResponse }) => {
        const root = await memoryGitFixture.checkout();
        const temp = await fsMkdtemp(join(tmpdir(), "sleep-worktree-"));
        const worktree = join(temp, "feature");
        const runtime = createSessionRuntime();
        let sessionId: string | undefined;
        try {
            const projectId = await admit(root);
            await git(root, ["worktree", "add", "-b", "feature", worktree]);
            await admit(worktree);
            setModelResponse("Memory maintenance complete.");
            ({ sessionId } = await runtime.createSession({ cwd: worktree, agentName: "router" }));
            const requests: string[] = [];
            runtime.subscribeSessionEvents(sessionId, (event) => {
                if (event.type === RuntimeEventTypes.USER_MESSAGE) requests.push(event.text);
            });
            const mnemoteca = createMnemotecaFixture();
            await runSleepCommand([], {
                sessionId,
                sessionRuntime: runtime,
                uiAPI: { appendSystemMessage: () => {} },
                mnemotecaPort: mnemoteca.port,
                sessionPort: UNEXPECTED_SESSION_PORT,
            });
            assertEquals(mnemoteca.exports[0]?.args.slice(0, 3), ["export", "--name", projectId]);
            assertStringIncludes(requests[0], `Use --name ${JSON.stringify(projectId)} for every mnemoteca command.`);
        } finally {
            if (sessionId) await runtime.closeSession(sessionId);
            await fsRm(temp, { recursive: true });
            await fsRm(root, { recursive: true });
        }
    });
});

test("sleep rejects missing Runtime state before touching Mnemoteca", async () => {
    const mnemoteca = createMnemotecaFixture();
    await assertRejects(
        () =>
            runSleepCommand([], {
                sessionId: "missing",
                sessionRuntime: createSessionRuntime(),
                uiAPI: { appendSystemMessage: () => {} },
                mnemotecaPort: mnemoteca.port,
                sessionPort: UNEXPECTED_SESSION_PORT,
            }),
        Error,
        "active runtime session",
    );
    assertEquals(mnemoteca.ensureCalls, 0);
});
