import { test } from "node:test";
import { readFile as fsReadFile } from "node:fs/promises";
import { assertEquals, assertStringIncludes } from "../src/testing/assertions.ts";

test("Homebrew credential check proves write access without changing the tap default branch", async () => {
    const workflow = await fsReadFile(".github/workflows/homebrew-tap-access.yml", "utf8");
    const createIndex = workflow.indexOf('git push origin "HEAD:refs/heads/$CHECK_BRANCH"');
    const deleteIndex = workflow.indexOf('git push origin --delete "$CHECK_BRANCH"', createIndex);

    assertStringIncludes(workflow, "workflow_dispatch:");
    assertStringIncludes(workflow, "repository: gandazgul/homebrew-tap");
    assertStringIncludes(workflow, "token: ${{ secrets.HOMEBREW_TAP_TOKEN }}");
    assertStringIncludes(workflow, "CHECK_BRANCH: credential-check-${{ github.run_id }}-${{ github.run_attempt }}");
    assertEquals(createIndex >= 0, true);
    assertEquals(deleteIndex > createIndex, true);
    assertEquals(workflow.includes("HEAD:main"), false);
});
