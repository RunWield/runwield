import { test } from "node:test";
import { strict as assert } from "node:assert";
import { configureGuideRunner, getGuideRunner, runWldJobCommand } from "./review-agent-handlers.js";

// One process-level configuration lifecycle. No model or local command is replaced.
test("guide runner selection defaults to the local command and rejects duplicate configuration", () => {
    assert.equal(getGuideRunner(), runWldJobCommand);
    const runner = async () => ({ stdout: "guide", provider: "external" });
    const clear = configureGuideRunner(runner);
    try {
        assert.equal(getGuideRunner(), runner);
        assert.throws(() => configureGuideRunner(runner), /already configured/);
    } finally {
        clear();
    }
    assert.equal(getGuideRunner(), runWldJobCommand);
    const clearNext = configureGuideRunner(runner);
    try {
        clear();
        assert.equal(getGuideRunner(), runner);
    } finally {
        clearNext();
    }
    assert.equal(getGuideRunner(), runWldJobCommand);
});
