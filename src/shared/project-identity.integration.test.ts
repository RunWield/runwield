import { test } from "node:test";
import { deepEqual, equal, notEqual, ok } from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import process from "node:process";
import { createHash, randomUUID } from "node:crypto";
import { defineCommittedGitFixture, git } from "./git-test-fixture.ts";
import { captureForegroundProcess } from "./captured-process.ts";
import {
    admitProjectIdentity,
    inspectProjectIdentity,
    type ProjectIdentityAdmission,
    type ProjectIdentity,
    type ProjectLaunchContext,
    type ProjectCloneChoice,
} from "./project-identity.ts";
import { enterProjectRuntime } from "./project-runtime-layout.ts";
import { getRunWieldSessionDir } from "./session/root-session.js";
import { locateAttachedWorkflows } from "./attached/record-store.ts";
import { encodeCwdForSessionDir } from "./project-directory-key.ts";
import { getHomeDir } from "../constants.js";
import { withProcessGlobalTestLock } from "../testing/process-global-lock.ts";
const fixture = defineCommittedGitFixture();
function admitted(result: ProjectIdentityAdmission): ProjectIdentity {
    equal(result.kind, "existing", JSON.stringify(result));
    if (result.kind !== "existing") throw new Error("Identity not admitted");
    return result.identity;
}
async function assertStoredBinding(home: string, identity: ProjectIdentity, root: string) {
    const canonicalRoot = await realpath(root);
    const { storageLocators, ...record } = JSON.parse(
        await readFile(join(home, ".wld", "projects", identity.projectId, "project.wld.json"), "utf8"),
    );
    ok(Array.isArray(storageLocators));
    deepEqual(record, {
        version: 1,
        projectId: identity.projectId,
        displayName: basename(canonicalRoot),
        personalOwner: identity.personalOwner,
        repositories: [
            {
                repositoryId: identity.repositoryId,
                remote: null,
                decision: "new",
                checkouts: [{ checkoutId: identity.checkoutId, root: canonicalRoot }],
            },
        ],
    });
}
function localContext(home: string): ProjectLaunchContext {
    return { executionAccountHome: home, personalOwner: { kind: "execution-account", identity: home } };
}
async function child(
    root: string,
    context: ProjectLaunchContext,
    choice?: ProjectCloneChoice,
    extraEnv: Record<string, string> = {},
): Promise<ProjectIdentityAdmission> {
    const module = new URL("./project-identity.ts", import.meta.url).href;
    const code = `import { admitProjectIdentity } from ${JSON.stringify(module)}; console.log(JSON.stringify(await admitProjectIdentity(${JSON.stringify(root)}, ${JSON.stringify({ context, choice })})));`;
    const result = await captureForegroundProcess(process.execPath, { cwd: root, args: ["-e", code], env: extraEnv });
    equal(result.code, 0, new TextDecoder().decode(result.stderr));
    return JSON.parse(new TextDecoder().decode(result.stdout));
}

test("independent processes concurrently admit one Git identity and reopen the same committed binding", async () => {
    const home = await mkdtemp(join(tmpdir(), "identity-concurrent-"));
    const root = await fixture.checkout();
    try {
        const context = localContext(home);
        const [one, two] = (await Promise.all([child(root, context), child(root, context)])).map(admitted);
        deepEqual(one, two);
        deepEqual(admitted(await child(root, context)), one);
        await assertStoredBinding(home, one, root);
        deepEqual(await readdir(join(home, ".wld", "projects")), [one.projectId]);
    } finally {
        await rm(home, { recursive: true, force: true });
        await rm(root, { recursive: true, force: true });
    }
});

test("independent processes concurrently admit one non-Git identity", async () => {
    const home = await mkdtemp(join(tmpdir(), "identity-nongit-"));
    const root = join(home, "project");
    try {
        await mkdir(root);
        const context = localContext(home);
        const [one, two] = (await Promise.all([child(root, context), child(root, context)])).map(admitted);
        deepEqual(one, two);
        deepEqual(admitted(await child(root, context)), one);
        await assertStoredBinding(home, one, root);
    } finally {
        await rm(home, { recursive: true, force: true });
    }
});

