import { test } from "node:test";
import { readFile as fsReadFile, stat as fsStat } from "node:fs/promises";
import { ok as assert } from "node:assert/strict";
import { assertEquals, assertStringIncludes } from "../../testing/assertions.ts";
import { join } from "node:path";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { assertRemoteStorageAbsent, withRemoteRuntimeFixture } from "./remote-runtime-test-fixture.ts";

for (const fault of ["append", "checkpoint"] as const) {
    test(`remote ${fault} interruption marks laptop ownership uncertain and resumes without repeating a project write`, async () => {
        await withRemoteRuntimeFixture(async (f) => {
            const contexts: string[] = [];
            f.setModelResponseFactories([
                (context) => {
                    contexts.push(JSON.stringify(context));
                    return fauxAssistantMessage(fauxToolCall("read", { path: "sentinel.txt" }));
                },
                (context) => {
                    contexts.push(JSON.stringify(context));
                    return fauxAssistantMessage(
                        fauxToolCall("write", { path: "sentinel.txt", content: "one durable effect\n" }),
                    );
                },
                (context) => {
                    contexts.push(JSON.stringify(context));
                    return fauxAssistantMessage(fauxText("Effect finished."));
                },
            ]);
            let interrupted = false;
            if (fault === "append") {
                // The owner has durably saved the tool result; only its network acknowledgement is lost.
                f.policy.handle = async (input, path, response) => {
                    if (
                        path === "/session/request" &&
                        input.kind === "append" &&
                        "contents" in input &&
                        input.contents.includes('"toolName":"write"')
                    ) {
                        interrupted = true;
                        await response.text();
                        return new Response("Lost append acknowledgement", { status: 503 });
                    }
                    return response;
                };
            } else {
                // A dropped checkpoint request cannot publish, and markUncertain must release its native writer.
                f.policy.before = (input, path) => {
                    if (path === "/session/control" && input.kind === "checkpoint") {
                        interrupted = true;
                        return Promise.resolve(new Response("Checkpoint connection interrupted", { status: 503 }));
                    }
                    return Promise.resolve(undefined);
                };
            }
            const child = await f.start();
            await child.read();
            await child.send({ kind: "turn", text: "Read the sentinel and write exactly one durable effect." });
            const failed = await child.read();
            assert(failed.savedId, JSON.stringify(failed));
            assertEquals(f.store.inspectSessionActivation(failed.savedId).activation?.state, "uncertain");
            const summary = (await f.control.list(failed.savedId))[0];
            assert(
                interrupted,
                `The intended fault was not reached: ${
                    summary?.contents?.match(/\"errorMessage\":\"[^\"]*/)?.[0] || JSON.stringify(failed)
                }`,
            );
            assertEquals(failed.ok, false, JSON.stringify(failed));
            assertEquals(f.store.inspectSessionActivation(failed.savedId).activation?.state, "idle");
            assertEquals(await fsReadFile(join(f.remoteProject, "sentinel.txt"), "utf8"), "one durable effect\n");
            assertEquals(await fsReadFile(join(f.projectRoot, "sentinel.txt"), "utf8"), "laptop initial\n");
            assert(f.controls.some((entry) => entry.request.kind === "markUncertain"));
            f.policy.handle = undefined;
            f.policy.before = undefined;
            const before = await fsStat(join(f.remoteProject, "sentinel.txt"));
            const requestCount = contexts.length;
            const fresh = await f.start();
            await fresh.read();
            await fresh.send({ kind: "load", sessionId: failed.savedId });
            const resumed = await fresh.read();
            assertEquals(resumed.ok, true, resumed.error);
            assertEquals(resumed.savedId, failed.savedId);
            assertEquals(
                contexts.length,
                requestCount,
                "Loading committed history must not replay a model or tool call",
            );
            assertEquals((await fsStat(join(f.remoteProject, "sentinel.txt"))).mtime, before.mtime);
            assertEquals(f.store.inspectSessionActivation(failed.savedId).activation?.state, "idle");
            f.setModelResponseFactory((context) => {
                contexts.push(JSON.stringify(context));
                return fauxAssistantMessage(fauxText("Continue without repeating the saved edit."));
            });
            await fresh.send({ kind: "turn", text: "Continue without repeating earlier tools." });
            const continued = await fresh.read();
            assertEquals(continued.ok, true, continued.error);
            assertEquals(continued.savedId, failed.savedId);
            assertStringIncludes(contexts.at(-1) || "", "one durable effect");
            const saved = (await f.control.list(failed.savedId))[0].contents || "";
            const entries = saved.trim().split("\n");
            assertEquals(
                entries.filter((line) => line.includes('"role":"toolResult"') && line.includes('"toolName":"write"'))
                    .length,
                1,
            );
            assertEquals((await fsStat(join(f.remoteProject, "sentinel.txt"))).mtime, before.mtime);
            await assertRemoteStorageAbsent(f);
        });
    });
}
