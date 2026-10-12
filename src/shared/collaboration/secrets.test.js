import { test } from "node:test";
import {
    chmod as fsChmod,
    mkdir as fsMkdir,
    mkdtemp as fsMkdtemp,
    readdir as fsReaddir,
    readFile as fsReadFile,
    realpath as fsRealpath,
    rm as fsRm,
    stat as fsStat,
    writeFile as fsWriteFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import process from "node:process";
import { ok as assert } from "node:assert/strict";
import { assertEquals, assertRejects } from "../../testing/assertions.ts";
import { join } from "node:path";
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

test("secret store paths keep global home storage and route project storage through primary runtime layout", async () => {
    assertEquals(getGlobalSecretStorePath("/home/user"), join("/home/user", ".wld", "collaboration-secrets.json"));
    await withProcessGlobalTestLock(async () => {
        const originalSandboxHome = process.env["WLD_TEST_SANDBOX_HOME"];
        const primaryCheckout = await gitFixture.checkout({ prefix: "runwield-secrets-primary-" });
        const selectedCheckout = await fsMkdtemp(join(tmpdir(), "runwield-secrets-linked-"));
        try {
            delete process.env["WLD_TEST_SANDBOX_HOME"];
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
                getProjectSecretStorePath(selectedCheckout).startsWith(await fsRealpath(primaryCheckout)),
                true,
            );
        } finally {
            if (originalSandboxHome === undefined) delete process.env["WLD_TEST_SANDBOX_HOME"];
            else process.env["WLD_TEST_SANDBOX_HOME"] = originalSandboxHome;
            await fsRm(selectedCheckout, { recursive: true }).catch(() => {});
            await fsRm(primaryCheckout, { recursive: true }).catch(() => {});
        }
    });
});

test("secret stores read missing files as empty documents and write atomically", async () => {
    const dir = await fsMkdtemp(join(tmpdir(), "runwield-secrets-"));
    try {
        const path = join(dir, ".wld", "collaboration-secrets.json");
        assertEquals(await readSecretStore(testSecretStore(path)), {
            schemaVersion: SECRET_STORE_SCHEMA_VERSION,
            records: {},
        });
        await putSecretRecord(testSecretStore(path), "plan-1", secretRecord());
        assertEquals(await getSecretRecord(testSecretStore(path), "plan-1"), secretRecord());
        if (process.platform !== "win32") assertEquals(((await fsStat(path)).mode ?? 0) & 0o777, 0o600);
        const siblingTemps = [];
        for await (const entry of await fsReaddir(join(dir, ".wld"), { withFileTypes: true })) {
            if (entry.name.includes(".tmp")) siblingTemps.push(entry.name);
        }
        assertEquals(siblingTemps, []);
    } finally {
        await fsRm(dir, { recursive: true });
    }
});

test("project secret writes from linked checkouts populate only the primary internal store", async () => {
    await withProcessGlobalTestLock(async () => {
        const originalSandboxHome = process.env["WLD_TEST_SANDBOX_HOME"];
        const primaryCheckout = await gitFixture.checkout({ prefix: "runwield-secrets-write-primary-" });
        const selectedCheckout = await fsMkdtemp(join(tmpdir(), "runwield-secrets-write-linked-"));
        try {
            delete process.env["WLD_TEST_SANDBOX_HOME"];
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
                () => fsStat(join(primaryCheckout, PROJECT_SECRET_STORE_RELATIVE_PATH)),
                Error,
                "ENOENT",
            );
            await assertRejects(
                () => fsStat(join(selectedCheckout, PROJECT_SECRET_STORE_RELATIVE_PATH)),
                Error,
                "ENOENT",
            );
            await assertRejects(
                () => fsStat(join(selectedCheckout, ".wld", "internal", "collaboration-secrets.json")),
                Error,
                "ENOENT",
            );
        } finally {
            if (originalSandboxHome === undefined) delete process.env["WLD_TEST_SANDBOX_HOME"];
            else process.env["WLD_TEST_SANDBOX_HOME"] = originalSandboxHome;
            await fsRm(selectedCheckout, { recursive: true }).catch(() => {});
            await fsRm(primaryCheckout, { recursive: true }).catch(() => {});
        }
    });
});

test("project secret path honors sandbox routing", async () => {
    const dir = await fsMkdtemp(join(tmpdir(), "runwield-secrets-sandbox-"));
    const sandboxHome = await fsMkdtemp(join(tmpdir(), "runwield-secrets-sandbox-home-"));
    const originalSandboxHome = process.env["WLD_TEST_SANDBOX_HOME"];
    try {
        process.env["WLD_TEST_SANDBOX_HOME"] = sandboxHome;
        assertEquals(
            getProjectSecretStorePath(dir),
            resolveProjectRuntimeLayout(dir).primary.projectSecretStorePath,
        );
        assert(getProjectSecretStorePath(dir).startsWith(sandboxHome));
    } finally {
        if (originalSandboxHome === undefined) delete process.env["WLD_TEST_SANDBOX_HOME"];
        else process.env["WLD_TEST_SANDBOX_HOME"] = originalSandboxHome;
        await fsRm(dir, { recursive: true }).catch(() => {});
        await fsRm(sandboxHome, { recursive: true }).catch(() => {});
    }
});