test("global and command-injected Git settings cannot supply Project identity", async () => {
    const home = await mkdtemp(join(tmpdir(), "identity-config-"));
    const root = await fixture.checkout();
    try {
        const poison = randomUUID();
        const global = join(home, "gitconfig");
        await writeFile(global, `[runwield]\nprojectId = ${poison}\n`);
        const first = admitted(
            await child(root, localContext(home), undefined, {
                GIT_CONFIG_GLOBAL: global,
                GIT_CONFIG_COUNT: "1",
                GIT_CONFIG_KEY_0: "runwield.projectId",
                GIT_CONFIG_VALUE_0: poison,
            }),
        );
        notEqual(first.projectId, poison);
        equal(await git(root, ["config", "--local", "runwield.projectId"]), first.projectId);
    } finally {
        await rm(home, { recursive: true, force: true });
        await rm(root, { recursive: true, force: true });
    }
});

test("clone choices stay pending without input, preserve cancellation, and remember acceptance and decline across processes", async () => {
    const home = await mkdtemp(join(tmpdir(), "identity-clones-"));
    const source = await fixture.checkout();
    try {
        const context = localContext(home);
        const one = join(home, "one");
        const two = join(home, "two");
        const three = join(home, "three");
        const four = join(home, "four");
        for (const root of [one, two, three, four]) await git(source, ["clone", source, root]);
        const first = admitted(await child(one, context));
        const before = await readFile(join(two, ".git", "config"), "utf8");
        const pending = await child(two, context);
        equal(pending.kind, "pending");
        if (pending.kind !== "pending") throw new Error("Expected pending clone");
        equal(pending.candidates.length, 1);
        equal((await child(two, context, { kind: "cancel", candidates: pending.candidates })).kind, "canceled");
        equal(await readFile(join(two, ".git", "config"), "utf8"), before);
        equal(inspectProjectIdentity(two, { context }).kind, "pending");
        const linked = admitted(
            await child(two, context, { kind: "link", candidates: pending.candidates, projectId: first.projectId }),
        );
        equal(linked.projectId, first.projectId);
        notEqual(linked.repositoryId, first.repositoryId);
        deepEqual(
            JSON.parse(await readFile(join(home, ".wld", "projects", first.projectId, "project.wld.json"), "utf8"))
                .repositories,
            [
                {
                    repositoryId: first.repositoryId,
                    remote: source,
                    decision: "new",
                    checkouts: [{ checkoutId: first.checkoutId, root: await realpath(one) }],
                },
                {
                    repositoryId: linked.repositoryId,
                    remote: source,
                    decision: "linked",
                    checkouts: [{ checkoutId: linked.checkoutId, root: await realpath(two) }],
                },
            ],
        );
        const declined = admitted(await child(three, context, { kind: "new", candidates: pending.candidates }));
        notEqual(declined.projectId, first.projectId);
        for (let i = 0; i < 2; i++) {
            equal(admitted(await child(two, context)).projectId, first.projectId);
            equal(admitted(await child(three, context)).projectId, declined.projectId);
        }
        const multiple = await child(four, context);
        equal(multiple.kind, "pending");
        if (multiple.kind !== "pending") throw new Error("Expected multiple candidates");
        equal(multiple.candidates.length, 2);
        equal(
            (await child(four, context, { kind: "link", projectId: first.projectId, candidates: pending.candidates }))
                .kind,
            "pending",
        );
        equal(
            admitted(
                await child(four, context, {
                    kind: "link",
                    projectId: declined.projectId,
                    candidates: multiple.candidates,
                }),
            ).projectId,
            declined.projectId,
        );
    } finally {
        await rm(home, { recursive: true, force: true });
        await rm(source, { recursive: true, force: true });
    }
});

