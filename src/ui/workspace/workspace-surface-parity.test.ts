// @ts-nocheck: Deno test imports are checked by scripts/run-tests.js, not Astro check.
import { readFile as fsReadFile } from "node:fs/promises";
import { test } from "node:test";
import { assertStringIncludes } from "../../testing/assertions.ts";

test("local and owner Plan Board routes share one page composition", async () => {
    const local = await fsReadFile(new URL("./pages/index.astro", import.meta.url), "utf8");
    const owner = await fsReadFile(new URL("./components/ProjectPlanBoardPage.astro", import.meta.url), "utf8");
    const shared = await fsReadFile(new URL("./components/PlanBoardPage.astro", import.meta.url), "utf8");

    assertStringIncludes(local, "PlanBoardPage");
    assertStringIncludes(local, 'context="local"');
    assertStringIncludes(owner, "PlanBoardPage");
    assertStringIncludes(owner, 'context="workspace"');
    assertStringIncludes(shared, "PlanBoardToolbar");
    assertStringIncludes(shared, "<PlanBoard");
    assertStringIncludes(shared, 'shell={context === "workspace" ? "workspace" : "local"}');
});

test("dev Surface Lab exposes both presentations of every shared surface", async () => {
    const catalog = await fsReadFile(new URL("./pages/dev/index.astro", import.meta.url), "utf8");

    for (const path of [
        "/projects/dev-project/plans",
        "/dev/plan-review",
        "/dev/workspace/plan-review",
        "/dev/code-review",
        "/dev/workspace/code-review",
    ])
        assertStringIncludes(catalog, path);
});

test("Workspace development has one Surface Lab entry task", async () => {
    const packageConfig = JSON.parse(await fsReadFile(new URL("../../../package.json", import.meta.url), "utf8"));
    const taskNames = Object.keys(packageConfig.scripts);

    assertStringIncludes(packageConfig.scripts["workspace:dev"], "--open /dev");
    if (taskNames.some((taskName) => taskName.startsWith("workspace:dev:"))) {
        throw new Error("Use workspace:dev and add new fixtures to the Surface Lab instead of adding launch aliases");
    }
});
