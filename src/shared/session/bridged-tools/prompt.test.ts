import { test } from "node:test";
import { assertStringIncludes } from "../../../testing/assertions.ts";
import { buildBridgedToolPromptAppendix } from "./prompt.ts";

test("Claude Code prompt includes tool name mapping", () => {
    const prompt = buildBridgedToolPromptAppendix([], "Claude Code");
    assertStringIncludes(prompt, "## Tool Name Mapping");
    assertStringIncludes(prompt, "`bash` -> `Bash`");
    assertStringIncludes(prompt, "`write`, `write_docs` -> `Write`");
    assertStringIncludes(prompt, "`edit`, `edit_docs` -> `Edit`");
    assertStringIncludes(prompt, "`read`, `view` -> `Read`");
});
