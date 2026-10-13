import {
    mkdir as fsMkdir,
    mkdtemp as fsMkdtemp,
    readFile as fsReadFile,
    rm as fsRm,
    writeFile as fsWriteFile,
} from "node:fs/promises";
import { test } from "node:test";
import { tmpdir } from "node:os";
import { assertEquals, assertStringIncludes } from "../testing/assertions.ts";
import { join } from "node:path";
import {
    CURRENT_PROJECT_RUNTIME_PATHS,
    ensureRunWieldOwnedGitignoreBlock,
    isCurrentProjectRuntimePath,
    isLegacyProjectRuntimeHazardPath,
    isRunWieldOwnedRuntimePath,
    LEGACY_PROJECT_RUNTIME_HAZARD_PATHS,
    RUNWIELD_GITIGNORE_BLOCK,
    RUNWIELD_OWNED_RUNTIME_PATHS,
    runwieldOwnedPathspecExclusions,
} from "./runwield-owned-paths.ts";

test("Gitignore retains legacy publication protection only while the directory exists", async () => {
    const root = await fsMkdtemp(join(tmpdir(), "runwield-staging-ignore-"));
    const staging = join(root, ".wld", "plan-staging");
    try {
        await fsMkdir(staging, { recursive: true });
        await fsWriteFile(join(staging, "saved.txt"), "saved repair\n");
        await fsWriteFile(join(root, ".gitignore"), ".wld/plan-staging/\n*.log\n");
        await ensureRunWieldOwnedGitignoreBlock(root);
        const content = await fsReadFile(join(root, ".gitignore"), "utf8");
        assertStringIncludes(content, ".wld/internal/\n.wld/plan-staging/\n");
        assertStringIncludes(content, "*.log\n");
        assertEquals((await ensureRunWieldOwnedGitignoreBlock(root)).changed, false);
        await fsRm(staging, { recursive: true });
        await ensureRunWieldOwnedGitignoreBlock(root);
        assertEquals(await fsReadFile(join(root, ".gitignore"), "utf8"), `*.log\n${RUNWIELD_GITIGNORE_BLOCK}`);
    } finally {
        await fsRm(root, { recursive: true });
    }
});

test("Gitignore keeps recovered legacy lock directories out of user commits", async () => {
    const root = await fsMkdtemp(join(tmpdir(), "runwield-recovery-ignore-"));
    try {
        await fsMkdir(join(root, ".wld", "controller", "plans"), { recursive: true });
        await fsMkdir(join(root, ".wld", "plan-locks"), { recursive: true });
        await fsWriteFile(join(root, ".wld", "controller", "plans", "demo.json.lock"), "");
        await ensureRunWieldOwnedGitignoreBlock(root);
        const content = await fsReadFile(join(root, ".gitignore"), "utf8");
        assertStringIncludes(content, ".wld/internal/\n");
        assertStringIncludes(content, ".wld/controller/\n");
        assertStringIncludes(content, ".wld/plan-locks/\n");
        assertEquals((await ensureRunWieldOwnedGitignoreBlock(root)).changed, false);
    } finally {
        await fsRm(root, { recursive: true });
    }
});

test("RunWield runtime classifiers separate current state from legacy hazards", () => {
    const cases = [
        { path: ".wld/internal", current: true, legacy: false, aggregate: true },
        { path: "./.wld/internal", current: true, legacy: false, aggregate: true },
        { path: ".wld/internal/controller/plans/a.json", current: true, legacy: false, aggregate: true },
        { path: ".wld/internal/worktrees.json.abc.tmp", current: true, legacy: false, aggregate: true },
        { path: ".wld/internal/future/new-state.json", current: true, legacy: false, aggregate: true },
        { path: ".wld", current: false, legacy: false, aggregate: false },
        { path: ".wld/internal-other", current: false, legacy: false, aggregate: false },
        { path: ".wldx/internal", current: false, legacy: false, aggregate: false },
        { path: ".wld/settings.json", current: false, legacy: false, aggregate: false },
        { path: ".wld/agents/a.md", current: false, legacy: false, aggregate: false },
        { path: ".wld/skills/s/SKILL.md", current: false, legacy: false, aggregate: false },
        { path: ".wld/prompts/a.md", current: false, legacy: false, aggregate: false },
        { path: ".wld/prompt-templates/a.md", current: false, legacy: false, aggregate: false },
        { path: "src/main.js", current: false, legacy: false, aggregate: false },
    ];

    for (const { path, current, legacy, aggregate } of cases) {
        assertEquals(isCurrentProjectRuntimePath(path), current, `${path} current`);
        assertEquals(isLegacyProjectRuntimeHazardPath(path), legacy, `${path} legacy`);
        assertEquals(isRunWieldOwnedRuntimePath(path), aggregate, `${path} aggregate`);
    }
});

