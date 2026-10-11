import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import {
    assertRemoteStorageAbsent,
    assertSmallControlBodies,
    latch,
    within,
    withRemoteRuntimeFixture,
} from "./remote-runtime-test-fixture.ts";

Deno.test("remote SessionRuntime stays unsaved until the first submitted message", async () => {
    await withRemoteRuntimeFixture(async (f) => {
        const child = await f.start();
        const ready = await child.read();
        assertEquals(ready.kind, "ready");
        assertEquals(ready.managed, false);
        assertEquals(await f.control.list(), []);
        assertEquals(f.store.listSessionProjects(), []);
        assertEquals(f.controls.filter((entry) => entry.request.kind === "create"), []);
        assertEquals(f.saves, []);
        assertSmallControlBodies(f);
        await assertRemoteStorageAbsent(f);
    });
});

Deno.test("remote normal turns wait for laptop user-save acknowledgement and resume committed context under the same id", async () => {
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
                    fauxToolCall("write", { path: "sentinel.txt", content: "remote edited\n" }),
                );
            },
            (context) => {
                contexts.push(JSON.stringify(context));
                return fauxAssistantMessage(fauxText("Remote edit complete. Remember amber-741."));
            },
            (context) => {
                contexts.push(JSON.stringify(context));
                return fauxAssistantMessage(fauxText("Later turn keeps amber-741."));
            },
            (context) => {
                contexts.push(JSON.stringify(context));
                return fauxAssistantMessage(fauxText("Fresh process keeps amber-741 and the edit."));
            },
        ]);
        const saved = latch();
        const acknowledge = latch();
        f.policy.handle = async (input, path, response) => {
            if (
                path === "/session/request" && input.kind === "append" && "contents" in input &&
                input.contents.includes('"role":"user"')
            ) {
                saved.release();
                await acknowledge.promise;
            }
            return response;
        };
        const child = await f.start();
        await child.read();
        await child.send({ kind: "turn", text: "Read the sentinel, edit it, and remember amber-741." });
        let progressed = false;
        const firstReport = child.read().then((value) => {
            progressed = true;
            return value;
        });
        try {
            await within(saved.promise);
            // The real owner wrote the user entry, but the reverse HTTP boundary has not acknowledged it.
            assert(f.saves.some((entry) => entry.kind === "append" && entry.contents.includes("amber-741")));
            await new Promise((resolve) => setTimeout(resolve, 100));
            assertEquals(progressed, false, "The turn must not finish before the user save is acknowledged");
            assertEquals(contexts, []);
            assertEquals(f.saves.some((entry) => entry.contents.includes('"role":"assistant"')), false);
            assertEquals(await Deno.readTextFile(join(f.remoteProject, "sentinel.txt")), "remote initial\n");
        } finally {
            acknowledge.release();
        }
        const first = await firstReport;
        assertEquals(first.ok, true, first.error);
        assert(first.savedId);
        assertEquals(first.dormant, true);
        const firstEvidence = (await f.control.list(first.savedId))[0].contents || "";
        assert(
            contexts.length >= 3,
            `Normal turn did not reach the laptop model: ${
                firstEvidence.match(/\"errorMessage\":\"[^\"]*/)?.[0] || firstEvidence
            }`,
        );
        assertStringIncludes(contexts[1], "remote initial");
        assertEquals(await Deno.readTextFile(join(f.remoteProject, "sentinel.txt")), "remote edited\n");
        assertEquals(await Deno.readTextFile(join(f.projectRoot, "sentinel.txt")), "laptop initial\n");
        assertEquals(f.store.inspectSessionActivation(first.savedId).activation?.state, "idle");
        const evidence = (await f.control.list(first.savedId))[0];
        assert(evidence.contents);
        assertStringIncludes(evidence.contents, "Remote edit complete");
        assertStringIncludes(evidence.contents, '"role":"toolResult"');
        await child.send({ kind: "turn", text: "What did we do earlier?" });
        const later = await child.read();
        assertEquals(later.ok, true, later.error);
        assertEquals(later.savedId, first.savedId);
        assertStringIncludes(contexts[3], "Remote edit complete");
        const fresh = await f.start();
        await fresh.read();
        await fresh.send({ kind: "load", sessionId: first.savedId });
        const loaded = await fresh.read();
        assertEquals(loaded.ok, true, loaded.error);
        assertEquals(loaded.savedId, first.savedId);
        await fresh.send({ kind: "turn", text: "Continue the saved conversation." });
        const resumed = await fresh.read();
        assertEquals(resumed.ok, true, resumed.error);
        assertEquals(resumed.savedId, first.savedId);
        assertStringIncludes(contexts[4], "Later turn keeps amber-741");
        assertStringIncludes(contexts[4], "remote initial");
        assertEquals((await f.control.list()).length, 1);
        assertSmallControlBodies(f);
        for (const exchange of f.controls) {
            if (exchange.request.kind !== "list") {
                const receipt = JSON.parse(exchange.response);
                assert(Object.keys(receipt).every((key) => ["operation"].includes(key)), exchange.response);
                for (
                    const forbidden of [
                        f.remoteProject,
                        f.projectRoot,
                        f.homeDir,
                        "proof",
                        "lockHandle",
                        "transcriptPath",
                    ]
                ) {
                    assertEquals(exchange.response.includes(forbidden), false, exchange.response);
                }
            }
        }
        await assertRemoteStorageAbsent(f);
    });
});