test("secret store write cleans up temporary files when atomic rename fails", async () => {
    const dir = await fsMkdtemp(join(tmpdir(), "runwield-secrets-rename-fail-"));
    try {
        const path = join(dir, "store.json");
        await fsMkdir(path);

        await assertRejects(
            () => writeSecretStore(testSecretStore(path), { schemaVersion: SECRET_STORE_SCHEMA_VERSION, records: {} }),
            Error,
            "Unable to write collaboration secret store",
        );

        const siblingTemps = [];
        for await (const entry of await fsReaddir(dir, { withFileTypes: true })) {
            if (entry.name.includes(".tmp")) siblingTemps.push(entry.name);
        }
        assertEquals(siblingTemps, []);
        assert((await fsStat(path)).isDirectory());
    } finally {
        await fsRm(dir, { recursive: true });
    }
});

test("secret store replacement leaves the file readable only by its owner", async () => {
    const dir = await fsMkdtemp(join(tmpdir(), "runwield-secrets-replace-"));
    try {
        const path = join(dir, "store.json");
        await fsWriteFile(path, `${JSON.stringify({ schemaVersion: SECRET_STORE_SCHEMA_VERSION, records: {} })}\n`, {
            mode: 0o644,
        });
        await fsChmod(path, 0o644);

        await writeSecretStore(testSecretStore(path), {
            schemaVersion: SECRET_STORE_SCHEMA_VERSION,
            records: { "plan-1:space-1": secretRecord() },
        });

        assertEquals((await readSecretStore(testSecretStore(path))).records["plan-1:space-1"], secretRecord());
        if (process.platform !== "win32") assertEquals(((await fsStat(path)).mode ?? 0) & 0o777, 0o600);
    } finally {
        await fsRm(dir, { recursive: true });
    }
});

test("secret stores delete records idempotently", async () => {
    const dir = await fsMkdtemp(join(tmpdir(), "runwield-secrets-delete-"));
    try {
        const path = join(dir, ".wld", "collaboration-secrets.json");
        await putSecretRecord(testSecretStore(path), "plan-1:space-1", secretRecord());
        await deleteSecretRecord(testSecretStore(path), "plan-1:space-1");
        await deleteSecretRecord(testSecretStore(path), "plan-1:space-1");
        assertEquals(await getSecretRecord(testSecretStore(path), "plan-1:space-1"), undefined);
    } finally {
        await fsRm(dir, { recursive: true });
    }
});

test("deleteCompatibleSecretRecords clears pair and legacy records across stores", async () => {
    const dir = await fsMkdtemp(join(tmpdir(), "runwield-secrets-unshare-"));
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
        await fsRm(dir, { recursive: true });
    }
});

test("deleteCompatibleSecretRecords tolerates missing stores", async () => {
    const dir = await fsMkdtemp(join(tmpdir(), "runwield-secrets-unshare-missing-"));
    try {
        assertEquals(
            await deleteCompatibleSecretRecords([testSecretStore(join(dir, "missing.json"))], "plan-1", "space-1"),
            [],
        );
    } finally {
        await fsRm(dir, { recursive: true });
    }
});

test("deleteCompatibleSecretRecords preserves unrelated legacy space records", async () => {
    const dir = await fsMkdtemp(join(tmpdir(), "runwield-secrets-unshare-preserve-"));
    try {
        const path = join(dir, "store.json");
        await putSecretRecord(testSecretStore(path), "plan-1", { ...secretRecord(), spaceId: "other-space" });

        assertEquals(await deleteCompatibleSecretRecords([testSecretStore(path)], "plan-1", "space-1"), []);
        assertEquals((await getSecretRecord(testSecretStore(path), "plan-1"))?.spaceId, "other-space");
    } finally {
        await fsRm(dir, { recursive: true });
    }
});

test("pull secret resolution prefers planId-space records across stores", async () => {
    const dir = await fsMkdtemp(join(tmpdir(), "runwield-secrets-resolve-"));
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
        await fsRm(dir, { recursive: true });
    }
});

test("compatible secret resolution ignores records bound to other Shared Spaces", async () => {
    const dir = await fsMkdtemp(join(tmpdir(), "runwield-secrets-compatible-"));
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
        await fsRm(dir, { recursive: true });
    }
});

