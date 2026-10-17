import { test } from "node:test";
import { ok as assert } from "node:assert/strict";
import { assertEquals } from "../../testing/assertions.ts";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import { getExternalCliPriceModel, getModelRegistry } from "./model-registry.ts";

test("agy price lookup uses the exact built-in Google model, not its zero-priced descriptor", () => {
    const model = getModelRegistry().find("agy-cli", "gemini-3.8-flash");
    assert(model);
    assertEquals(model.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    const price = getExternalCliPriceModel(model);
    assertEquals(
        price,
        getBuiltinModels("google").find((candidate) => candidate.id === model.id),
    );
    assert(price);
    assertEquals(price.provider, "google");
    assertEquals(price.cost, { input: 0.75, output: 3.75, cacheRead: 0.075, cacheWrite: 0 });
});

test("agy price lookup never replaces a missing exact ID with the priced preview", () => {
    assert(getBuiltinModels("google").some((model) => model.id === "gemini-3.1-pro-preview"));
    const model = getModelRegistry().find("agy-cli", "gemini-3.1-pro");
    assert(model);
    assertEquals(getExternalCliPriceModel(model), undefined);
});

test("models outside a named external CLI price catalog have no CLI price evidence", () => {
    assertEquals(getExternalCliPriceModel({ provider: "claude-cli", id: "sonnet" }), undefined);
    assertEquals(getExternalCliPriceModel({ provider: "google", id: "gemini-3.8-flash" }), undefined);
    assertEquals(getExternalCliPriceModel({ provider: "agy-cli", id: "missing-model" }), undefined);
});
