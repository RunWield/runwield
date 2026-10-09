import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { createTestWorktreeAttempt, git, makeRepo } from "./worktree-test-helpers.ts";
import { removeWorktreeGitArtifacts } from "./worktree.js";
import { ensureRunWieldOwnedGitignoreBlock, RUNWIELD_GITIGNORE_BLOCK } from "./runwield-owned-paths.ts";
import { recordInitializedProjectContext } from "./worktree-project-context.ts";
import { publishExecutionWorktreeIsolated } from "./isolated-publication.ts";
import { prepareProjectContextPublication, settleProjectContextPublication } from "./project-context-publication.ts";

async function fixture(tracked: boolean, staged: boolean) {
    const root = await makeRepo();
    const worktreeRoot = await Deno.makeTempDir();
    await Deno.mkdir(join(root, ".wld"), { recursive: true });
    await Deno.mkdir(join(root, "docs"), { recursive: true });
    await Deno.writeTextFile(join(root, ".gitignore"), "node_modules/\n");
    if (tracked) {
        await Deno.writeTextFile(join(root, ".wld/settings.json"), '{"verification_command":"old"}\n');
        await Deno.writeTextFile(join(root, "docs/domain-language.md"), "# Original glossary\n");
    }
    await git(root, ["add", "."]);
    await git(root, ["commit", "-m", "Before Init"]);
    await Deno.writeTextFile(join(root, ".wld/settings.json"), '{"verification_command":"printf init"}\n');
    await Deno.writeTextFile(join(root, "docs/domain-language.md"), "# Init glossary\n");
    await ensureRunWieldOwnedGitignoreBlock(root);
    await recordInitializedProjectContext(root);
    if (staged) await git(root, ["add", ".gitignore", ".wld/settings.json", "docs/domain-language.md"]);
    const entry = await createTestWorktreeAttempt({ projectRoot: root, planName: "setup", worktreeRoot });
    await Deno.writeTextFile(join(entry.path, "implementation.txt"), "Validated implementation\n");
    await Deno.writeTextFile(join(entry.path, ".wld/settings.json"), '{"verification_command":"printf repaired"}\n');
    await Deno.writeTextFile(join(entry.path, "docs/domain-language.md"), "# Updated by the Plan\n");
    await git(entry.path, ["add", "."]);
    await git(entry.path, ["commit", "-m", "Validated candidate"]);
    const candidate = await git(entry.path, ["rev-parse", "HEAD"]);
    const args = {
        projectRoot: root,
        executionCwd: entry.path,
        executionBranch: entry.branch,
        targetBranch: "main",
        planName: "setup",
        sealedExecutionCommit: candidate,
        allowedPlanPaths: [],
    };
    return {
        root,
        entry,
        candidate,
        args,
        async cleanup() {
            await removeWorktreeGitArtifacts({ projectRoot: root, path: entry.path, force: true });
            await Deno.remove(root, { recursive: true });
            await Deno.remove(worktreeRoot, { recursive: true });
        },
    };
}

for (const tracked of [false, true]) {
    for (const staged of [false, true]) {
        Deno.test(`local publication reconciles Init and mechanical ignore output: tracked=${tracked}, staged=${staged}`, async () => {
            const f = await fixture(tracked, staged);
            try {
                await Deno.writeTextFile(join(f.root, "personal-note.txt"), "Keep me\n");
                await publishExecutionWorktreeIsolated(f.args);
                assertEquals(
                    await Deno.readTextFile(join(f.root, "docs/domain-language.md")),
                    "# Updated by the Plan\n",
                );
                assertStringIncludes(await Deno.readTextFile(join(f.root, ".wld/settings.json")), "printf repaired");
                assertEquals(
                    await Deno.readTextFile(join(f.root, ".gitignore")),
                    `node_modules/\n${RUNWIELD_GITIGNORE_BLOCK}`,
                );
                assertEquals(await Deno.readTextFile(join(f.root, "personal-note.txt")), "Keep me\n");
                assertEquals(await git(f.root, ["status", "--porcelain"]), "?? personal-note.txt");
                await git(f.root, ["merge-base", "--is-ancestor", f.candidate, "HEAD"]);
            } finally {
                await f.cleanup();
            }
        });
    }
}

for (const path of [".wld/settings.json", "docs/domain-language.md", ".gitignore"]) {
    Deno.test(`publication preserves later user edits to ${path}`, async () => {
        const f = await fixture(true, false);
        try {
            await Deno.writeTextFile(join(f.root, path), "User changes after Init\n", { append: true });
            const before = await Deno.readTextFile(join(f.root, path));
            const head = await git(f.root, ["rev-parse", "HEAD"]);
            const index = await git(f.root, ["write-tree"]);
            await assertRejects(() => publishExecutionWorktreeIsolated(f.args), Error, "project folder has user edits");
            assertEquals(await Deno.readTextFile(join(f.root, path)), before);
            assertEquals(await git(f.root, ["rev-parse", "HEAD"]), head);
            assertEquals(await git(f.root, ["write-tree"]), index);
        } finally {
            await f.cleanup();
        }
    });
}

