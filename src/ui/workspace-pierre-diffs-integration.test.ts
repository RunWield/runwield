import { assertEquals } from "../testing/assertions.ts";
import { test } from "node:test";
import { Editor, TextDocument } from "@pierre/diffs/edit";

test("Workspace resolves the Pierre edit API required by Plannotator", () => {
    assertEquals(typeof Editor, "function");
    assertEquals(typeof TextDocument, "function");
});
