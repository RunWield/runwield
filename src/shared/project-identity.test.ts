import { test } from "node:test";
import { deepEqual, equal, notEqual, ok, match } from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rename, rm, symlink, writeFile, readdir, lstat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { defineCommittedGitFixture, git } from "./git-test-fixture.ts";
import {
    admitProjectIdentity,
    inspectProjectIdentity,
    type ProjectIdentityAdmission,
    type ProjectIdentity,
    type ProjectLaunchContext,
} from "./project-identity.ts";

const fixture = defineCommittedGitFixture();
function admitted(result: ProjectIdentityAdmission): ProjectIdentity {
    equal(result.kind, "existing", JSON.stringify(result));
    if (result.kind !== "existing") throw new Error("Identity not admitted");
    return result.identity;
}
async function environment() {
    const home = await mkdtemp(join(tmpdir(), "identity-home-"));
    const root = await fixture.checkout();
    const context: ProjectLaunchContext = {
        executionAccountHome: home,
        personalOwner: { kind: "execution-account", identity: home },
    };
    return {
        home,
        root,
        context,
        async close() {
            await rm(home, { recursive: true, force: true });
            await rm(root, { recursive: true, force: true });
        },
    };
}
async function snapshot(root: string): Promise<string[]> {
    const entries: string[] = [];
    async function visit(path: string) {
        const stat = await lstat(path);
        entries.push(`${path}:${stat.mode}:${stat.mtimeMs}:${stat.isFile() ? await readFile(path, "base64") : ""}`);
        if (stat.isDirectory()) for (const name of (await readdir(path)).sort()) await visit(join(path, name));
    }
    await visit(root);
    return entries;
}

test("identity inspection leaves fresh, admitted and malformed project and home bytes untouched", async () => {
    const f = await environment();
    try {
        const fresh = [...(await snapshot(f.home)), ...(await snapshot(f.root))];
        equal(inspectProjectIdentity(f.root, { context: f.context }).kind, "fresh");
        deepEqual([...(await snapshot(f.home)), ...(await snapshot(f.root))], fresh);
        admitted(await admitProjectIdentity(f.root, { context: f.context }));
        const existing = [...(await snapshot(f.home)), ...(await snapshot(f.root))];
        equal(inspectProjectIdentity(f.root, { context: f.context }).kind, "existing");
        deepEqual([...(await snapshot(f.home)), ...(await snapshot(f.root))], existing);
        await writeFile(join(f.root, ".wld-project.json"), "user-owned contents");
        const malformed = [...(await snapshot(f.home)), ...(await snapshot(f.root))];
        equal(inspectProjectIdentity(f.root, { context: f.context }).kind, "invalid");
        equal((await admitProjectIdentity(f.root, { context: f.context })).kind, "invalid");
        deepEqual([...(await snapshot(f.home)), ...(await snapshot(f.root))], malformed);
    } finally {
        await f.close();
    }
});

test("linked worktrees and subdirectories share Project and repository IDs with distinct checkout IDs", async () => {
    const f = await environment();
    const linked = `${f.root}-linked`;
    try {
        const first = admitted(await admitProjectIdentity(f.root, { context: f.context }));
        await git(f.root, ["worktree", "add", "-b", "linked", linked]);
        await mkdir(join(linked, "nested"));
        const second = admitted(await admitProjectIdentity(join(linked, "nested"), { context: f.context }));
        equal(second.projectId, first.projectId);
        equal(second.repositoryId, first.repositoryId);
        notEqual(second.checkoutId, first.checkoutId);
        equal(admitted(inspectProjectIdentity(linked, { context: f.context })).checkoutId, second.checkoutId);
    } finally {
        await rm(linked, { recursive: true, force: true });
        await f.close();
    }
});

test("Project identity survives checkout moves and remote edits without changing legacy locators", async () => {
    const f = await environment();
    const moved = `${f.root}-moved`;
    try {
        const first = admitted(await admitProjectIdentity(f.root, { context: f.context }));
        await git(f.root, ["remote", "add", "origin", "https://example.invalid/project.git"]);
        await rename(f.root, moved);
        const second = admitted(await admitProjectIdentity(moved, { context: f.context }));
        equal(second.projectId, first.projectId);
        equal(second.checkoutId, first.checkoutId);
        await git(moved, ["remote", "remove", "origin"]);
        equal(admitted(await admitProjectIdentity(moved, { context: f.context })).projectId, first.projectId);
        match(first.projectId, /^[0-9a-f-]{36}$/);
    } finally {
        await rm(moved, { recursive: true, force: true });
        await f.close();
    }
});

test("independent same-basename repositories receive separate opaque identities", async () => {
    const f = await environment();
    const parent = await mkdtemp(join(tmpdir(), "identity-names-"));
    try {
        const other = await fixture.checkout();
        const firstRoot = join(parent, "one", "same");
        const secondRoot = join(parent, "two", "same");
        await mkdir(join(parent, "one"));
        await mkdir(join(parent, "two"));
        await rename(f.root, firstRoot);
        await rename(other, secondRoot);
        const first = admitted(await admitProjectIdentity(firstRoot, { context: f.context }));
        const second = admitted(await admitProjectIdentity(secondRoot, { context: f.context }));
        notEqual(first.projectId, second.projectId);
        notEqual(first.repositoryId, second.repositoryId);
    } finally {
        await rm(parent, { recursive: true, force: true });
        await f.close();
    }
});

