import { readFile as fsReadFile } from "node:fs/promises";
import { test } from "node:test";
import { assertStringIncludes } from "../../../testing/assertions.ts";

test("complete Plan feedback includes direct edits and referenced-file comments", async () => {
    const source = await fsReadFile("src/ui/workspace/react/plan-review-feedback.ts", "utf8");

    assertStringIncludes(source, "exportAnnotations");
    assertStringIncludes(source, "composeRunWieldPlanFeedback");
    assertStringIncludes(source, "exportCodeFileAnnotations");
    assertStringIncludes(source, "if (planFeedback === NO_CHANGES) return codeFeedback");
});