test("real runtime entry preserves independently pinned runtime and legacy Session locators", async () => {
    await withProcessGlobalTestLock(async () => {
        const root = await fixture.checkout();
        const home = await mkdtemp(join(tmpdir(), "identity-entry-"));
        const originalHome = process.env.HOME;
        const originalSandboxHome = process.env.WLD_TEST_SANDBOX_HOME;
        try {
            process.env.HOME = home;
            delete process.env.WLD_TEST_SANDBOX_HOME;
            const context = localContext(home);
            const canonicalRoot = await realpath(root);
            // These legacy values are fixed independently of the encoder under test.
            equal(encodeCwdForSessionDir("/legacy/runwield project"), "--legacy-runwield project--");
            equal(encodeCwdForSessionDir("C:\\legacy\\runwield project"), "--C--legacy-runwield project--");
            const readableKey = `--${canonicalRoot.split(/[\\/]/).filter(Boolean).join("-").replace(/:/g, "-")}--`;
            const legacyKey =
                readableKey.length <= 120
                    ? readableKey
                    : `--${basename(canonicalRoot).slice(0, 40)}-${createHash("sha256").update(canonicalRoot).digest("hex").slice(0, 32)}--`;
            const internal = join(canonicalRoot, ".wld", "internal");
            const layout = await enterProjectRuntime(root, { context });
            deepEqual(layout, {
                primary: {
                    checkoutRoot: canonicalRoot,
                    internalRoot: internal,
                    layoutMarkerPath: join(internal, "layout.json"),
                    layoutMigrationJournalPath: join(internal, "layout-migration.json"),
                    layoutMigrationLockPath: join(internal, "layout-migration.lock"),
                    controllerPlansDir: join(internal, "controller", "plans"),
                    worktreeRegistryPath: join(internal, "worktrees.json"),
                    worktreeRegistryLockPath: join(internal, "worktrees.lock"),
                    worktreeRegistryMigrationIssuesPath: join(internal, "worktree-registry-migration-issues.json"),
                    publicationStagingRoot: join(internal, "plan-staging"),
                    deliveryEvidenceRoot: join(internal, "delivery-evidence"),
                    projectSecretStorePath: join(internal, "collaboration-secrets.json"),
                    fallbackWorktreesRoot: join(internal, "worktrees"),
                    debugRoot: join(internal, "debug"),
                    workRecordIndexDatabasePath: join(internal, "work-records.sqlite3"),
                },
                selected: {
                    checkoutRoot: canonicalRoot,
                    internalRoot: internal,
                    planLocksDir: join(internal, "plan-locks"),
                    planCatalogLockPath: join(internal, "plan-locks", "catalog.lock"),
                    transitionJournalsDir: join(internal, "plan-transitions"),
                    planBackupsDir: join(internal, "plan-backups"),
                    workRecordSupersessionLockPath: join(internal, "work-record-supersession.lock"),
                    workRecordSupersessionRecoveryLockPath: join(internal, "work-record-supersession-recovery.lock"),
                },
            });
            equal(getRunWieldSessionDir(root), join(getHomeDir(), ".wld", "sessions", legacyKey));
            equal(
                locateAttachedWorkflows(root).workflowsDir,
                join(getHomeDir(), ".wld", "attached", legacyKey, "workflows"),
            );
            equal(inspectProjectIdentity(root, { context }).kind, "existing");
        } finally {
            if (originalHome === undefined) delete process.env.HOME;
            else process.env.HOME = originalHome;
            if (originalSandboxHome === undefined) delete process.env.WLD_TEST_SANDBOX_HOME;
            else process.env.WLD_TEST_SANDBOX_HOME = originalSandboxHome;
            await rm(home, { recursive: true, force: true });
            await rm(root, { recursive: true, force: true });
        }
    });
});

