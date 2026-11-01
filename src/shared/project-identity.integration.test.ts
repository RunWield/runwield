import { test } from "node:test";
import { deepEqual, equal, notEqual, ok } from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import process from "node:process";
import { randomUUID } from "node:crypto";
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
import { enterProjectRuntime, resolveProjectRuntimeLayout } from "./project-runtime-layout.ts";
import { encodeCwdForSessionDir } from "./project-directory-key.ts";
import { getHomeDir } from "../constants.js";
import { withProcessGlobalTestLock } from "../testing/process-global-lock.ts";
const fixture = defineCommittedGitFixture();
function admitted(result: ProjectIdentityAdmission): ProjectIdentity {
    equal(result.kind, "existing", JSON.stringify(result));
    if (result.kind !== "existing") throw new Error("Identity not admitted");
    return result.identity;
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

test("real runtime entry admits identity without moving runtime or legacy Session locators", async () => {
    const root = await fixture.checkout();
    const home = await mkdtemp(join(tmpdir(), "identity-entry-"));
    try {
        const context = localContext(home);
        const before = resolveProjectRuntimeLayout(root);
        const key = encodeCwdForSessionDir(root);
        const layout = await enterProjectRuntime(root, { context });
        deepEqual(layout, before);
        equal(encodeCwdForSessionDir(root), key);
        ok(layout.primary.internalRoot.endsWith(join(".wld", "internal")));
        equal(inspectProjectIdentity(root, { context }).kind, "existing");
    } finally {
        await rm(home, { recursive: true, force: true });
        await rm(root, { recursive: true, force: true });
    }
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
            args: ["--no-env-file", "--no-install", cli, "plans"],
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
