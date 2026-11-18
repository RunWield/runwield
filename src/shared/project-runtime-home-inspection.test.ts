import { test } from "node:test";
import { equal, ok, rejects } from "node:assert/strict";
import { chmod, lstat, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { getRunWieldRuntimeDir } from "../constants.js";
import { runtimeSourceArgs } from "../testing/runtime-source-args.ts";
import { defineCommittedGitFixture } from "./git-test-fixture.ts";
import { enterProjectRuntime, inspectProjectRuntimeReadAccess } from "./project-runtime-layout.ts";

const fixture = defineCommittedGitFixture();
const driver = fileURLToPath(new URL("./testing/project-runtime-home-process-driver.ts", import.meta.url));

function inspectAfterChange(root: string, path: string, change = "remove") {
    return spawnSync(
        process.execPath,
        runtimeSourceArgs(["run", driver, "inspect-after-directory-change", root, path, change]),
        { encoding: "utf8" },
    );
}

for (const resource of ["staging", "publication-lock", "legacy-root", "legacy-nested"]) {
    test(`passive inspection survives concurrent ${resource} directory retirement`, async () => {
        const root = await realpath(await fixture.checkout());
        try {
            const layout = await enterProjectRuntime(root);
            const marker = await readFile(layout.primary.layoutMarkerPath, "utf8");
            const legacy = join(getRunWieldRuntimeDir(root), "internal");
            const path =
                resource === "staging"
                    ? join(layout.primary.publicationStagingRoot, "retiring-attempt")
                    : resource === "publication-lock"
                      ? join(layout.selected.internalRoot, "local-publication.lock")
                      : resource === "legacy-root"
                        ? legacy
                        : join(legacy, "debug", "retiring-directory");
            await mkdir(path, { recursive: true });
            await writeFile(join(path, "retiring-file"), "retired by the concurrent writer");
            await mkdir(layout.primary.debugRoot, { recursive: true });
            const retained = join(layout.primary.debugRoot, "retained");
            await writeFile(retained, "preserved authority");

            const result = inspectAfterChange(root, path);
            ok(result.stdout.includes("directory-changed-before-read"), result.stdout);
            equal(result.status, 0, result.stderr);
            equal(JSON.parse(result.stdout.trim().split("\n").at(-1)!).kind, "ready");
            await rejects(() => lstat(path), { code: "ENOENT" });
            equal(await readFile(retained, "utf8"), "preserved authority");
            equal(await readFile(layout.primary.layoutMarkerPath, "utf8"), marker);
            await rejects(() => lstat(layout.primary.layoutMigrationJournalPath), { code: "ENOENT" });
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });
}

for (const change of ["file", "unreadable"]) {
    test(`passive inspection preserves ${change} directory errors during enumeration`, async () => {
        const root = await realpath(await fixture.checkout());
        let path = "";
        try {
            const layout = await enterProjectRuntime(root);
            path = join(layout.primary.publicationStagingRoot, "invalid-attempt");
            await mkdir(path, { recursive: true });
            const result = inspectAfterChange(root, path, change);
            ok(result.stdout.includes("directory-changed-before-read"), result.stdout);
            ok(result.status !== 0, result.stdout);
            ok(result.stderr.includes(change === "file" ? "ENOTDIR" : "EACCES"), result.stderr);
            ok(await lstat(path));
        } finally {
            if (path && change === "unreadable") await chmod(path, 0o700);
            await rm(root, { recursive: true, force: true });
        }
    });
}

test("passive inspection rejects a symlink without removing publication directories", async () => {
    const root = await realpath(await fixture.checkout());
    try {
        const layout = await enterProjectRuntime(root);
        const retiring = join(layout.primary.publicationStagingRoot, "retiring-attempt");
        await mkdir(retiring, { recursive: true });
        await mkdir(layout.primary.debugRoot, { recursive: true });
        const link = join(layout.primary.debugRoot, "unsafe-link");
        await symlink(join(root, "missing"), link);
        const result = await inspectProjectRuntimeReadAccess(root);
        equal(result.kind, "blocked");
        ok(result.kind === "blocked" && result.reason === "symlink");
        ok((await lstat(link)).isSymbolicLink());
        ok((await lstat(retiring)).isDirectory());
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