test("ordinary manual SSH startup retains execution-account ownership", async () => {
    await withProcessGlobalTestLock(async () => {
        const root = await fixture.checkout();
        const old = process.env.SSH_CONNECTION;
        try {
            process.env.SSH_CONNECTION = "laptop 123 server 22";
            const identity = admitted(await admitProjectIdentity(root));
            deepEqual(identity.personalOwner, { kind: "execution-account", identity: getHomeDir() });
            equal(identity.executionAccountHome, getHomeDir());
        } finally {
            if (old === undefined) delete process.env.SSH_CONNECTION;
            else process.env.SSH_CONNECTION = old;
            await rm(root, { recursive: true, force: true });
        }
    });
});

test("Workspace registration keeps its registration ID while associating admitted Core identity", async () => {
    const { openOwnerCoordinationDatabase } = await import("./owner-coordination/database.js");
    const { registerProject, getProjectById } = await import("./owner-coordination/projects.js");
    const home = await mkdtemp(join(tmpdir(), "identity-workspace-"));
    const root = await fixture.checkout();
    const database = openOwnerCoordinationDatabase({ dbPath: join(home, "owner.sqlite3") });
    try {
        const registration = registerProject(database, { root });
        equal(registration.coreProjectId, null);
        const identity = admitted(await admitProjectIdentity(root));
        const associated = getProjectById(database, registration.projectId);
        equal(associated?.projectId, registration.projectId);
        equal(associated?.coreProjectId, identity.projectId);
        notEqual(identity.projectId, registration.projectId);
    } finally {
        database.close();
        await rm(home, { recursive: true, force: true });
        await rm(root, { recursive: true, force: true });
    }
});

test("ordinary CLI presents unavailable clone choice as pending and saves no decline", async () => {
    const { fileURLToPath } = await import("node:url");
    const home = await mkdtemp(join(tmpdir(), "identity-cli-"));
    const source = await fixture.checkout();
    try {
        const one = join(home, "one");
        const two = join(home, "two");
        for (const root of [one, two]) await git(source, ["clone", source, root]);
        admitted(await child(one, localContext(home)));
        const cli = fileURLToPath(new URL("../cli.ts", import.meta.url));
        const result = await captureForegroundProcess(process.execPath, {
            cwd: two,
            args: ["--no-env-file", "--no-install", cli, "Establish this Project"],
            env: { HOME: home, WLD_TEST_SANDBOX_HOME: home },
            stdinText: "",
        });
        equal(result.code, 1);
        ok(new TextDecoder().decode(result.stderr).includes("Project clone-link choice required"));
        equal(inspectProjectIdentity(two, { context: localContext(home) }).kind, "pending");
        ok(!(await readdir(join(two, ".git"))).includes(".runwield-project.lock"));
    } finally {
        await rm(home, { recursive: true, force: true });
        await rm(source, { recursive: true, force: true });
    }
});

for (const scenario of ["new then link", "link then new", "link then different link"] as const) {
    test(`stale clone choice conflicts with committed identity: ${scenario}`, async () => {
        const home = await mkdtemp(join(tmpdir(), "identity-stale-choice-"));
        const source = await fixture.checkout();
        try {
            const context = localContext(home);
            const known = join(home, "known");
            const separate = join(home, "separate");
            const clone = join(home, "clone");
            for (const root of [known, separate, clone]) await git(source, ["clone", source, root]);
            const first = admitted(await child(known, context));
            const initial = inspectProjectIdentity(separate, { context });
            if (initial.kind !== "pending") throw new Error("Expected pending clone");
            const other = admitted(await child(separate, context, { kind: "new", candidates: initial.candidates }));
            // Both prompts observe the same uncommitted clone before either submits its answer.
            const promptA = inspectProjectIdentity(clone, { context });
            const promptB = inspectProjectIdentity(clone, { context });
            if (promptA.kind !== "pending" || promptB.kind !== "pending") throw new Error("Expected pending prompts");
            deepEqual(promptA, promptB);
            const winner: ProjectCloneChoice =
                scenario === "new then link"
                    ? { kind: "new", candidates: promptA.candidates }
                    : { kind: "link", projectId: first.projectId, candidates: promptA.candidates };
            const committed = admitted(await child(clone, context, winner));
            const stale: ProjectCloneChoice =
                scenario === "link then new"
                    ? { kind: "new", candidates: promptB.candidates }
                    : {
                          kind: "link",
                          projectId: scenario === "new then link" ? first.projectId : other.projectId,
                          candidates: promptB.candidates,
                      };
            const config = await readFile(join(clone, ".git", "config"), "utf8");
            const recordPath = join(home, ".wld", "projects", committed.projectId, "project.wld.json");
            const record = await readFile(recordPath, "utf8");
            const result = await child(clone, context, stale);
            equal(result.kind, "invalid", JSON.stringify(result));
            if (result.kind !== "invalid") throw new Error("Expected a clone-choice conflict");
            ok(result.message.includes("conflicts with the committed Project"), result.message);
            equal(await readFile(join(clone, ".git", "config"), "utf8"), config);
            equal(await readFile(recordPath, "utf8"), record);
            deepEqual(admitted(await child(clone, context)), committed);
            // Repeating the winning decision remains idempotent.
            deepEqual(admitted(await child(clone, context, winner)), committed);
        } finally {
            await rm(home, { recursive: true, force: true });
            await rm(source, { recursive: true, force: true });
        }
    });
}

