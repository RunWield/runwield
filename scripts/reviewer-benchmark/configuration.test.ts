import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { cp, readFile, writeFile, mkdir, rm, unlink } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { withRuntimeCommandFixture } from "../../src/cmd/testing/runtime-command-fixture.ts";
import { captureCheckoutIdentity, captureConfiguration, fixtureHash } from "./configuration.ts";
import { defineGitFixture } from "../../src/shared/git-test-fixture.ts";
import { setExactProjectCustomSetting, __resetSettingsForTests } from "../../src/shared/settings.js";
import { rawGit, withFixtureCopy } from "./test-fixtures.ts";

test("configuration records this checkout and the exact production prompt bytes without a model call", async () => {
    await withRuntimeCommandFixture("benchmark-identity-", async (runtime) => {
        let calls = 0;
        runtime.setModelResponseFactory(() => {
            calls++;
            throw new Error("Identity checks must not spend");
        });
        const configuration = await captureConfiguration({});
        const root = fileURLToPath(new URL("../../", import.meta.url));
        assert.equal(configuration.revision, (await rawGit(root, ["rev-parse", "HEAD"])).trim());
        assert.equal(
            configuration.dirty,
            (await rawGit(root, ["status", "--porcelain", "--untracked-files=normal"])).trim().length > 0,
        );
        const expected: Record<string, string> = {};
        for (const path of [
            "src/agent-definitions/subagent-definitions/reviewer-prompt.md",
            "src/agent-definitions/subagent-definitions/reviewer-verify-prompt.md",
            "src/agent-definitions/shared-practice/review-practice.md",
        ])
            expected[path] = createHash("sha256")
                .update(await readFile(join(root, path)))
                .digest("hex");
        assert.deepEqual(configuration.promptHashes, expected);
        assert.equal(configuration.model, "fixture-model");
        assert.equal(configuration.provider, "runtime-command-fixture");
        assert.equal(configuration.bunVersion, "1.4.3");
        setExactProjectCustomSetting("defaultThinkingLevel", "high", runtime.projectRoot);
        assert.equal((await captureConfiguration({ configurationRoot: runtime.projectRoot })).thinkingLevel, "high");
        setExactProjectCustomSetting("defaultThinkingLevel", "low", runtime.projectRoot);
        __resetSettingsForTests();
        assert.equal((await captureConfiguration({ configurationRoot: runtime.projectRoot })).thinkingLevel, "low");
        assert.equal(calls, 0);
    });
});

test("fixture identity ignores its location but changes with source or hidden ground truth", async () => {
    await withFixtureCopy("RV-D04", async (directory) => {
        const copy = join(directory, "../fingerprint-copy");
        await cp(directory, copy, { recursive: true });
        const original = await fixtureHash(directory);
        assert.equal(await fixtureHash(copy), original);
        const path = join(copy, "source/src/browser.ts");
        const source = await readFile(path, "utf8");
        await writeFile(path, source + "\n// Changed source\n");
        assert.notEqual(await fixtureHash(copy), original);
        await writeFile(path, source);
        await writeFile(join(copy, "evaluation/proofs.ts"), 'throw new Error("changed proof");\n');
        assert.notEqual(await fixtureHash(copy), original);
        assert.equal(await fixtureHash(directory), original);
    });
});

const cleanCheckouts = defineGitFixture(async (root) => {
    await writeFile(join(root, "source.ts"), "export const value = 1;\n");
    await rawGit(root, ["add", "."]);
    await rawGit(root, ["commit", "-m", "Initial implementation"]);
});

test("checkout-local run artifacts do not change identity, but source and other files do", async () => {
    const root = await cleanCheckouts.checkout();
    try {
        const out = join(root, "benchmark-output");
        const initial = await captureCheckoutIdentity(root, out);
        assert.equal(initial.dirty, false);
        await mkdir(out);
        for (const path of ["run.json", "results.jsonl", "summary.json", "summary.md", "adjudications.json", ".lock"])
            await writeFile(join(out, path), "artifact\n");
        assert.deepEqual(await captureCheckoutIdentity(root, out), initial);
        assert.equal((await captureCheckoutIdentity(root)).dirty, true);
        await writeFile(join(out, "unrelated.ts"), "export const extra = 1;\n");
        assert.equal((await captureCheckoutIdentity(root, out)).dirty, true);
        await unlink(join(out, "unrelated.ts"));
        await writeFile(join(root, "source.ts"), "export const value = 2;\n");
        assert.equal((await captureCheckoutIdentity(root, out)).dirty, true);
        await unlink(join(root, ".git/HEAD"));
        await assert.rejects(captureCheckoutIdentity(root, out), /Cannot establish checkout identity/);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
