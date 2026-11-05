import { test } from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { assertEquals, assertStringIncludes } from "../testing/assertions.ts";
import { withProcessGlobalTestLock } from "../testing/process-global-lock.ts";
import { savePlan } from "../plan-store.js";
import { readControllerRecord, writeControllerState } from "./workflow/controller-registry.ts";
import { defineGitFixture, git } from "./git-test-fixture.ts";

test("Git fixture templates stay unchanged by automatic object maintenance", async () => {
    await withProcessGlobalTestLock(async () => {
        const root = await mkdtemp(join(tmpdir(), "git-fixture-maintenance-"));
        const previous = process.env.GIT_CONFIG_GLOBAL;
        let checkout: string | undefined;
        try {
            const config = join(root, "gitconfig");
            await writeFile(config, "[gc]\n\tauto = 1\n\tautoDetach = false\n");
            process.env.GIT_CONFIG_GLOBAL = config;
            const fixture = defineGitFixture(async (repo) => {
                // Enough loose objects in Git's sampled bucket to trigger host auto-GC.
                for (const index of [672, 1117, 1577]) {
                    await writeFile(join(repo, `${index}.txt`), `fixture object ${index}\n`);
                }
                await git(repo, ["add", "."]);
                await git(repo, ["commit", "-m", "Fixture objects"]);
            });
            checkout = await fixture.checkout();
            assertStringIncludes(await git(checkout, ["count-objects", "-v"]), "in-pack: 0\n");
            assertEquals(await git(checkout, ["fsck", "--full"]), "");
            assertEquals((await git(checkout, ["ls-tree", "--name-only", "HEAD"])).split("\n").length, 3);
        } finally {
            if (previous === undefined) delete process.env.GIT_CONFIG_GLOBAL;
            else process.env.GIT_CONFIG_GLOBAL = previous;
            if (checkout) await rm(checkout, { recursive: true });
            await rm(root, { recursive: true });
        }
    });
});

test("Git fixture checkouts isolate home-owned controller state seeded by the template", async () => {
    const fixture = defineGitFixture(async (repo) => {
        await savePlan(repo, "demo", "# Seeded Plan\n", { planId: "seeded", status: "reviewed" });
        await git(repo, ["add", "."]);
        await git(repo, ["commit", "-m", "Seeded Plan"]);
    });
    const first = await fixture.checkout();
    const second = await fixture.checkout();
    try {
        await writeControllerState(first, { planId: "seeded", planName: "demo" }, { validationCiAttempts: 2 });
        await writeControllerState(second, { planId: "seeded", planName: "demo" }, {});
        assertEquals(
            (await readControllerRecord(second, { planId: "seeded", planName: "demo" }))?.state.validationCiAttempts,
            undefined,
        );
    } finally {
        await rm(first, { recursive: true, force: true });
        await rm(second, { recursive: true, force: true });
    }
});