Deno.test("fresh remote runtime reads a laptop attachment through attachment-read after resume", async () => {
    await withRemoteRuntimeFixture(async (f) => {
        const contexts: string[] = [];
        f.setModelResponseFactory((context) => {
            contexts.push(JSON.stringify(context));
            return fauxAssistantMessage(fauxText("Image received."));
        });
        const child = await f.start();
        await child.read();
        await child.send({ kind: "turn", text: "Start a conversation for image storage.", image: true });
        const first = await child.read();
        assertEquals(first.ok, true, first.error);
        assert(first.savedId);
        const summary = (await f.control.list()).find((session) => session.id === first.savedId);
        assert(summary);
        const attachmentRef = summary.firstMessage.match(/attachment:[a-f0-9-]+/)?.[0];
        assert(attachmentRef, summary.firstMessage);
        const marker = `[Image attached: ${attachmentRef} image/png]`;
        assertStringIncludes(summary.firstMessage, marker);
        const hydrated = (await f.control.list(first.savedId))[0].contents;
        assert(hydrated);
        const entries: SessionEntry[] = hydrated.trim().split("\n").map((line) => JSON.parse(line));
        const user = entries.find((entry) => entry.type === "message" && entry.message.role === "user");
        assert(user?.type === "message" && user.message.role === "user");
        assert(Array.isArray(user.message.content));
        assertEquals(user.message.content.filter((block) => block.type === "text"), [{
            type: "text",
            text: `Start a conversation for image storage.\n\n${marker}`,
        }]);
        assert(user.message.content.some((block) => block.type === "image"));
        assertStringIncludes(contexts[0], marker);
        assertStringIncludes(contexts[0], '"type":"image"');
        await child.send({ kind: "upload" });
        const uploaded = await child.read();
        const ref = uploaded.ref;
        assert(ref, JSON.stringify(uploaded));
        assert(ref.startsWith("attachment:"));
        assertEquals(uploaded.base64, "AQIDBA==");
        assertEquals(JSON.stringify(uploaded).includes(f.resources), false);
        const fresh = await f.start();
        await fresh.read();
        await fresh.send({ kind: "load", sessionId: first.savedId });
        assertEquals((await fresh.read()).ok, true);
        await fresh.send({ kind: "image-read", sessionId: first.savedId, ref: attachmentRef });
        const submittedImage = await fresh.read();
        assertEquals(submittedImage.kind, "image-read", JSON.stringify(submittedImage));
        assertEquals(submittedImage.ref, attachmentRef);
        assertEquals(
            submittedImage.base64,
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
        );
        await fresh.send({ kind: "image-read", sessionId: first.savedId, ref });
        const result = await fresh.read();
        assertEquals(result.kind, "image-read", JSON.stringify(result));
        assertEquals(result.base64, "AQIDBA==");
        assertEquals(result.ref, ref);
        assert(f.saves.some((entry) => entry.kind === "attachment-read" && entry.contents === ref));
        assertSmallControlBodies(f);
        await assertRemoteStorageAbsent(f);
    });
});
