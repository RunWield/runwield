import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { withRuntimeCommandFixture } from "../cmd/testing/runtime-command-fixture.ts";
import {
    __resetSettingsForTests,
    clearMascotEnabledCache,
    isMascotEnabled,
    preserveRunWieldCustomSettingsForWrite,
    setCustomSetting,
    setExactProjectCustomSetting,
} from "./settings.js";

Deno.test("mascot defaults on and only literal false disables it", async () => {
    await withRuntimeCommandFixture("settings-mascot-default-", async ({ projectRoot }) => {
        assertEquals(isMascotEnabled(projectRoot), true);
        for (const value of [false, true, "false", 0, null]) {
            await setCustomSetting("mascot", value, "global", projectRoot);
            assertEquals(isMascotEnabled(projectRoot), value !== false);
        }
    });
});

Deno.test("mascot project overrides and exact writes invalidate cached visibility", async () => {
    await withRuntimeCommandFixture("settings-mascot-project-", async ({ projectRoot }) => {
        await setCustomSetting("mascot", true, "global", projectRoot);
        assertEquals(isMascotEnabled(projectRoot), true);
        await setCustomSetting("mascot", false, "project", projectRoot);
        assertEquals(isMascotEnabled(projectRoot), false);
        setExactProjectCustomSetting("mascot", true, projectRoot);
        assertEquals(isMascotEnabled(projectRoot), true);
    });
});

Deno.test("manual mascot edits stay cached until reload or test reset", async () => {
    await withRuntimeCommandFixture("settings-mascot-cache-", async ({ projectRoot }) => {
        assertEquals(isMascotEnabled(projectRoot), true);
        const path = join(projectRoot, ".wld", "settings.json");
        await Deno.mkdir(join(projectRoot, ".wld"), { recursive: true });
        await Deno.writeTextFile(path, JSON.stringify({ mascot: false }));
        assertEquals(isMascotEnabled(projectRoot), true);
        clearMascotEnabledCache();
        assertEquals(isMascotEnabled(projectRoot), false);
        await Deno.writeTextFile(path, JSON.stringify({ mascot: true }));
        assertEquals(isMascotEnabled(projectRoot), false);
        __resetSettingsForTests();
        assertEquals(isMascotEnabled(projectRoot), true);
    });
});

Deno.test("Pi settings writes preserve mascot visibility", () => {
    assertEquals(
        JSON.parse(preserveRunWieldCustomSettingsForWrite('{"mascot":false}', '{"theme":"dark"}')),
        { theme: "dark", mascot: false },
    );
});
