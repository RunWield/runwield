import { test } from "node:test";
import { ok as assert } from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineGitFixture, git } from "../src/shared/git-test-fixture.ts";
import { assertEquals, assertStringIncludes } from "../src/testing/assertions.ts";
import { bashFixtureExecutable } from "./bash-fixture.ts";
import { captureScriptProcess } from "./script-process.ts";

const script = resolve(dirname(fileURLToPath(import.meta.url)), "integrate-release-branch.sh");
const tag = "v2.0.0";
const branch = `release/${tag}`;
const decoder = new TextDecoder();

const repository = defineGitFixture(async (work) => {
    await writeFile(join(work, "shared.txt"), "base\n");
    await git(work, ["add", "."]);
    await git(work, ["commit", "-m", "Base"]);
    await git(work, ["switch", "-c", branch]);
    await writeFile(join(work, "shared.txt"), "release\n");
    await writeFile(join(work, "release-fix.txt"), "qualified release fix\n");
    await git(work, ["add", "."]);
    await git(work, ["commit", "-m", "Release fix"]);
    await git(work, ["tag", tag]);
    // Integration must preserve the branch tip, including fixes after the tag.
    await writeFile(join(work, "after-tag.txt"), "later release fix\n");
    await git(work, ["add", "."]);
    await git(work, ["commit", "-m", "Release fix after tag"]);
    await git(work, ["switch", "main"]);
    await writeFile(join(work, "main-feature.txt"), "unreleased main feature\n");
    await git(work, ["add", "."]);
    await git(work, ["commit", "-m", "Main work"]);
});