test("compatible secret resolution returns null for only unrelated space records", async () => {
    const dir = await fsMkdtemp(join(tmpdir(), "runwield-secrets-compatible-null-"));
    try {
        const path = join(dir, "store.json");
        await putSecretRecord(testSecretStore(path), "plan-1", { ...secretRecord(), spaceId: "other-space" });

        assertEquals(await resolveCompatibleSecretRecord([testSecretStore(path)], "plan-1", "space-1"), null);
    } finally {
        await fsRm(dir, { recursive: true });
    }
});

test("pull secret resolution refuses conflicts across stores and legacy records", async () => {
    const dir = await fsMkdtemp(join(tmpdir(), "runwield-secrets-resolve-conflict-"));
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
        await fsRm(dir, { recursive: true });
    }
});

test("URL import compatibility checks all stores before writing target record", async () => {
    const dir = await fsMkdtemp(join(tmpdir(), "runwield-secrets-import-conflict-"));
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
        await fsRm(dir, { recursive: true });
    }
});

test("putCompatibleSecretRecord refuses conflicting imported maintainer secrets", async () => {
    const dir = await fsMkdtemp(join(tmpdir(), "runwield-secrets-conflict-"));
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
        await fsRm(dir, { recursive: true });
    }
});

test("secret store rejects corrupt schema with redacted actionable errors", async () => {
    const dir = await fsMkdtemp(join(tmpdir(), "runwield-secrets-corrupt-"));
    try {
        const path = join(dir, "collaboration-secrets.json");
        await fsWriteFile(path, JSON.stringify({ schemaVersion: 999, records: {} }));
        await assertRejects(
            () => readSecretStore(testSecretStore(path)),
            Error,
            "Unable to read collaboration secret store",
        );
    } finally {
        await fsRm(dir, { recursive: true });
    }
});

test("ensureProjectSecretStoreIgnored protects the primary managed runtime block from linked checkouts", async () => {
    await withProcessGlobalTestLock(async () => {
        const originalSandboxHome = process.env["WLD_TEST_SANDBOX_HOME"];
        const primaryCheckout = await gitFixture.checkout({ prefix: "runwield-gitignore-primary-" });
        const selectedCheckout = await fsMkdtemp(join(tmpdir(), "runwield-gitignore-linked-"));
        try {
            delete process.env["WLD_TEST_SANDBOX_HOME"];
            await fsWriteFile(join(primaryCheckout, ".gitignore"), "node_modules/\n");
            await git(primaryCheckout, [
                "worktree",
                "add",
                "-b",
                `secrets-ignore-test-${crypto.randomUUID()}`,
                selectedCheckout,
            ]);
            await fsWriteFile(join(selectedCheckout, ".gitignore"), "selected-only\n");

            await ensureProjectSecretStoreIgnored(selectedCheckout);
            const first = await fsReadFile(join(primaryCheckout, ".gitignore"), "utf8");
            await ensureProjectSecretStoreIgnored(selectedCheckout);

            assertEquals(await fsReadFile(join(primaryCheckout, ".gitignore"), "utf8"), first);
            assert(first.startsWith("node_modules/\n"));
            assert(first.includes("# BEGIN RunWield owned runtime state\n"));
            assertEquals(
                first.includes(`\n${PROJECT_SECRET_STORE_RELATIVE_PATH}\n${PROJECT_SECRET_STORE_RELATIVE_PATH}\n`),
                false,
            );
            assertEquals(await fsReadFile(join(selectedCheckout, ".gitignore"), "utf8"), "selected-only\n");
            assert((await fsStat(resolveProjectRuntimeLayout(selectedCheckout).primary.internalRoot)).isDirectory());
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
            if (originalSandboxHome === undefined) delete process.env["WLD_TEST_SANDBOX_HOME"];
            else process.env["WLD_TEST_SANDBOX_HOME"] = originalSandboxHome;
            await fsRm(selectedCheckout, { recursive: true }).catch(() => {});
            await fsRm(primaryCheckout, { recursive: true }).catch(() => {});
        }
    });
});

test("redactSecretStoreValue redacts local secret fields", () => {
    const redacted = redactSecretStoreValue({ records: { "plan-1": secretRecord() } });
    assert(!redacted.includes("content-key"));
    assert(!redacted.includes("reviewer-cap"));
    assert(!redacted.includes("maintainer-cap"));
    assert(redacted.includes("[redacted-capability]"));
});

test("writeSecretStore validates records before persisting", async () => {
    const dir = await fsMkdtemp(join(tmpdir(), "runwield-secrets-invalid-"));
    try {
        const document = /** @type {import("./secrets.js").SecretStoreDocument} */ ({
            schemaVersion: 1,
            records: { bad: /** @type {any} */ ({}) },
        });
        await assertRejects(() => writeSecretStore(testSecretStore(join(dir, "store.json")), document));
    } finally {
        await fsRm(dir, { recursive: true });
    }
});
