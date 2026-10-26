import { mkdtemp as fsMkdtemp, rm as fsRm } from "node:fs/promises";
import { test } from "node:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { assertEquals, assertInstanceOf, assertStringIncludes } from "../testing/assertions.ts";
import {
    assertGitRepository,
    GitRepositoryRequiredError,
    isGitRepository,
    isGitRepositoryRequiredError,
    probeGitRepository,
} from "./git.ts";

test("probeGitRepository reports non-Git directories without throwing", async () => {
    const dir = await fsMkdtemp(join(tmpdir(), "runwield-non-git-probe-"));
    try {
        const probe = await probeGitRepository(dir);
        assertEquals(probe.ok, false);
        assertEquals(probe.state, "not_git");
        assertEquals(await isGitRepository(dir), false);
    } finally {
        await fsRm(dir, { recursive: true });
    }
});

test("assertGitRepository throws a typed friendly error outside Git", async () => {
    const dir = await fsMkdtemp(join(tmpdir(), "runwield-non-git-assert-"));
    try {
        let caught;
        try {
            await assertGitRepository(dir, "Testing Git-required behavior");
        } catch (error) {
            caught = error;
        }
        assertInstanceOf(caught, GitRepositoryRequiredError);
        assertEquals(isGitRepositoryRequiredError(caught), true);
        assertStringIncludes(caught.message, "Testing Git-required behavior requires a Git repository");
    } finally {
        await fsRm(dir, { recursive: true });
    }
});