test("legacy runtime hazards cover only the bounded old catalog and temp-file shapes", () => {
    for (const path of LEGACY_PROJECT_RUNTIME_HAZARD_PATHS) {
        assertEquals(isCurrentProjectRuntimePath(path), false, `${path} is not current`);
        assertEquals(isLegacyProjectRuntimeHazardPath(path), true, `${path} is legacy`);
        assertEquals(isRunWieldOwnedRuntimePath(path), true, `${path} is aggregate`);
    }

    for (
        const path of [
            ".wld/plan-locks/demo.lock",
            ".wld/plan-transitions/transition.json",
            ".wld/plan-backups/recovery.json",
            ".wld/plan-staging/attempt-1/state.json",
            ".wld/worktrees/child",
            ".wld/debug/log.txt",
            ".wld/controller/plans/demo.json",
            ".wld/worktrees.json.dea8f5f0-04a1-4bb4-ab80-a22496a5a593.tmp",
            "./.wld/worktrees.json.abc.tmp",
            ".wld/collaboration-secrets.json.dea8f5f0-04a1-4bb4-ab80-a22496a5a593.tmp",
        ]
    ) {
        assertEquals(isCurrentProjectRuntimePath(path), false, `${path} is not current`);
        assertEquals(isLegacyProjectRuntimeHazardPath(path), true, `${path} is legacy`);
        assertEquals(isRunWieldOwnedRuntimePath(path), true, `${path} is aggregate`);
    }

    for (
        const path of [
            ".wld/plan-locks-other/demo.lock",
            ".wld/worktrees.json.tmp",
            ".wld/worktrees.json.abc.tmp/child.json",
            ".wld/collaboration-secrets.json.tmp",
            ".wld/collaboration-secrets.json.abc.tmp/child.json",
            ".wld/work-record-supersession.lock/child.json",
        ]
    ) {
        assertEquals(isCurrentProjectRuntimePath(path), false, `${path} is not current`);
        assertEquals(isLegacyProjectRuntimeHazardPath(path), false, `${path} is not legacy`);
        assertEquals(isRunWieldOwnedRuntimePath(path), false, `${path} is not aggregate`);
    }
});

test("temporary Git safety exports protect current and legacy runtime paths", () => {
    assertEquals(CURRENT_PROJECT_RUNTIME_PATHS, [".wld/internal"]);

    for (const path of CURRENT_PROJECT_RUNTIME_PATHS) {
        assertEquals(RUNWIELD_OWNED_RUNTIME_PATHS.includes(path), true, path);
        assertStringIncludes(RUNWIELD_GITIGNORE_BLOCK, `${path}/`);
    }
    for (const path of LEGACY_PROJECT_RUNTIME_HAZARD_PATHS) {
        assertEquals(RUNWIELD_OWNED_RUNTIME_PATHS.includes(path), true, path);
        assertEquals(RUNWIELD_GITIGNORE_BLOCK.includes(path), false, `${path} is safety-only`);
    }

    assertEquals(runwieldOwnedPathspecExclusions.includes(":(exclude).wld/internal/**"), true);
    assertEquals(runwieldOwnedPathspecExclusions.includes(":(exclude).wld/plan-locks/**"), true);
    assertEquals(runwieldOwnedPathspecExclusions.includes(":(exclude).wld/worktrees.json"), true);
    assertEquals(runwieldOwnedPathspecExclusions.includes(":(exclude).wld/worktrees.json.*.tmp"), true);
    assertEquals(runwieldOwnedPathspecExclusions.includes(":(exclude).wld/collaboration-secrets.json.*.tmp"), true);
    assertEquals(
        RUNWIELD_GITIGNORE_BLOCK,
        "# BEGIN RunWield owned runtime state\n.wld/internal/\n# END RunWield owned runtime state\n",
    );
});

