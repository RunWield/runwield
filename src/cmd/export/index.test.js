import { assertEquals, assertRejects, assertStringIncludes } from "../../testing/assertions.ts";
import { test } from "node:test";
import { readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createSessionRuntime } from "../../shared/session/session-runtime.ts";
import { withRuntimeCommandFixture } from "../testing/runtime-command-fixture.ts";
import { runExportCommand } from "./index.ts";

/**
 * @param {import('../../shared/session/session-runtime.ts').SessionRuntime} sessionRuntime
 * @param {string} sessionId
 */
function makeContext(sessionRuntime, sessionId) {
    const messages = /** @type {string[]} */ ([]);
    let cleared = false;
    return {
        messages,
        wasCleared: () => cleared,
        context: {
            sessionId,
            sessionRuntime,
            sessionStartedAt: "2026-10-19T12:00:00.000Z",
            uiAPI: { appendSystemMessage: (/** @type {string} */ message) => messages.push(message) },
            editor: {
                disableSubmit: true,
                setText: () => {
                    cleared = true;
                },
            },
        },
    };
}

test("export writes the complete Session JSON document and creates parent directories", async () => {
    await withRuntimeCommandFixture("export-json-", async ({ projectRoot }) => {
        const runtime = createSessionRuntime();
        const created = await runtime.createInteractiveSession({ cwd: projectRoot, mode: "new" });
        const fixture = makeContext(runtime, created.sessionId);
        try {
            await runExportCommand(["exports/session.json"], fixture.context);
            const path = join(projectRoot, "exports/session.json");
            const exported = JSON.parse(await readFile(path, "utf8"));
            assertEquals(exported.format, "runwield.session-export");
            assertEquals(exported.version, 1);
            assertEquals(exported.segments.length, 1);
            assertEquals(exported.segments[0].entries[0].type, "session");
            assertEquals(fixture.messages, ["", `Session exported to: ${path}`]);
            assertEquals(fixture.wasCleared(), true);
        } finally {
            await runtime.closeSession(created.sessionId);
        }
    });
});

test("export defaults to self-contained HTML in the Session project", async () => {
    await withRuntimeCommandFixture("export-html-", async ({ projectRoot }) => {
        const runtime = createSessionRuntime();
        const created = await runtime.createInteractiveSession({ cwd: projectRoot, mode: "new" });
        const fixture = makeContext(runtime, created.sessionId);
        try {
            await runExportCommand([], fixture.context);
            const path = join(projectRoot, "session-2026-10-19T12-00-00.html");
            assertEquals((await readFile(path, "utf8")).startsWith("<!doctype html>"), true);
            assertEquals(fixture.messages.at(-1), `Session exported to: ${path}`);
        } finally {
            await runtime.closeSession(created.sessionId);
        }
    });
});

test("export rejects retired JSONL paths without writing a file", async () => {
    await withRuntimeCommandFixture("export-jsonl-", async ({ projectRoot }) => {
        const runtime = createSessionRuntime();
        const created = await runtime.createInteractiveSession({ cwd: projectRoot, mode: "new" });
        const fixture = makeContext(runtime, created.sessionId);
        try {
            assertEquals(await runExportCommand(["session.jsonl"], fixture.context), "failed");
            await assertRejects(() => stat(join(projectRoot, "session.jsonl")), Error, "ENOENT");
            assertStringIncludes(fixture.messages.at(-1) || "", ".json path");
            assertEquals(fixture.wasCleared(), true);
        } finally {
            await runtime.closeSession(created.sessionId);
        }
    });
});

test("export reports file errors and resets the editor", async () => {
    await withRuntimeCommandFixture("export-error-", async ({ projectRoot }) => {
        const runtime = createSessionRuntime();
        const created = await runtime.createInteractiveSession({ cwd: projectRoot, mode: "new" });
        const fixture = makeContext(runtime, created.sessionId);
        try {
            await writeFile(join(projectRoot, "blocked"), "not a directory");
            assertEquals(await runExportCommand(["blocked/out.json"], fixture.context), "failed");
            assertStringIncludes(fixture.messages.at(-1) || "", "Failed to export session:");
            assertEquals(fixture.wasCleared(), true);
            assertEquals(fixture.context.editor.disableSubmit, false);
        } finally {
            await runtime.closeSession(created.sessionId);
        }
    });
});

test("export reports Runtime read errors and resets the editor", async () => {
    await withRuntimeCommandFixture("export-read-error-", async ({ projectRoot }) => {
        const runtime = createSessionRuntime();
        const created = await runtime.createInteractiveSession({ cwd: projectRoot, mode: "new" });
        const fixture = makeContext(runtime, created.sessionId);
        await runtime.closeSession(created.sessionId);
        assertEquals(await runExportCommand([], fixture.context), "failed");
        assertStringIncludes(fixture.messages.at(-1) || "", "session not found");
        assertEquals(fixture.wasCleared(), true);
        assertEquals(fixture.context.editor.disableSubmit, false);
    });
});

test("export does not restore a missing Session Manifest through a snapshot read", async () => {
    await withRuntimeCommandFixture("export-read-only-", async ({ projectRoot, homeDir, setModelResponse }) => {
        setModelResponse("Recorded reply.");
        const runtime = createSessionRuntime();
        const created = await runtime.createInteractiveSession({ cwd: projectRoot, mode: "new" });
        const fixture = makeContext(runtime, created.sessionId);
        let manifestPath = "";
        try {
            await runtime.promptUserTurn(created.sessionId, {
                initialRequest: "Save this Session.",
                agentName: "operator",
            });
            const root = join(homeDir, ".wld", "sessions");
            const manifests = (await readdir(root, { recursive: true })).filter((path) =>
                path.endsWith("/manifest.json"),
            );
            assertEquals(manifests.length, 1);
            manifestPath = join(root, manifests[0]);
            await rename(manifestPath, `${manifestPath}.held`);
            assertEquals(await runExportCommand(["out.json"], fixture.context), "failed");
            await assertRejects(() => stat(manifestPath), Error, "ENOENT");
            await assertRejects(() => stat(join(projectRoot, "out.json")), Error, "ENOENT");
        } finally {
            if (manifestPath) await rename(`${manifestPath}.held`, manifestPath);
            await runtime.closeSession(created.sessionId);
        }
    });
});