async function fixture() {
    const work = await repository.checkout();
    const root = await mkdtemp(join(tmpdir(), "runwield-release-integration-"));
    const remote = join(root, "origin.git");
    await git(root, ["clone", "--bare", work, remote]);
    await git(work, ["remote", "add", "origin", remote]);
    const main = await git(remote, ["rev-parse", "refs/heads/main"]);
    const tip = await git(remote, ["rev-parse", `refs/heads/${branch}`]);
    return { work, root, remote, main, tip };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function integrate(f: Fixture, requestedTag = tag) {
    return await captureScriptProcess(bashFixtureExecutable(), {
        args: [script, requestedTag],
        cwd: f.work,
        stdout: "piped",
        stderr: "piped",
    });
}

async function cleanup(f: Fixture): Promise<void> {
    await rm(f.work, { recursive: true, force: true });
    await rm(f.root, { recursive: true, force: true });
}

async function hook(f: Fixture, name: string, content: string): Promise<void> {
    const path = join(f.remote, "hooks", name);
    await writeFile(path, `#!/usr/bin/env bash\nset -euo pipefail\n${content}\n`);
    await chmod(path, 0o755);
}

async function assertRetained(f: Fixture, expectedMain = f.main): Promise<void> {
    assertEquals(await git(f.remote, ["rev-parse", "refs/heads/main"]), expectedMain);
    assertEquals(await git(f.remote, ["rev-parse", `refs/heads/${branch}`]), f.tip);
}

test("Stable integration merges the entire Release Branch into remote main before retiring it", async () => {
    const f = await fixture();
    try {
        const result = await integrate(f);
        assert(result.success, decoder.decode(result.stderr));
        const main = await git(f.remote, ["rev-parse", "refs/heads/main"]);
        assertEquals(await git(f.remote, ["show", "-s", "--format=%P", main]), `${f.main} ${f.tip}`);
        await git(f.remote, ["merge-base", "--is-ancestor", f.tip, "refs/heads/main"]);
        assertEquals(await git(f.remote, ["show", "main:after-tag.txt"]), "later release fix");
        assertEquals(await git(f.remote, ["show", "main:main-feature.txt"]), "unreleased main feature");
        assertEquals(await git(f.work, ["ls-remote", "--heads", "origin", `refs/heads/${branch}`]), "");
        const retry = await integrate(f);
        assert(retry.success, decoder.decode(retry.stderr));
        assertEquals(await git(f.remote, ["rev-parse", "main"]), main);
    } finally {
        await cleanup(f);
    }
});

test("an already integrated Release Branch is retired without a redundant main commit", async () => {
    const f = await fixture();
    try {
        await git(f.work, ["merge", "--no-ff", branch, "-m", "Already integrated"]);
        await git(f.work, ["push", "origin", "HEAD:main"]);
        const main = await git(f.remote, ["rev-parse", "main"]);
        const result = await integrate(f);
        assert(result.success, decoder.decode(result.stderr));
        assertEquals(await git(f.remote, ["rev-parse", "main"]), main);
        assertEquals(await git(f.work, ["ls-remote", "--heads", "origin", `refs/heads/${branch}`]), "");
    } finally {
        await cleanup(f);
    }
});

test("a merge conflict leaves remote main and the Release Branch unchanged with manual recovery steps", async () => {
    const f = await fixture();
    try {
        await writeFile(join(f.work, "shared.txt"), "conflicting main\n");
        await git(f.work, ["add", "."]);
        await git(f.work, ["commit", "-m", "Conflicting main work"]);
        await git(f.work, ["push", "origin", "HEAD:main"]);
        const main = await git(f.remote, ["rev-parse", "main"]);
        const result = await integrate(f);
        assertEquals(result.success, false);
        await assertRetained(f, main);
        assertStringIncludes(decoder.decode(result.stderr), "resolve the merge manually");
        assertStringIncludes(
            decoder.decode(result.stderr),
            `git merge-base --is-ancestor origin/${branch} origin/main`,
        );
    } finally {
        await cleanup(f);
    }
});

test("a missing Release Branch skips integration without changing remote main", async () => {
    const f = await fixture();
    try {
        await git(f.remote, ["update-ref", "-d", `refs/heads/${branch}`]);
        const refs = await git(f.remote, ["show-ref"]);
        const result = await integrate(f);
        assert(result.success, decoder.decode(result.stderr));
        assertStringIncludes(decoder.decode(result.stdout), `No remote ${branch}; skipping integration.`);
        assertEquals(await git(f.remote, ["show-ref"]), refs);
    } finally {
        await cleanup(f);
    }
});

test("a rejected main push cannot retire the Release Branch", async () => {
    const f = await fixture();
    try {
        await hook(
            f,
            "pre-receive",
            `while read -r old new ref; do
  if [[ "$ref" == refs/heads/main ]]; then echo "main push rejected" >&2; exit 1; fi
done`,
        );
        const result = await integrate(f);
        assertEquals(result.success, false);
        await assertRetained(f);
        assertStringIncludes(decoder.decode(result.stderr), "main push rejected");
        assertStringIncludes(decoder.decode(result.stderr), "resolve the merge manually");
    } finally {
        await cleanup(f);
    }
});

test("retirement requires ancestry proof from freshly fetched remote main, not the local merge", async () => {
    const f = await fixture();
    try {
        // Model a remote administrator restoring main after accepting the push.
        // Keep automatic push tracking separate from the script's explicit fetch
        // destination. Otherwise the rewind fails at fetch, masking a missing
        // ancestry check. The final fetch must succeed and the proof must fail.
        await git(f.work, ["config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/push-tracking/*"]);
        await hook(
            f,
            "post-receive",
            `while read -r old new ref; do
  if [[ "$ref" == refs/heads/main ]]; then
    git update-ref refs/heads/main "$old" "$new"
    echo "$new" > hooks/accepted-main
  fi
done`,
        );
        const result = await integrate(f);
        assertEquals(result.success, false);
        const accepted = (await readFile(join(f.remote, "hooks/accepted-main"), "utf8")).trim();
        await git(f.remote, ["merge-base", "--is-ancestor", f.tip, accepted]);
        await assertRetained(f);
        assertStringIncludes(decoder.decode(result.stderr), "resolve the merge manually");
    } finally {
        await cleanup(f);
    }
});

test("a Release Branch fix that arrives during integration cannot be deleted", async () => {
    const f = await fixture();
    try {
        await git(f.work, ["switch", branch]);
        await writeFile(join(f.work, "arriving-fix.txt"), "keep this release fix\n");
        await git(f.work, ["add", "."]);
        await git(f.work, ["commit", "-m", "Arriving fix"]);
        const arriving = await git(f.work, ["rev-parse", "HEAD"]);
        await git(f.work, ["push", "origin", `${arriving}:refs/heads/arriving-fix`]);
        await hook(
            f,
            "post-receive",
            `while read -r old new ref; do
  if [[ "$ref" == refs/heads/main ]]; then
    git update-ref refs/heads/${branch} ${arriving}
  fi
done`,
        );
        const result = await integrate(f);
        assertEquals(result.success, false);
        await git(f.remote, ["merge-base", "--is-ancestor", f.tip, "main"]);
        assertEquals(await git(f.remote, ["rev-parse", `refs/heads/${branch}`]), arriving);
    } finally {
        await cleanup(f);
    }
});

for (const requestedTag of ["v2.0.0-rc.1", "not-a-tag"]) {
    test(`integration rejects non-Stable tag ${requestedTag} without changing remote refs`, async () => {
        const f = await fixture();
        try {
            const refs = await git(f.remote, ["show-ref"]);
            const result = await integrate(f, requestedTag);
            assertEquals(result.success, false);
            assertStringIncludes(decoder.decode(result.stderr), "Expected a Stable tag");
            assertEquals(await git(f.remote, ["show-ref"]), refs);
        } finally {
            await cleanup(f);
        }
    });
}