test("managed gitignore reconciliation replaces old runtime rules and preserves user content", async () => {
    const projectRoot = await fsMkdtemp(join(tmpdir(), "runwield-gitignore-reconcile-"));
    try {
        const gitignorePath = join(projectRoot, ".gitignore");
        await fsWriteFile(
            gitignorePath,
            [
                "node_modules",
                ".wld/plan-locks",
                "# keep custom",
                "!important.txt",
                "# BEGIN RunWield owned runtime state",
                ".wld/worktrees.json",
                ".wld/controller/",
                "# END RunWield owned runtime state",
                "custom.cache",
                "# BEGIN RunWield owned runtime state",
                ".wld/debug",
                "# END RunWield owned runtime state",
                ".wld/collaboration-secrets.json.*.tmp",
                "",
            ].join("\n"),
        );

        const first = await ensureRunWieldOwnedGitignoreBlock(projectRoot);
        const afterFirst = await fsReadFile(gitignorePath, "utf8");
        const second = await ensureRunWieldOwnedGitignoreBlock(projectRoot);
        const afterSecond = await fsReadFile(gitignorePath, "utf8");

        assertEquals(first.changed, true);
        assertEquals(second.changed, false);
        assertEquals(afterFirst, afterSecond);
        assertEquals(
            afterFirst,
            [
                "node_modules",
                "# keep custom",
                "!important.txt",
                "# BEGIN RunWield owned runtime state",
                ".wld/internal/",
                "# END RunWield owned runtime state",
                "custom.cache",
                "",
            ].join("\n"),
        );
    } finally {
        await fsRm(projectRoot, { recursive: true }).catch(() => {});
    }
});

test("managed gitignore reconciliation keeps custom patterns that differ from emitted obsolete rules", async () => {
    const projectRoot = await fsMkdtemp(join(tmpdir(), "runwield-gitignore-custom-"));
    try {
        const gitignorePath = join(projectRoot, ".gitignore");
        await fsWriteFile(gitignorePath, " .wld/debug/\n/.wld/debug/\n.wld/debug/\n");

        await ensureRunWieldOwnedGitignoreBlock(projectRoot);
        const gitignore = await fsReadFile(gitignorePath, "utf8");

        assertStringIncludes(gitignore, " .wld/debug/\n");
        assertStringIncludes(gitignore, "/.wld/debug/\n");
        assertEquals(gitignore.includes("\n.wld/debug/\n"), false);
    } finally {
        await fsRm(projectRoot, { recursive: true }).catch(() => {});
    }
});

test("managed gitignore reconciliation preserves broad wld rules and reports hidden configuration", async () => {
    const projectRoot = await fsMkdtemp(join(tmpdir(), "runwield-gitignore-broad-"));
    try {
        const gitignorePath = join(projectRoot, ".gitignore");
        await fsWriteFile(gitignorePath, "cache/\r\n.wld/\r\n# END custom\r\n");

        const result = await ensureRunWieldOwnedGitignoreBlock(projectRoot);
        const gitignore = await fsReadFile(gitignorePath, "utf8");

        assertEquals(result.warnings.length, 1);
        assertEquals(result.warnings[0].kind, "broad_wld_ignore");
        assertStringIncludes(result.warnings[0].message, ".wld/settings.json");
        assertStringIncludes(gitignore, ".wld/\r\n");
        assertStringIncludes(
            gitignore,
            "# BEGIN RunWield owned runtime state\r\n.wld/internal/\r\n# END RunWield owned runtime state\r\n",
        );
    } finally {
        await fsRm(projectRoot, { recursive: true }).catch(() => {});
    }
});

test("managed gitignore reconciliation leaves unmatched markers untouched", async () => {
    const projectRoot = await fsMkdtemp(join(tmpdir(), "runwield-gitignore-unmatched-"));
    try {
        const gitignorePath = join(projectRoot, ".gitignore");
        await fsWriteFile(gitignorePath, "# BEGIN RunWield owned runtime state\nuser-owned\n");

        const result = await ensureRunWieldOwnedGitignoreBlock(projectRoot);
        const gitignore = await fsReadFile(gitignorePath, "utf8");
        const second = await ensureRunWieldOwnedGitignoreBlock(projectRoot);
        const afterSecond = await fsReadFile(gitignorePath, "utf8");

        assertEquals(result.warnings[0].kind, "unmatched_managed_marker");
        assertEquals(second.changed, false);
        assertEquals(afterSecond, gitignore);
        assertEquals(
            gitignore,
            "# BEGIN RunWield owned runtime state\nuser-owned\n# BEGIN RunWield owned runtime state\n.wld/internal/\n# END RunWield owned runtime state\n",
        );
    } finally {
        await fsRm(projectRoot, { recursive: true }).catch(() => {});
    }
});
