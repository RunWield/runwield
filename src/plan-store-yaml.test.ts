import { test } from "node:test";
import { assertEquals, assertStringIncludes } from "./testing/assertions.ts";
import { injectFrontMatter, parsePlanFrontMatter } from "./plan-store.js";

test("Plan Front Matter safely round-trips ANSI control characters", () => {
    const failureReason = `CI failed: \u001b[31mFAILED\u001b[0m`;
    const markdown = injectFrontMatter("# Plan\n", { failureReason });

    assertEquals(markdown.includes("\u001b"), false);
    assertStringIncludes(markdown, "\\u001b[31mFAILED\\u001b[0m");
    assertEquals(parsePlanFrontMatter(markdown).attrs.failureReason, failureReason);
});
