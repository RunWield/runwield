import { captureForegroundProcess } from "../../../shared/captured-process.ts";
import { tmpdir } from "node:os";
import { test } from "node:test";
import {
    mkdtemp as fsMkdtemp,
    readFile as fsReadFile,
    rm as fsRm,
    stat as fsStat,
    writeFile as fsWriteFile,
} from "node:fs/promises";
import { ok as assert } from "node:assert/strict";
import { assertEquals, assertRejects, assertStringIncludes } from "../../../testing/assertions.ts";
import { join } from "node:path";
import { git } from "../../../shared/git-test-fixture.ts";
import { createGoldenIsolatedEnvironment, prepareGoldenRepositoryTemplates } from "./isolated-environment.js";

test("createGoldenIsolatedEnvironment creates isolated HOME and Project then cleans them", async () => {
    const env = await createGoldenIsolatedEnvironment();
    const root = env.root;
    try {
        assert((await fsStat(env.home)).isDirectory());
        assert((await fsStat(env.projectRoot)).isDirectory());
        assert(env.env.PATH.startsWith(join(root, "bin")));
        assertEquals(env.env.TERM, "screen");
        assert((await fsReadFile(join(env.projectRoot, "README.md"), "utf8")).includes("Golden TUI Fixture"));
        const help = await captureForegroundProcess("mnemoteca", {
            args: ["update", "--help"],
            cwd: env.projectRoot,
            env: env.env,
        });
        assertEquals(help.success, true);
        assertStringIncludes(new TextDecoder().decode(help.stdout), "update <id> --replace-tags");
    } finally {
        await env.cleanup();
    }
    const removed = await assertRejects(() => fsStat(root), Error);
    assert("code" in removed && removed.code === "ENOENT");
});

test("Golden fixture copies isolate commits, remotes, and onboarding variants", async () => {
    const templates = await fsMkdtemp(join(tmpdir(), "golden-template-test-"));
    await prepareGoldenRepositoryTemplates(templates);
    const first = await createGoldenIsolatedEnvironment({ repositoryTemplateRoot: templates });
    const second = await createGoldenIsolatedEnvironment({ repositoryTemplateRoot: templates });
    const uninitialized = await createGoldenIsolatedEnvironment({ repositoryTemplateRoot: templates, initDone: false });
    try {
        const original = await git(second.projectRoot, ["rev-parse", "HEAD"]);
        assertEquals(await git(first.projectRoot, ["remote", "get-url", "origin"]), first.remoteRoot);
        assertEquals(await git(second.projectRoot, ["remote", "get-url", "origin"]), second.remoteRoot);
        await fsWriteFile(join(first.projectRoot, "README.md"), "Only the first fixture changed.\n");
        await git(first.projectRoot, ["add", "."]);
        await git(first.projectRoot, ["commit", "-m", "Independent fixture"]);
        await git(first.projectRoot, ["push", "origin", "main"]);
        assert((await git(first.remoteRoot, ["rev-parse", "main"])) !== original);
        assertEquals(await git(second.projectRoot, ["status", "--porcelain"]), "");
        assertEquals(await git(second.remoteRoot, ["rev-parse", "main"]), original);
        assertEquals(await git(join(templates, "initialized", "remote.git"), ["rev-parse", "main"]), original);
        const absent = await assertRejects(
            () => fsStat(join(uninitialized.projectRoot, "docs", "domain-language.md")),
            Error,
        );
        assert("code" in absent && absent.code === "ENOENT");
        assert((await fsStat(join(second.projectRoot, "docs", "domain-language.md"))).isFile());
    } finally {
        await Promise.all([first.cleanup(), second.cleanup(), uninitialized.cleanup()]);
        await fsRm(templates, { recursive: true });
    }
});
