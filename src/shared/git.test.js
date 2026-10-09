import { assertEquals, assertInstanceOf, assertStringIncludes } from "@std/assert";
import {
    assertGitRepository,
    GitRepositoryRequiredError,
    isGitRepository,
    isGitRepositoryRequiredError,
    probeGitRepository,
} from "./git.ts";

Deno.test("probeGitRepository reports non-Git directories without throwing", async () => {
    const dir = await Deno.makeTempDir({ prefix: "runwield-non-git-probe-" });
    try {
        const probe = await probeGitRepository(dir);
        assertEquals(probe.ok, false);
        assertEquals(probe.state, "not_git");
        assertEquals(await isGitRepository(dir), false);
    } finally {
        await Deno.remove(dir, { recursive: true });
    }
});

Deno.test("assertGitRepository throws a typed friendly error outside Git", async () => {
    const dir = await Deno.makeTempDir({ prefix: "runwield-non-git-assert-" });
    try {
        let caught;
        try {
            await assertGitRepository(dir, "Testing Git-required behavior");
        } catch (error) {
            caught = error;
        }
        assertInstanceOf(caught, GitRepositoryRequiredError);
        assertEquals(isGitRepositoryRequiredError(caught), true);
        assertStringIncludes(
            /** @type {Error} */ (caught).message,
            "Testing Git-required behavior requires a Git repository",
        );
    } finally {
        await Deno.remove(dir, { recursive: true });
    }
});
