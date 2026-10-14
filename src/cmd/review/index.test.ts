import { test } from "node:test";
import { assertEquals, assertRejects, assertStringIncludes } from "../../testing/assertions.ts";
import { COMMAND_NAMES, commandRegistry, hasCommandSurface } from "../registry.js";
import { runReviewCommand } from "./index.ts";
test("review is CLI only and help lists all three source forms", () => {
    const definition = commandRegistry[COMMAND_NAMES.REVIEW];
    assertEquals(hasCommandSurface(definition, "cli"), true);
    assertEquals(hasCommandSurface(definition, "slash"), false);
    assertEquals(definition.usage, ["wld review", "wld review <branch>", "wld review <PR/MR URL>"]);
    assertStringIncludes(definition.summary, "without a Plan");
});
test("review rejects surplus args before target resolution", async () => {
    await assertRejects(() => runReviewCommand(["one", "two"]), Error, "Usage:");
});
