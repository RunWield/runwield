import { assert, assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { PROJECT_SECRET_STORE_RELATIVE_PATH } from "../../constants.js";
import { defineCommittedGitFixture, git } from "../git-test-fixture.ts";
import { resolveProjectRuntimeLayout } from "../project-runtime-layout.ts";
import { withProcessGlobalTestLock } from "../../testing/process-global-lock.ts";
import {
    assertCompatiblePullSecretRecord,
    deleteCompatibleSecretRecords,
    deleteSecretRecord,
    ensureProjectSecretStoreIgnored,
    getGlobalSecretStorePath,
    getProjectSecretStoreLocation,
    getProjectSecretStorePath,
    getSecretRecord,
    putCompatibleSecretRecord,
    putSecretRecord,
    readSecretStore,
    redactSecretStoreValue,
    resolveCompatibleSecretRecord,
    resolvePullSecretRecord,
    SECRET_STORE_SCHEMA_VERSION,
    writeSecretStore,
} from "./secrets.js";

const gitFixture = defineCommittedGitFixture({ "README.md": "# Collaboration secrets fixture\n" });

/**
 * @typedef {Object} TestSecretStore
 * @property {"global"} owner
 * @property {string} path
 */

/**
 * @param {string} path
 * @returns {TestSecretStore}
 */
function testSecretStore(path) {
    return { owner: "global", path };
}

function secretRecord() {
    return {
        planId: "plan-1",
        spaceId: "space-1",
        contentKey: "content-key",
        reviewerCapability: "reviewer-cap",
        maintainerCapability: "maintainer-cap",
        updatedAt: "2026-07-04T00:00:00.000Z",
    };
}

Deno.test("secret store paths keep global home storage and route project storage through primary runtime layout", async () => {
    assertEquals(getGlobalSecretStorePath("/home/user"), "/home/user/.wld/collaboration-secrets.json");
    await withProcessGlobalTestLock(async () => {
        const originalSandboxHome = Deno.env.get("WLD_TEST_SANDBOX_HOME");
        const primaryCheckout = await gitFixture.checkout({ prefix: "runwield-secrets-primary-" });
        const selectedCheckout = await Deno.makeTempDir({ prefix: "runwield-secrets-linked-" });
        try {
            Deno.env.delete("WLD_TEST_SANDBOX_HOME");
            await git(primaryCheckout, [
                "worktree",
                "add",
                "-b",
                `secrets-path-test-${crypto.randomUUID()}`,
                selectedCheckout,
            ]);
            const layout = resolveProjectRuntimeLayout(selectedCheckout);
            assertEquals(getProjectSecretStorePath(selectedCheckout), layout.primary.projectSecretStorePath);
            assertEquals(
                getProjectSecretStorePath(selectedCheckout).startsWith(await Deno.realPath(primaryCheckout)),
                true,
            );
        } finally {
            if (originalSandboxHome === undefined) Deno.env.delete("WLD_TEST_SANDBOX_HOME");
            else Deno.env.set("WLD_TEST_SANDBOX_HOME", originalSandboxHome);
            await Deno.remove(selectedCheckout, { recursive: true }).catch(() => {});
            await Deno.remove(primaryCheckout, { recursive: true }).catch(() => {});
        }
    });
});

Deno.test("secret stores read missing files as empty documents and write atomically", async () => {
    const dir = await Deno.makeTempDir({ prefix: "runwield-secrets-" });
    try {
        const path = join(dir, ".wld", "collaboration-secrets.json");
        assertEquals(await readSecretStore(testSecretStore(path)), {
            schemaVersion: SECRET_STORE_SCHEMA_VERSION,
            records: {},
        });
        await putSecretRecord(testSecretStore(path), "plan-1", secretRecord());
        assertEquals(await getSecretRecord(testSecretStore(path), "plan-1"), secretRecord());
        assertEquals(((await Deno.stat(path)).mode ?? 0) & 0o777, 0o600);
        const siblingTemps = [];
        for await (const entry of Deno.readDir(join(dir, ".wld"))) {
            if (entry.name.includes(".tmp")) siblingTemps.push(entry.name);
        }
        assertEquals(siblingTemps, []);
    } finally {
        await Deno.remove(dir, { recursive: true });
    }
});

Deno.test("project secret writes from linked checkouts populate only the primary internal store", async () => {
    await withProcessGlobalTestLock(async () => {
        const originalSandboxHome = Deno.env.get("WLD_TEST_SANDBOX_HOME");
        const primaryCheckout = await gitFixture.checkout({ prefix: "runwield-secrets-write-primary-" });
        const selectedCheckout = await Deno.makeTempDir({ prefix: "runwield-secrets-write-linked-" });
        try {
            Deno.env.delete("WLD_TEST_SANDBOX_HOME");
            await git(primaryCheckout, [
                "worktree",
                "add",
                "-b",
                `secrets-write-test-${crypto.randomUUID()}`,
                selectedCheckout,
            ]);
            const primaryLayout = resolveProjectRuntimeLayout(primaryCheckout);
            const selectedLocation = await getProjectSecretStoreLocation(selectedCheckout);
            const selectedPath = selectedLocation.path;
            await putSecretRecord(selectedLocation, "plan-1:space-1", secretRecord());

            assertEquals(selectedPath, primaryLayout.primary.projectSecretStorePath);
            assertEquals(
                (await readSecretStore(await getProjectSecretStoreLocation(primaryCheckout))).records["plan-1:space-1"],
                secretRecord(),
            );
            await assertRejects(
                () => Deno.stat(join(primaryCheckout, PROJECT_SECRET_STORE_RELATIVE_PATH)),
                Deno.errors.NotFound,
            );
            await assertRejects(
                () => Deno.stat(join(selectedCheckout, PROJECT_SECRET_STORE_RELATIVE_PATH)),
                Deno.errors.NotFound,
            );
            await assertRejects(
                () => Deno.stat(join(selectedCheckout, ".wld", "internal", "collaboration-secrets.json")),
                Deno.errors.NotFound,
            );
        } finally {
            if (originalSandboxHome === undefined) Deno.env.delete("WLD_TEST_SANDBOX_HOME");
            else Deno.env.set("WLD_TEST_SANDBOX_HOME", originalSandboxHome);
            await Deno.remove(selectedCheckout, { recursive: true }).catch(() => {});
            await Deno.remove(primaryCheckout, { recursive: true }).catch(() => {});
        }
    });
});

Deno.test("project secret path honors sandbox routing", async () => {
    const dir = await Deno.makeTempDir({ prefix: "runwield-secrets-sandbox-" });
    const sandboxHome = await Deno.makeTempDir({ prefix: "runwield-secrets-sandbox-home-" });
    const originalSandboxHome = Deno.env.get("WLD_TEST_SANDBOX_HOME");
    try {
        Deno.env.set("WLD_TEST_SANDBOX_HOME", sandboxHome);
        assertEquals(
            getProjectSecretStorePath(dir),
            resolveProjectRuntimeLayout(dir).primary.projectSecretStorePath,
        );
        assert(getProjectSecretStorePath(dir).startsWith(sandboxHome));
    } finally {
        if (originalSandboxHome === undefined) Deno.env.delete("WLD_TEST_SANDBOX_HOME");
        else Deno.env.set("WLD_TEST_SANDBOX_HOME", originalSandboxHome);
        await Deno.remove(dir, { recursive: true }).catch(() => {});
        await Deno.remove(sandboxHome, { recursive: true }).catch(() => {});
    }
});

Deno.test("secret store write cleans up temporary files when atomic rename fails", async () => {
    const dir = await Deno.makeTempDir({ prefix: "runwield-secrets-rename-fail-" });
    try {
        const path = join(dir, "store.json");
        await Deno.mkdir(path);

        await assertRejects(
            () => writeSecretStore(testSecretStore(path), { schemaVersion: SECRET_STORE_SCHEMA_VERSION, records: {} }),
            Error,
            "Unable to write collaboration secret store",
        );

        const siblingTemps = [];
        for await (const entry of Deno.readDir(dir)) {
            if (entry.name.includes(".tmp")) siblingTemps.push(entry.name);
        }
        assertEquals(siblingTemps, []);
        assert((await Deno.stat(path)).isDirectory);
    } finally {
        await Deno.remove(dir, { recursive: true });
    }
});

Deno.test("secret store replacement leaves the file readable only by its owner", async () => {
    const dir = await Deno.makeTempDir({ prefix: "runwield-secrets-replace-" });
    try {
        const path = join(dir, "store.json");
        await Deno.writeTextFile(
            path,
            `${JSON.stringify({ schemaVersion: SECRET_STORE_SCHEMA_VERSION, records: {} })}\n`,
            {
                mode: 0o644,
            },
        );
        await Deno.chmod(path, 0o644);

        await writeSecretStore(testSecretStore(path), {
            schemaVersion: SECRET_STORE_SCHEMA_VERSION,
            records: { "plan-1:space-1": secretRecord() },
        });

        assertEquals((await readSecretStore(testSecretStore(path))).records["plan-1:space-1"], secretRecord());
        assertEquals(((await Deno.stat(path)).mode ?? 0) & 0o777, 0o600);
    } finally {
        await Deno.remove(dir, { recursive: true });
    }
});

Deno.test("secret stores delete records idempotently", async () => {
    const dir = await Deno.makeTempDir({ prefix: "runwield-secrets-delete-" });
    try {
        const path = join(dir, ".wld", "collaboration-secrets.json");
        await putSecretRecord(testSecretStore(path), "plan-1:space-1", secretRecord());
        await deleteSecretRecord(testSecretStore(path), "plan-1:space-1");
        await deleteSecretRecord(testSecretStore(path), "plan-1:space-1");
        assertEquals(await getSecretRecord(testSecretStore(path), "plan-1:space-1"), undefined);
    } finally {
        await Deno.remove(dir, { recursive: true });
    }
});

Deno.test("deleteCompatibleSecretRecords clears pair and legacy records across stores", async () => {
    const dir = await Deno.makeTempDir({ prefix: "runwield-secrets-unshare-" });
    try {
        const globalPath = join(dir, "global.json");
        const projectPath = join(dir, "project.json");
        await putSecretRecord(testSecretStore(globalPath), "plan-1:space-1", secretRecord());
        await putSecretRecord(testSecretStore(globalPath), "plan-1", secretRecord());
        await putSecretRecord(testSecretStore(projectPath), "plan-1", {
            ...secretRecord(),
            reviewerCapability: "project-reviewer",
        });
        await putSecretRecord(testSecretStore(projectPath), "plan-1:other-space", {
            ...secretRecord(),
            spaceId: "other-space",
        });

        const deleted = await deleteCompatibleSecretRecords(
            [testSecretStore(globalPath), testSecretStore(projectPath)],
            "plan-1",
            "space-1",
        );

        assertEquals(
            deleted.map((entry) => `${entry.path}:${entry.key}`).sort(),
            [
                `${globalPath}:plan-1`,
                `${globalPath}:plan-1:space-1`,
                `${projectPath}:plan-1`,
            ].sort(),
        );
        assertEquals(await getSecretRecord(testSecretStore(globalPath), "plan-1"), undefined);
        assertEquals(await getSecretRecord(testSecretStore(globalPath), "plan-1:space-1"), undefined);
        assertEquals(await getSecretRecord(testSecretStore(projectPath), "plan-1"), undefined);
        assertEquals(
            (await getSecretRecord(testSecretStore(projectPath), "plan-1:other-space"))?.spaceId,
            "other-space",
        );
    } finally {
        await Deno.remove(dir, { recursive: true });
    }
});

Deno.test("deleteCompatibleSecretRecords tolerates missing stores", async () => {
    const dir = await Deno.makeTempDir({ prefix: "runwield-secrets-unshare-missing-" });
    try {
        assertEquals(
            await deleteCompatibleSecretRecords([testSecretStore(join(dir, "missing.json"))], "plan-1", "space-1"),
            [],
        );
    } finally {
        await Deno.remove(dir, { recursive: true });
    }
});

Deno.test("deleteCompatibleSecretRecords preserves unrelated legacy space records", async () => {
    const dir = await Deno.makeTempDir({ prefix: "runwield-secrets-unshare-preserve-" });
    try {
        const path = join(dir, "store.json");
        await putSecretRecord(testSecretStore(path), "plan-1", { ...secretRecord(), spaceId: "other-space" });

        assertEquals(await deleteCompatibleSecretRecords([testSecretStore(path)], "plan-1", "space-1"), []);
        assertEquals((await getSecretRecord(testSecretStore(path), "plan-1"))?.spaceId, "other-space");
    } finally {
        await Deno.remove(dir, { recursive: true });
    }
});

Deno.test("pull secret resolution prefers planId-space records across stores", async () => {
    const dir = await Deno.makeTempDir({ prefix: "runwield-secrets-resolve-" });
    try {
        const globalPath = join(dir, "global.json");
        const projectPath = join(dir, "project.json");
        await putSecretRecord(testSecretStore(globalPath), "plan-1", secretRecord());
        await putSecretRecord(testSecretStore(projectPath), "plan-1:space-1", secretRecord());
        const resolved = await resolvePullSecretRecord(
            [testSecretStore(globalPath), testSecretStore(projectPath)],
            "plan-1",
            "space-1",
        );
        assertEquals(resolved?.path, projectPath);
        assertEquals(resolved?.key, "plan-1:space-1");
        assertEquals(resolved?.record.maintainerCapability, "maintainer-cap");
    } finally {
        await Deno.remove(dir, { recursive: true });
    }
});

Deno.test("compatible secret resolution ignores records bound to other Shared Spaces", async () => {
    const dir = await Deno.makeTempDir({ prefix: "runwield-secrets-compatible-" });
    try {
        const globalPath = join(dir, "global.json");
        const projectPath = join(dir, "project.json");
        await putSecretRecord(testSecretStore(globalPath), "plan-1", { ...secretRecord(), spaceId: "other-space" });
        await putSecretRecord(testSecretStore(projectPath), "plan-1:space-1", secretRecord());

        const resolved = await resolveCompatibleSecretRecord(
            [testSecretStore(globalPath), testSecretStore(projectPath)],
            "plan-1",
            "space-1",
        );

        assertEquals(resolved?.path, projectPath);
        assertEquals(resolved?.key, "plan-1:space-1");
    } finally {
        await Deno.remove(dir, { recursive: true });
    }
});

Deno.test("compatible secret resolution returns null for only unrelated space records", async () => {
    const dir = await Deno.makeTempDir({ prefix: "runwield-secrets-compatible-null-" });
    try {
        const path = join(dir, "store.json");
        await putSecretRecord(testSecretStore(path), "plan-1", { ...secretRecord(), spaceId: "other-space" });

        assertEquals(await resolveCompatibleSecretRecord([testSecretStore(path)], "plan-1", "space-1"), null);
    } finally {
        await Deno.remove(dir, { recursive: true });
    }
});

Deno.test("pull secret resolution refuses conflicts across stores and legacy records", async () => {
    const dir = await Deno.makeTempDir({ prefix: "runwield-secrets-resolve-conflict-" });
    try {
        const globalPath = join(dir, "global.json");
        const projectPath = join(dir, "project.json");
        await putSecretRecord(testSecretStore(projectPath), "plan-1:space-1", secretRecord());
        await putSecretRecord(testSecretStore(globalPath), "plan-1", {
            ...secretRecord(),
            maintainerCapability: "different-cap",
        });

        await assertRejects(
            () =>
                resolvePullSecretRecord(
                    [testSecretStore(projectPath), testSecretStore(globalPath)],
                    "plan-1",
                    "space-1",
                ),
            Error,
            "Conflicting collaboration secret record for maintainerCapability",
        );
    } finally {
        await Deno.remove(dir, { recursive: true });
    }
});

Deno.test("URL import compatibility checks all stores before writing target record", async () => {
    const dir = await Deno.makeTempDir({ prefix: "runwield-secrets-import-conflict-" });
    try {
        const globalPath = join(dir, "global.json");
        const projectPath = join(dir, "project.json");
        await putSecretRecord(testSecretStore(globalPath), "plan-1", {
            ...secretRecord(),
            contentKey: "different-key",
        });

        await assertRejects(
            () =>
                assertCompatiblePullSecretRecord(
                    [testSecretStore(projectPath), testSecretStore(globalPath)],
                    "plan-1",
                    "space-1",
                    secretRecord(),
                ),
            Error,
            "Conflicting collaboration secret record for contentKey",
        );
        assertEquals(await getSecretRecord(testSecretStore(projectPath), "plan-1:space-1"), undefined);
    } finally {
        await Deno.remove(dir, { recursive: true });
    }
});

Deno.test("putCompatibleSecretRecord refuses conflicting imported maintainer secrets", async () => {
    const dir = await Deno.makeTempDir({ prefix: "runwield-secrets-conflict-" });
    try {
        const path = join(dir, "store.json");
        await putCompatibleSecretRecord(testSecretStore(path), "plan-1:space-1", secretRecord());
        await assertRejects(
            () =>
                putCompatibleSecretRecord(testSecretStore(path), "plan-1:space-1", {
                    ...secretRecord(),
                    maintainerCapability: "different-cap",
                }),
            Error,
            "Conflicting collaboration secret record",
        );
    } finally {
        await Deno.remove(dir, { recursive: true });
    }
});

Deno.test("secret store rejects corrupt schema with redacted actionable errors", async () => {
    const dir = await Deno.makeTempDir({ prefix: "runwield-secrets-corrupt-" });
    try {
        const path = join(dir, "collaboration-secrets.json");
        await Deno.writeTextFile(path, JSON.stringify({ schemaVersion: 999, records: {} }));
        await assertRejects(
            () => readSecretStore(testSecretStore(path)),
            Error,
            "Unable to read collaboration secret store",
        );
    } finally {
        await Deno.remove(dir, { recursive: true });
    }
});

Deno.test("ensureProjectSecretStoreIgnored protects the primary managed runtime block from linked checkouts", async () => {
    await withProcessGlobalTestLock(async () => {
        const originalSandboxHome = Deno.env.get("WLD_TEST_SANDBOX_HOME");
        const primaryCheckout = await gitFixture.checkout({ prefix: "runwield-gitignore-primary-" });
        const selectedCheckout = await Deno.makeTempDir({ prefix: "runwield-gitignore-linked-" });
        try {
            Deno.env.delete("WLD_TEST_SANDBOX_HOME");
            await Deno.writeTextFile(join(primaryCheckout, ".gitignore"), "node_modules/\n");
            await git(primaryCheckout, [
                "worktree",
                "add",
                "-b",
                `secrets-ignore-test-${crypto.randomUUID()}`,
                selectedCheckout,
            ]);
            await Deno.writeTextFile(join(selectedCheckout, ".gitignore"), "selected-only\n");

            await ensureProjectSecretStoreIgnored(selectedCheckout);
            const first = await Deno.readTextFile(join(primaryCheckout, ".gitignore"));
            await ensureProjectSecretStoreIgnored(selectedCheckout);

            assertEquals(await Deno.readTextFile(join(primaryCheckout, ".gitignore")), first);
            assert(first.startsWith("node_modules/\n"));
            assert(first.includes("# BEGIN RunWield owned runtime state\n"));
            assertEquals(
                first.includes(`\n${PROJECT_SECRET_STORE_RELATIVE_PATH}\n${PROJECT_SECRET_STORE_RELATIVE_PATH}\n`),
                false,
            );
            assertEquals(await Deno.readTextFile(join(selectedCheckout, ".gitignore")), "selected-only\n");
            assert((await Deno.stat(resolveProjectRuntimeLayout(selectedCheckout).primary.internalRoot)).isDirectory);
            assertEquals(
                await git(primaryCheckout, ["check-ignore", ".wld/internal/collaboration-secrets.json"]),
                ".wld/internal/collaboration-secrets.json",
            );
            assertEquals(
                await git(primaryCheckout, ["check-ignore", ".wld/internal/collaboration-secrets.json.token.tmp"]),
                ".wld/internal/collaboration-secrets.json.token.tmp",
            );
            for (
                const path of [".wld/settings.json", ".wld/agents/a.md", ".wld/skills/s/SKILL.md", ".wld/prompts/a.md"]
            ) {
                await assertRejects(() => git(primaryCheckout, ["check-ignore", path]));
            }
        } finally {
            if (originalSandboxHome === undefined) Deno.env.delete("WLD_TEST_SANDBOX_HOME");
            else Deno.env.set("WLD_TEST_SANDBOX_HOME", originalSandboxHome);
            await Deno.remove(selectedCheckout, { recursive: true }).catch(() => {});
            await Deno.remove(primaryCheckout, { recursive: true }).catch(() => {});
        }
    });
});

Deno.test("redactSecretStoreValue redacts local secret fields", () => {
    const redacted = redactSecretStoreValue({ records: { "plan-1": secretRecord() } });
    assert(!redacted.includes("content-key"));
    assert(!redacted.includes("reviewer-cap"));
    assert(!redacted.includes("maintainer-cap"));
    assert(redacted.includes("[redacted-capability]"));
});

Deno.test("writeSecretStore validates records before persisting", async () => {
    const dir = await Deno.makeTempDir({ prefix: "runwield-secrets-invalid-" });
    try {
        const document = /** @type {import("./secrets.js").SecretStoreDocument} */ ({
            schemaVersion: 1,
            records: { bad: /** @type {any} */ ({}) },
        });
        await assertRejects(() => writeSecretStore(testSecretStore(join(dir, "store.json")), document));
    } finally {
        await Deno.remove(dir, { recursive: true });
    }
});
