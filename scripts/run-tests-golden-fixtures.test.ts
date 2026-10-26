import { test } from "node:test";
import { equal, ok } from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix, win32 } from "node:path";
import { prepareGoldenFixtures } from "./run-tests.js";

for (const paths of [posix, win32]) {
    test(`Golden suites receive prepared repository templates with ${JSON.stringify(paths.sep)} paths`, async () => {
        const sandbox = await mkdtemp(join(tmpdir(), "golden-runner-path-"));
        try {
            const file = paths.join(paths.sep, "repo", "src", "ui", "tui", "golden-scenarios", "fixture.test.ts");
            const root = await prepareGoldenFixtures([file], sandbox);
            ok(root, "Golden suite must receive shared repository templates");
            for (const variant of ["initialized", "uninitialized"]) {
                ok(existsSync(join(root, variant, "project", ".git")));
                ok(existsSync(join(root, variant, "remote.git", "HEAD")));
            }
        } finally {
            await rm(sandbox, { recursive: true, force: true });
        }
    });
}

test("source-only suites do not prepare Golden repository templates", async () => {
    const sandbox = await mkdtemp(join(tmpdir(), "source-runner-path-"));
    try {
        equal(await prepareGoldenFixtures([join(sandbox, "source.test.ts")], sandbox), "");
        equal((await readdir(sandbox)).length, 0);
    } finally {
        await rm(sandbox, { recursive: true, force: true });
    }
});
