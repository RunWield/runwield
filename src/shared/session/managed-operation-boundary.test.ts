import { assertEquals } from "../../testing/assertions.ts";
import { readFile as fsReadFile } from "node:fs/promises";
import { test } from "node:test";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { withRuntimeCommandFixture } from "../../cmd/testing/runtime-command-fixture.ts";
import { openOwnerCoordinationStore } from "../owner-coordination/index.js";
import { createSessionRuntime } from "./session-runtime.ts";

test("ManagedOperationCapability has no runtime constructor export", async () => {
    const managedOperationModule = await import("./managed-operation.ts");
    assertEquals("ManagedOperationCapability" in managedOperationModule, false);
});

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

test("managed operation re-entry policy is keyed to capability state, not runtime busy state", async () => {
    const source = await fsReadFile(new URL("./runtime/managed-operations.ts", import.meta.url), "utf8");
    const rejectionStart = source.indexOf(
        "rejectManagedPublicMutation(",
    );
    const rejectionEnd = source.indexOf("\n    /**", rejectionStart);
    const rejectionBody = source.slice(rejectionStart, rejectionEnd);
    assertEquals(rejectionBody.includes("currentManagedOperations"), true);
    assertEquals(rejectionBody.includes("busyOperationDepths"), false);
    assertEquals(rejectionBody.includes("busy"), false);

    const runStart = source.indexOf("async runManagedOperation<T>(");
    const runEnd = source.indexOf("const managed = hostedSession.getManagedMetadata?.();", runStart);
    const runPrelude = source.slice(runStart, runEnd);
    assertEquals(runPrelude.includes("busyOperationDepths"), false);
    assertEquals(runPrelude.includes("busy"), false);
});

test("managed prompt re-entry is rejected while a real operation holds the capability", async () => {
    await withRuntimeCommandFixture(
        "managed-operation-boundary-",
        async ({ homeDir: home, projectRoot: cwd, setModelResponseFactories }) => {
            setModelResponseFactories([
                () => fauxAssistantMessage(fauxText("First managed prompt completed. ".repeat(2_000))),
                () => fauxAssistantMessage(fauxText("Third managed prompt completed.")),
            ]);
            const store = openOwnerCoordinationStore({ dbPath: `${home}/owner.sqlite3` });
            try {
                store.registerProject({ root: cwd, now: () => "2026-01-01T00:00:01.000Z" });
                const runtime = createSessionRuntime({
                    sessionStore: store,
                    ownerProcessKind: "test",
                    ownerInstanceId: "managed-operation-boundary-owner",
                });
                let firstPrompt:
                    | Promise<{ ok: boolean; turns: number; error?: string }>
                    | null = null;
                try {
                    const created = await runtime.createInteractiveSession({
                        cwd,
                        mode: "new",
                    });
                    await runtime.switchAgent(created.sessionId, { agentName: "engineer" });
                    const dormant = runtime.getSessionSnapshot(created.sessionId);
                    assertEquals(dormant?.managed?.generation, 1);
                    assertEquals(typeof dormant?.sessionManagerId, "string");

                    firstPrompt = runtime.promptManagedSession(created.sessionId, {
                        initialRequest: "first managed prompt",
                        expectedGeneration: 1,
                    });
                    let hydrated = runtime.getSessionSnapshot(created.sessionId);
                    for (let attempt = 0; attempt < 1_000 && hydrated?.managed?.dormant !== false; attempt += 1) {
                        await delay(10);
                        hydrated = runtime.getSessionSnapshot(created.sessionId);
                    }
                    assertEquals(hydrated?.managed?.dormant, false);
                    assertEquals(hydrated?.busy, true);

                    const second = await runtime.promptManagedSession(created.sessionId, {
                        initialRequest: "second managed prompt",
                        expectedGeneration: 1,
                    });
                    assertEquals(second, {
                        ok: false,
                        turns: 0,
                        error: "managed_operation_in_progress",
                    });
                    assertEquals(runtime.getSessionSnapshot(created.sessionId)?.managed?.generation, 1);
                    const cataloged = store.getSessionById(dormant?.managed?.runwieldSessionId || "");
                    const transcriptBeforeFirstCompletes = await fsReadFile(cataloged?.transcriptPath || "", "utf8");
                    assertEquals(transcriptBeforeFirstCompletes.includes("second managed prompt"), false);

                    const first = await firstPrompt;
                    assertEquals(first.ok, true);
                    assertEquals(runtime.getSessionSnapshot(created.sessionId)?.managed?.generation, 2);
                    assertEquals(typeof runtime.getSessionSnapshot(created.sessionId)?.sessionManagerId, "string");

                    const third = await runtime.promptManagedSession(created.sessionId, {
                        initialRequest: "third managed prompt",
                        expectedGeneration: 2,
                    });
                    assertEquals(third.ok, true);
                    assertEquals(runtime.getSessionSnapshot(created.sessionId)?.managed?.generation, 3);
                } finally {
                    if (firstPrompt) await firstPrompt.catch(() => undefined);
                    await runtime.closeAllSessionsWhenIdle?.();
                }
            } finally {
                store.close();
            }
        },
    );
});
