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
import process from "node:process";
import { getCwd, getHomeDir } from "../constants.js";
/**
 * @module shared/settings.test
 */

import { assertEquals, assertRejects, assertThrows } from "../testing/assertions.ts";
import { join } from "node:path";
import {
    __resetSettingsForTests,
    getCodeReviewMode,
    getCustomSetting,
    getDefaultPlanServerUrl,
    getExactProjectCustomSetting,
    getGuidedReviewMode,
    getPlanArchiveRetentionPolicy,
    getResolvedVisionFallbackModelSetting,
    getSettingsManager,
    migratePiSettingsOnce,
    PLAN_SERVER_URL_SETTING_KEY,
    setCompactionKeepRecentTokens,
    setCompactionReserveTokens,
    setCustomSetting,
    setDefaultPlanServerUrl,
    setExactProjectCustomSetting,
    shouldAutoGenerateWorkRecordsOnPlanCompletion,
    shouldCleanupMergedWorktrees,
} from "./settings.js";
import { withProcessGlobalTestLock } from "../testing/process-global-lock.ts";
import { defineGitFixture, git } from "./git-test-fixture.ts";

type SettingsTestBody = () => void | Promise<void>;

interface SettingsTestDefinition {
    name: string;
    ignore?: boolean;
    fn: SettingsTestBody;
}

