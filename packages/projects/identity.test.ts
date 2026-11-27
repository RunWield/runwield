import {
    isProjectId,
    parseProjectId,
    projects,
    type ProjectIdentityAdmission,
    type ProjectIdentity,
    type ProjectLaunchContext,
} from "@runwield/projects";
import { withProcessGlobalTestLock } from "../../test-support/process-global-lock.ts";
import { test } from "node:test";
import process from "node:process";
import { deepEqual, equal, notEqual, ok, match } from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rename, rm, symlink, writeFile, readdir, lstat, realpath } from "node:fs/promises";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { defineCommittedGitFixture, git } from "../../test-support/git-test-fixture.ts";

const fixture = defineCommittedGitFixture();
async function assertStoredBinding(home: string, identity: ProjectIdentity, roots: string[], checkouts = [identity]) {
    const canonicalRoots = await Promise.all(roots.map((root) => realpath(root)));
    const { storageLocators, ...record } = JSON.parse(
        await readFile(join(home, ".wld", "projects", identity.projectId, "project.wld.json"), "utf8"),
    );
    ok(Array.isArray(storageLocators));
    deepEqual(record, {
        version: 1,
        projectId: identity.projectId,
        displayName: basename(canonicalRoots[0]),
        personalOwner: identity.personalOwner,
        repositories: [
            {
                repositoryId: identity.repositoryId,
                remote: null,
                decision: "new",
                checkouts: checkouts.map((checkout, index) => ({
                    checkoutId: checkout.checkoutId,
                    root: canonicalRoots[index],
                })),
            },
        ],
    });
}
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

test("Project ID parsing preserves stored UUID spelling and rejects malformed IDs", () => {
    const stored = "A1234567-89AB-4DEF-A123-456789ABCDEF";
    ok(isProjectId(stored));
    equal(parseProjectId(stored), stored);
    equal(parseProjectId(stored.toLowerCase()), stored.toLowerCase());
    equal(parseProjectId(stored.replace("-4DEF", "-7DEF")), undefined);
    equal(parseProjectId(`${stored}\n`), undefined);
    equal(parseProjectId("legacy-session-storage"), undefined);
});

test("identity inspection leaves fresh, admitted and malformed project and home bytes untouched", async () => {
    const f = await environment();
    try {
        const fresh = [...(await snapshot(f.home)), ...(await snapshot(f.root))];
        equal(projects.checkout.inspect(f.root, { context: f.context }).kind, "fresh");
        deepEqual([...(await snapshot(f.home)), ...(await snapshot(f.root))], fresh);
        admitted(await projects.checkout.admit(f.root, { context: f.context }));
        const existing = [...(await snapshot(f.home)), ...(await snapshot(f.root))];
        equal(projects.checkout.inspect(f.root, { context: f.context }).kind, "existing");
        deepEqual([...(await snapshot(f.home)), ...(await snapshot(f.root))], existing);
        await writeFile(join(f.root, ".wld-project.json"), "user-owned contents");
        const malformed = [...(await snapshot(f.home)), ...(await snapshot(f.root))];
        equal(projects.checkout.inspect(f.root, { context: f.context }).kind, "invalid");
        equal((await projects.checkout.admit(f.root, { context: f.context })).kind, "invalid");
        deepEqual([...(await snapshot(f.home)), ...(await snapshot(f.root))], malformed);
    } finally {
        await f.close();
    }
});

test("pending clone inspection leaves home, project and Git names, bytes and modification times untouched", async () => {
    const f = await environment();
    try {
        const one = join(f.home, "one");
        const two = join(f.home, "two");
        for (const root of [one, two]) await git(f.root, ["clone", f.root, root]);
        admitted(await projects.checkout.admit(one, { context: f.context }));
        const before = [...(await snapshot(f.home)), ...(await snapshot(f.root))];
        const pending = projects.checkout.inspect(two, { context: f.context });
        equal(pending.kind, "pending");
        if (pending.kind !== "pending") throw new Error("Expected pending clone");
        equal(pending.candidates.length, 1);
        deepEqual([...(await snapshot(f.home)), ...(await snapshot(f.root))], before);
    } finally {
        await f.close();
    }
});

