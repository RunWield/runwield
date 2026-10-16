import { test } from "node:test";
import {
    mkdir as fsMkdir,
    mkdtemp as fsMkdtemp,
    readFile as fsReadFile,
    rm as fsRm,
    stat as fsStat,
    writeFile as fsWriteFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { assertEquals, assertRejects, assertStringIncludes } from "../testing/assertions.ts";
import { join } from "node:path";
import { createTestWorktreeAttempt, git, makeRepo } from "./worktree-test-helpers.ts";
import { removeWorktreeGitArtifacts } from "./worktree.js";
import { ensureRunWieldOwnedGitignoreBlock, RUNWIELD_GITIGNORE_BLOCK } from "./runwield-owned-paths.ts";
import { recordInitializedProjectContext } from "./worktree-project-context.ts";
import { publishExecutionWorktreeIsolated } from "./isolated-publication.ts";
import { prepareProjectContextPublication, settleProjectContextPublication } from "./project-context-publication.ts";

async function fixture(tracked: boolean, staged: boolean) {
    const root = await makeRepo();
    const worktreeRoot = await fsMkdtemp(join(tmpdir(), "runwield-fixture-"));
    await fsMkdir(join(root, ".wld"), { recursive: true });
    await fsMkdir(join(root, "docs"), { recursive: true });
    await fsWriteFile(join(root, ".gitignore"), "node_modules/\n");
    if (tracked) {
        await fsWriteFile(join(root, ".wld/settings.json"), '{"verification_command":"old"}\n');
        await fsWriteFile(join(root, "docs/domain-language.md"), "# Original glossary\n");
    }
    await git(root, ["add", "."]);
    await git(root, ["commit", "-m", "Before Init"]);
    await fsWriteFile(join(root, ".wld/settings.json"), '{"verification_command":"printf init"}\n');
    await fsWriteFile(join(root, "docs/domain-language.md"), "# Init glossary\n");
    await ensureRunWieldOwnedGitignoreBlock(root);
    await recordInitializedProjectContext(root);
    if (staged) await git(root, ["add", ".gitignore", ".wld/settings.json", "docs/domain-language.md"]);
    const entry = await createTestWorktreeAttempt({ projectRoot: root, planName: "setup", worktreeRoot });
    await fsWriteFile(join(entry.path, "implementation.txt"), "Validated implementation\n");
    await fsWriteFile(join(entry.path, ".wld/settings.json"), '{"verification_command":"printf repaired"}\n');
    await fsWriteFile(join(entry.path, "docs/domain-language.md"), "# Updated by the Plan\n");
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
            await fsRm(root, { recursive: true });
            await fsRm(worktreeRoot, { recursive: true });
        },
    };
}

for (const tracked of [false, true]) {
    for (const staged of [false, true]) {
        test(`local publication reconciles Init and mechanical ignore output: tracked=${tracked}, staged=${staged}`, async () => {
            const f = await fixture(tracked, staged);
            try {
                await fsWriteFile(join(f.root, "personal-note.txt"), "Keep me\n");
                await publishExecutionWorktreeIsolated(f.args);
                assertEquals(
                    await fsReadFile(join(f.root, "docs/domain-language.md"), "utf8"),
                    "# Updated by the Plan\n",
                );
                assertStringIncludes(await fsReadFile(join(f.root, ".wld/settings.json"), "utf8"), "printf repaired");
                assertEquals(
                    await fsReadFile(join(f.root, ".gitignore"), "utf8"),
                    `node_modules/\n${RUNWIELD_GITIGNORE_BLOCK}`,
                );
                assertEquals(await fsReadFile(join(f.root, "personal-note.txt"), "utf8"), "Keep me\n");
                assertEquals(await git(f.root, ["status", "--porcelain"]), "?? personal-note.txt");
                await git(f.root, ["merge-base", "--is-ancestor", f.candidate, "HEAD"]);
            } finally {
                await f.cleanup();
            }
        });
    }
}

for (const path of [".wld/settings.json", "docs/domain-language.md", ".gitignore"]) {
    test(`publication preserves later user edits to ${path}`, async () => {
        const f = await fixture(true, false);
        try {
            await fsWriteFile(join(f.root, path), "User changes after Init\n", { flag: "a" });
            const before = await fsReadFile(join(f.root, path), "utf8");
            const head = await git(f.root, ["rev-parse", "HEAD"]);
            const index = await git(f.root, ["write-tree"]);
            await assertRejects(() => publishExecutionWorktreeIsolated(f.args), Error, "project folder has user edits");
            assertEquals(await fsReadFile(join(f.root, path), "utf8"), before);
            assertEquals(await git(f.root, ["rev-parse", "HEAD"]), head);
            assertEquals(await git(f.root, ["write-tree"]), index);
        } finally {
            await f.cleanup();
        }
    });
}

