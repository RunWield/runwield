import process from "node:process";
import { test } from "node:test";
import { assertEquals, assertStringIncludes } from "../../testing/assertions.ts";
import { withRuntimeCommandFixture } from "../testing/runtime-command-fixture.ts";
import { runRouterCommand } from "./index.ts";

async function captureLogs(run: () => void | Promise<void>): Promise<string[]> {
    const logs: string[] = [];
    const original = console.log;
    console.log = (message = "") => logs.push(String(message));
    try {
        await run();
    } finally {
        console.log = original;
    }
    return logs;
}

test("router help uses the real command registry without starting a session", async () => {
    await withRuntimeCommandFixture("router-help-", async ({ projectRoot }) => {
        process.chdir(projectRoot);
        let started = false;
        const logs = await captureLogs(() =>
            runRouterCommand(["help"], {
                sessionPort: {
                    startInteractiveSession: () => {
                        started = true;
                        return Promise.resolve();
                    },
                },
            })
        );

        assertEquals(started, false);
        assertStringIncludes(logs.join("\n"), "Usage (router):");
        assertStringIncludes(logs.join("\n"), "default command");
    });
});

test("router starts the external session with the complete request and requested mode", async () => {
    await withRuntimeCommandFixture("router-request-", async ({ projectRoot }) => {
        process.chdir(projectRoot);
        let receivedRequest: string | null = null;
        let receivedMode: "new" | "continue" | undefined;

        await runRouterCommand(["fix", "the", "fixture"], {
            sessionStartMode: "continue",
            sessionPort: {
                startInteractiveSession: (request, options) => {
                    receivedRequest = request;
                    receivedMode = options.sessionStartMode;
                    return Promise.resolve();
                },
            },
        });

        assertEquals(receivedRequest, "fix the fixture");
        assertEquals(receivedMode, "continue");
    });
});

test("router starts an empty external session when no request is supplied", async () => {
    await withRuntimeCommandFixture("router-empty-", async ({ projectRoot }) => {
        process.chdir(projectRoot);
        let receivedRequest: string | null = "sentinel";

        await runRouterCommand([], {
            sessionPort: {
                startInteractiveSession: (request) => {
                    receivedRequest = request;
                    return Promise.resolve();
                },
            },
        });

        assertEquals(receivedRequest, null);
    });
});
