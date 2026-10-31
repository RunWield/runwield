import { test } from "node:test";
import { tmpdir } from "node:os";
import {
    mkdtemp as fsMkdtemp,
    mkdir as fsMkdir,
    writeFile as fsWriteFile,
    rm as fsRm,
    rename as fsRename,
} from "node:fs/promises";
import { join } from "node:path";
import { assertEquals, assertThrows } from "../../testing/assertions.ts";
import { type SettingsManager } from "@earendil-works/pi-coding-agent";
import { withProcessGlobalTestLock } from "../../testing/process-global-lock.ts";
import { __resetSettingsForTests, getSettingsManager } from "../settings.js";
import { configureRemotePersonalResources, PersonalResourcePathError } from "./personal-resources.ts";

interface SettingsFixture {
    manager: SettingsManager;
    projectRoot: string;
    settingsPath: string;
}

test("remote settings handles stay live without an explicit reload", async (test) => {
    await withProcessGlobalTestLock(async () => {
        const root = await fsMkdtemp(join(tmpdir(), "remote-settings-manager-"));
        const mounted = join(root, "mount");
        await fsMkdir(mounted);
        configureRemotePersonalResources({ globalRoot: mounted });

        async function withManager(run: (fixture: SettingsFixture) => Promise<void>) {
            const projectRoot = await fsMkdtemp(join(root, "project-"));
            const settingsPath = join(mounted, "settings.json");
            await fsMkdir(join(projectRoot, ".wld"));
            await fsWriteFile(join(projectRoot, ".wld", "settings.json"), "{}");
            await fsWriteFile(settingsPath, '{"theme":"dark"}');
            __resetSettingsForTests();
            try {
                await run({ manager: getSettingsManager(projectRoot), projectRoot, settingsPath });
            } finally {
                __resetSettingsForTests();
                await fsRm(projectRoot, { recursive: true });
            }
        }

        try {
            await test.test("a held manager immediately sees direct mounted settings edits", () =>
                withManager(async ({ manager, projectRoot, settingsPath }) => {
                    assertEquals(manager.getTheme(), "dark");
                    await fsWriteFile(settingsPath, '{"theme":"light"}');
                    assertEquals(manager.getTheme(), "light");
                    assertEquals(getSettingsManager(projectRoot), manager);
                }),
            );

            await test.test("a held getter sees an edit between capture and invocation", () =>
                withManager(async ({ manager, settingsPath }) => {
                    const readTheme = manager.getTheme;
                    await fsWriteFile(settingsPath, '{"theme":"mono"}');
                    assertEquals(readTheme(), "mono");
                }),
            );

            await test.test("nonmethod properties read the live manager after a mounted edit", () =>
                withManager(async ({ manager, settingsPath }) => {
                    // Caller annotations belong to the loaded manager, not the stable handle.
                    const annotation = Symbol("caller annotation");
                    assertEquals(Reflect.set(manager, annotation, "old snapshot"), true);
                    assertEquals(Reflect.get(manager, annotation), "old snapshot");
                    await fsWriteFile(settingsPath, '{"theme":"light"}');
                    assertEquals(Reflect.get(manager, annotation), undefined);
                }),
            );

            await test.test("nonmethod reads reject a detached mount", () =>
                withManager(async ({ manager }) => {
                    const annotation = Symbol("caller annotation");
                    await fsRename(mounted, join(root, "detached"));
                    try {
                        assertThrows(() => Reflect.get(manager, annotation), PersonalResourcePathError);
                    } finally {
                        await fsRename(join(root, "detached"), mounted);
                    }
                }),
            );

            await test.test("property writes reject a detached mount", () =>
                withManager(async ({ manager }) => {
                    const annotation = Symbol("caller annotation");
                    await fsRename(mounted, join(root, "detached"));
                    try {
                        assertThrows(() => Reflect.set(manager, annotation, "unsafe"), PersonalResourcePathError);
                    } finally {
                        await fsRename(join(root, "detached"), mounted);
                    }
                }),
            );
        } finally {
            __resetSettingsForTests();
            await fsRm(root, { recursive: true });
        }
    });
});
