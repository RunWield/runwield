import { rm, writeFile } from "node:fs/promises";
import { makeTempDirectory } from "../../testing/temp-file.ts";
import { test } from "node:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { assertEquals, assertStringIncludes } from "../../testing/assertions.ts";
import { withRuntimeCommandFixture } from "../../cmd/testing/runtime-command-fixture.ts";
import { defineGitFixture, git } from "../git-test-fixture.ts";
import { approveAndCommit } from "./review-commit.ts";
const fixture = defineGitFixture(async (cwd) => {
    await writeFile(`${cwd}/base.txt`, "base\n");
    await git(cwd, ["add", "."]);
    await git(cwd, ["commit", "-m", "base"]);
});
test("Operator commit without push names the upstream check and retains commits", async () => {
    await withRuntimeCommandFixture("review-commit-", async ({ setModelResponseFactory }) => {
        const cwd = await fixture.checkout();
        try {
            const before = await git(cwd, ["rev-parse", "HEAD"]);
            await writeFile(`${cwd}/edit.txt`, "reviewed edit\n");
            setModelResponseFactory(async () => {
                await git(cwd, ["add", "."]);
                await git(cwd, ["commit", "-m", "reviewed"]);
                return fauxAssistantMessage("Committed.");
            });
            const result = await approveAndCommit(cwd);
            assertEquals(result.ok, false);
            assertStringIncludes(result.message, "@{u}");
            assertEquals(await git(cwd, ["status", "--porcelain"]), "");
            assertEquals((await git(cwd, ["rev-parse", "HEAD"])) === before, false);
        } finally {
            await rm(cwd, { recursive: true });
        }
    });
});
test("detached HEAD refuses before the Operator starts", async () => {
    const cwd = await fixture.checkout();
    try {
        await git(cwd, ["checkout", "--detach"]);
        const result = await approveAndCommit(cwd);
        assertEquals(result.ok, false);
        assertStringIncludes(result.message, "detached HEAD");
    } finally {
        await rm(cwd, { recursive: true });
    }
});
test("Operator commit and push succeeds only after Git checks", async () => {
    await withRuntimeCommandFixture("review-commit-push-", async ({ setModelResponseFactory }) => {
        const cwd = await fixture.checkout();
        const remote = await makeTempDirectory();
        try {
            await git(remote, ["init", "--bare"]);
            await git(cwd, ["remote", "add", "origin", remote]);
            await git(cwd, ["push", "-u", "origin", "HEAD"]);
            await writeFile(`${cwd}/edit.txt`, "reviewed edit\n");
            setModelResponseFactory(async () => {
                await git(cwd, ["add", "."]);
                await git(cwd, ["commit", "-m", "reviewed"]);
                await git(cwd, ["push"]);
                return fauxAssistantMessage("Pushed.");
            });
            assertEquals((await approveAndCommit(cwd)).ok, true);
        } finally {
            await rm(cwd, { recursive: true });
            await rm(remote, { recursive: true });
        }
    });
});

test("Operator success text cannot replace clean-tree and moved-HEAD checks", async () => {
    await withRuntimeCommandFixture("review-commit-noop-", async ({ setModelResponse }) => {
        const cwd = await fixture.checkout();
        try {
            await writeFile(`${cwd}/edit.txt`, "edit\n");
            setModelResponse("All committed and pushed.");
            const result = await approveAndCommit(cwd);
            assertEquals(result.ok, false);
            assertStringIncludes(result.message, "working tree is not clean");
            assertStringIncludes(result.message, "HEAD did not move");
        } finally {
            await rm(cwd, { recursive: true });
        }
    });
});

test("Approve & Commit retries publication of the existing reviewed commit", async () => {
    await withRuntimeCommandFixture("review-commit-retry-", async ({ setModelResponseFactory }) => {
        const cwd = await fixture.checkout();
        const remote = await makeTempDirectory();
        try {
            await git(remote, ["init", "--bare"]);
            await git(cwd, ["remote", "add", "origin", remote]);
            await git(cwd, ["push", "-u", "origin", "HEAD"]);
            await writeFile(`${cwd}/edit.txt`, "reviewed edit\n");
            setModelResponseFactory(async () => {
                await git(cwd, ["add", "."]);
                await git(cwd, ["commit", "-m", "reviewed"]);
                return fauxAssistantMessage("Push failed.");
            });
            const state = {};
            assertEquals((await approveAndCommit(cwd, undefined, state)).ok, false);
            const committed = await git(cwd, ["rev-parse", "HEAD"]);
            setModelResponseFactory(async () => {
                await git(cwd, ["push"]);
                return fauxAssistantMessage("Pushed existing commit.");
            });
            assertEquals((await approveAndCommit(cwd, undefined, state)).ok, true);
            assertEquals(await git(cwd, ["rev-parse", "HEAD"]), committed);
        } finally {
            await rm(cwd, { recursive: true });
            await rm(remote, { recursive: true });
        }
    });
});