test("activated managed owner never falls back after its verified mount is detached", async () => {
    const home = await mkdtemp(join(tmpdir(), "identity-activated-owner-"));
    const root = await fixture.checkout();
    try {
        const identityModule = new URL("./project-identity.ts", import.meta.url).href;
        const resourcesModule = new URL("./remote/personal-resources.ts", import.meta.url).href;
        const constantsModule = new URL("../constants.js", import.meta.url).href;
        const code = `
            import { deepEqual, equal, match } from "node:assert/strict";
            import { mkdir, rename, readdir, readFile, lstat } from "node:fs/promises";
            import { join } from "node:path";
            import { admitProjectIdentity, inspectProjectIdentity } from ${JSON.stringify(identityModule)};
            import { configureRemotePersonalResources } from ${JSON.stringify(resourcesModule)};
            import { getHomeDir } from ${JSON.stringify(constantsModule)};
            const root = ${JSON.stringify(root)};
            const home = getHomeDir();
            const globalRoot = join(home, "mounted-laptop");
            await mkdir(globalRoot);
            const personalOwner = { kind: "managed-remote", identity: "verified-laptop-owner" };
            configureRemotePersonalResources({ globalRoot, personalOwner });
            const active = await admitProjectIdentity(root);
            equal(active.kind, "existing", JSON.stringify(active));
            deepEqual(active.identity.personalOwner, personalOwner);
            equal(active.identity.executionAccountHome, home);
            deepEqual((await readdir(home)).sort(), ["mounted-laptop"]);
            await rename(globalRoot, join(home, "detached-laptop"));
            await mkdir(globalRoot);
            async function snapshot(path) {
                const stat = await lstat(path);
                const own = [path, stat.mode, stat.mtimeMs, stat.isFile() ? await readFile(path, "base64") : ""];
                const nested = stat.isDirectory()
                    ? await Promise.all((await readdir(path)).sort().map((name) => snapshot(join(path, name))))
                    : [];
                return [own, nested];
            }
            const before = [await snapshot(home), await snapshot(root)];
            const inspected = inspectProjectIdentity(root);
            equal(inspected.kind, "invalid", JSON.stringify(inspected));
            match(inspected.message, /changed identity/);
            const admitted = await admitProjectIdentity(root);
            equal(admitted.kind, "invalid", JSON.stringify(admitted));
            match(admitted.message, /changed identity/);
            deepEqual([await snapshot(home), await snapshot(root)], before);
        `;
        const result = await captureForegroundProcess(process.execPath, {
            cwd: root,
            args: ["-e", code],
            env: { HOME: home, WLD_TEST_SANDBOX_HOME: home },
        });
        equal(result.code, 0, new TextDecoder().decode(result.stderr));
    } finally {
        await rm(home, { recursive: true, force: true });
        await rm(root, { recursive: true, force: true });
    }
});