Deno.test("failed publication restores generated files and their staging, then succeeds on retry", async () => {
    const f = await fixture(false, true);
    try {
        const status = await git(f.root, ["status", "--porcelain"]);
        const index = await git(f.root, ["write-tree"]);
        const glossary = await Deno.readTextFile(join(f.root, "docs/domain-language.md"));
        await assertRejects(
            () =>
                publishExecutionWorktreeIsolated({
                    ...f.args,
                    onProgress: (step) => {
                        if (step === "combining_work") throw new Error("Publication interrupted");
                    },
                }),
            Error,
            "Publication interrupted",
        );
        assertEquals(await git(f.root, ["status", "--porcelain"]), status);
        assertEquals(await git(f.root, ["write-tree"]), index);
        assertEquals(await Deno.readTextFile(join(f.root, "docs/domain-language.md")), glossary);
        await publishExecutionWorktreeIsolated(f.args);
        assertEquals(await git(f.root, ["status", "--porcelain"]), "");
    } finally {
        await f.cleanup();
    }
});

Deno.test("publication never commits unrelated staged user work while reconciling setup", async () => {
    const f = await fixture(false, true);
    try {
        await Deno.writeTextFile(join(f.root, "README.md"), "User work staged separately\n");
        await git(f.root, ["add", "README.md"]);
        const index = await git(f.root, ["write-tree"]);
        const head = await git(f.root, ["rev-parse", "HEAD"]);
        const settings = await Deno.readTextFile(join(f.root, ".wld/settings.json"));
        await assertRejects(() => publishExecutionWorktreeIsolated(f.args), Error, "README.md");
        assertEquals(await git(f.root, ["rev-parse", "HEAD"]), head);
        assertEquals(await git(f.root, ["write-tree"]), index);
        assertEquals(await Deno.readTextFile(join(f.root, "README.md")), "User work staged separately\n");
        assertEquals(await Deno.readTextFile(join(f.root, ".wld/settings.json")), settings);
    } finally {
        await f.cleanup();
    }
});

for (const stagedChange of ["edit", "deletion"] as const) {
    Deno.test(`publication preserves a distinct staged user ${stagedChange} beneath unchanged Init output`, async () => {
        const f = await fixture(true, false);
        const path = "docs/domain-language.md";
        try {
            const content = await Deno.readTextFile(join(f.root, path));
            if (stagedChange === "deletion") {
                await git(f.root, ["rm", "--cached", "--", path]);
            } else {
                await Deno.writeTextFile(join(f.root, path), "# Staged user glossary\n");
                await git(f.root, ["add", "--", path]);
                await Deno.writeTextFile(join(f.root, path), content);
            }
            const index = await git(f.root, ["write-tree"]);
            const head = await git(f.root, ["rev-parse", "HEAD"]);
            await assertRejects(() => publishExecutionWorktreeIsolated(f.args), Error, "project folder has user edits");
            assertEquals(await Deno.readTextFile(join(f.root, path)), content);
            assertEquals(await git(f.root, ["write-tree"]), index);
            assertEquals(await git(f.root, ["rev-parse", "HEAD"]), head);
        } finally {
            await f.cleanup();
        }
    });
}

Deno.test("publication preparation can recover original bytes and staging from its durable record", async () => {
    const f = await fixture(false, true);
    try {
        const status = await git(f.root, ["status", "--porcelain"]);
        const index = await git(f.root, ["write-tree"]);
        await prepareProjectContextPublication(f.root, f.entry.path, f.candidate);
        await assertRejects(() => Deno.stat(join(f.root, "docs/domain-language.md")), Deno.errors.NotFound);
        await settleProjectContextPublication(f.root);
        assertEquals(await git(f.root, ["status", "--porcelain"]), status);
        assertEquals(await git(f.root, ["write-tree"]), index);
        assertEquals(await Deno.readTextFile(join(f.root, "docs/domain-language.md")), "# Init glossary\n");
    } finally {
        await f.cleanup();
    }
});

Deno.test("concurrent local publication attempts serialize setup reconciliation", async () => {
    const f = await fixture(false, true);
    try {
        const results = await Promise.all([
            publishExecutionWorktreeIsolated(f.args),
            publishExecutionWorktreeIsolated(f.args),
        ]);
        assertEquals(results.map((result) => result.publicationMode), ["local", "local"]);
        assertEquals(await git(f.root, ["status", "--porcelain"]), "");
        assertEquals(await Deno.readTextFile(join(f.root, "docs/domain-language.md")), "# Updated by the Plan\n");
    } finally {
        await f.cleanup();
    }
});

Deno.test("a real merge conflict restores original setup files and staging", async () => {
    const f = await fixture(false, true);
    try {
        await Deno.writeTextFile(join(f.root, "implementation.txt"), "Conflicting target implementation\n");
        await git(f.root, ["add", "--", "implementation.txt"]);
        await git(f.root, ["commit", "--only", "-m", "Target implementation", "--", "implementation.txt"]);
        const status = await git(f.root, ["status", "--porcelain"]);
        const index = await git(f.root, ["write-tree"]);
        const head = await git(f.root, ["rev-parse", "HEAD"]);
        await assertRejects(() => publishExecutionWorktreeIsolated(f.args));
        assertEquals(await git(f.root, ["status", "--porcelain"]), status);
        assertEquals(await git(f.root, ["write-tree"]), index);
        assertEquals(await git(f.root, ["rev-parse", "HEAD"]), head);
        assertEquals(await Deno.readTextFile(join(f.root, "docs/domain-language.md")), "# Init glossary\n");
        assertEquals(
            await Deno.readTextFile(join(f.root, "implementation.txt")),
            "Conflicting target implementation\n",
        );
    } finally {
        await f.cleanup();
    }
});
