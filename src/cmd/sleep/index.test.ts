import { assert, assertEquals, assertMatch, assertRejects, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { withRuntimeCommandFixture } from "../testing/runtime-command-fixture.ts";
import { createSessionRuntime } from "../../shared/session/session-runtime.ts";
import { RuntimeEventTypes } from "../../shared/session/session-runtime-events.js";
import {
    exportMnemotecaCollection,
    type InteractiveSessionPort,
    type MnemotecaPort,
    runSleepCommand,
} from "./index.ts";

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
                    await Deno.writeTextFile(outputPath, '{"type":"mnemoteca-export"}\n');
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

Deno.test("sleep help uses the real command registry", async () => {
    const output = await captureConsole(() =>
        runSleepCommand(["--help"], {
            mnemotecaPort: createMnemotecaFixture().port,
            sessionPort: UNEXPECTED_SESSION_PORT,
        })
    );
    assertStringIncludes(output.logs.join("\n"), "Usage (sleep):");
    assertStringIncludes(output.logs.join("\n"), "memory");
});

Deno.test("standalone sleep delegates only interactive session startup", async () => {
    let request: string | null = null;
    let agentName = "";
    await runSleepCommand([], {
        mnemotecaPort: createMnemotecaFixture().port,
        sessionPort: {
            startInteractiveSession: (nextRequest, options) => {
                request = nextRequest;
                agentName = options.initialAgentName || "";
                return Promise.resolve();
            },
        },
    });

    assertEquals(request, "/sleep");
    assertEquals(agentName, "engineer");
});

Deno.test("Mnemoteca export creates its real fixture directory and verifies the subprocess output", async () => {
    const tempDir = await Deno.makeTempDir({ prefix: "runwield-sleep-export-" });
    const outputPath = join(tempDir, "nested", "backup.jsonl");
    const fixture = createMnemotecaFixture();
    try {
        await exportMnemotecaCollection("project", outputPath, fixture.port);

        assertEquals(fixture.exports, [{
            args: ["export", "--name", "project", "--no-embeddings", "--output", outputPath],
            outputPath,
        }]);
        assert((await Deno.stat(outputPath)).isFile);
    } finally {
        await Deno.remove(tempDir, { recursive: true });
    }
});

Deno.test("Mnemoteca export rejects subprocess failure and false success", async () => {
    const tempDir = await Deno.makeTempDir({ prefix: "runwield-sleep-export-failure-" });
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
        await Deno.remove(tempDir, { recursive: true });
    }
});

Deno.test("sleep backs up fixture memory before a real Runtime switches and runs Engineer", async () => {
    await withRuntimeCommandFixture("sleep-command-", async ({ homeDir, projectRoot, setModelResponse }) => {
        setModelResponse("Memory maintenance complete.");
        const runtime = createSessionRuntime();
        const sessionId = await runtime.createPromptReadySession({ cwd: projectRoot, agentName: "router" });
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
            assert(backupPath.startsWith(join(homeDir, ".wld")));
            assertMatch(backupPath, /project\.sleep-backup-.*\.jsonl$/);
            assertEquals(await Deno.readTextFile(backupPath), '{"type":"mnemoteca-export"}\n');
            assertEquals(messages, [`[RunWield] Memory backup created before sleep mode: ${backupPath}`]);
            assertEquals(runtime.getSessionSnapshot(sessionId)?.activeAgent, "engineer");
            assertEquals(requests.length, 1);
            assertStringIncludes(requests[0], await Deno.readTextFile(new URL("./prompt.md", import.meta.url)));
            assertStringIncludes(requests[0], `Immutable pre-maintenance backup: ${backupPath}`);
            assertStringIncludes(requests[0], "Session artifact directory:");
        } finally {
            runtime.closeSession(sessionId);
        }
    });
});

Deno.test("sleep can be the first prompt in a new deferred-persistence Session", async () => {
    await withRuntimeCommandFixture(
        "sleep-command-first-prompt-",
        async ({ homeDir, projectRoot, setModelResponse }) => {
            setModelResponse("Memory maintenance complete.");
            const runtime = createSessionRuntime();
            const sessionId = await runtime.createPromptReadySession({
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

Deno.test("sleep leaves a real Runtime on its current Agent when external backup fails", async () => {
    await withRuntimeCommandFixture("sleep-command-failure-", async ({ projectRoot }) => {
        const runtime = createSessionRuntime();
        const sessionId = await runtime.createPromptReadySession({ cwd: projectRoot, agentName: "router" });
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

Deno.test("sleep rejects missing Runtime state before touching Mnemoteca", async () => {
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
