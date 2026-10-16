import { assertEquals } from "../../testing/assertions.ts";
import { readFile as fsReadFile } from "node:fs/promises";
import { test } from "node:test";
import { ok as assert } from "node:assert/strict";

/**
 * @param {string} source
 * @param {string} marker
 * @returns {string}
 */
function extractFunctionSource(source, marker) {
    const start = source.indexOf(marker);
    assert(start >= 0, `${marker} must exist`);
    const openBrace = source.indexOf("{", start);
    assert(openBrace >= 0, `${marker} must have a body`);

    let depth = 0;
    for (let index = openBrace; index < source.length; index += 1) {
        const char = source[index];
        if (char === "{") depth += 1;
        if (char === "}") depth -= 1;
        if (depth === 0) return source.slice(start, index + 1);
    }
    throw new Error(`${marker} body was not closed`);
}

test("runValidationLoop is a single-phase dispatcher", async () => {
    // The dispatcher lives in the engine after the session-independent split; the
    // public entry in validation.ts only builds the port and delegates.
    const source = await fsReadFile(new URL("./validation-engine.ts", import.meta.url), "utf8");
    const functionSource = extractFunctionSource(source, "async function runValidationPhase");

    assert(functionSource.split("\n").length < 200, "the phase dispatcher should stay under 200 lines");
    assert(!functionSource.includes("while"), "the phase dispatcher must not contain while loops");
    assert(!functionSource.includes("for ("), "the phase dispatcher must not loop over phases");
});

test("legacy validation drivers are not reachable", async () => {
    const lifecycleSource = await fsReadFile(new URL("./validation.ts", import.meta.url), "utf8");
    const legacySource = await fsReadFile(new URL("./validation-helpers.ts", import.meta.url), "utf8");

    assertEquals(lifecycleSource.includes("runLegacyValidationMachine"), false);
    assertEquals(lifecycleSource.includes("runLegacyPhaseAdapter"), false);
    assertEquals(lifecycleSource.includes("ValidationPhaseComplete"), false);
    assertEquals(lifecycleSource.includes("pauseForExecutionContinuation"), false);
    assertEquals(legacySource.includes("runLegacyValidationMachine"), false);
    assertEquals(legacySource.includes("while (!executionComplete"), false);
    assertEquals(legacySource.includes("pauseForExecutionContinuation"), false);
});

test("publication records every irreversible Git boundary in the durable state machine", async () => {
    const source = await fsReadFile(new URL("./validation-publication.ts", import.meta.url), "utf8");
    const publication = extractFunctionSource(source, "async function runLockedPublicationPhase");
    assert(publication.includes("startPublicationAttempt"));
    assert(publication.includes('"artifacts_committed"'));
    assert(publication.includes('"target_integrated"'));
    assert(publication.includes('"target_published"'));
    assert(publication.includes('"publication_verified"'));
    assert(publication.includes('"cleanup_complete"'));
    assertEquals(publication.includes("runDirectDeliveryPublicationTransition"), false);
});
