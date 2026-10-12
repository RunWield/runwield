import { assertEquals } from "@std/assert";
import { setCustomSetting, shouldAutoMergePlansIntoTargetBranch } from "./settings.js";
import { withRuntimeCommandFixture } from "../cmd/testing/runtime-command-fixture.ts";

Deno.test("Plan auto-merge defaults off and accepts only a literal true", async () => {
    await withRuntimeCommandFixture("plan-merge-setting-", async ({ projectRoot }) => {
        assertEquals(shouldAutoMergePlansIntoTargetBranch(projectRoot), false);
        for (
            const plans of [true, "true", [], { autoMergeIntoTargetBranch: "true" }, { autoMergeIntoTargetBranch: 1 }]
        ) {
            await setCustomSetting("plans", plans, "project", projectRoot);
            assertEquals(shouldAutoMergePlansIntoTargetBranch(projectRoot), false);
        }
        await setCustomSetting("plans", { autoMergeIntoTargetBranch: true }, "project", projectRoot);
        assertEquals(shouldAutoMergePlansIntoTargetBranch(projectRoot), true);
    });
});

Deno.test("project Plan auto-merge overrides global while unrelated Plan keys inherit", async () => {
    await withRuntimeCommandFixture("plan-merge-precedence-", async ({ projectRoot }) => {
        await setCustomSetting("plans", { autoMergeIntoTargetBranch: true }, "global", projectRoot);
        await setCustomSetting("plans", { archiveKeepLast: 4 }, "project", projectRoot);
        assertEquals(shouldAutoMergePlansIntoTargetBranch(projectRoot), true);
        await setCustomSetting("plans", { autoMergeIntoTargetBranch: false }, "project", projectRoot);
        assertEquals(shouldAutoMergePlansIntoTargetBranch(projectRoot), false);
        await setCustomSetting("plans", { autoMergeIntoTargetBranch: true }, "project", projectRoot);
        await setCustomSetting("plans", { autoMergeIntoTargetBranch: false }, "global", projectRoot);
        assertEquals(shouldAutoMergePlansIntoTargetBranch(projectRoot), true);
    });
});
