import { tmpdir } from "node:os";
import { test } from "node:test";
import {
    mkdir as fsMkdir,
    mkdtemp as fsMkdtemp,
    readFile as fsReadFile,
    rm as fsRm,
    stat as fsStat,
    writeFile as fsWriteFile,
} from "node:fs/promises";
import { assertEquals, assertRejects, assertStringIncludes } from "../testing/assertions.ts";
import { join } from "node:path";
import { SNIP_FILTERS_DIR } from "../constants.js";
import {
    cleanupRunWieldSnipFiltersForUser,
    getRunWieldSnipFilterInstallStatus,
    getRunWieldSnipPaths,
    installRunWieldSnipFiltersForUser,
} from "./snip-filters.ts";

test("bundled Snip filters are readable from the compile-safe resource directory", async () => {
    const denoTestFilter = await fsReadFile(join(SNIP_FILTERS_DIR, "deno-test.yaml"), "utf8");

    assertStringIncludes(SNIP_FILTERS_DIR, join("src", "snip-filters"));
    assertStringIncludes(denoTestFilter, "deno test");
});

test("user Snip filter install and cleanup only manage RunWield-owned files", async () => {
    const homeDir = await fsMkdtemp(join(tmpdir(), "runwield-snip-home-"));
    const bundledDir = await fsMkdtemp(join(tmpdir(), "runwield-snip-bundled-"));
    try {
        await fsWriteFile(join(bundledDir, "deno-check.yaml"), "name: deno-check\n");
        await fsWriteFile(join(bundledDir, "deno-fmt.yaml"), "name: deno-fmt\n");
        await fsWriteFile(join(bundledDir, "deno-lint.yaml"), "name: deno-lint\n");
        await fsWriteFile(join(bundledDir, "deno-test.yaml"), "name: deno-test\n");

        await fsWriteFile(join(bundledDir, "deno-task.yaml"), "name: deno-task\n");

        const paths = getRunWieldSnipPaths({ homeDir });
        await fsMkdir(paths.userFiltersDir, { recursive: true });
        await fsWriteFile(join(paths.userFiltersDir, "deno-lint.yaml"), "name: user-deno-lint\n");
        await fsWriteFile(
            join(paths.userFiltersDir, "deno-check.yaml"),
            "# Managed by Harns. Remove with: hns snip-filters cleanup\nname: old-deno-check\n",
        );
        const legacyFiltersDir = join(homeDir, ".config", "snip", "harns", "filters");
        await fsMkdir(legacyFiltersDir, { recursive: true });
        for (const fileName of ["deno-fmt.yaml", "deno-lint.yaml", "deno-test.yaml"]) {
            await fsWriteFile(join(legacyFiltersDir, fileName), `name: old-${fileName}\n`);
        }

        const install = await installRunWieldSnipFiltersForUser({ homeDir, bundledDir });
        assertEquals(install.filtersDir, paths.userFiltersDir);
        assertEquals(install.installed.length, 4);
        assertEquals(install.removedLegacy.length, 3);
        assertEquals(install.skipped, [
            {
                path: join(paths.userFiltersDir, "deno-lint.yaml"),
                reason: "existing non-RunWield filter",
            },
        ]);

        const installedFmt = await fsReadFile(join(paths.userFiltersDir, "deno-fmt.yaml"), "utf8");
        assertStringIncludes(installedFmt, "Managed by RunWield");
        assertStringIncludes(installedFmt, "name: deno-fmt");
        assertStringIncludes(
            await fsReadFile(join(paths.userFiltersDir, "deno-check.yaml"), "utf8"),
            "Managed by RunWield",
        );
        await assertRejects(() => fsStat(legacyFiltersDir), Error, "ENOENT");

        const status = await getRunWieldSnipFilterInstallStatus({ homeDir });
        assertEquals(status.installed.length, 4);
        assertEquals(status.conflicts, [join(paths.userFiltersDir, "deno-lint.yaml")]);
        assertEquals(status.missing, []);

        const cleanup = await cleanupRunWieldSnipFiltersForUser({ homeDir });
        assertEquals(cleanup.removed.length, 4);
        assertEquals(cleanup.removedLegacy, []);
        assertEquals(cleanup.skipped, [
            {
                path: join(paths.userFiltersDir, "deno-lint.yaml"),
                reason: "existing non-RunWield filter",
            },
        ]);
        assertEquals(await fsReadFile(join(paths.userFiltersDir, "deno-lint.yaml"), "utf8"), "name: user-deno-lint\n");
    } finally {
        await fsRm(homeDir, { recursive: true }).catch(() => {});
        await fsRm(bundledDir, { recursive: true }).catch(() => {});
    }
});
