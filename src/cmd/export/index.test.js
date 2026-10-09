import { assertEquals } from "@std/assert";
import { runExportCommand } from "./index.ts";

/** @param {(sessionId: string, outputPath: string) => Promise<string>} exportSession */
function makeContext(exportSession) {
    const messages = /** @type {string[]} */ ([]);
    let cleared = false;
    return {
        messages,
        wasCleared: () => cleared,
        context: /** @type {any} */ ({
            sessionId: "export-test",
            sessionRuntime: { exportSession },
            uiAPI: { appendSystemMessage: (/** @type {string} */ message) => messages.push(message) },
            editor: {
                disableSubmit: true,
                setText: () => {
                    cleared = true;
                },
            },
        }),
    };
}

Deno.test("runExportCommand exports through SessionRuntime", async () => {
    const fixture = makeContext(
        /** @param {string} _id @param {string} outputPath */
        (_id, outputPath) => Promise.resolve(outputPath),
    );
    await runExportCommand(["/tmp/session.jsonl"], fixture.context);

    assertEquals(fixture.messages, ["", "Session exported to: /tmp/session.jsonl"]);
    assertEquals(fixture.wasCleared(), true);
});

Deno.test("runExportCommand reports Runtime export errors", async () => {
    const fixture = makeContext(() => Promise.reject(new Error("export failed")));
    assertEquals(await runExportCommand([], fixture.context), "failed");

    assertEquals(fixture.messages, ["", "Failed to export session: export failed"]);
    assertEquals(fixture.wasCleared(), true);
});
