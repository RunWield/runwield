import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { git } from "../../../shared/git-test-fixture.ts";
import { createGoldenIsolatedEnvironment, prepareGoldenRepositoryTemplates } from "./isolated-environment.js";

Deno.test("createGoldenIsolatedEnvironment creates isolated HOME and Project then cleans them", async () => {
    const env = await createGoldenIsolatedEnvironment();
    const root = env.root;
    try {
        assert((await Deno.stat(env.home)).isDirectory);
        assert((await Deno.stat(env.projectRoot)).isDirectory);
        assert(env.env.PATH.startsWith(join(root, "bin")));
        assertEquals(env.env.TERM, "screen");
        assert((await Deno.readTextFile(join(env.projectRoot, "README.md"))).includes("Golden TUI Fixture"));
        const help = await new Deno.Command("mnemoteca", {
            args: ["update", "--help"],
            env: env.env,
            stdout: "piped",
        }).output();
        assertEquals(help.success, true);
        assertStringIncludes(new TextDecoder().decode(help.stdout), "update <id> --replace-tags");
    } finally {
        await env.cleanup();
    }
    await assertRejects(() => Deno.stat(root), Deno.errors.NotFound);
});

Deno.test("Golden fixture copies isolate commits, remotes, and onboarding variants", async () => {
    const templates = await Deno.makeTempDir({ prefix: "golden-template-test-" });
    await prepareGoldenRepositoryTemplates(templates);
    const first = await createGoldenIsolatedEnvironment({ repositoryTemplateRoot: templates });
    const second = await createGoldenIsolatedEnvironment({ repositoryTemplateRoot: templates });
    const uninitialized = await createGoldenIsolatedEnvironment({ repositoryTemplateRoot: templates, initDone: false });
    try {
        const original = await git(second.projectRoot, ["rev-parse", "HEAD"]);
        assertEquals(await git(first.projectRoot, ["remote", "get-url", "origin"]), first.remoteRoot);
        assertEquals(await git(second.projectRoot, ["remote", "get-url", "origin"]), second.remoteRoot);
        await Deno.writeTextFile(join(first.projectRoot, "README.md"), "Only the first fixture changed.\n");
        await git(first.projectRoot, ["add", "."]);
        await git(first.projectRoot, ["commit", "-m", "Independent fixture"]);
        await git(first.projectRoot, ["push", "origin", "main"]);
        assert((await git(first.remoteRoot, ["rev-parse", "main"])) !== original);
        assertEquals(await git(second.projectRoot, ["status", "--porcelain"]), "");
        assertEquals(await git(second.remoteRoot, ["rev-parse", "main"]), original);
        assertEquals(await git(join(templates, "initialized", "remote.git"), ["rev-parse", "main"]), original);
        await assertRejects(
            () => Deno.stat(join(uninitialized.projectRoot, "docs", "domain-language.md")),
            Deno.errors.NotFound,
        );
        assert((await Deno.stat(join(second.projectRoot, "docs", "domain-language.md"))).isFile);
    } finally {
        await Promise.all([first.cleanup(), second.cleanup(), uninitialized.cleanup()]);
        await Deno.remove(templates, { recursive: true });
    }
});