test("failed publication restores generated files and their staging, then succeeds on retry", async () => {
    const f = await fixture(false, true);
    try {
        const status = await git(f.root, ["status", "--porcelain"]);
        const index = await git(f.root, ["write-tree"]);
        const glossary = await fsReadFile(join(f.root, "docs/domain-language.md"), "utf8");
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
        assertEquals(await fsReadFile(join(f.root, "docs/domain-language.md"), "utf8"), glossary);
        await publishExecutionWorktreeIsolated(f.args);
        assertEquals(await git(f.root, ["status", "--porcelain"]), "");
    } finally {
        await f.cleanup();
    }
});

test("publication never commits unrelated staged user work while reconciling setup", async () => {
    const f = await fixture(false, true);
    try {
        await fsWriteFile(join(f.root, "README.md"), "User work staged separately\n");
        await git(f.root, ["add", "README.md"]);
        const index = await git(f.root, ["write-tree"]);
        const head = await git(f.root, ["rev-parse", "HEAD"]);
        const settings = await fsReadFile(join(f.root, ".wld/settings.json"), "utf8");
        await assertRejects(() => publishExecutionWorktreeIsolated(f.args), Error, "README.md");
        assertEquals(await git(f.root, ["rev-parse", "HEAD"]), head);
        assertEquals(await git(f.root, ["write-tree"]), index);
        assertEquals(await fsReadFile(join(f.root, "README.md"), "utf8"), "User work staged separately\n");
        assertEquals(await fsReadFile(join(f.root, ".wld/settings.json"), "utf8"), settings);
    } finally {
        await f.cleanup();
    }
});

for (const stagedChange of ["edit", "deletion"] as const) {
    test(`publication preserves a distinct staged user ${stagedChange} beneath unchanged Init output`, async () => {
        const f = await fixture(true, false);
        const path = "docs/domain-language.md";
        try {
            const content = await fsReadFile(join(f.root, path), "utf8");
            if (stagedChange === "deletion") {
                await git(f.root, ["rm", "--cached", "--", path]);
            } else {
                await fsWriteFile(join(f.root, path), "# Staged user glossary\n");
                await git(f.root, ["add", "--", path]);
                await fsWriteFile(join(f.root, path), content);
            }
            const index = await git(f.root, ["write-tree"]);
            const head = await git(f.root, ["rev-parse", "HEAD"]);
            await assertRejects(() => publishExecutionWorktreeIsolated(f.args), Error, "project folder has user edits");
            assertEquals(await fsReadFile(join(f.root, path), "utf8"), content);
            assertEquals(await git(f.root, ["write-tree"]), index);
            assertEquals(await git(f.root, ["rev-parse", "HEAD"]), head);
        } finally {
            await f.cleanup();
        }
    });
}

test("publication preparation can recover original bytes and staging from its durable record", async () => {
    const f = await fixture(false, true);
    try {
        const status = await git(f.root, ["status", "--porcelain"]);
        const index = await git(f.root, ["write-tree"]);
        await prepareProjectContextPublication(f.root, f.entry.path, f.candidate);
        await assertRejects(() => fsStat(join(f.root, "docs/domain-language.md")), Error, "ENOENT");
        await settleProjectContextPublication(f.root);
        assertEquals(await git(f.root, ["status", "--porcelain"]), status);
        assertEquals(await git(f.root, ["write-tree"]), index);
        assertEquals(await fsReadFile(join(f.root, "docs/domain-language.md"), "utf8"), "# Init glossary\n");
    } finally {
        await f.cleanup();
    }
});

test("concurrent local publication attempts serialize setup reconciliation", async () => {
    const f = await fixture(false, true);
    try {
        const results = await Promise.all([
            publishExecutionWorktreeIsolated(f.args),
            publishExecutionWorktreeIsolated(f.args),
        ]);
        assertEquals(results.map((result) => result.publicationMode), ["local", "local"]);
        assertEquals(await git(f.root, ["status", "--porcelain"]), "");
        assertEquals(await fsReadFile(join(f.root, "docs/domain-language.md"), "utf8"), "# Updated by the Plan\n");
    } finally {
        await f.cleanup();
    }
});

test("a real merge conflict restores original setup files and staging", async () => {
    const f = await fixture(false, true);
    try {
        await fsWriteFile(join(f.root, "implementation.txt"), "Conflicting target implementation\n");
        await git(f.root, ["add", "--", "implementation.txt"]);
        await git(f.root, ["commit", "--only", "-m", "Target implementation", "--", "implementation.txt"]);
        const status = await git(f.root, ["status", "--porcelain"]);
        const index = await git(f.root, ["write-tree"]);
        const head = await git(f.root, ["rev-parse", "HEAD"]);
        await assertRejects(() => publishExecutionWorktreeIsolated(f.args));
        assertEquals(await git(f.root, ["status", "--porcelain"]), status);
        assertEquals(await git(f.root, ["write-tree"]), index);
        assertEquals(await git(f.root, ["rev-parse", "HEAD"]), head);
        assertEquals(await fsReadFile(join(f.root, "docs/domain-language.md"), "utf8"), "# Init glossary\n");
        assertEquals(
            await fsReadFile(join(f.root, "implementation.txt"), "utf8"),
            "Conflicting target implementation\n",
        );
    } finally {
        await f.cleanup();
    }
});
