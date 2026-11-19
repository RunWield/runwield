import { test } from "node:test";
import { chmod, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { assertEquals } from "../src/testing/assertions.ts";
import { defineCommittedGitFixture, git } from "../src/shared/git-test-fixture.ts";
import { bashFixtureExecutable } from "./bash-fixture.ts";
import { captureScriptProcess } from "./script-process.ts";

interface AccessStep {
    name: string;
    run?: string;
}
interface AccessJob {
    steps: AccessStep[];
}
interface AccessJobs {
    verify: AccessJob;
}
interface AccessWorkflow {
    jobs: AccessJobs;
}

const repository = defineCommittedGitFixture();

test("Homebrew credential check proves temporary branch write and cleanup without changing the default branch", async () => {
    const root = await repository.checkout();
    try {
        const remote = join(root, "remote.git");
        await git(root, ["clone", "--bare", root, remote]);
        await git(root, ["remote", "add", "origin", remote]);
        const before = await git(remote, ["rev-parse", "main"]);
        await writeFile(join(root, "README.md"), "unpublished local work\n");
        await git(root, ["add", "README.md"]);
        await git(root, ["commit", "-m", "Local work must not reach main"]);
        const head = await git(root, ["rev-parse", "HEAD"]);
        const hook = join(remote, "hooks/post-receive");
        await writeFile(
            hook,
            '#!/bin/sh\nwhile read old new ref; do printf "%s %s %s\\n" "$old" "$new" "$ref" >> hooks/received; done\n',
        );
        await chmod(hook, 0o755);
        const workflow = Bun.YAML.parse(
            await readFile(".github/workflows/homebrew-tap-access.yml", "utf8"),
        ) as AccessWorkflow;
        const script = workflow.jobs.verify.steps.find((step) => step.name === "Verify Homebrew tap write access")?.run;
        if (!script) throw new Error("Credential check must provide an executable workflow step");
        const branch = "credential-check-fixture";
        const result = await captureScriptProcess(bashFixtureExecutable(), {
            args: ["-euc", script],
            cwd: root,
            env: { CHECK_BRANCH: branch },
        });
        assertEquals(result.code, 0, new TextDecoder().decode(result.stderr));
        assertEquals(await git(remote, ["rev-parse", "main"]), before);
        assertEquals(await git(remote, ["for-each-ref", "--format=%(refname)", "refs/heads"]), "refs/heads/main");
        const zero = "0".repeat(40);
        assertEquals((await readFile(join(remote, "hooks/received"), "utf8")).trim().split("\n"), [
            `${zero} ${head} refs/heads/${branch}`,
            `${head} ${zero} refs/heads/${branch}`,
        ]);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