function delay(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * macOS can briefly report recursive temp cleanup as ENOTEMPTY/EBUSY while
 * filesystem metadata settles after a test's last writes. Retry boundedly so
 * cleanup flakiness does not fail an otherwise successful test.
 *
 */
async function removeTempDir(path: string) {
    for (let attempt = 0; attempt < 5; attempt += 1) {
        try {
            await fsRm(path, { recursive: true });
            return;
        } catch (error) {
            if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
            const isRetryable =
                error instanceof Error &&
                /Directory not empty|resource busy|os error 66|os error 16/i.test(error.message);
            if (!isRetryable || attempt === 4) throw error;
            await delay(25 * (attempt + 1));
        }
    }
}

const linkedWorktreeSettingsRepo = defineGitFixture(async (repoPath) => {
    await fsWriteFile(join(repoPath, "README.md"), "base\n");
    await git(repoPath, ["add", "."]);
    await git(repoPath, ["commit", "-m", "base"]);
});

function settingsTest(testDefinition: string | SettingsTestDefinition, fn?: SettingsTestBody) {
    if (typeof testDefinition === "string") {
        if (!fn) throw new Error("settingsTest requires a test function");
        test(testDefinition, () => withProcessGlobalTestLock(async () => await fn()));
        return;
    }
    test(testDefinition.name, { skip: testDefinition.ignore === true }, () =>
        withProcessGlobalTestLock(async () => await testDefinition.fn()),
    );
}

settingsTest({
    name: "project settings written from a linked worktree land in the primary checkout",
    async fn() {
        __resetSettingsForTests();
        const cwd = await linkedWorktreeSettingsRepo.checkout();
        const worktreePath = `${cwd}-settings-worktree`;
        try {
            await fsMkdir(join(cwd, ".wld"), { recursive: true });
            await fsWriteFile(join(cwd, ".wld", "settings.json"), JSON.stringify({ other: "kept" }, null, 4));
            await git(cwd, ["worktree", "add", "-b", "settings-side", worktreePath, "main"]);

            await setCustomSetting("verification_command", "true", "project", worktreePath);

            const primarySettings = JSON.parse(await fsReadFile(join(cwd, ".wld", "settings.json"), "utf8"));
            assertEquals(primarySettings.other, "kept");
            assertEquals(primarySettings.verification_command, "true");
            assertEquals(await getCustomSetting("verification_command", "project", worktreePath), "true");
            await assertRejects(() => fsStat(join(worktreePath, ".wld", "settings.json")), Error, "ENOENT");
        } finally {
            __resetSettingsForTests();
            await git(cwd, ["worktree", "remove", "--force", worktreePath]).catch(() => {});
            await fsRm(cwd, { recursive: true }).catch(() => {});
        }
    },
});

settingsTest({
    name: "exact project settings stay in a linked worktree and reload from disk",
    async fn() {
        __resetSettingsForTests();
        const cwd = await linkedWorktreeSettingsRepo.checkout();
        const worktreePath = `${cwd}-exact-settings-worktree`;
        const worktreeSettingsPath = join(worktreePath, ".wld", "settings.json");
        try {
            await fsMkdir(join(cwd, ".wld"), { recursive: true });
            await fsWriteFile(
                join(cwd, ".wld", "settings.json"),
                JSON.stringify({ verification_command: "primary-command" }, null, 4),
            );
            await git(cwd, ["worktree", "add", "-b", "exact-settings-side", worktreePath, "main"]);

            await setExactProjectCustomSetting("verification_command", "worktree-command", worktreePath);

            assertEquals(await getCustomSetting("verification_command", "project", worktreePath), "primary-command");
            assertEquals(getExactProjectCustomSetting("verification_command", worktreePath), "worktree-command");
            assertEquals(
                JSON.parse(await fsReadFile(worktreeSettingsPath, "utf8")).verification_command,
                "worktree-command",
            );

            await fsWriteFile(
                worktreeSettingsPath,
                `{
                    // JSONC stays readable on each exact read.
                    "verification_command": "changed-command",
                }`,
            );
            assertEquals(getExactProjectCustomSetting("verification_command", worktreePath), "changed-command");
        } finally {
            __resetSettingsForTests();
            await git(cwd, ["worktree", "remove", "--force", worktreePath]).catch(() => {});
            await fsRm(cwd, { recursive: true }).catch(() => {});
        }
    },
});

settingsTest("getResolvedVisionFallbackModelSetting prefers active preset over top-level", async () => {
    const originalHome = getHomeDir();
    const originalCwd = getCwd();
    const tempHome = await fsMkdtemp(join(tmpdir(), "runwield-vision-home-"));
    const tempProject = await fsMkdtemp(join(tmpdir(), "runwield-vision-project-"));
    try {
        process.env["HOME"] = tempHome;
        process.chdir(tempProject);
        await fsMkdir(".wld", { recursive: true });
        await fsWriteFile(
            ".wld/settings.json",
            JSON.stringify({
                visionFallback: { model: "top/model" },
                activeModelPreset: "local",
                modelPresets: { local: { visionFallback: { model: "preset/model" } } },
            }),
        );
        __resetSettingsForTests();

        assertEquals(getResolvedVisionFallbackModelSetting(tempProject), "preset/model");
    } finally {
        __resetSettingsForTests();
        process.chdir(originalCwd);
        if (originalHome === undefined) delete process.env["HOME"];
        else process.env["HOME"] = originalHome;
        await removeTempDir(tempHome);
        await removeTempDir(tempProject);
    }
});

settingsTest("getResolvedVisionFallbackModelSetting reads the requested Project root", async () => {
    const originalHome = getHomeDir();
    const originalCwd = getCwd();
    const tempHome = await fsMkdtemp(join(tmpdir(), "runwield-vision-root-home-"));
    const projectA = await fsMkdtemp(join(tmpdir(), "runwield-vision-root-a-"));
    const projectB = await fsMkdtemp(join(tmpdir(), "runwield-vision-root-b-"));
    try {
        process.env["HOME"] = tempHome;
        await fsMkdir(join(projectA, ".wld"), { recursive: true });
        await fsWriteFile(
            join(projectA, ".wld", "settings.json"),
            JSON.stringify({
                visionFallback: { model: "wrong/model" },
            }),
        );
        await fsMkdir(join(projectB, ".wld"), { recursive: true });
        await fsWriteFile(
            join(projectB, ".wld", "settings.json"),
            JSON.stringify({
                visionFallback: { model: "right/model" },
            }),
        );
        process.chdir(projectA);
        __resetSettingsForTests();

        assertEquals(getResolvedVisionFallbackModelSetting(projectB), "right/model");
    } finally {
        __resetSettingsForTests();
        process.chdir(originalCwd);
        if (originalHome === undefined) delete process.env["HOME"];
        else process.env["HOME"] = originalHome;
        await removeTempDir(tempHome);
        await removeTempDir(projectA);
        await removeTempDir(projectB);
    }
});

settingsTest("migratePiSettingsOnce copies legacy Pi settings when RunWield settings are missing", async () => {
    const tempDir = await fsMkdtemp(join(tmpdir(), "runwield-settings-migration-"));
    try {
        const piPath = join(tempDir, ".pi", "agent", "settings.json");
        const runwieldPath = join(tempDir, ".wld", "settings.json");
        await fsMkdir(join(tempDir, ".pi", "agent"), { recursive: true });
        await fsWriteFile(piPath, '{"theme":"legacy-pi"}');

        const result = migratePiSettingsOnce({ runwieldPath, piPath });

        assertEquals(result, { copied: true, skipped: false });
        assertEquals(await fsReadFile(runwieldPath, "utf8"), '{"theme":"legacy-pi"}');
    } finally {
        await removeTempDir(tempDir);
    }
});

settingsTest("migratePiSettingsOnce leaves existing RunWield settings untouched", async () => {
    const tempDir = await fsMkdtemp(join(tmpdir(), "runwield-settings-migration-"));
    try {
        const piPath = join(tempDir, ".pi", "agent", "settings.json");
        const runwieldPath = join(tempDir, ".wld", "settings.json");
        await fsMkdir(join(tempDir, ".pi", "agent"), { recursive: true });
        await fsMkdir(join(tempDir, ".wld"), { recursive: true });
        await fsWriteFile(piPath, '{"theme":"legacy-pi"}');
        await fsWriteFile(runwieldPath, '{"theme":"runwield"}');

        const result = migratePiSettingsOnce({ runwieldPath, piPath });

        assertEquals(result, { copied: false, skipped: true });
        assertEquals(await fsReadFile(runwieldPath, "utf8"), '{"theme":"runwield"}');
    } finally {
        await removeTempDir(tempDir);
    }
});

settingsTest("getPlanArchiveRetentionPolicy reads project settings only", async () => {
    const originalHome = getHomeDir();
    const originalCwd = getCwd();
    const tempHome = await fsMkdtemp(join(tmpdir(), "runwield-plan-retention-home-"));
    const tempProject = await fsMkdtemp(join(tmpdir(), "runwield-plan-retention-project-"));
    try {
        process.env["HOME"] = tempHome;
        process.chdir(tempProject);
        __resetSettingsForTests();

        await setCustomSetting("plans", { archiveRetentionDays: 0, archiveKeepLast: 0 }, "global", tempProject);
        assertEquals(getPlanArchiveRetentionPolicy(tempProject), { retentionDays: 14, keepLast: 10 });

        await setCustomSetting("plans", { archiveRetentionDays: 7, archiveKeepLast: 5 }, "project", tempProject);
        assertEquals(getPlanArchiveRetentionPolicy(tempProject), { retentionDays: 7, keepLast: 5 });
    } finally {
        process.chdir(originalCwd);
        if (originalHome === undefined) delete process.env["HOME"];
        else process.env["HOME"] = originalHome;
        __resetSettingsForTests();
        await removeTempDir(tempHome);
        await removeTempDir(tempProject);
    }
});

settingsTest("getPlanArchiveRetentionPolicy names invalid keys", async () => {
    const originalHome = getHomeDir();
    const originalCwd = getCwd();
    const tempHome = await fsMkdtemp(join(tmpdir(), "runwield-plan-retention-bad-home-"));
    const tempProject = await fsMkdtemp(join(tmpdir(), "runwield-plan-retention-bad-project-"));
    try {
        process.env["HOME"] = tempHome;
        process.chdir(tempProject);
        __resetSettingsForTests();

        await setCustomSetting("plans", { archiveRetentionDays: -1, archiveKeepLast: 10 }, "project", tempProject);
        assertThrows(() => getPlanArchiveRetentionPolicy(tempProject), Error, "plans.archiveRetentionDays");

        await setCustomSetting("plans", { archiveRetentionDays: 14, archiveKeepLast: "many" }, "project", tempProject);
        assertThrows(() => getPlanArchiveRetentionPolicy(tempProject), Error, "plans.archiveKeepLast");
    } finally {
        process.chdir(originalCwd);
        if (originalHome === undefined) delete process.env["HOME"];
        else process.env["HOME"] = originalHome;
        __resetSettingsForTests();
        await removeTempDir(tempHome);
        await removeTempDir(tempProject);
    }
});

settingsTest(
    "shouldAutoGenerateWorkRecordsOnPlanCompletion defaults true and only literal nested false disables",
    async () => {
        const originalHome = getHomeDir();
        const originalCwd = getCwd();
        const tempHome = await fsMkdtemp(join(tmpdir(), "runwield-work-record-setting-home-"));
        const tempProject = await fsMkdtemp(join(tmpdir(), "runwield-work-record-setting-project-"));
        try {
            process.env["HOME"] = tempHome;
            process.chdir(tempProject);
            __resetSettingsForTests();

            assertEquals(shouldAutoGenerateWorkRecordsOnPlanCompletion(tempProject), true);

            await setCustomSetting("workRecords", { autoGenerateOnPlanCompletion: "false" }, "project");
            assertEquals(shouldAutoGenerateWorkRecordsOnPlanCompletion(tempProject), true);

            await setCustomSetting("workRecords", { autoGenerateOnPlanCompletion: false }, "project");
            assertEquals(shouldAutoGenerateWorkRecordsOnPlanCompletion(tempProject), false);
        } finally {
            process.chdir(originalCwd);
            if (originalHome === undefined) delete process.env["HOME"];
            else process.env["HOME"] = originalHome;
            __resetSettingsForTests();
            await removeTempDir(tempHome);
            await removeTempDir(tempProject);
        }
    },
);

settingsTest(
    "shouldAutoGenerateWorkRecordsOnPlanCompletion merges global and project workRecords settings",
    async () => {
        const originalHome = getHomeDir();
        const originalCwd = getCwd();
        const tempHome = await fsMkdtemp(join(tmpdir(), "runwield-work-record-merge-home-"));
        const tempProject = await fsMkdtemp(join(tmpdir(), "runwield-work-record-merge-project-"));
        try {
            process.env["HOME"] = tempHome;
            process.chdir(tempProject);
            __resetSettingsForTests();

            await setCustomSetting("workRecords", { autoGenerateOnPlanCompletion: false }, "global");
            assertEquals(shouldAutoGenerateWorkRecordsOnPlanCompletion(tempProject), false);

            await setCustomSetting("workRecords", { autoGenerateOnPlanCompletion: true }, "project");
            assertEquals(shouldAutoGenerateWorkRecordsOnPlanCompletion(tempProject), true);
        } finally {
            process.chdir(originalCwd);
            if (originalHome === undefined) delete process.env["HOME"];
            else process.env["HOME"] = originalHome;
            __resetSettingsForTests();
            await removeTempDir(tempHome);
            await removeTempDir(tempProject);
        }
    },
);

settingsTest("shouldCleanupMergedWorktrees defaults true and honors false setting", async () => {
    const originalHome = getHomeDir();
    const originalCwd = getCwd();
    const tempHome = await fsMkdtemp(join(tmpdir(), "runwield-cleanup-setting-home-"));
    const tempProject = await fsMkdtemp(join(tmpdir(), "runwield-cleanup-setting-project-"));
    try {
        process.env["HOME"] = tempHome;
        process.chdir(tempProject);
        __resetSettingsForTests();

        assertEquals(shouldCleanupMergedWorktrees(tempProject), true);

        await setCustomSetting("cleanupMergedWorktrees", false, "project");
        assertEquals(shouldCleanupMergedWorktrees(tempProject), false);
    } finally {
        process.chdir(originalCwd);
        if (originalHome === undefined) delete process.env["HOME"];
        else process.env["HOME"] = originalHome;
        __resetSettingsForTests();
        await removeTempDir(tempHome);
        await removeTempDir(tempProject);
    }
});

settingsTest("RunWield keeps Pi cache warming off without changing stored settings", async () => {
    const originalHome = process.env["HOME"];
    const originalCwd = getCwd();
    const tempHome = await fsMkdtemp(join(tmpdir(), "runwield-cache-warming-home-"));
    const tempProject = await fsMkdtemp(join(tmpdir(), "runwield-cache-warming-project-"));
    const settingsPath = join(tempHome, ".wld", "settings.json");
    try {
        process.env["HOME"] = tempHome;
        process.chdir(tempProject);
        await fsMkdir(join(tempHome, ".wld"), { recursive: true });

        for (const storedMode of [undefined, "streaming", "idle"]) {
            const stored = storedMode === undefined ? { theme: "dark" } : { theme: "dark", cacheWarming: storedMode };
            await fsWriteFile(settingsPath, JSON.stringify(stored));
            __resetSettingsForTests();

            const manager = getSettingsManager(tempProject);
            assertEquals(manager.getCacheWarmingMode(), "off");
            manager.setCompactionEnabled(false);
            await manager.flush();

            const afterWrite = JSON.parse(await fsReadFile(settingsPath, "utf8"));
            assertEquals(afterWrite.cacheWarming, storedMode);
            __resetSettingsForTests();
            assertEquals(getSettingsManager(tempProject).getCacheWarmingMode(), "off");
            assertEquals(JSON.parse(await fsReadFile(settingsPath, "utf8")).cacheWarming, storedMode);
        }
    } finally {
        process.chdir(originalCwd);
        if (originalHome === undefined) delete process.env["HOME"];
        else process.env["HOME"] = originalHome;
        __resetSettingsForTests();
        await removeTempDir(tempHome);
        await removeTempDir(tempProject);
    }
});

settingsTest("compaction token setters persist globally and preserve sibling compaction fields", async () => {
    const originalHome = getHomeDir();
    const originalCwd = getCwd();
    const tempHome = await fsMkdtemp(join(tmpdir(), "runwield-compaction-setting-home-"));
    const tempProject = await fsMkdtemp(join(tmpdir(), "runwield-compaction-setting-project-"));
    try {
        process.env["HOME"] = tempHome;
        process.chdir(tempProject);
        __resetSettingsForTests();

        getSettingsManager().setCompactionEnabled(false);
        await getSettingsManager().flush();
        await setCompactionReserveTokens(12000);
        await setCompactionKeepRecentTokens(34000);

        const settings = getSettingsManager().getCompactionSettings();
        assertEquals(settings, { enabled: false, reserveTokens: 12000, keepRecentTokens: 34000 });
        assertEquals(JSON.parse(await fsReadFile(join(tempHome, ".wld", "settings.json"), "utf8")).compaction, {
            enabled: false,
            reserveTokens: 12000,
            keepRecentTokens: 34000,
        });
    } finally {
        process.chdir(originalCwd);
        if (originalHome === undefined) delete process.env["HOME"];
        else process.env["HOME"] = originalHome;
        __resetSettingsForTests();
        await removeTempDir(tempHome);
        await removeTempDir(tempProject);
    }
});

settingsTest("compaction token setters reject invalid values before writing", async () => {
    const originalHome = getHomeDir();
    const originalCwd = getCwd();
    const tempHome = await fsMkdtemp(join(tmpdir(), "runwield-compaction-invalid-home-"));
    const tempProject = await fsMkdtemp(join(tmpdir(), "runwield-compaction-invalid-project-"));
    try {
        process.env["HOME"] = tempHome;
        process.chdir(tempProject);
        __resetSettingsForTests();

        let message = "";
        try {
            await setCompactionReserveTokens(0);
        } catch (error) {
            message = error instanceof Error ? error.message : String(error);
        }
        assertEquals(message, "Reserve tokens must be a positive integer.");
        assertEquals(getSettingsManager().getCompactionSettings().reserveTokens, 16384);
    } finally {
        process.chdir(originalCwd);
        if (originalHome === undefined) delete process.env["HOME"];
        else process.env["HOME"] = originalHome;
        __resetSettingsForTests();
        await removeTempDir(tempHome);
        await removeTempDir(tempProject);
    }
});

settingsTest("getGuidedReviewMode defaults auto, honors overrides, and rejects invalid values", async () => {
    const originalHome = getHomeDir();
    const originalCwd = getCwd();
    const tempHome = await fsMkdtemp(join(tmpdir(), "runwield-guided-review-setting-home-"));
    const tempProject = await fsMkdtemp(join(tmpdir(), "runwield-guided-review-setting-project-"));
    try {
        process.env["HOME"] = tempHome;
        process.chdir(tempProject);
        __resetSettingsForTests();

        assertEquals(getGuidedReviewMode(tempProject), "auto");

        await setCustomSetting("guidedReview", " ALWAYS ", "global");
        assertEquals(getGuidedReviewMode(tempProject), "always");

        await setCustomSetting("guidedReview", "ask", "project");
        assertEquals(getGuidedReviewMode(tempProject), "ask");

        await setCustomSetting("guidedReview", "none", "project");
        assertEquals(getGuidedReviewMode(tempProject), "none");

        await setCustomSetting("guidedReview", "sometimes", "project");
        assertEquals(getGuidedReviewMode(tempProject), "none");
    } finally {
        process.chdir(originalCwd);
        if (originalHome === undefined) delete process.env["HOME"];
        else process.env["HOME"] = originalHome;
        __resetSettingsForTests();
        await removeTempDir(tempHome);
        await removeTempDir(tempProject);
    }
});

settingsTest("getCodeReviewMode defaults ask and preserves explicit review choices", async () => {
    const originalHome = getHomeDir();
    const originalCwd = getCwd();
    const tempHome = await fsMkdtemp(join(tmpdir(), "runwield-codereview-setting-home-"));
    const tempProject = await fsMkdtemp(join(tmpdir(), "runwield-codereview-setting-project-"));
    try {
        process.env["HOME"] = tempHome;
        process.chdir(tempProject);
        __resetSettingsForTests();

        assertEquals(getCodeReviewMode(tempProject), "ask");

        await setCustomSetting("codereview", "none", "global");
        assertEquals(getCodeReviewMode(tempProject), "none");

        await setCustomSetting("codereview", " ALWAYS ", "global");
        assertEquals(getCodeReviewMode(tempProject), "always");

        await setCustomSetting("codereview", "ask", "project");
        assertEquals(getCodeReviewMode(tempProject), "ask");

        await setCustomSetting("codereview", "sometimes", "project");
        assertEquals(getCodeReviewMode(tempProject), "none");
    } finally {
        process.chdir(originalCwd);
        if (originalHome === undefined) delete process.env["HOME"];
        else process.env["HOME"] = originalHome;
        __resetSettingsForTests();
        await removeTempDir(tempHome);
        await removeTempDir(tempProject);
    }
});

settingsTest("Plan Server URL setting uses global value and project override precedence", async () => {
    const originalHome = getHomeDir();
    const originalCwd = getCwd();
    const tempHome = await fsMkdtemp(join(tmpdir(), "runwield-plan-server-home-"));
    const tempProject = await fsMkdtemp(join(tmpdir(), "runwield-plan-server-project-"));
    try {
        process.env["HOME"] = tempHome;
        process.chdir(tempProject);
        __resetSettingsForTests();

        await setDefaultPlanServerUrl("https://global.example.test/", "global");
        assertEquals(getDefaultPlanServerUrl(), "https://global.example.test");
        await setDefaultPlanServerUrl("https://project.example.test/base/", "project");
        assertEquals(getDefaultPlanServerUrl(), "https://project.example.test/base");
    } finally {
        __resetSettingsForTests();
        process.chdir(originalCwd);
        if (originalHome === undefined) delete process.env["HOME"];
        else process.env["HOME"] = originalHome;
        await removeTempDir(tempHome);
        await removeTempDir(tempProject);
    }
});

settingsTest("Plan Server URL setting rejects full share URLs and secret fragments", async () => {
    await assertRejects(() =>
        setDefaultPlanServerUrl("https://plans.example.test/p/space-1#key=secret&cap=secret", "project"),
    );
});

settingsTest("Plan Server URL setting stores only the normalized server URL", async () => {
    const originalHome = getHomeDir();
    const originalCwd = getCwd();
    const tempHome = await fsMkdtemp(join(tmpdir(), "runwield-plan-server-clean-home-"));
    const tempProject = await fsMkdtemp(join(tmpdir(), "runwield-plan-server-clean-project-"));
    try {
        process.env["HOME"] = tempHome;
        process.chdir(tempProject);
        __resetSettingsForTests();
        await setDefaultPlanServerUrl("https://plans.example.test/root/", "project");
        const settings = await fsReadFile(join(tempProject, ".wld", "settings.json"), "utf8");
        assertEquals(JSON.parse(settings)[PLAN_SERVER_URL_SETTING_KEY], "https://plans.example.test/root");
    } finally {
        __resetSettingsForTests();
        process.chdir(originalCwd);
        if (originalHome === undefined) delete process.env["HOME"];
        else process.env["HOME"] = originalHome;
        await removeTempDir(tempHome);
        await removeTempDir(tempProject);
    }
});
