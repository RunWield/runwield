import { test } from "node:test";
import { strictEqual, throws } from "node:assert/strict";
import { ScriptedInteractionSurface } from "./scripted-review-surface.js";

const resume = {
    type: "select" as const,
    promptIncludes: "Resume tutorial guidance",
    value: "resume",
    optional: true,
};

test("an optional reload prompt can be absent after asynchronous completion", () => {
    const surface = new ScriptedInteractionSurface([resume]);
    surface.assertComplete();
    strictEqual(surface.consumed.length, 0);
});

test("an optional reload prompt still checks and records the answer when present", () => {
    const surface = new ScriptedInteractionSurface([resume]);
    strictEqual(surface.next("select", { prompt: "Resume tutorial guidance for this saved Session?" }), "resume");
    surface.assertComplete();
    strictEqual(surface.consumed.length, 1);
    throws(() => new ScriptedInteractionSurface([resume]).next("select", { prompt: "Unexpected prompt" }));
});

test("an optional reload prompt does not excuse a missing required interaction", () => {
    const surface = new ScriptedInteractionSurface([
        { type: "text", promptIncludes: "Test command", value: "true" },
        resume,
    ]);
    throws(() => surface.assertComplete(), /Unused scripted Runtime interactions: 1/);
});
