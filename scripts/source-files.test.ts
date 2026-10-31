import { test } from "node:test";
import { ok as assert } from "node:assert/strict";
import { walkSourceFiles } from "./source-files.js";

test("first-party package sources and tests participate in the type gate", async () => {
    const files = await walkSourceFiles();
    assert(files.includes("packages/langfuse-exporter/exporter.ts"));
    assert(files.includes("packages/langfuse-exporter/installation.test.ts"));
    assert(!files.some((file) => file.startsWith("src/ui/workspace/")));
});
