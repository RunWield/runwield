import { test } from "node:test";
import { equal, ok, rejects } from "node:assert/strict";
import { readFile, stat, lstat, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { projects } from "@runwield/projects";
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

test("a managed write repairs the local Git identity before opening its operation journal", () =>
    withProcessGlobalTestLock(async () => {
        const fixture = await composedRemoteFixture();
        try {
            // The server retains its admission. The next process must repair local identity from the legacy marker.
            const admitted = await fetch(`${fixture.endpoint}/project-store/admit`, {
                method: "POST",
                headers: fixture.headers,
            });
            equal(admitted.status, 200);
            const checkout = projects.checkout.inspect(fixture.root);
            ok(checkout.kind === "existing");
            const { projectId, repositoryId, checkoutId } = checkout.identity;
            const marker = join(fixture.root, ".wld-project.json");
            const checkoutIdentity = join(
                await git(fixture.root, ["rev-parse", "--absolute-git-dir"]),
                "runwield-checkout-id",
            );
            await writeFile(
                marker,
                JSON.stringify({ format: "runwield-project", version: 1, projectId, repositoryId, checkoutId }),
            );
            await rm(checkoutIdentity);

            ok(await fixture.run("managed-author"));
            equal((await readFile(checkoutIdentity, "utf8")).trim(), checkoutId);
            await rejects(lstat(marker), { code: "ENOENT" });
        } finally {
            await fixture.cleanup();
        }
    }));

test("a managed store handle rejects an in-flight read after the host reconnects", () =>
    withProcessGlobalTestLock(async () => {
        const fixture = await composedRemoteFixture();
        try {
            ok(await fixture.run("managed-author"));
            await fixture.run("managed-connection-reopen");
        } finally {
            await fixture.cleanup();
        }
    }));

test("a managed import retains its operation when the host reconnects before returning its result", () =>
    withProcessGlobalTestLock(async () => {
        const fixture = await composedRemoteFixture();
        try {
            await fixture.run("managed-import-reconnect");
        } finally {
            await fixture.cleanup();
        }
    }));

test("a managed import can replay after reconnecting between owner commit and acknowledgement", () =>
    withProcessGlobalTestLock(async () => {
        const fixture = await composedRemoteFixture();
        try {
            await fixture.run("managed-import-reconnect-after-commit");
        } finally {
            await fixture.cleanup();
        }
    }));

test("revoking a managed import while its journal lock is held preserves the operation for replay", () =>
    withProcessGlobalTestLock(async () => {
        const fixture = await composedRemoteFixture();
        try {
            await fixture.run("managed-import-reconnect-with-held-lock");
        } finally {
            await fixture.cleanup();
        }
    }));

test("managed CLI prune keeps its approved selection when the connection changes at the copy cleanup lock", () =>
    withProcessGlobalTestLock(async () => {
        const fixture = await composedRemoteFixture();
        try {
            await fixture.run("managed-prune-reconnect");
        } finally {
            await fixture.cleanup();
        }
    }));
