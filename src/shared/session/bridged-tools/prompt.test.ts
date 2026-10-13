import { test } from "node:test";
import { assertEquals, assertStringIncludes } from "../../../testing/assertions.ts";
import { getCwd } from "../../../constants.js";
import { createMultiFileEditTool } from "../../../tools/multi_file_edit.ts";
import { buildBridgedToolPromptAppendix } from "./prompt.ts";

test("Antigravity prompt includes tool name mapping for all capabilities", () => {
    const prompt = buildBridgedToolPromptAppendix([createMultiFileEditTool(getCwd())], "Antigravity CLI");
    assertStringIncludes(prompt, "## Tool Name Mapping");
    assertStringIncludes(prompt, "`bash` -> `run_command`");
    assertStringIncludes(prompt, "`write`, `write_docs` -> `write_to_file`");
    assertStringIncludes(prompt, "`edit`, `edit_docs` -> `replace_file_content`");
    assertStringIncludes(prompt, "`read`, `view` -> `view_file`");
});

test("Antigravity prompt adapts mapping to read-only declared tools", () => {
    const prompt = buildBridgedToolPromptAppendix([], "Antigravity CLI", ["read", "code_search"]);
    assertStringIncludes(prompt, "`read`, `view` -> `view_file`");
    assertEquals(prompt.includes("run_command"), false);
    assertEquals(prompt.includes("write_to_file"), false);
    assertEquals(prompt.includes("replace_file_content"), false);
});

test("Antigravity prompt includes edit mapping when multi_file_edit is declared", () => {
    const prompt = buildBridgedToolPromptAppendix([], "Antigravity CLI", ["read", "multi_file_edit"]);
    assertStringIncludes(prompt, "`edit`, `edit_docs` -> `replace_file_content`");
    assertStringIncludes(prompt, "`read`, `view` -> `view_file`");
    assertEquals(prompt.includes("run_command"), false);
    assertEquals(prompt.includes("write_to_file"), false);
});

test("Claude Code prompt includes tool name mapping", () => {
    const prompt = buildBridgedToolPromptAppendix([], "Claude Code");
    assertStringIncludes(prompt, "## Tool Name Mapping");
    assertStringIncludes(prompt, "`bash` -> `Bash`");
    assertStringIncludes(prompt, "`write`, `write_docs` -> `Write`");
    assertStringIncludes(prompt, "`edit`, `edit_docs` -> `Edit`");
    assertStringIncludes(prompt, "`read`, `view` -> `Read`");
});
