import { test } from "node:test";
import { equal, ok, rejects } from "node:assert/strict";
import { readFile, stat, lstat } from "node:fs/promises";
import { join } from "node:path";
import { composedRemoteFixture } from "./composed-store-fixture.ts";
import { withProcessGlobalTestLock } from "../../testing/process-global-lock.ts";
import { git } from "../git-test-fixture.ts";

test("managed import and sibling publication retain laptop ownership beside a same-ID manual owner", () =>
    withProcessGlobalTestLock(async () => {
        const fixture = await composedRemoteFixture();
        try {
            const personal: { path: string; markdown: string } = JSON.parse(await fixture.run("manual-seed"));
            const before = await readFile(personal.path, "utf8");
            const managed: { executionCwd: string; sibling: string; attemptId: string; records: string[] } = JSON.parse(
                await fixture.run("managed-deliver"),
            );
            equal(managed.records.length, 1);
            ok(managed.executionCwd.startsWith(fixture.remoteHome));
            await rejects(stat(managed.executionCwd), { code: "ENOENT" });
            ok(managed.sibling.includes("Laptop sibling sentinel"));
            equal(await git(fixture.upstream, ["show", "main:managed-sentinel"]), "Delivered sentinel");
            equal(await readFile(personal.path, "utf8"), before);
            const reconnected: { markdown: string } = JSON.parse(await fixture.run("managed-read"));
            ok(reconnected.markdown.includes("Laptop sibling sentinel"));
            await fixture.disconnect();
            const delivered: { records: string[] } = JSON.parse(await fixture.run("manual-deliver"));
            equal(delivered.records.length, 1);
            equal(await git(fixture.upstream, ["show", "main:manual-sentinel"]), "Delivered sentinel");
            const manual: { markdown: string } = JSON.parse(await fixture.run("manual-read"));
            ok(manual.markdown.includes("Remote personal decoy"));
            equal(await readFile(personal.path, "utf8"), before);
            for (const path of [".wld/internal", ".wld/plans"])
                await rejects(lstat(join(fixture.root, path)), { code: "ENOENT" });
        } finally {
            await fixture.cleanup();
        }
    }));
