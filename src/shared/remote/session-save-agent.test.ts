import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { dirname, join } from "@std/path";
import { makeControlFixture } from "./session-save-test-fixture.ts";
import { verificationClient, verificationTransport } from "./session-save-verification-fixture.ts";
import { parseRemoteSessionTranscript } from "./session-protocol.ts";

Deno.test("bound real Pi AgentSession saves a complete tool turn, metadata and actual compaction on the laptop", async () => {
    const f = await makeControlFixture();
    await f.ready();
    const client = verificationClient(f, f.baseUrl, { mode: "turn" });
    try {
        const result = await client.result();
        assertEquals(result.effects, 1);
        assertEquals(result.file, null);
        assertEquals(result.roles, ["system", "user", "assistant", "toolResult", "assistant"]);
        assertStringIncludes(result.summary ?? "", "Actual compaction summary");
        assert(result.types?.includes("custom"));
        assert(result.types?.includes("compaction"));
        const saved = parseRemoteSessionTranscript(f.owner.inspect().contents).slice(1);
        assertEquals(saved.length, result.entries);
        assertEquals(saved.map((entry) => entry.type), result.types);
        assertEquals(await Deno.readTextFile(join(f.remoteProject, "dependent-marker")), "effect\n");
        assertEquals([...Deno.readDirSync(f.mount)], []);
        assertEquals([...Deno.readDirSync(f.remoteProject)].map((entry) => entry.name), ["dependent-marker"]);
    } finally {
        await client.close();
        await f.close();
    }
});

for (const faultPoint of ["before-prompt", "before-tool", "after-tool", "tool-hook"] as const) {
    Deno.test(`bound real Pi AgentSession stops ${faultPoint} progress after swallowed recorder failure`, async () => {
        const f = await makeControlFixture();
        await f.ready();
        const proxy = verificationTransport(f, async (input, response) => {
            if (input.kind === "append" && input.contents.includes("runwield.manual_model")) {
                assertEquals(response.status, 200);
                await response.text();
                return new Response(null, { status: 503 });
            }
            return response;
        });
        const client = verificationClient(f, proxy.baseUrl, { mode: "agent-fault", faultPoint });
        try {
            const result = await client.result();
            assertEquals(result.stopped, true);
            assertEquals(result.nextPromptStopped, true);
            assertEquals(result.unhealthy, true);
            assertEquals(result.effects, faultPoint === "after-tool" ? 1 : 0);
            assertEquals(result.modelRequests, faultPoint === "before-prompt" ? 0 : 1);
            assertEquals(result.disposeFailed, false, "Real Pi disposal must remain usable after the bridge fault");
            const saved = f.owner.inspect().contents;
            assertStringIncludes(saved, "runwield.manual_model");
            assert(!saved.includes("Remote effect saved."));
            assertEquals(f.store.inspectSessionActivation(f.session.runwieldSessionId).generation, null);
            f.owner.markUncertain();
            if (faultPoint !== "after-tool") {
                await assertRejects(() => Deno.stat(join(f.remoteProject, "dependent-marker")), Deno.errors.NotFound);
            }
        } finally {
            await client.close();
            await proxy.close();
            await f.close();
        }
    });
}

Deno.test("remote attachment manager saves laptop bytes and stores only a path-free durable reference", async () => {
    const f = await makeControlFixture();
    await f.ready();
    const client = verificationClient(f, f.baseUrl, { mode: "attachment" });
    try {
        const image = await client.result();
        assertEquals(image.base64, "AQIDBA==");
        assertEquals(image.mimeType, "image/png");
        assertEquals(image.path, undefined);
        assert(image.ref?.startsWith("attachment:"));
        const segment = f.store.getCurrentSessionSegment(f.session.runwieldSessionId);
        assert(segment);
        const directory = join(dirname(segment.transcriptPath), `${segment.piSessionId}_images`);
        const files = [...Deno.readDirSync(directory)];
        assertEquals(files.length, 1);
        assertEquals(await Deno.readFile(join(directory, files[0].name)), new Uint8Array([1, 2, 3, 4]));
        const saved = f.owner.inspect().contents;
        assertStringIncludes(saved, image.ref ?? "missing");
        assert(!saved.includes(f.mount));
        assert(!saved.includes(f.remoteProject));
        assertEquals([...Deno.readDirSync(f.remoteProject)], []);
        assertEquals([...Deno.readDirSync(f.mount)], []);
    } finally {
        await client.close();
        await f.close();
    }
});
