import { captureScriptProcess } from "./script-process.ts";
import {
    chmod as fsChmod,
    mkdtemp as fsMkdtemp,
    readFile as fsReadFile,
    rename as fsRename,
    rm as fsRm,
    writeFile as fsWriteFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { assertEquals, assertRejects, assertStringIncludes, assertThrows } from "../src/testing/assertions.ts";
import { defineCommittedGitFixture } from "../src/shared/git-test-fixture.ts";

import {
    createCandidate,
    createStable,
    expectedReleaseAssetNames,
    nextCandidateTag,
    parseReleaseArgs,
    parseReleaseTag,
    previousStableTag,
    promoteCandidate,
    releaseMetadataForTag,
    resolveRemoteTagCommit,
    stableTagForCandidate,
} from "./release.js";

test("parseReleaseTag accepts WLD stable and candidate tags", () => {
    assertEquals(parseReleaseTag("v1.2.3"), {
        tag: "v1.2.3",
        major: 1,
        minor: 2,
        patch: 3,
        rc: undefined,
        kind: "stable",
        stableTag: "v1.2.3",
    });
    assertEquals(parseReleaseTag("v1.2.3-rc.10").rc, 10);
    assertEquals(stableTagForCandidate("v1.2.3-rc.1"), "v1.2.3");
});

test("parseReleaseTag rejects unsafe or unsupported tags", () => {
    for (const tag of [
        "1.2.3",
        "v1.2.3-beta.1",
        "v1.2.3-rc.0",
        "v01.2.3",
        "v1.02.3",
        "v1.2.03",
        "v1.2.3-rc.01",
        "v1.2.3/bad",
        "v1.2.3\n",
    ]) {
        assertThrows(() => parseReleaseTag(tag), Error);
    }
});

test("candidate progression and previous stable ignore Candidate tags", () => {
    const tags = ["v0.8.9", "v0.8.10", "v0.8.11-rc.1", "v0.8.11-rc.10", "v0.8.11"];
    assertEquals(previousStableTag(tags), "v0.8.11");
    assertEquals(nextCandidateTag(tags), "v0.8.12-rc.1");
});

test("releaseMetadataForTag emits GitHub channel metadata", () => {
    assertEquals(releaseMetadataForTag("v1.2.3-rc.1"), {
        tag: "v1.2.3-rc.1",
        kind: "candidate",
        buildVersion: "v1.2.3-rc.1",
        prerelease: true,
        makeLatest: false,
    });
    assertEquals(releaseMetadataForTag("v1.2.3"), {
        tag: "v1.2.3",
        kind: "stable",
        buildVersion: "v1.2.3",
        prerelease: false,
        makeLatest: true,
    });
});

test("expectedReleaseAssetNames covers all WLD release assets", () => {
    const names = expectedReleaseAssetNames("v1.2.3-rc.1");
    assertEquals(names.includes("wld-v1.2.3-rc.1-linux-x64.tar.gz"), true);
    assertEquals(names.includes("wld-v1.2.3-rc.1-windows-x64.tar.zst.sha256"), true);
    assertEquals(names.includes("SHA256SUMS"), true);
    assertEquals(names.includes("config.schema.json"), true);
});

test("parseReleaseArgs keeps command contracts explicit", () => {
    assertEquals(parseReleaseArgs(["candidate", "--tag", "v1.2.3-rc.1", "--dry-run"]), {
        command: "candidate",
        tag: "v1.2.3-rc.1",
        dryRun: true,
    });
    assertEquals(parseReleaseArgs(["promote", "--candidate", "v1.2.3-rc.1"]), {
        command: "promote",
        candidate: "v1.2.3-rc.1",
        dryRun: false,
    });
});

/**
 * @param {Record<string, { success?: boolean, code?: number, stdout?: string, stderr?: string }>} responses
 */
function depsForCommands(responses) {
    /** @type {Array<{ command: string, args: string[] }>} */
    const calls = [];
    /** @type {string[]} */
    const logs = [];
    const deps = {
        /** @param {string} message */
        log(message) {
            logs.push(message);
        },
        makeTempDir: () => Promise.resolve("/tmp/wld-release-test"),
        remove: () => Promise.resolve(),
        /**
         * @param {string} command
         * @param {string[]} args
         */
        run(command, args) {
            calls.push({ command, args });
            const key = `${command} ${args.join(" ")}`;
            const defaultResponse = (() => {
                if (command === "git" && args.join(" ") === "fetch origin main") return { stdout: "" };
                if (command === "git" && args.join(" ") === "rev-parse origin/main") {
                    return responses["git rev-parse @{u}"] || { stdout: "" };
                }
                if (command === "gh" && args[0] === "release" && args[1] === "view" && args.includes("id")) {
                    return { success: false, code: 1, stderr: "release not found" };
                }
                return { success: true, code: 0, stdout: "", stderr: "" };
            })();
            const response = responses[key] || defaultResponse;
            return Promise.resolve({
                success: response.success ?? true,
                code: response.code ?? 0,
                stdout: response.stdout ?? "",
                stderr: response.stderr ?? "",
            });
        },
    };
    return { calls, deps, logs };
}

/**
 * @param {string} command
 * @param {string[]} args
 * @param {{ cwd?: string }} [options]
 */
async function runCommand(command, args, options = {}) {
    const output = await captureScriptProcess(command, { args, cwd: options.cwd, stdout: "piped", stderr: "piped" });
    const decoder = new TextDecoder();
    if (!output.success) {
        throw new Error(
            `${command} ${args.join(" ")} failed: ${decoder.decode(output.stderr) || decoder.decode(output.stdout)}`,
        );
    }
    return decoder.decode(output.stdout);
}

const releaseRepoFixture = defineCommittedGitFixture({ "file.txt": "initial\n" });

async function createReleaseRepo() {
    const root = await fsMkdtemp(join(tmpdir(), "wld-release-repo-"));
    const remote = `${root}/remote.git`;
    const repo = `${root}/repo`;
    const checkout = await releaseRepoFixture.checkout({ prefix: "wld-release-checkout-" });
    await fsRename(checkout, repo);
    await runCommand("git", ["init", "--bare", remote]);
    await runCommand("git", ["remote", "add", "origin", remote], { cwd: repo });
    await runCommand("git", ["push", "-u", "origin", "main"], { cwd: repo });
    return { root, repo, remote };
}

/** @param {string} repo */
function repoDeps(repo) {
    /** @type {Array<{ command: string, args: string[] }>} */
    const calls = [];
    /** @type {string[]} */
    const logs = [];
    return {
        calls,
        logs,
        deps: {
            /** @param {string} message */
            log(message) {
                logs.push(message);
            },
            error() {},
            /**
             * @param {string} command
             * @param {string[]} args
             * @param {{ cwd?: string, env?: Record<string, string> }} [options]
             */
            async run(command, args, options = {}) {
                calls.push({ command, args });
                if (command === "deno") throw new Error("Release tooling must not invoke Deno");
                if (command === "gh") {
                    const tag = args[2];
                    if (args.includes("id")) {
                        return { success: false, code: 1, stdout: "", stderr: "release not found" };
                    }
                    const assets = expectedReleaseAssetNames(tag).map((name) => ({ name }));
                    return {
                        success: true,
                        code: 0,
                        stdout: JSON.stringify({ isPrerelease: true, isDraft: false, assets }),
                        stderr: "",
                    };
                }
                const output = await captureScriptProcess(command, {
                    args,
                    cwd: options.cwd || repo,
                    env: options.env,
                    stdout: "piped",
                    stderr: "piped",
                });
                const decoder = new TextDecoder();
                return {
                    success: output.success,
                    code: output.code,
                    stdout: decoder.decode(output.stdout),
                    stderr: decoder.decode(output.stderr),
                };
            },
        },
    };
}

test("resolveRemoteTagCommit peels annotated remote tags to the source commit", async () => {
    const fixture = await createReleaseRepo();
    try {
        const sourceCommit = (await runCommand("git", ["rev-parse", "HEAD"], { cwd: fixture.repo })).trim();
        await runCommand("git", ["tag", "-a", "v1.2.3-rc.1", "-m", "candidate"], { cwd: fixture.repo });
        const tagObject = (await runCommand("git", ["rev-parse", "v1.2.3-rc.1"], { cwd: fixture.repo })).trim();
        await runCommand("git", ["push", "origin", "refs/tags/v1.2.3-rc.1"], { cwd: fixture.repo });
        const { deps } = repoDeps(fixture.repo);

        assertEquals(await resolveRemoteTagCommit(deps, "v1.2.3-rc.1"), sourceCommit);
        assertEquals(sourceCommit === tagObject, false);
    } finally {
        await fsRm(fixture.root, { recursive: true });
    }
});

test("createCandidate dry-run reports a new release branch without publication side effects", async () => {
    const { deps, calls, logs } = depsForCommands({
        "git branch --show-current": { stdout: "main\n" },
        "git status --porcelain": { stdout: "" },
        "git rev-parse HEAD": { stdout: "abc123\n" },
        "git rev-parse @{u}": { stdout: "abc123\n" },
        "git tag --list v*": { stdout: "v1.2.2\n" },
        "git ls-remote --tags origin refs/tags/v*": { stdout: "" },
        "git rev-parse v1.2.3-rc.1^{commit}": { success: false, code: 1 },
        "git ls-remote --tags origin refs/tags/v1.2.3-rc.1": { stdout: "" },
        "git rev-parse v1.2.3^{commit}": { success: false, code: 1 },
        "git ls-remote --tags origin refs/tags/v1.2.3": { stdout: "" },
    });

    await createCandidate(deps, "v1.2.3-rc.1", true);

    assertEquals(
        calls.some((call) => call.command === "git" && call.args.join(" ") === "rev-parse HEAD"),
        true,
    );
    assertEquals(
        logs.some((line) => line.includes("release/v1.2.3") && line.includes("abc123")),
        true,
    );
    assertEquals(
        logs.some((line) => line.includes("atomically push")),
        true,
    );
    assertEquals(
        calls.some((call) => call.command === "deno"),
        false,
    );
    assertEquals(
        calls.some((call) => call.command === "git" && call.args[0] === "tag" && call.args.includes("-a")),
        false,
    );
    assertEquals(
        calls.some((call) => call.command === "git" && call.args[0] === "push"),
        false,
    );
    assertEquals(
        calls.some((call) => call.command === "gh" && call.args.includes("create")),
        false,
    );
    assertEquals(
        calls.some((call) => call.command === "gh" && call.args.includes("edit")),
        false,
    );
    assertEquals(
        calls.some((call) => call.command === "glab"),
        false,
    );
});

test("Candidate dry-run preserves real checkout files, index, and refs", async () => {
    const fixture = await createReleaseRepo();
    try {
        await runCommand("git", ["tag", "-a", "v1.2.2", "-m", "stable"], { cwd: fixture.repo });
        await runCommand("git", ["push", "origin", "refs/tags/v1.2.2"], { cwd: fixture.repo });
        await fsWriteFile(`${fixture.repo}/staged.txt`, "staged\n");
        await runCommand("git", ["add", "staged.txt"], { cwd: fixture.repo });
        await fsWriteFile(`${fixture.repo}/file.txt`, "unstaged\n");
        await fsWriteFile(`${fixture.repo}/untracked.txt`, "untracked\n");
        const beforeHead = await runCommand("git", ["rev-parse", "HEAD"], { cwd: fixture.repo });
        const beforeBranch = await runCommand("git", ["branch", "--show-current"], { cwd: fixture.repo });
        const beforeStatus = await runCommand("git", ["status", "--porcelain"], { cwd: fixture.repo });
        const beforeRefs = await runCommand("git", ["show-ref"], { cwd: fixture.repo });
        const { deps, logs } = repoDeps(fixture.repo);

        await createCandidate(deps, "v1.2.3-rc.1", true);

        assertEquals(await runCommand("git", ["rev-parse", "HEAD"], { cwd: fixture.repo }), beforeHead);
        assertEquals(await runCommand("git", ["branch", "--show-current"], { cwd: fixture.repo }), beforeBranch);
        assertEquals(await runCommand("git", ["status", "--porcelain"], { cwd: fixture.repo }), beforeStatus);
        assertEquals(await runCommand("git", ["show-ref"], { cwd: fixture.repo }), beforeRefs);
        assertEquals(await fsReadFile(`${fixture.repo}/file.txt`, "utf8"), "unstaged\n");
        assertEquals(await fsReadFile(`${fixture.repo}/untracked.txt`, "utf8"), "untracked\n");
        assertEquals(
            logs.some((line) => line.includes("release/v1.2.3")),
            true,
        );
    } finally {
        await fsRm(fixture.root, { recursive: true });
    }
});

test("later Candidate dry-run fetches remote source without moving local refs", async () => {
    const fixture = await createReleaseRepo();
    try {
        await runCommand("git", ["tag", "-a", "v1.2.2", "-m", "stable"], { cwd: fixture.repo });
        await runCommand("git", ["push", "origin", "refs/tags/v1.2.2"], { cwd: fixture.repo });
        const { deps } = repoDeps(fixture.repo);
        await createCandidate(deps, "v1.2.3-rc.1", false);

        const fixer = `${fixture.root}/dry-run-fixer`;
        await runCommand("git", ["clone", fixture.remote, fixer]);
        await runCommand("git", ["config", "user.email", "release-test@example.com"], { cwd: fixer });
        await runCommand("git", ["config", "user.name", "Release Test"], { cwd: fixer });
        await runCommand("git", ["checkout", "-b", "release/v1.2.3", "origin/release/v1.2.3"], { cwd: fixer });
        await fsWriteFile(`${fixer}/fix.txt`, "release fix\n");
        await runCommand("git", ["add", "fix.txt"], { cwd: fixer });
        await runCommand("git", ["commit", "-m", "release fix"], { cwd: fixer });
        await runCommand("git", ["push", "origin", "release/v1.2.3"], { cwd: fixer });
        const beforeRefs = await runCommand("git", ["show-ref"], { cwd: fixture.repo });
        const beforeStatus = await runCommand("git", ["status", "--porcelain"], { cwd: fixture.repo });

        await createCandidate(deps, "v1.2.3-rc.2", true);

        assertEquals(await runCommand("git", ["show-ref"], { cwd: fixture.repo }), beforeRefs);
        assertEquals(await runCommand("git", ["status", "--porcelain"], { cwd: fixture.repo }), beforeStatus);
        assertEquals(await runCommand("git", ["tag", "--list", "v1.2.3-rc.2"], { cwd: fixture.repo }), "");
    } finally {
        await fsRm(fixture.root, { recursive: true });
    }
});

test("createCandidate atomically publishes RC1 branch and tag without checkout checks", async () => {
    const { deps, calls } = depsForCommands({
        "git rev-parse HEAD": { stdout: "abc123\n" },
        "git tag --list v*": { stdout: "v1.2.2\n" },
        "git ls-remote --tags origin refs/tags/v*": { stdout: "" },
        "git rev-parse v1.2.3-rc.1^{commit}": { success: false, code: 1 },
        "git ls-remote --tags origin refs/tags/v1.2.3-rc.1": { stdout: "" },
        "git rev-parse v1.2.3^{commit}": { success: false, code: 1 },
        "git ls-remote --tags origin refs/tags/v1.2.3": { stdout: "" },
    });

    await createCandidate(deps, "v1.2.3-rc.1", false);

    const tagCall = calls.find((call) => call.command === "git" && call.args[0] === "tag" && call.args.includes("-a"));
    assertEquals(tagCall?.args.includes("abc123"), true);
    const pushCall = calls.find((call) => call.command === "git" && call.args[0] === "push");
    assertEquals(pushCall?.args.includes("--atomic"), true);
    assertEquals(pushCall?.args.includes("abc123:refs/heads/release/v1.2.3"), true);
    assertEquals(pushCall?.args.includes("refs/tags/v1.2.3-rc.1"), true);
    assertEquals(
        calls.some((call) => call.command === "deno"),
        false,
    );
    assertEquals(
        calls.some((call) => call.args[0] === "branch" || call.args[0] === "status"),
        false,
    );
});

test("createCandidate rejects duplicate GitHub release before creating a tag", async () => {
    const { deps, calls } = depsForCommands({
        "git branch --show-current": { stdout: "main\n" },
        "git status --porcelain": { stdout: "" },
        "git rev-parse HEAD": { stdout: "abc123\n" },
        "git rev-parse @{u}": { stdout: "abc123\n" },
        "git tag --list v*": { stdout: "v1.2.2\n" },
        "git ls-remote --tags origin refs/tags/v*": { stdout: "" },
        "git rev-parse v1.2.3-rc.1^{commit}": { success: false, code: 1 },
        "git ls-remote --tags origin refs/tags/v1.2.3-rc.1": { stdout: "" },
        "git rev-parse v1.2.3^{commit}": { success: false, code: 1 },
        "git ls-remote --tags origin refs/tags/v1.2.3": { stdout: "" },
        "gh release view v1.2.3-rc.1 --json id": { stdout: JSON.stringify({ id: "existing" }) },
    });

    await assertRejects(() => createCandidate(deps, "v1.2.3-rc.1", false), Error, "GitHub release already exists");

    assertEquals(
        calls.some((call) => call.command === "git" && call.args[0] === "tag" && call.args.includes("-a")),
        false,
    );
    assertEquals(
        calls.some((call) => call.command === "git" && call.args[0] === "push"),
        false,
    );
});

test("createCandidate accepts explicit minor and major Candidate selections newer than previous Stable", async () => {
    for (const candidate of ["v1.3.0-rc.1", "v2.0.0-rc.1"]) {
        const { deps } = depsForCommands({
            "git branch --show-current": { stdout: "main\n" },
            "git status --porcelain": { stdout: "" },
            "git rev-parse HEAD": { stdout: "abc123\n" },
            "git rev-parse @{u}": { stdout: "abc123\n" },
            "git tag --list v*": { stdout: "v1.2.3\n" },
            "git ls-remote --tags origin refs/tags/v*": { stdout: "" },
            [`git rev-parse ${candidate}^{commit}`]: { success: false, code: 1 },
            [`git ls-remote --tags origin refs/tags/${candidate}`]: { stdout: "" },
            [`git rev-parse ${stableTagForCandidate(candidate)}^{commit}`]: { success: false, code: 1 },
            [`git ls-remote --tags origin refs/tags/${stableTagForCandidate(candidate)}`]: { stdout: "" },
        });

        await createCandidate(deps, candidate, true);
    }
});

test("createCandidate enforces next RC ordinal from real local and remote tags", async () => {
    const fixture = await createReleaseRepo();
    try {
        await runCommand("git", ["tag", "-a", "v1.2.2", "-m", "stable"], { cwd: fixture.repo });
        await runCommand("git", ["tag", "-a", "v1.2.3-rc.1", "-m", "candidate"], { cwd: fixture.repo });
        await runCommand("git", ["push", "origin", "refs/tags/v1.2.2", "refs/tags/v1.2.3-rc.1"], { cwd: fixture.repo });
        const { deps } = repoDeps(fixture.repo);
        await assertRejects(() => createCandidate(deps, "v1.2.3-rc.3", true), Error, "v1.2.3-rc.2");
    } finally {
        await fsRm(fixture.root, { recursive: true });
    }
});

test("later Candidates include pushed release fixes and exclude new main features", async () => {
    const fixture = await createReleaseRepo();
    try {
        await runCommand("git", ["tag", "-a", "v1.2.2", "-m", "stable"], { cwd: fixture.repo });
        await runCommand("git", ["push", "origin", "refs/tags/v1.2.2"], { cwd: fixture.repo });
        const { deps, logs } = repoDeps(fixture.repo);

        await createCandidate(deps, "v1.2.3-rc.1", false);
        const initialCommit = (await runCommand("git", ["rev-parse", "HEAD"], { cwd: fixture.repo })).trim();
        assertEquals(
            (
                await runCommand("git", ["ls-remote", "origin", "refs/heads/release/v1.2.3"], {
                    cwd: fixture.repo,
                })
            ).startsWith(initialCommit),
            true,
        );

        const fixer = `${fixture.root}/fixer`;
        await runCommand("git", ["clone", fixture.remote, fixer]);
        await runCommand("git", ["config", "user.email", "release-test@example.com"], { cwd: fixer });
        await runCommand("git", ["config", "user.name", "Release Test"], { cwd: fixer });
        await runCommand("git", ["checkout", "-b", "release/v1.2.3", "origin/release/v1.2.3"], { cwd: fixer });
        await fsWriteFile(`${fixer}/fix.txt`, "release fix\n");
        await runCommand("git", ["add", "fix.txt"], { cwd: fixer });
        await runCommand("git", ["commit", "-m", "release fix"], { cwd: fixer });
        await runCommand("git", ["push", "origin", "release/v1.2.3"], { cwd: fixer });
        const fixCommit = (await runCommand("git", ["rev-parse", "HEAD"], { cwd: fixer })).trim();

        await fsWriteFile(`${fixture.repo}/feature.txt`, "new feature\n");
        await runCommand("git", ["add", "feature.txt"], { cwd: fixture.repo });
        await runCommand("git", ["commit", "-m", "new feature"], { cwd: fixture.repo });
        await runCommand("git", ["push", "origin", "main"], { cwd: fixture.repo });
        await fsWriteFile(`${fixture.repo}/staged.txt`, "staged\n");
        await runCommand("git", ["add", "staged.txt"], { cwd: fixture.repo });
        await fsWriteFile(`${fixture.repo}/file.txt`, "unstaged\n");
        await fsWriteFile(`${fixture.repo}/untracked.txt`, "untracked\n");
        const beforeHead = (await runCommand("git", ["rev-parse", "HEAD"], { cwd: fixture.repo })).trim();
        const beforeStatus = await runCommand("git", ["status", "--porcelain"], { cwd: fixture.repo });

        await createCandidate(deps, "v1.2.3-rc.2", false);

        const candidateCommit = (
            await runCommand("git", ["rev-parse", "v1.2.3-rc.2^{commit}"], {
                cwd: fixture.repo,
            })
        ).trim();
        const candidateFiles = await runCommand("git", ["ls-tree", "--name-only", "v1.2.3-rc.2^{commit}"], {
            cwd: fixture.repo,
        });
        assertEquals(candidateCommit, fixCommit);
        assertStringIncludes(candidateFiles, "fix.txt");
        assertEquals(candidateFiles.includes("feature.txt"), false);
        assertEquals(await runCommand("git", ["branch", "--show-current"], { cwd: fixture.repo }), "main\n");
        assertEquals((await runCommand("git", ["rev-parse", "HEAD"], { cwd: fixture.repo })).trim(), beforeHead);
        assertEquals(await runCommand("git", ["status", "--porcelain"], { cwd: fixture.repo }), beforeStatus);
        assertEquals(
            logs.some((line) => line.includes("release/v1.2.3") && line.includes(fixCommit)),
            true,
        );

        await runCommand("git", ["push", "origin", "--delete", "v1.2.3-rc.2"], { cwd: fixture.repo });
        await runCommand("git", ["tag", "--delete", "v1.2.3-rc.2"], { cwd: fixture.repo });
        await fsWriteFile(`${fixer}/fix-two.txt`, "second release fix\n");
        await runCommand("git", ["add", "fix-two.txt"], { cwd: fixer });
        await runCommand("git", ["commit", "-m", "second release fix"], { cwd: fixer });
        await runCommand("git", ["push", "origin", "release/v1.2.3"], { cwd: fixer });
        const secondFixCommit = (await runCommand("git", ["rev-parse", "HEAD"], { cwd: fixer })).trim();

        await createCandidate(deps, "v1.2.3-rc.2", false);

        assertEquals(
            (await runCommand("git", ["rev-parse", "v1.2.3-rc.2^{commit}"], { cwd: fixture.repo })).trim(),
            secondFixCommit,
        );
        assertEquals(await runCommand("git", ["status", "--porcelain"], { cwd: fixture.repo }), beforeStatus);
    } finally {
        await fsRm(fixture.root, { recursive: true });
    }
});

test("later Candidate ignores unpushed commits on a local Release Branch", async () => {
    const fixture = await createReleaseRepo();
    try {
        await runCommand("git", ["tag", "-a", "v1.2.2", "-m", "stable"], { cwd: fixture.repo });
        await runCommand("git", ["push", "origin", "refs/tags/v1.2.2"], { cwd: fixture.repo });
        const { deps } = repoDeps(fixture.repo);
        await createCandidate(deps, "v1.2.3-rc.1", false);
        await runCommand("git", ["switch", "--create", "release/v1.2.3", "v1.2.3-rc.1"], {
            cwd: fixture.repo,
        });
        await fsWriteFile(`${fixture.repo}/local-only.txt`, "unpushed local work\n");
        await runCommand("git", ["add", "local-only.txt"], { cwd: fixture.repo });
        await runCommand("git", ["commit", "-m", "unpushed local work"], { cwd: fixture.repo });
        const localCommit = (await runCommand("git", ["rev-parse", "HEAD"], { cwd: fixture.repo })).trim();

        const fixer = `${fixture.root}/remote-fixer`;
        await runCommand("git", ["clone", fixture.remote, fixer]);
        await runCommand("git", ["config", "user.email", "release-test@example.com"], { cwd: fixer });
        await runCommand("git", ["config", "user.name", "Release Test"], { cwd: fixer });
        await runCommand("git", ["checkout", "-b", "release/v1.2.3", "origin/release/v1.2.3"], { cwd: fixer });
        await fsWriteFile(`${fixer}/remote-fix.txt`, "pushed fix\n");
        await runCommand("git", ["add", "remote-fix.txt"], { cwd: fixer });
        await runCommand("git", ["commit", "-m", "pushed fix"], { cwd: fixer });
        await runCommand("git", ["push", "origin", "release/v1.2.3"], { cwd: fixer });
        const remoteCommit = (await runCommand("git", ["rev-parse", "HEAD"], { cwd: fixer })).trim();

        await createCandidate(deps, "v1.2.3-rc.2", false);

        assertEquals(
            (await runCommand("git", ["rev-parse", "v1.2.3-rc.2^{commit}"], { cwd: fixture.repo })).trim(),
            remoteCommit,
        );
        assertEquals(await runCommand("git", ["branch", "--show-current"], { cwd: fixture.repo }), "release/v1.2.3\n");
        assertEquals((await runCommand("git", ["rev-parse", "HEAD"], { cwd: fixture.repo })).trim(), localCommit);
        assertEquals(localCommit === remoteCommit, false);
    } finally {
        await fsRm(fixture.root, { recursive: true });
    }
});

test("RC1 retry uses an existing pushed release branch instead of HEAD", async () => {
    const fixture = await createReleaseRepo();
    try {
        await runCommand("git", ["tag", "-a", "v1.2.2", "-m", "stable"], { cwd: fixture.repo });
        await runCommand("git", ["push", "origin", "refs/tags/v1.2.2"], { cwd: fixture.repo });
        const branchCommit = (await runCommand("git", ["rev-parse", "HEAD"], { cwd: fixture.repo })).trim();
        await runCommand("git", ["push", "origin", `${branchCommit}:refs/heads/release/v1.2.3`], {
            cwd: fixture.repo,
        });
        await fsWriteFile(`${fixture.repo}/feature.txt`, "new feature\n");
        await runCommand("git", ["add", "feature.txt"], { cwd: fixture.repo });
        await runCommand("git", ["commit", "-m", "new feature"], { cwd: fixture.repo });
        const headCommit = (await runCommand("git", ["rev-parse", "HEAD"], { cwd: fixture.repo })).trim();
        const { deps } = repoDeps(fixture.repo);

        await createCandidate(deps, "v1.2.3-rc.1", false);

        assertEquals(
            (await runCommand("git", ["rev-parse", "v1.2.3-rc.1^{commit}"], { cwd: fixture.repo })).trim(),
            branchCommit,
        );
        assertEquals(branchCommit === headCommit, false);
    } finally {
        await fsRm(fixture.root, { recursive: true });
    }
});

test("later Candidate refuses a missing release branch", async () => {
    const fixture = await createReleaseRepo();
    try {
        await runCommand("git", ["tag", "-a", "v1.2.2", "-m", "stable"], { cwd: fixture.repo });
        await runCommand("git", ["tag", "-a", "v1.2.3-rc.1", "-m", "candidate"], { cwd: fixture.repo });
        await runCommand("git", ["push", "origin", "refs/tags/v1.2.2", "refs/tags/v1.2.3-rc.1"], {
            cwd: fixture.repo,
        });
        const { deps } = repoDeps(fixture.repo);

        await assertRejects(
            () => createCandidate(deps, "v1.2.3-rc.2", true),
            Error,
            "Remote release branch does not exist",
        );
    } finally {
        await fsRm(fixture.root, { recursive: true });
    }
});

test("later Candidate refuses a missing remote predecessor tag", async () => {
    const fixture = await createReleaseRepo();
    try {
        await runCommand("git", ["tag", "-a", "v1.2.2", "-m", "stable"], { cwd: fixture.repo });
        await runCommand("git", ["tag", "-a", "v1.2.3-rc.1", "-m", "local candidate"], { cwd: fixture.repo });
        await runCommand("git", ["push", "origin", "refs/tags/v1.2.2", "HEAD:refs/heads/release/v1.2.3"], {
            cwd: fixture.repo,
        });
        const { deps } = repoDeps(fixture.repo);

        await assertRejects(
            () => createCandidate(deps, "v1.2.3-rc.2", true),
            Error,
            "Previous Candidate tag does not exist on origin",
        );
    } finally {
        await fsRm(fixture.root, { recursive: true });
    }
});

test("later Candidate refuses a release branch unrelated to the previous Candidate", async () => {
    const fixture = await createReleaseRepo();
    try {
        await runCommand("git", ["tag", "-a", "v1.2.2", "-m", "stable"], { cwd: fixture.repo });
        await runCommand("git", ["tag", "-a", "v1.2.3-rc.1", "-m", "candidate"], { cwd: fixture.repo });
        await runCommand("git", ["push", "origin", "refs/tags/v1.2.2", "refs/tags/v1.2.3-rc.1"], {
            cwd: fixture.repo,
        });
        const unrelated = `${fixture.root}/unrelated`;
        await runCommand("git", ["clone", fixture.remote, unrelated]);
        await runCommand("git", ["config", "user.email", "release-test@example.com"], { cwd: unrelated });
        await runCommand("git", ["config", "user.name", "Release Test"], { cwd: unrelated });
        await runCommand("git", ["checkout", "--orphan", "release-source"], { cwd: unrelated });
        await fsWriteFile(`${unrelated}/unrelated.txt`, "unrelated\n");
        await runCommand("git", ["add", "unrelated.txt"], { cwd: unrelated });
        await runCommand("git", ["commit", "-m", "unrelated"], { cwd: unrelated });
        await runCommand("git", ["push", "origin", "HEAD:refs/heads/release/v1.2.3"], { cwd: unrelated });
        const { deps } = repoDeps(fixture.repo);

        await assertRejects(() => createCandidate(deps, "v1.2.3-rc.2", true), Error, "does not descend");
    } finally {
        await fsRm(fixture.root, { recursive: true });
    }
});

test("later Candidate stops when the release branch changes while its source loads", async () => {
    const fixture = await createReleaseRepo();
    try {
        await runCommand("git", ["tag", "-a", "v1.2.2", "-m", "stable"], { cwd: fixture.repo });
        await runCommand("git", ["push", "origin", "refs/tags/v1.2.2"], { cwd: fixture.repo });
        const release = repoDeps(fixture.repo);
        await createCandidate(release.deps, "v1.2.3-rc.1", false);

        const fixer = `${fixture.root}/source-race-fixer`;
        await runCommand("git", ["clone", fixture.remote, fixer]);
        await runCommand("git", ["config", "user.email", "release-test@example.com"], { cwd: fixer });
        await runCommand("git", ["config", "user.name", "Release Test"], { cwd: fixer });
        await runCommand("git", ["checkout", "-b", "release/v1.2.3", "origin/release/v1.2.3"], { cwd: fixer });
        await fsWriteFile(`${fixer}/raced.txt`, "raced\n");
        await runCommand("git", ["add", "raced.txt"], { cwd: fixer });
        await runCommand("git", ["commit", "-m", "raced fix"], { cwd: fixer });

        const originalRun = release.deps.run;
        let branchReads = 0;
        release.deps.run = async (command, args, options = {}) => {
            if (command === "git" && args.join(" ") === "ls-remote --heads origin refs/heads/release/v1.2.3") {
                branchReads += 1;
                if (branchReads === 2) {
                    await runCommand("git", ["push", "origin", "release/v1.2.3"], { cwd: fixer });
                }
            }
            return await originalRun(command, args, options);
        };

        await assertRejects(
            () => createCandidate(release.deps, "v1.2.3-rc.2", true),
            Error,
            "changed during preflight",
        );
        assertEquals(await runCommand("git", ["tag", "--list", "v1.2.3-rc.2"], { cwd: fixture.repo }), "");
    } finally {
        await fsRm(fixture.root, { recursive: true });
    }
});

test("later Candidate stops when the release branch changes during preflight", async () => {
    const fixture = await createReleaseRepo();
    try {
        await runCommand("git", ["tag", "-a", "v1.2.2", "-m", "stable"], { cwd: fixture.repo });
        await runCommand("git", ["push", "origin", "refs/tags/v1.2.2"], { cwd: fixture.repo });
        const release = repoDeps(fixture.repo);
        await createCandidate(release.deps, "v1.2.3-rc.1", false);

        const fixer = `${fixture.root}/race-fixer`;
        await runCommand("git", ["clone", fixture.remote, fixer]);
        await runCommand("git", ["config", "user.email", "release-test@example.com"], { cwd: fixer });
        await runCommand("git", ["config", "user.name", "Release Test"], { cwd: fixer });
        await runCommand("git", ["checkout", "-b", "release/v1.2.3", "origin/release/v1.2.3"], { cwd: fixer });
        const originalRun = release.deps.run;
        let branchReads = 0;
        release.deps.run = async (command, args, options = {}) => {
            if (command === "git" && args.join(" ") === "ls-remote --heads origin refs/heads/release/v1.2.3") {
                branchReads += 1;
                if (branchReads === 3) {
                    await fsWriteFile(`${fixer}/raced.txt`, "raced\n");
                    await runCommand("git", ["add", "raced.txt"], { cwd: fixer });
                    await runCommand("git", ["commit", "-m", "raced fix"], { cwd: fixer });
                    await runCommand("git", ["push", "origin", "release/v1.2.3"], { cwd: fixer });
                }
            }
            return await originalRun(command, args, options);
        };

        await assertRejects(
            () => createCandidate(release.deps, "v1.2.3-rc.2", false),
            Error,
            "changed during preflight",
        );
        assertEquals(await runCommand("git", ["tag", "--list", "v1.2.3-rc.2"], { cwd: fixture.repo }), "");
    } finally {
        await fsRm(fixture.root, { recursive: true });
    }
});

test("RC1 does not overwrite a release branch created during preflight", async () => {
    const fixture = await createReleaseRepo();
    try {
        await runCommand("git", ["tag", "-a", "v1.2.2", "-m", "stable"], { cwd: fixture.repo });
        await runCommand("git", ["push", "origin", "refs/tags/v1.2.2"], { cwd: fixture.repo });
        const actor = `${fixture.root}/branch-actor`;
        await runCommand("git", ["clone", fixture.remote, actor]);
        await runCommand("git", ["config", "user.email", "release-test@example.com"], { cwd: actor });
        await runCommand("git", ["config", "user.name", "Release Test"], { cwd: actor });
        await fsWriteFile(`${actor}/actor.txt`, "actor branch\n");
        await runCommand("git", ["add", "actor.txt"], { cwd: actor });
        await runCommand("git", ["commit", "-m", "actor branch"], { cwd: actor });
        const actorCommit = (await runCommand("git", ["rev-parse", "HEAD"], { cwd: actor })).trim();
        const release = repoDeps(fixture.repo);
        const originalRun = release.deps.run;
        let branchReads = 0;
        release.deps.run = async (command, args, options = {}) => {
            if (command === "git" && args.join(" ") === "ls-remote --heads origin refs/heads/release/v1.2.3") {
                branchReads += 1;
                if (branchReads === 2) {
                    await runCommand("git", ["push", "origin", "HEAD:refs/heads/release/v1.2.3"], { cwd: actor });
                }
            }
            return await originalRun(command, args, options);
        };

        await assertRejects(
            () => createCandidate(release.deps, "v1.2.3-rc.1", false),
            Error,
            "changed during preflight",
        );

        assertEquals(await runCommand("git", ["tag", "--list", "v1.2.3-rc.1"], { cwd: fixture.repo }), "");
        assertEquals(
            (
                await runCommand("git", ["ls-remote", "origin", "refs/heads/release/v1.2.3"], {
                    cwd: fixture.repo,
                })
            ).startsWith(actorCommit),
            true,
        );
    } finally {
        await fsRm(fixture.root, { recursive: true });
    }
});

test("RC1 branch and tag publication is atomic when the remote rejects the tag", async () => {
    const fixture = await createReleaseRepo();
    try {
        await runCommand("git", ["tag", "-a", "v1.2.2", "-m", "stable"], { cwd: fixture.repo });
        await runCommand("git", ["push", "origin", "refs/tags/v1.2.2"], { cwd: fixture.repo });
        const hook = `${fixture.remote}/hooks/pre-receive`;
        await fsWriteFile(
            hook,
            '#!/bin/sh\nwhile read old new ref; do\n  if [ "$ref" = "refs/tags/v1.2.3-rc.1" ]; then exit 1; fi\ndone\n',
        );
        await fsChmod(hook, 0o755);
        const { deps } = repoDeps(fixture.repo);

        const failure = await assertRejects(
            () => createCandidate(deps, "v1.2.3-rc.1", false),
            Error,
            "Push release branch and tag",
        );
        assertStringIncludes(failure.message, "local tag v1.2.3-rc.1 remains");
        assertStringIncludes(failure.message, "origin release/v1.2.3 is absent");

        assertEquals(
            await runCommand("git", ["ls-remote", "--heads", "origin", "refs/heads/release/v1.2.3"], {
                cwd: fixture.repo,
            }),
            "",
        );
        assertEquals(
            await runCommand("git", ["ls-remote", "--tags", "origin", "refs/tags/v1.2.3-rc.1"], {
                cwd: fixture.repo,
            }),
            "",
        );
        assertEquals(
            (await runCommand("git", ["tag", "--list", "v1.2.3-rc.1"], { cwd: fixture.repo })).trim(),
            "v1.2.3-rc.1",
        );

        await fsRm(hook);
        await runCommand("git", ["tag", "--delete", "v1.2.3-rc.1"], { cwd: fixture.repo });
        await createCandidate(deps, "v1.2.3-rc.1", false);
        assertEquals(
            (
                await runCommand("git", ["ls-remote", "origin", "refs/heads/release/v1.2.3"], {
                    cwd: fixture.repo,
                })
            ).length > 0,
            true,
        );
        assertEquals(
            (
                await runCommand("git", ["ls-remote", "origin", "refs/tags/v1.2.3-rc.1"], {
                    cwd: fixture.repo,
                })
            ).length > 0,
            true,
        );
    } finally {
        await fsRm(fixture.root, { recursive: true });
    }
});

test("every grandfathered Candidate series retains HEAD selection without a release branch", async () => {
    const series = ["v0.8.16", "v0.9.0", "v0.9.2", "v0.9.3", "v0.9.4", "v0.9.6", "v0.10.1"];
    for (const stableTag of series) {
        const candidate = `${stableTag}-rc.2`;
        const { deps, calls, logs } = depsForCommands({
            "git tag --list v*": { stdout: `v0.0.1\n${stableTag}-rc.1\n` },
            "git ls-remote --tags origin refs/tags/v*": { stdout: "" },
            [`git rev-parse ${candidate}^{commit}`]: { success: false, code: 1 },
            [`git ls-remote --tags origin refs/tags/${candidate}*`]: { stdout: "" },
            [`git rev-parse ${stableTag}^{commit}`]: { success: false, code: 1 },
            [`git ls-remote --tags origin refs/tags/${stableTag}*`]: { stdout: "" },
            "git rev-parse HEAD": { stdout: "legacy-head\n" },
        });

        await createCandidate(deps, candidate, true);

        assertEquals(
            logs.some((line) => line.includes("HEAD at legacy-head")),
            true,
        );
        assertEquals(
            calls.some((call) => call.args.includes("--heads")),
            false,
        );
    }
});

test("createStable rejects regressive tags but permits dirty and ahead real checkouts", async () => {
    const fixture = await createReleaseRepo();
    try {
        await runCommand("git", ["tag", "-a", "v1.2.2", "-m", "stable"], { cwd: fixture.repo });
        await runCommand("git", ["push", "origin", "refs/tags/v1.2.2"], { cwd: fixture.repo });
        const { deps } = repoDeps(fixture.repo);
        await assertRejects(() => createStable(deps, "v1.2.1", true), Error, "newer than previous Stable");
        await fsWriteFile(`${fixture.repo}/dirty.txt`, "dirty\n");
        await createStable(deps, "v1.2.3", true);
        await fsRm(`${fixture.repo}/dirty.txt`);
        await fsWriteFile(`${fixture.repo}/file.txt`, "ahead\n");
        await runCommand("git", ["commit", "-am", "ahead"], { cwd: fixture.repo });
        await createStable(deps, "v1.2.3", true);
    } finally {
        await fsRm(fixture.root, { recursive: true });
    }
});

test("createStable refuses direct Stable when a Candidate exists for that version", async () => {
    const fixture = await createReleaseRepo();
    try {
        await runCommand("git", ["tag", "-a", "v1.2.2", "-m", "stable"], { cwd: fixture.repo });
        await runCommand("git", ["tag", "-a", "v1.2.3-rc.1", "-m", "candidate"], { cwd: fixture.repo });
        await runCommand("git", ["push", "origin", "refs/tags/v1.2.2", "refs/tags/v1.2.3-rc.1"], { cwd: fixture.repo });
        const { deps } = repoDeps(fixture.repo);
        await assertRejects(() => createStable(deps, "v1.2.3", true), Error, "release:promote");
    } finally {
        await fsRm(fixture.root, { recursive: true });
    }
});

test("promoteCandidate tags the Candidate peeled commit instead of HEAD in a real repository", async () => {
    const fixture = await createReleaseRepo();
    try {
        await runCommand("git", ["tag", "-a", "v1.2.2", "-m", "stable"], { cwd: fixture.repo });
        await fsWriteFile(`${fixture.repo}/file.txt`, "candidate\n");
        await runCommand("git", ["commit", "-am", "candidate"], { cwd: fixture.repo });
        const candidateCommit = (await runCommand("git", ["rev-parse", "HEAD"], { cwd: fixture.repo })).trim();
        await runCommand("git", ["tag", "-a", "v1.2.3-rc.1", "-m", "candidate"], { cwd: fixture.repo });
        await runCommand(
            "git",
            [
                "push",
                "origin",
                "main",
                "refs/tags/v1.2.2",
                "refs/tags/v1.2.3-rc.1",
                `${candidateCommit}:refs/heads/release/v1.2.3`,
            ],
            { cwd: fixture.repo },
        );
        await fsWriteFile(`${fixture.repo}/file.txt`, "after candidate\n");
        await runCommand("git", ["commit", "-am", "after candidate"], { cwd: fixture.repo });
        const headCommit = (await runCommand("git", ["rev-parse", "HEAD"], { cwd: fixture.repo })).trim();
        await runCommand("git", ["push", "origin", "HEAD:refs/heads/release/v1.2.3"], { cwd: fixture.repo });
        const { deps } = repoDeps(fixture.repo);
        await promoteCandidate(deps, "v1.2.3-rc.1", false);
        const stableCommit = (await runCommand("git", ["rev-parse", "v1.2.3^{commit}"], { cwd: fixture.repo })).trim();
        assertEquals(stableCommit, candidateCommit);
        assertEquals(stableCommit === headCommit, false);
    } finally {
        await fsRm(fixture.root, { recursive: true });
    }
});

test("promotion fetches a remote Candidate source missing from the local object database", async () => {
    const fixture = await createReleaseRepo();
    try {
        await runCommand("git", ["tag", "-a", "v1.2.2", "-m", "stable"], { cwd: fixture.repo });
        await runCommand("git", ["push", "origin", "refs/tags/v1.2.2"], { cwd: fixture.repo });
        const publisher = `${fixture.root}/candidate-publisher`;
        await runCommand("git", ["clone", fixture.remote, publisher]);
        await runCommand("git", ["config", "user.email", "release-test@example.com"], { cwd: publisher });
        await runCommand("git", ["config", "user.name", "Release Test"], { cwd: publisher });
        await fsWriteFile(`${publisher}/remote-candidate.txt`, "remote candidate\n");
        await runCommand("git", ["add", "remote-candidate.txt"], { cwd: publisher });
        await runCommand("git", ["commit", "-m", "remote candidate"], { cwd: publisher });
        const candidateCommit = (await runCommand("git", ["rev-parse", "HEAD"], { cwd: publisher })).trim();
        await runCommand("git", ["tag", "-a", "v1.2.3-rc.1", "-m", "candidate"], { cwd: publisher });
        await runCommand("git", ["push", "origin", "refs/tags/v1.2.3-rc.1"], { cwd: publisher });
        const beforeFetch = await captureScriptProcess("git", {
            args: ["cat-file", "-e", `${candidateCommit}^{commit}`],
            cwd: fixture.repo,
            stdout: "null",
            stderr: "null",
        });
        assertEquals(beforeFetch.success, false);
        const { deps } = repoDeps(fixture.repo);

        await promoteCandidate(deps, "v1.2.3-rc.1", false);

        assertEquals(
            (await runCommand("git", ["rev-parse", "v1.2.3^{commit}"], { cwd: fixture.repo })).trim(),
            candidateCommit,
        );
    } finally {
        await fsRm(fixture.root, { recursive: true });
    }
});

test("promoteCandidate rejects version regressions before tag or push", async () => {
    const { deps, calls } = depsForCommands({
        "git tag --list v*": { stdout: "v1.2.3\n" },
        "git ls-remote --tags origin refs/tags/v*": { stdout: "stable-object\trefs/tags/v1.2.3\n" },
        "git rev-parse v1.2.2^{commit}": { success: false, code: 1 },
        "git ls-remote --tags origin refs/tags/v1.2.2": { stdout: "" },
        "git rev-parse v1.2.2-rc.1^{commit}": { stdout: "candidate-sha\n" },
        "git ls-remote --tags origin refs/tags/v1.2.2-rc.1*": {
            stdout: "tag-object\trefs/tags/v1.2.2-rc.1\ncandidate-sha\trefs/tags/v1.2.2-rc.1^{}\n",
        },
    });

    await assertRejects(() => promoteCandidate(deps, "v1.2.2-rc.1", false), Error, "newer than previous Stable");

    assertEquals(
        calls.some((call) => call.command === "gh"),
        false,
    );
    assertEquals(
        calls.some((call) => call.command === "git" && call.args[0] === "tag" && call.args.includes("-a")),
        false,
    );
    assertEquals(
        calls.some((call) => call.command === "git" && call.args[0] === "push"),
        false,
    );
});

test("promoteCandidate rejects stale local Candidate tags instead of promoting local-only source", async () => {
    const assets = expectedReleaseAssetNames("v1.2.3-rc.1").map((name) => ({ name }));
    const { deps, calls } = depsForCommands({
        "git rev-parse v1.2.3^{commit}": { success: false, code: 1 },
        "git ls-remote --tags origin refs/tags/v1.2.3": { stdout: "" },
        "git rev-parse v1.2.3-rc.1^{commit}": { stdout: "local-sha\n" },
        "git ls-remote --tags origin refs/tags/v1.2.3-rc.1*": {
            stdout: "tag-object\trefs/tags/v1.2.3-rc.1\nremote-sha\trefs/tags/v1.2.3-rc.1^{}\n",
        },
        "gh release view v1.2.3-rc.1 --json isPrerelease,isDraft,assets": {
            stdout: JSON.stringify({ isPrerelease: true, isDraft: false, assets }),
        },
    });

    await assertRejects(() => promoteCandidate(deps, "v1.2.3-rc.1", false), Error, "stale local tag");

    assertEquals(
        calls.some((call) => call.command === "git" && call.args[0] === "tag" && call.args.includes("-a")),
        false,
    );
    assertEquals(
        calls.some((call) => call.command === "git" && call.args[0] === "push"),
        false,
    );
});

test("promoteCandidate records only Candidate tag provenance and never edits host releases", async () => {
    const assets = expectedReleaseAssetNames("v1.2.3-rc.1").map((name) => ({ name }));
    const { deps, calls } = depsForCommands({
        "git rev-parse v1.2.3^{commit}": { success: false, code: 1 },
        "git ls-remote --tags origin refs/tags/v1.2.3": { stdout: "" },
        "git rev-parse v1.2.3-rc.1^{commit}": { stdout: "candidate-sha\n" },
        "git ls-remote --tags origin refs/tags/v1.2.3-rc.1*": {
            stdout: "tag-object\trefs/tags/v1.2.3-rc.1\ncandidate-sha\trefs/tags/v1.2.3-rc.1^{}\n",
        },
        "gh release view v1.2.3-rc.1 --json isPrerelease,isDraft,assets": {
            stdout: JSON.stringify({ isPrerelease: true, isDraft: false, assets }),
        },
    });

    await promoteCandidate(deps, "v1.2.3-rc.1", true);

    const tagCall = calls.find((call) => call.args[0] === "tag" && call.args.includes("-a"));
    assertEquals(tagCall, undefined);
    assertEquals(
        calls.some((call) => call.command === "gh" && call.args.includes("edit")),
        false,
    );
    assertEquals(
        calls.some((call) => call.command === "gh" && call.args.includes("create")),
        false,
    );
});

test("promoteCandidate rejects incomplete Candidate assets before tag creation", async () => {
    const { deps, calls } = depsForCommands({
        "git rev-parse v1.2.3^{commit}": { success: false, code: 1 },
        "git ls-remote --tags origin refs/tags/v1.2.3": { stdout: "" },
        "git rev-parse v1.2.3-rc.1^{commit}": { stdout: "candidate-sha\n" },
        "git ls-remote --tags origin refs/tags/v1.2.3-rc.1*": {
            stdout: "tag-object\trefs/tags/v1.2.3-rc.1\ncandidate-sha\trefs/tags/v1.2.3-rc.1^{}\n",
        },
        "gh release view v1.2.3-rc.1 --json isPrerelease,isDraft,assets": {
            stdout: JSON.stringify({ isPrerelease: true, isDraft: false, assets: [{ name: "SHA256SUMS" }] }),
        },
    });

    await assertRejects(() => promoteCandidate(deps, "v1.2.3-rc.1", true), Error, "missing asset");
    assertEquals(
        calls.some((call) => (call.args[0] === "tag" && call.args.includes("-a")) || call.args[0] === "push"),
        false,
    );
});

test("non-dry-run promotion annotation contains Candidate tag without a source SHA field", async () => {
    const assets = expectedReleaseAssetNames("v1.2.3-rc.1").map((name) => ({ name }));
    const { deps, calls } = depsForCommands({
        "git rev-parse v1.2.3^{commit}": { success: false, code: 1 },
        "git ls-remote --tags origin refs/tags/v1.2.3": { stdout: "" },
        "git rev-parse v1.2.3-rc.1^{commit}": { stdout: "candidate-sha\n" },
        "git ls-remote --tags origin refs/tags/v1.2.3-rc.1*": {
            stdout: "tag-object\trefs/tags/v1.2.3-rc.1\ncandidate-sha\trefs/tags/v1.2.3-rc.1^{}\n",
        },
        "gh release view v1.2.3-rc.1 --json isPrerelease,isDraft,assets": {
            stdout: JSON.stringify({ isPrerelease: true, isDraft: false, assets }),
        },
    });

    await promoteCandidate(deps, "v1.2.3-rc.1", false);

    const tagCall = calls.find((call) => call.command === "git" && call.args[0] === "tag" && call.args.includes("-a"));
    assertStringIncludes(tagCall?.args.join("\n") || "", "Promoted-From: v1.2.3-rc.1");
    assertEquals((tagCall?.args.join("\n") || "").includes("candidate-sha"), true, "tag target may be the commit");
    assertEquals(
        (tagCall?.args.at(-1) || "").includes("candidate-sha"),
        false,
        "annotation must not persist source SHA",
    );
    assertEquals(
        calls.some((call) => call.command === "deno"),
        false,
    );
    assertEquals(
        calls.some((call) => call.args[0] === "worktree"),
        false,
    );
});