test("linked worktrees and subdirectories share Project and repository IDs with distinct checkout IDs", async () => {
    const f = await environment();
    const linked = `${f.root}-linked`;
    try {
        const first = admitted(await projects.checkout.admit(f.root, { context: f.context }));
        await git(f.root, ["worktree", "add", "-b", "linked", linked]);
        await mkdir(join(linked, "nested"));
        const second = admitted(await projects.checkout.admit(join(linked, "nested"), { context: f.context }));
        equal(second.projectId, first.projectId);
        equal(second.repositoryId, first.repositoryId);
        notEqual(second.checkoutId, first.checkoutId);
        equal(admitted(projects.checkout.inspect(linked, { context: f.context })).checkoutId, second.checkoutId);
        await assertStoredBinding(f.home, first, [f.root, linked], [first, second]);
    } finally {
        await rm(linked, { recursive: true, force: true });
        await f.close();
    }
});

test("Project identity survives checkout moves and remote edits without changing legacy locators", async () => {
    const f = await environment();
    const moved = `${f.root}-moved`;
    try {
        const first = admitted(await projects.checkout.admit(f.root, { context: f.context }));
        await git(f.root, ["remote", "add", "origin", "https://example.invalid/project.git"]);
        await rename(f.root, moved);
        const second = admitted(await projects.checkout.admit(moved, { context: f.context }));
        equal(second.projectId, first.projectId);
        equal(second.checkoutId, first.checkoutId);
        await git(moved, ["remote", "remove", "origin"]);
        equal(admitted(await projects.checkout.admit(moved, { context: f.context })).projectId, first.projectId);
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
        const first = admitted(await projects.checkout.admit(firstRoot, { context: f.context }));
        const second = admitted(await projects.checkout.admit(secondRoot, { context: f.context }));
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
        await git(f.root, ["config", "preserve.setting", "keep-me"]);
        const first = admitted(await projects.checkout.admit(f.root, { context: f.context }));
        equal(await git(f.root, ["config", "preserve.setting"]), "keep-me");
        const included = join(f.home, "included");
        await writeFile(included, `[runwield]\nprojectId = ${randomUUID()}\n`);
        await git(f.root, ["config", "include.path", included]);
        await git(f.root, ["config", "extensions.worktreeConfig", "true"]);
        await git(f.root, ["config", "--worktree", "runwield.projectId", randomUUID()]);
        equal(admitted(await projects.checkout.admit(f.root, { context: f.context })).projectId, first.projectId);
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
        const first = admitted(await projects.checkout.admit(directory, { context: f.context }));
        await rename(directory, moved);
        await git(moved, ["init"]);
        const second = admitted(await projects.checkout.admit(moved, { context: f.context }));
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

async function linkedNonGitProject(home: string, context: ProjectLaunchContext, markerEol: "lf" | "crlf" = "lf") {
    const primary = join(home, "plain");
    const linked = join(home, "linked");
    await mkdir(primary);
    const first = admitted(await projects.checkout.admit(primary, { context }));
    await git(primary, ["init", "-b", "main"]);
    await git(primary, ["config", "user.email", "fixture@runwield.test"]);
    await git(primary, ["config", "user.name", "RunWield Fixture"]);
    await git(primary, ["config", "commit.gpgsign", "false"]);
    if (markerEol === "crlf") {
        await writeFile(join(primary, ".gitattributes"), ".wld-project.json text eol=crlf\n");
        await git(primary, ["add", ".gitattributes"]);
    }
    await git(primary, ["add", ".wld-project.json"]);
    await git(primary, ["commit", "-m", "Initial checkout"]);
    await git(primary, ["worktree", "add", "-b", "linked", linked]);
    const linkedAdmin = await git(linked, ["rev-parse", "--absolute-git-dir"]);
    return { primary, linked, first, linkedBinding: join(linkedAdmin, "runwield-checkout-id") };
}

test("a committed non-Git marker keeps the primary binding when a linked worktree enters first", async () => {
    const f = await environment();
    try {
        const { primary, linked, first, linkedBinding } = await linkedNonGitProject(f.home, f.context);
        const before = await snapshot(f.home);
        equal(projects.checkout.inspect(linked, { context: f.context }).kind, "fresh");
        deepEqual(await snapshot(f.home), before);
        const second = admitted(await projects.checkout.admit(linked, { context: f.context }));
        equal(second.projectId, first.projectId);
        equal(second.repositoryId, first.repositoryId);
        notEqual(second.checkoutId, first.checkoutId);
        deepEqual(projects.checkout.historicalRoots(first), [first.checkoutRoot]);
        equal(await readFile(join(primary, ".git", "runwield-checkout-id"), "utf8"), `${first.checkoutId}\n`);

        await git(primary, ["switch", "-c", "without-marker"]);
        await git(primary, ["rm", ".wld-project.json"]);
        await git(primary, ["commit", "-m", "Stop tracking the marker"]);
        equal(admitted(projects.checkout.inspect(primary, { context: f.context })).checkoutId, first.checkoutId);
        await git(primary, ["switch", "main"]);
        const adopted = admitted(await projects.checkout.admit(primary, { context: f.context }));
        equal(adopted.checkoutId, first.checkoutId);
        await assertStoredBinding(f.home, first, [primary, linked], [first, second]);
        for (const root of [primary, linked]) {
            equal(await git(root, ["diff", "--cached", "--name-only"]), "");
            ok(!(await readdir(root)).includes(".wld-project.json"));
        }

        const unrelated = join(f.home, "unrelated");
        await mkdir(unrelated);
        const other = admitted(await projects.checkout.admit(unrelated, { context: f.context }));
        const unrelatedMarker = await readFile(join(unrelated, ".wld-project.json"), "utf8");
        const linkedMarker = join(linked, ".wld-project.json");
        await writeFile(linkedMarker, unrelatedMarker);
        const conflict = await projects.checkout.admit(linked, { context: f.context });
        equal(conflict.kind, "invalid");
        if (conflict.kind !== "invalid") throw new Error("Unrelated Project marker was admitted");
        match(conflict.message, /conflicts with the primary Project identity/);
        equal(await readFile(linkedMarker, "utf8"), unrelatedMarker);
        await assertStoredBinding(f.home, other, [unrelated]);
        await rm(linkedMarker);

        await writeFile(linkedBinding, `${first.checkoutId}\n`);
        const invalid = await projects.checkout.admit(linked, { context: f.context });
        equal(invalid.kind, "invalid");
        if (invalid.kind !== "invalid") throw new Error("Duplicate checkout binding was admitted");
        match(invalid.message, /shares the primary Git checkout ID/);
        equal(await readFile(linkedBinding, "utf8"), `${first.checkoutId}\n`);
        await assertStoredBinding(f.home, first, [primary, linked], [first, second]);

        await writeFile(linkedBinding, `${second.checkoutId}\n`);
        const sibling = join(f.home, "sibling");
        await git(primary, ["worktree", "add", "-b", "sibling", sibling]);
        const siblingAdmin = await git(sibling, ["rev-parse", "--absolute-git-dir"]);
        await writeFile(join(siblingAdmin, "runwield-checkout-id"), `${second.checkoutId}\n`);
        const beforeConflict = await snapshot(f.home);
        for (const root of [primary, linked, sibling]) {
            const conflict = await projects.checkout.admit(root, { context: f.context });
            equal(conflict.kind, "invalid");
            if (conflict.kind !== "invalid") throw new Error("Duplicate sibling binding was admitted");
            match(conflict.message, /Linked checkouts share a Git checkout ID/);
        }
        deepEqual(await snapshot(f.home), beforeConflict);
    } finally {
        await f.close();
    }
});

for (const firstEntry of ["primary", "linked"] as const) {
    test(`admits ${firstEntry} first after the primary branch drops its marker and Git checks out the copy as CRLF`, async () => {
        const f = await environment();
        try {
            const { primary, linked, first } = await linkedNonGitProject(f.home, f.context, "crlf");
            await git(primary, ["switch", "-c", "without-marker"]);
            await git(primary, ["rm", ".wld-project.json"]);
            await git(primary, ["commit", "-m", "Stop tracking the marker"]);

            match(await readFile(join(linked, ".wld-project.json"), "utf8"), /\r\n$/);
            equal(await git(linked, ["status", "--porcelain"]), "");
            notEqual(
                await git(linked, ["hash-object", "--no-filters", ".wld-project.json"]),
                await git(linked, ["rev-parse", "HEAD:.wld-project.json"]),
            );
            await writeFile(join(primary, ".git", "info", "attributes"), ".wld-project.json filter=marker-test\n");
            await git(primary, ["config", "filter.marker-test.clean", "false"]);
            await git(primary, ["config", "filter.marker-test.required", "true"]);
            equal(
                await git(linked, ["check-attr", "filter", "--", ".wld-project.json"]),
                ".wld-project.json: filter: marker-test",
            );
            const before = await snapshot(f.home);
            equal(admitted(projects.checkout.inspect(primary, { context: f.context })).checkoutId, first.checkoutId);
            equal(projects.checkout.inspect(linked, { context: f.context }).kind, "fresh");
            deepEqual(await snapshot(f.home), before);

            const [startingRoot, nextRoot] = firstEntry === "primary" ? [primary, linked] : [linked, primary];
            const starting = admitted(await projects.checkout.admit(startingRoot, { context: f.context }));
            equal(await readFile(join(primary, ".git", "runwield-checkout-id"), "utf8"), `${first.checkoutId}\n`);
            const next = admitted(await projects.checkout.admit(nextRoot, { context: f.context }));
            const [adoptedPrimary, adoptedLinked] = firstEntry === "primary" ? [starting, next] : [next, starting];
            equal(adoptedPrimary.checkoutId, first.checkoutId);
            notEqual(adoptedLinked.checkoutId, first.checkoutId);
            for (const identity of [adoptedPrimary, adoptedLinked]) {
                equal(identity.projectId, first.projectId);
                equal(identity.repositoryId, first.repositoryId);
            }
            await assertStoredBinding(f.home, first, [primary, linked], [adoptedPrimary, adoptedLinked]);
        } finally {
            await f.close();
        }
    });
}

test("modified and unrelated sibling markers cannot select the primary identity", async () => {
    const f = await environment();
    try {
        const { primary, linked, first } = await linkedNonGitProject(f.home, f.context, "crlf");
        await git(primary, ["rm", ".wld-project.json"]);
        await git(primary, ["commit", "-m", "Stop tracking the marker"]);
        const markerPath = join(linked, ".wld-project.json");
        const committedMarker = await readFile(markerPath, "utf8");
        await writeFile(markerPath, ` ${committedMarker}`);
        const beforeModified = await snapshot(f.home);
        equal(projects.checkout.inspect(primary, { context: f.context }).kind, "fresh");
        equal(projects.checkout.inspect(linked, { context: f.context }).kind, "invalid");
        deepEqual(await snapshot(f.home), beforeModified);

        const unrelated = join(f.home, "unrelated");
        await mkdir(unrelated);
        const other = admitted(await projects.checkout.admit(unrelated, { context: f.context }));
        await writeFile(markerPath, await readFile(join(unrelated, ".wld-project.json"), "utf8"));
        await git(linked, ["add", ".wld-project.json"]);
        await git(linked, ["commit", "-m", "Track an unrelated marker"]);

        const before = await snapshot(f.home);
        equal(projects.checkout.inspect(primary, { context: f.context }).kind, "fresh");
        equal(projects.checkout.inspect(linked, { context: f.context }).kind, "invalid");
        equal((await projects.checkout.admit(linked, { context: f.context })).kind, "invalid");
        deepEqual(await snapshot(f.home), before);
        await assertStoredBinding(f.home, first, [primary]);
        await assertStoredBinding(f.home, other, [unrelated]);
    } finally {
        await f.close();
    }
});

test("a staged sibling marker absent from HEAD cannot select the primary identity", async () => {
    const f = await environment();
    try {
        const { primary, linked, first } = await linkedNonGitProject(f.home, f.context);
        const markerPath = join(linked, ".wld-project.json");
        const marker = await readFile(markerPath);
        for (const root of [primary, linked]) {
            await git(root, ["rm", ".wld-project.json"]);
            await git(root, ["commit", "-m", "Stop tracking the marker"]);
        }
        await writeFile(markerPath, marker);
        await git(linked, ["add", ".wld-project.json"]);
        equal(await git(linked, ["ls-tree", "HEAD", "--", ".wld-project.json"]), "");
        equal(await git(linked, ["diff", "--cached", "--name-only"]), ".wld-project.json");

        const before = await snapshot(f.home);
        equal(projects.checkout.inspect(primary, { context: f.context }).kind, "fresh");
        equal(projects.checkout.inspect(linked, { context: f.context }).kind, "invalid");
        equal((await projects.checkout.admit(linked, { context: f.context })).kind, "invalid");
        deepEqual(await snapshot(f.home), before);
        await assertStoredBinding(f.home, first, [primary]);
    } finally {
        await f.close();
    }
});

test("inspect and admit preserve a legacy linked checkout that claimed the original primary binding", async () => {
    const f = await environment();
    try {
        const { primary, linked, first, linkedBinding } = await linkedNonGitProject(f.home, f.context);
        await assertStoredBinding(f.home, first, [primary]);
        await git(primary, ["config", "runwield.projectId", first.projectId]);
        await git(primary, ["config", "runwield.repositoryId", first.repositoryId]);
        await writeFile(linkedBinding, `${first.checkoutId}\n`);
        await rm(join(linked, ".wld-project.json"));
        const recordPath = join(f.home, ".wld", "projects", first.projectId, "project.wld.json");

        for (const state of ["primary-marker", "original-registry", "moved-registry"]) {
            if (state === "original-registry") {
                await git(primary, ["rm", ".wld-project.json"]);
                await git(primary, ["commit", "-m", "Stop tracking the marker"]);
            }
            if (state === "moved-registry") {
                const record = JSON.parse(await readFile(recordPath, "utf8"));
                const binding = record.repositories[0].checkouts[0];
                binding.historicalRoots = [binding.root];
                binding.root = await realpath(linked);
                await writeFile(recordPath, `${JSON.stringify(record)}\n`);
            }
            const before = await snapshot(f.home);
            for (const root of [primary, linked]) {
                for (const result of [
                    projects.checkout.inspect(root, { context: f.context }),
                    await projects.checkout.admit(root, { context: f.context }),
                ]) {
                    equal(result.kind, "invalid");
                    if (result.kind !== "invalid") throw new Error("Duplicate checkout binding was accepted");
                    match(result.message, /shares the primary Git checkout ID/);
                }
            }
            deepEqual(await snapshot(f.home), before);
        }
    } finally {
        await f.close();
    }
});

test("conflicting Git identity preserves a valid non-Git marker", async () => {
    const f = await environment();
    const directory = join(f.home, "plain");
    try {
        await mkdir(directory);
        admitted(await projects.checkout.admit(directory, { context: f.context }));
        const marker = await readFile(join(directory, ".wld-project.json"), "utf8");
        await git(directory, ["init"]);
        const different = randomUUID();
        await git(directory, ["config", "runwield.projectId", different]);
        equal((await projects.checkout.admit(directory, { context: f.context })).kind, "invalid");
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
        equal((await projects.checkout.admit(f.root, { context: f.context })).kind, "invalid");
        ok((await lstat(join(f.root, ".wld-project.json"))).isSymbolicLink());
        equal(await readFile(target, "utf8"), "user bytes");
    } finally {
        await f.close();
    }
});

test("committed Git identity repairs missing home metadata without minting replacement IDs", async () => {
    const f = await environment();
    try {
        const first = admitted(await projects.checkout.admit(f.root, { context: f.context }));
        await rm(join(f.home, ".wld"), { recursive: true });
        deepEqual(admitted(await projects.checkout.admit(f.root, { context: f.context })), first);
        await assertStoredBinding(f.home, first, [f.root]);
        deepEqual(await readdir(join(f.home, ".wld", "projects")), [first.projectId]);
    } finally {
        await f.close();
    }
});

test("corrupt home metadata cannot replace committed repository identity", async () => {
    const f = await environment();
    try {
        const first = admitted(await projects.checkout.admit(f.root, { context: f.context }));
        const record = join(f.home, ".wld", "projects", first.projectId, "project.wld.json");
        await writeFile(record, "broken");
        equal((await projects.checkout.admit(f.root, { context: f.context })).kind, "invalid");
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
        const result = admitted(await projects.checkout.admit(f.root, { context }));
        equal(result.personalOwner.identity, "laptop-owner");
        equal(result.executionAccountHome, f.home);
        deepEqual(await readdir(f.home), []);
    } finally {
        await f.close();
    }
});

for (const key of ["runwield.projectId", "runwield.repositoryId"]) {
    test(`duplicate ${key} values refuse admission without changing identity evidence`, async () => {
        const f = await environment();
        try {
            const first = admitted(await projects.checkout.admit(f.root, { context: f.context }));
            const value = key === "runwield.projectId" ? first.projectId : first.repositoryId;
            await git(f.root, ["config", "--add", key, value]);
            const before = [...(await snapshot(f.home)), ...(await snapshot(f.root))];
            equal(projects.checkout.inspect(f.root, { context: f.context }).kind, "invalid");
            equal((await projects.checkout.admit(f.root, { context: f.context })).kind, "invalid");
            deepEqual([...(await snapshot(f.home)), ...(await snapshot(f.root))], before);
        } finally {
            await f.close();
        }
    });
}

test(
    "identity admission preserves Git directory paths containing a newline",
    { skip: process.platform === "win32" ? "Windows filenames cannot contain newlines" : false },
    async () => {
        const f = await environment();
        const moved = `${f.root}-line\nbreak`;
        try {
            const first = admitted(await projects.checkout.admit(f.root, { context: f.context }));
            await rename(f.root, moved);
            const next = admitted(await projects.checkout.admit(moved, { context: f.context }));
            equal(next.projectId, first.projectId);
            equal(next.checkoutId, first.checkoutId);
            equal(next.checkoutRoot, await realpath(moved));
        } finally {
            await rm(moved, { recursive: true, force: true });
            await f.close();
        }
    },
);

interface IdentityGitTraceEvent {
    event: string;
    argv?: string[];
}

test("identity config parsing is reused only while its exact file contents remain unchanged", async () => {
    await withProcessGlobalTestLock(async () => {
        const f = await environment();
        const previousTrace = process.env.GIT_TRACE2_EVENT;
        try {
            admitted(await projects.checkout.admit(f.root, { context: f.context }));
            const trace = join(f.home, "identity-git-trace.jsonl");
            await writeFile(trace, "");
            process.env.GIT_TRACE2_EVENT = trace;
            const configQueries = async () => {
                const events: IdentityGitTraceEvent[] = (await readFile(trace, "utf8"))
                    .split("\n")
                    .filter(Boolean)
                    .map((line) => JSON.parse(line));
                return events.filter((event) => event.event === "start" && event.argv?.includes("--get-regexp")).length;
            };
            equal(projects.checkout.inspect(f.root, { context: f.context }).kind, "existing");
            const first = await configQueries();
            for (let index = 0; index < 3; index++)
                equal(projects.checkout.inspect(f.root, { context: f.context }).kind, "existing");
            equal(await configQueries(), first, "unchanged config must not launch duplicate Git parsers");
            const movedHome = join(f.home, "another-account");
            const changedContext: ProjectLaunchContext = {
                executionAccountHome: movedHome,
                personalOwner: { kind: "execution-account", identity: movedHome },
            };
            const currentOwner = projects.checkout.inspect(f.root, { context: changedContext });
            ok(currentOwner.kind === "existing");
            equal(currentOwner.identity.executionAccountHome, movedHome);
            deepEqual(currentOwner.identity.personalOwner, changedContext.personalOwner);
            const managedOwner: ProjectLaunchContext = {
                executionAccountHome: f.home,
                personalOwner: { kind: "managed-remote", identity: "another-owner" },
            };
            const managed = projects.checkout.inspect(f.root, { context: managedOwner });
            ok(managed.kind === "existing");
            deepEqual(managed.identity.personalOwner, managedOwner.personalOwner);
            await git(f.root, ["config", "--add", "runwield.projectId", randomUUID()]);
            equal(projects.checkout.inspect(f.root, { context: f.context }).kind, "invalid");
            ok((await configQueries()) > first, "changed identity must be re-parsed and rejected");
        } finally {
            if (previousTrace === undefined) delete process.env.GIT_TRACE2_EVENT;
            else process.env.GIT_TRACE2_EVENT = previousTrace;
            await f.close();
        }
    });
});
