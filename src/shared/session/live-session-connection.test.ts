import { assertEquals } from "../../testing/assertions.ts";
import { createHash } from "node:crypto";
import { Agent, request } from "node:http";
import { platform } from "node:process";
import { mock, test } from "node:test";
import { getHomeDir } from "../../constants.ts";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { withRuntimeCommandFixture } from "../../cmd/testing/runtime-command-fixture.ts";
import { makeManagedSessionFixture } from "../../testing/managed-session-fixture.ts";
import { readLiveSessionConnection } from "./live-session-connection.ts";

async function withLiveTurn(run: (live: LiveTurn) => Promise<void>) {
    await withRuntimeCommandFixture(
        "live-session-contract-",
        async ({ homeDir, projectRoot, setModelResponseFactory }) => {
            const fixture = await makeManagedSessionFixture({ home: homeDir, projectRoot });
            const handle = fixture.openRuntime("test", "live-contract-owner");
            let release = () => {};
            let started = () => {};
            const responseReady = new Promise<void>((resolve) => {
                release = resolve;
            });
            const modelStarted = new Promise<void>((resolve) => {
                started = resolve;
            });
            setModelResponseFactory(async () => {
                started();
                await responseReady;
                return fauxAssistantMessage(fauxText("The live turn completed."));
            });
            const turn = handle.runtime.promptManagedSession(handle.adoptedSessionId, {
                initialRequest: "Start a live turn",
                expectedGeneration: 0,
            });
            try {
                await modelStarted;
                const operationId = handle.store.inspectSessionActivation(fixture.session.runwieldSessionId).activation
                    ?.operationId;
                if (!operationId) throw new Error("Expected a real active operation");
                await run({
                    sessionId: fixture.session.runwieldSessionId,
                    operationId,
                    queued: () => handle.runtime.getQueuedMessages(handle.adoptedSessionId),
                    finish: async () => {
                        release();
                        await turn;
                    },
                });
            } finally {
                release();
                await turn;
                await handle.close();
                await fixture.cleanup();
            }
        },
    );
}

type LiveTurn = {
    sessionId: string;
    operationId: string;
    queued: () => ReturnType<import("./session-runtime.ts").SessionRuntime["getQueuedMessages"]>;
    finish: () => Promise<void>;
};

test("a retry after five elapsed minutes queues its message only once in the real runtime", async () => {
    await withLiveTurn(async (live) => {
        mock.timers.enable({ apis: ["setTimeout", "Date"] });
        try {
            const command = { action: "steer" as const, requestId: "retry-1", text: "change direction" };
            const first = await readLiveSessionConnection(live.sessionId, live.operationId, command);
            mock.timers.tick(5 * 60 * 1000 + 1);
            const second = await readLiveSessionConnection(live.sessionId, live.operationId, command);
            assertEquals(first.ok, true);
            assertEquals(first.queued, true);
            assertEquals(second, first);
            assertEquals(
                live.queued().map((message) => message.text),
                ["change direction"],
            );
        } finally {
            mock.timers.reset();
        }
    });
});

test("settling a live turn releases an idle HTTP keep-alive client", async () => {
    await withLiveTurn(async (live) => {
        const agent = new Agent({ keepAlive: true });
        const key = createHash("sha256")
            .update(`${getHomeDir()}:${live.sessionId}:${live.operationId}`)
            .digest("hex")
            .slice(0, 40);
        const path = platform === "win32" ? `\\\\.\\pipe\\runwield-${key}` : `/tmp/runwield-${key}.sock`;
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            await new Promise<void>((resolve, reject) => {
                const req = request({ socketPath: path, path: "/", agent }, (response) => {
                    response.resume();
                    response.once("end", resolve);
                    response.once("error", reject);
                });
                req.once("error", reject);
                req.end();
            });
            await Promise.race([
                live.finish(),
                new Promise<void>((_resolve, reject) => {
                    timer = setTimeout(() => reject(new Error("An idle client blocked turn settlement")), 1000);
                }),
            ]);
        } finally {
            clearTimeout(timer);
            agent.destroy();
        }
    });
});
