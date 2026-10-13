import { test } from "node:test";
import { readdir as fsReaddir } from "node:fs/promises";
import { assertEquals, assertRejects } from "../../testing/assertions.ts";
import { TuiMainScreen } from "@earendil-works/pi-tui";
import { createSessionRuntime } from "../../shared/session/session-runtime.ts";
import { getRunWieldSessionDir } from "../../shared/session/root-session.js";
import { initTUIWithPair, stopTUI } from "../../ui/tui/tui.ts";
import { VirtualTerminal } from "../../ui/tui/testing/virtual-terminal.js";
import { withRuntimeCommandFixture } from "../testing/runtime-command-fixture.ts";
import { runNewCommand } from "./index.ts";

async function captureErrors(run: () => Promise<void>): Promise<string[]> {
    const originalError = console.error;
    const errors: string[] = [];
    console.error = (message = "") => errors.push(String(message));
    try {
        await run();
    } finally {
        console.error = originalError;
    }
    return errors;
}

class CompatibleVirtualTerminal extends VirtualTerminal {
    override drainInput(): Promise<void> {
        return Promise.resolve();
    }

    override moveBy(lines: number, columns?: number): void {
        super.moveBy(lines, columns ?? 0);
    }

    override setProgress(active: boolean | number | null): void {
        super.setProgress(typeof active === "boolean" ? (active ? 1 : null) : active);
    }
}

async function countTranscripts(projectRoot: string): Promise<number> {
    let count = 0;
    try {
        for await (const entry of await fsReaddir(getRunWieldSessionDir(projectRoot), { withFileTypes: true })) {
            if (entry.isFile() && entry.name.endsWith(".jsonl")) count++;
        }
    } catch (error) {
        if ((error instanceof Error && "code" in error && error.code === "ENOENT")) return 0;
        throw error;
    }
    return count;
}

test("runNewCommand creates and names an in-memory Router session until its first message", async () => {
    await withRuntimeCommandFixture("runwield-new-command-", async ({ projectRoot, setModelResponse }) => {
        setModelResponse("New Session ready.");
        const runtime = createSessionRuntime();
        const current = await runtime.createInteractiveSession({ cwd: projectRoot, mode: "new" });
        const transcriptsBeforeNew = await countTranscripts(projectRoot);
        let replacementId = "";
        let cleared = false;
        try {
            await runNewCommand(["build", "coverage"], {
                uiAPI: { clearMessages: () => cleared = true },
                sessionId: current.sessionId,
                sessionRuntime: runtime,
                replaceRuntimeSession: (sessionId) => replacementId = sessionId,
            });

            const replacement = runtime.getSessionSnapshot(replacementId);
            assertEquals(replacement?.cwd, projectRoot);
            assertEquals(replacement?.name, "build coverage");
            assertEquals(replacement?.activeAgent, "router");
            assertEquals(replacement?.sessionManagerId, null);
            assertEquals(replacement?.managed, null);
            assertEquals(cleared, true);
            assertEquals(runtime.listSessions().length, 2);
            assertEquals(await countTranscripts(projectRoot), transcriptsBeforeNew);

            const firstTurn = await runtime.promptUserTurn(replacementId, { initialRequest: "Start working" });
            assertEquals(firstTurn.ok, true);
            assertEquals(typeof runtime.getSessionSnapshot(replacementId)?.sessionManagerId, "string");
            assertEquals(runtime.getSessionSnapshot(replacementId)?.name, "build coverage");
            assertEquals(await countTranscripts(projectRoot), transcriptsBeforeNew + 1);
        } finally {
            runtime.closeAllSessions();
        }
    });
});

test("runNewCommand uses the fixture cwd when there is no current session", async () => {
    await withRuntimeCommandFixture("runwield-new-command-", async ({ alternateRoot }) => {
        const runtime = createSessionRuntime();
        const terminal = new CompatibleVirtualTerminal();
        const tui = new TuiMainScreen(terminal);
        initTUIWithPair({ terminal, tui });
        let replacementId = "";
        try {
            await runNewCommand([], {
                uiAPI: {},
                sessionRuntime: runtime,
                replaceRuntimeSession: (sessionId) => replacementId = sessionId,
            });

            const replacement = runtime.getSessionSnapshot(replacementId);
            assertEquals(replacement?.cwd, alternateRoot);
            assertEquals(replacement?.name, null);
            assertEquals(terminal.title, "W.");
            assertEquals(replacement?.activeAgent, "router");
            assertEquals(replacement?.sessionManagerId, null);
            assertEquals(replacement?.managed, null);
            assertEquals(await countTranscripts(alternateRoot), 0);
        } finally {
            stopTUI();
            runtime.closeAllSessions();
        }
    });
});

test("runNewCommand reports unavailable interactive state", async () => {
    await withRuntimeCommandFixture("runwield-new-command-", async () => {
        const errors = await captureErrors(() => runNewCommand([]));
        assertEquals(errors, ["The /new command is only available inside an interactive session."]);

        await assertRejects(
            () => runNewCommand([], { uiAPI: {} }),
            Error,
            "/new requires the SessionRuntime surface.",
        );
    });
});
