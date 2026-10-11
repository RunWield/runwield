import { assertEquals, assertThrows } from "@std/assert";
import { join } from "@std/path";
import type { SettingsManager } from "@earendil-works/pi-coding-agent";
import { withProcessGlobalTestLock } from "../../testing/process-global-lock.ts";
import { __resetSettingsForTests, getSettingsManager } from "../settings.js";
import { configureRemotePersonalResources, PersonalResourcePathError } from "./personal-resources.ts";

interface SettingsFixture {
    manager: SettingsManager;
    projectRoot: string;
    settingsPath: string;
}

Deno.test("remote settings handles stay live without an explicit reload", async (test) => {
    await withProcessGlobalTestLock(async () => {
        const root = await Deno.makeTempDir({ prefix: "remote-settings-manager-" });
        const mounted = join(root, "mount");
        await Deno.mkdir(mounted);
        configureRemotePersonalResources({ globalRoot: mounted });

        async function withManager(run: (fixture: SettingsFixture) => Promise<void>) {
            const projectRoot = await Deno.makeTempDir({ dir: root, prefix: "project-" });
            const settingsPath = join(mounted, "settings.json");
            await Deno.mkdir(join(projectRoot, ".wld"));
            await Deno.writeTextFile(join(projectRoot, ".wld", "settings.json"), "{}");
            await Deno.writeTextFile(settingsPath, '{"theme":"dark"}');
            __resetSettingsForTests();
            try {
                await run({ manager: getSettingsManager(projectRoot), projectRoot, settingsPath });
            } finally {
                __resetSettingsForTests();
                await Deno.remove(projectRoot, { recursive: true });
            }
        }

        try {
            await test.step("a held manager immediately sees direct mounted settings edits", () =>
                withManager(async ({ manager, projectRoot, settingsPath }) => {
                    assertEquals(manager.getTheme(), "dark");
                    await Deno.writeTextFile(settingsPath, '{"theme":"light"}');
                    assertEquals(manager.getTheme(), "light");
                    assertEquals(getSettingsManager(projectRoot), manager);
                }));

            await test.step("a held getter sees an edit between capture and invocation", () =>
                withManager(async ({ manager, settingsPath }) => {
                    const readTheme = manager.getTheme;
                    await Deno.writeTextFile(settingsPath, '{"theme":"mono"}');
                    assertEquals(readTheme(), "mono");
                }));

            await test.step("nonmethod properties read the live manager after a mounted edit", () =>
                withManager(async ({ manager, settingsPath }) => {
                    // Caller annotations belong to the loaded manager, not the stable handle.
                    const annotation = Symbol("caller annotation");
                    assertEquals(Reflect.set(manager, annotation, "old snapshot"), true);
                    assertEquals(Reflect.get(manager, annotation), "old snapshot");
                    await Deno.writeTextFile(settingsPath, '{"theme":"light"}');
                    assertEquals(Reflect.get(manager, annotation), undefined);
                }));

            await test.step("nonmethod reads reject a detached mount", () =>
                withManager(async ({ manager }) => {
                    const annotation = Symbol("caller annotation");
                    await Deno.rename(mounted, join(root, "detached"));
                    try {
                        assertThrows(() => Reflect.get(manager, annotation), PersonalResourcePathError);
                    } finally {
                        await Deno.rename(join(root, "detached"), mounted);
                    }
                }));

            await test.step("property writes reject a detached mount", () =>
                withManager(async ({ manager }) => {
                    const annotation = Symbol("caller annotation");
                    await Deno.rename(mounted, join(root, "detached"));
                    try {
                        assertThrows(() => Reflect.set(manager, annotation, "unsafe"), PersonalResourcePathError);
                    } finally {
                        await Deno.rename(join(root, "detached"), mounted);
                    }
                }));
        } finally {
            __resetSettingsForTests();
            await Deno.remove(root, { recursive: true });
        }
    });
});