test("only the common Git config own identity is authoritative, excluding included and worktree values", async () => {
    const f = await environment();
    try {
        const first = admitted(await admitProjectIdentity(f.root, { context: f.context }));
        const included = join(f.home, "included");
        await writeFile(included, `[runwield]\nprojectId = ${randomUUID()}\n`);
        await git(f.root, ["config", "include.path", included]);
        await git(f.root, ["config", "extensions.worktreeConfig", "true"]);
        await git(f.root, ["config", "--worktree", "runwield.projectId", randomUUID()]);
        await git(f.root, ["config", "preserve.setting", "keep-me"]);
        equal(admitted(await admitProjectIdentity(f.root, { context: f.context })).projectId, first.projectId);
        equal(await git(f.root, ["config", "preserve.setting"]), "keep-me");
    } finally {
        await f.close();
    }
});

test("non-Git identity survives move and Git adoption without altering settings or indexing its marker", async () => {
    const f = await environment();
    const directory = join(f.home, "plain");
    const moved = join(f.home, "renamed");
    try {
        await mkdir(join(directory, ".wld"), { recursive: true });
        await writeFile(join(directory, ".wld", "settings.json"), '{ "user": "bytes" }\n');
        const first = admitted(await admitProjectIdentity(directory, { context: f.context }));
        await rename(directory, moved);
        await git(moved, ["init"]);
        const second = admitted(await admitProjectIdentity(moved, { context: f.context }));
        equal(second.projectId, first.projectId);
        equal(second.repositoryId, first.repositoryId);
        equal(second.checkoutId, first.checkoutId);
        ok(!(await readdir(moved)).includes(".wld-project.json"));
        equal(await readFile(join(moved, ".wld", "settings.json"), "utf8"), '{ "user": "bytes" }\n');
        equal(await git(moved, ["ls-files"]), "");
    } finally {
        await f.close();
    }
});

test("conflicting Git identity preserves a valid non-Git marker", async () => {
    const f = await environment();
    const directory = join(f.home, "plain");
    try {
        await mkdir(directory);
        admitted(await admitProjectIdentity(directory, { context: f.context }));
        const marker = await readFile(join(directory, ".wld-project.json"), "utf8");
        await git(directory, ["init"]);
        const different = randomUUID();
        await git(directory, ["config", "runwield.projectId", different]);
        equal((await admitProjectIdentity(directory, { context: f.context })).kind, "invalid");
        equal(await readFile(join(directory, ".wld-project.json"), "utf8"), marker);
        equal(await git(directory, ["config", "runwield.projectId"]), different);
    } finally {
        await f.close();
    }
});

test("symlink and user-owned markers are preserved rather than adopted", async () => {
    const f = await environment();
    try {
        const target = join(f.home, "user.json");
        await writeFile(target, "user bytes");
        await symlink(target, join(f.root, ".wld-project.json"));
        equal((await admitProjectIdentity(f.root, { context: f.context })).kind, "invalid");
        ok((await lstat(join(f.root, ".wld-project.json"))).isSymbolicLink());
        equal(await readFile(target, "utf8"), "user bytes");
    } finally {
        await f.close();
    }
});

test("committed Git identity repairs missing home metadata without minting replacement IDs", async () => {
    const f = await environment();
    try {
        const first = admitted(await admitProjectIdentity(f.root, { context: f.context }));
        await rm(join(f.home, ".wld"), { recursive: true });
        deepEqual(admitted(await admitProjectIdentity(f.root, { context: f.context })), first);
        ok(await readFile(join(f.home, ".wld", "projects", first.projectId, "project.wld.json"), "utf8"));
    } finally {
        await f.close();
    }
});

test("corrupt home metadata cannot replace committed repository identity", async () => {
    const f = await environment();
    try {
        const first = admitted(await admitProjectIdentity(f.root, { context: f.context }));
        const record = join(f.home, ".wld", "projects", first.projectId, "project.wld.json");
        await writeFile(record, "broken");
        equal((await admitProjectIdentity(f.root, { context: f.context })).kind, "invalid");
        equal(await readFile(record, "utf8"), "broken");
        equal(await git(f.root, ["config", "runwield.projectId"]), first.projectId);
    } finally {
        await f.close();
    }
});

test("explicit managed owner keeps execution home separate and does not write a remote canonical registry", async () => {
    const f = await environment();
    try {
        const context: ProjectLaunchContext = {
            executionAccountHome: f.home,
            personalOwner: { kind: "managed-remote", identity: "laptop-owner" },
        };
        const result = admitted(await admitProjectIdentity(f.root, { context }));
        equal(result.personalOwner.identity, "laptop-owner");
        equal(result.executionAccountHome, f.home);
        deepEqual(await readdir(f.home), []);
    } finally {
        await f.close();
    }
});
