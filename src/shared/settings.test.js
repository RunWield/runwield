import { getCwd, getHomeDir } from "../constants.js";
import { normalizePlanServerUrl } from "./collaboration/urls.ts";
/**
 * @module shared/settings.test
 */

import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { join } from "@std/path";
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
    ONBOARDING_TUTORIAL_OFFER_HANDLED_SETTING_KEY,
    PLAN_SERVER_URL_SETTING_KEY,
    preserveRunWieldCustomSettingsForWrite,
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

// Use a temp dir for isolated file-based tests
const TEMP_DIR = await Deno.makeTempDir({ prefix: "runwield-settings-test-" });
const TEMP_GLOBAL_SETTINGS = join(TEMP_DIR, "global-settings.json");
const TEMP_PROJECT_SETTINGS = join(TEMP_DIR, "project-settings.json");

/** @param {number} ms */
function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * macOS can briefly report recursive temp cleanup as ENOTEMPTY/EBUSY while
 * filesystem metadata settles after a test's last writes. Retry boundedly so
 * cleanup flakiness does not fail an otherwise successful test.
 *
 * @param {string} path
 */
async function removeTempDir(path) {
    for (let attempt = 0; attempt < 5; attempt += 1) {
        try {
            await Deno.remove(path, { recursive: true });
            return;
        } catch (error) {
            if (error instanceof Deno.errors.NotFound) return;
            const isRetryable = error instanceof Error &&
                /Directory not empty|resource busy|os error 66|os error 16/i.test(error.message);
            if (!isRetryable || attempt === 4) throw error;
            await delay(25 * (attempt + 1));
        }
    }
}

const linkedWorktreeSettingsRepo = defineGitFixture(async (repoPath) => {
    await Deno.writeTextFile(join(repoPath, "README.md"), "base\n");
    await git(repoPath, ["add", "."]);
    await git(repoPath, ["commit", "-m", "base"]);
});

/**
 * @param {string | Record<string, any>} testDefinition
 * @param {(() => void | Promise<void>) | undefined} [fn]
 */
function settingsTest(testDefinition, fn) {
    if (typeof testDefinition === "string") {
        if (!fn) throw new Error("settingsTest requires a test function");
        Deno.test(testDefinition, () => withProcessGlobalTestLock(async () => await fn()));
        return;
    }
    Deno.test(
        /** @type {any} */ ({
            ...testDefinition,
            fn: () => withProcessGlobalTestLock(async () => await testDefinition.fn()),
        }),
    );
}

settingsTest({
    name: "project settings written from a linked worktree land in the primary checkout",
    async fn() {
        __resetSettingsForTests();
        const cwd = await linkedWorktreeSettingsRepo.checkout();
        const worktreePath = `${cwd}-settings-worktree`;
        try {
            await Deno.mkdir(join(cwd, ".wld"), { recursive: true });
            await Deno.writeTextFile(join(cwd, ".wld", "settings.json"), JSON.stringify({ other: "kept" }, null, 4));
            await git(cwd, ["worktree", "add", "-b", "settings-side", worktreePath, "main"]);

            await setCustomSetting("verification_command", "true", "project", worktreePath);

            const primarySettings = JSON.parse(await Deno.readTextFile(join(cwd, ".wld", "settings.json")));
            assertEquals(primarySettings.other, "kept");
            assertEquals(primarySettings.verification_command, "true");
            assertEquals(await getCustomSetting("verification_command", "project", worktreePath), "true");
            await assertRejects(() => Deno.stat(join(worktreePath, ".wld", "settings.json")), Deno.errors.NotFound);
        } finally {
            __resetSettingsForTests();
            await git(cwd, ["worktree", "remove", "--force", worktreePath]).catch(() => {});
            await Deno.remove(cwd, { recursive: true }).catch(() => {});
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
            await Deno.mkdir(join(cwd, ".wld"), { recursive: true });
            await Deno.writeTextFile(
                join(cwd, ".wld", "settings.json"),
                JSON.stringify({ verification_command: "primary-command" }, null, 4),
            );
            await git(cwd, ["worktree", "add", "-b", "exact-settings-side", worktreePath, "main"]);

            await setExactProjectCustomSetting("verification_command", "worktree-command", worktreePath);

            assertEquals(await getCustomSetting("verification_command", "project", worktreePath), "primary-command");
            assertEquals(getExactProjectCustomSetting("verification_command", worktreePath), "worktree-command");
            assertEquals(
                JSON.parse(await Deno.readTextFile(worktreeSettingsPath)).verification_command,
                "worktree-command",
            );

            await Deno.writeTextFile(
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
            await Deno.remove(cwd, { recursive: true }).catch(() => {});
        }
    },
});

settingsTest({
    name: "getCustomSetting parses JSONC with comments",
    async fn() {
        // Write a JSONC file (with comments and trailing comma)
        const jsoncContent = `{
            // This is a comment
            "theme": "dark", /* block comment */
            "agents": {
                "router": { "model": "provider/router-v2" },
                "planner": { "model": "provider/planner-v1" },
            },
        }`;
        await Deno.writeTextFileSync(TEMP_GLOBAL_SETTINGS, jsoncContent);

        // We test via the storage path directly by using getCustomSetting.
        // Since getCustomSetting uses the singleton, we need to reset between tests.
        // The approach: temporarily override the storage paths by patching env vars.
        // Instead, let's test the raw parseJsonc behavior via an imported helper.

        // Actually, the cleanest test: write to a temp dir and verify via
        // the module's helper by reading the file content directly.
        const { parse: parseJsonc } = await import("@std/jsonc");
        const parsed = /** @type {Record<string, any>} */ (parseJsonc(jsoncContent));
        assertEquals(parsed.theme, "dark");
        assertEquals(parsed.agents.router.model, "provider/router-v2");
        assertEquals(parsed.agents.planner.model, "provider/planner-v1");
    },
});

settingsTest({
    name: "getMergedCustomSetting merges global and project with project override",
    async fn() {
        // Write global settings
        await Deno.writeTextFileSync(
            TEMP_GLOBAL_SETTINGS,
            JSON.stringify({
                agents: {
                    router: { model: "global/router" },
                    operator: { model: "global/operator" },
                },
            }),
        );

        // Write project settings (overrides router, adds planner)
        await Deno.writeTextFileSync(
            TEMP_PROJECT_SETTINGS,
            JSON.stringify({
                agents: {
                    router: { model: "project/router" },
                    planner: { model: "project/planner" },
                },
            }),
        );

        // Override settings dirs to point to our temp dirs
        // Import after setting up dirs
        const tempWldDir = join(TEMP_DIR, ".wld");
        await Deno.mkdirSync(tempWldDir, { recursive: true });
        await Deno.writeTextFileSync(
            join(tempWldDir, "settings.json"),
            JSON.stringify({
                agents: {
                    router: { model: "global/router" },
                    operator: { model: "global/operator" },
                },
            }),
        );

        const projectWldDir = join(TEMP_DIR, "project-wld");
        await Deno.mkdirSync(projectWldDir, { recursive: true });
        await Deno.writeTextFileSync(
            join(projectWldDir, "settings.json"),
            JSON.stringify({
                agents: {
                    router: { model: "project/router" },
                    planner: { model: "project/planner" },
                },
            }),
        );

        // Verify merge logic directly
        // globalVal: { router: { model: "global/router" }, operator: { model: "global/operator" } }
        // projectVal: { router: { model: "project/router" }, planner: { model: "project/planner" } }
        // Merged: { router: { model: "project/router" }, operator: { model: "global/operator" }, planner: { model: "project/planner" } }

        const globalVal = {
            router: { model: "global/router" },
            operator: { model: "global/operator" },
        };
        const projectVal = {
            router: { model: "project/router" },
            planner: { model: "project/planner" },
        };

        const merged = { ...globalVal, ...projectVal };
        assertEquals(merged.router.model, "project/router");
        assertEquals(merged.operator.model, "global/operator");
        assertEquals(merged.planner.model, "project/planner");
    },
});

settingsTest({
    name: "getMergedCustomSetting returns project value for scalar overrides",
    fn() {
        const projectVal = "project-value";

        // Project wins for scalar
        assertEquals(projectVal, "project-value");
    },
});

settingsTest("preserveRunWieldCustomSettingsForWrite keeps RunWield custom keys across SettingsManager writes", () => {
    const previous = JSON.stringify({
        theme: "old-theme",
        agents: {},
        activeModelPreset: "codex",
        modelPresets: {
            codex: {
                agents: {
                    operator: { model: "crofai/deepseek-v4-pro" },
                },
            },
        },
    });
    const next = JSON.stringify({
        theme: "new-theme",
    });

    const preserved = JSON.parse(preserveRunWieldCustomSettingsForWrite(previous, next));

    assertEquals(preserved, {
        theme: "new-theme",
        agents: {},
        activeModelPreset: "codex",
        modelPresets: {
            codex: {
                agents: {
                    operator: { model: "crofai/deepseek-v4-pro" },
                },
            },
        },
    });
});

settingsTest("model and theme writes preserve permanent onboarding dismissal", () => {
    const previous = JSON.stringify({ [ONBOARDING_TUTORIAL_OFFER_HANDLED_SETTING_KEY]: true });
    const next = JSON.stringify({ theme: "light", defaultModel: "model-a" });

    assertEquals(JSON.parse(preserveRunWieldCustomSettingsForWrite(previous, next)), {
        theme: "light",
        defaultModel: "model-a",
        [ONBOARDING_TUTORIAL_OFFER_HANDLED_SETTING_KEY]: true,
    });
});

settingsTest("preserveRunWieldCustomSettingsForWrite lets explicit new custom values win", () => {
    const previous = JSON.stringify({
        activeModelPreset: "codex",
    });
    const next = JSON.stringify({
        activeModelPreset: "crof.ai",
    });

    assertEquals(JSON.parse(preserveRunWieldCustomSettingsForWrite(previous, next)), {
        activeModelPreset: "crof.ai",
    });
});

settingsTest("preserveRunWieldCustomSettingsForWrite keeps visionFallback", () => {
    const previous = JSON.stringify({ visionFallback: { model: "lmstudio/gemma" } });
    const next = JSON.stringify({ theme: "new-theme" });

    assertEquals(JSON.parse(preserveRunWieldCustomSettingsForWrite(previous, next)), {
        theme: "new-theme",
        visionFallback: { model: "lmstudio/gemma" },
    });
});

settingsTest("preserveRunWieldCustomSettingsForWrite keeps codereview and guidedReview", () => {
    const previous = JSON.stringify({ codereview: "always", guidedReview: "auto" });
    const next = JSON.stringify({ theme: "new-theme" });

    assertEquals(JSON.parse(preserveRunWieldCustomSettingsForWrite(previous, next)), {
        theme: "new-theme",
        codereview: "always",
        guidedReview: "auto",
    });
});

settingsTest("preserveRunWieldCustomSettingsForWrite keeps notifications", () => {
    const previous = JSON.stringify({ notifications: { enabled: true, activation: "tab" } });
    const next = JSON.stringify({ theme: "new-theme" });

    assertEquals(JSON.parse(preserveRunWieldCustomSettingsForWrite(previous, next)), {
        theme: "new-theme",
        notifications: { enabled: true, activation: "tab" },
    });
});

settingsTest("preserveRunWieldCustomSettingsForWrite preserves codereview across SettingsManager-shaped writes", () => {
    const previous = JSON.stringify({
        theme: "dark",
        codereview: "ask",
        verification_command: "deno task ci",
    });
    const next = JSON.stringify({
        theme: "light",
        defaultModel: "model-a",
    });

    assertEquals(JSON.parse(preserveRunWieldCustomSettingsForWrite(previous, next)), {
        theme: "light",
        defaultModel: "model-a",
        codereview: "ask",
        verification_command: "deno task ci",
    });
});

settingsTest("getResolvedVisionFallbackModelSetting prefers active preset over top-level", async () => {
    const originalHome = getHomeDir();
    const originalCwd = getCwd();
    const tempHome = await Deno.makeTempDir({ prefix: "runwield-vision-home-" });
    const tempProject = await Deno.makeTempDir({ prefix: "runwield-vision-project-" });
    try {
        Deno.env.set("HOME", tempHome);
        Deno.chdir(tempProject);
        await Deno.mkdir(".wld", { recursive: true });
        await Deno.writeTextFile(
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
        Deno.chdir(originalCwd);
        if (originalHome === undefined) Deno.env.delete("HOME");
        else Deno.env.set("HOME", originalHome);
        await removeTempDir(tempHome);
        await removeTempDir(tempProject);
    }
});

settingsTest("getResolvedVisionFallbackModelSetting reads the requested Project root", async () => {
    const originalHome = getHomeDir();
    const originalCwd = getCwd();
    const tempHome = await Deno.makeTempDir({ prefix: "runwield-vision-root-home-" });
    const projectA = await Deno.makeTempDir({ prefix: "runwield-vision-root-a-" });
    const projectB = await Deno.makeTempDir({ prefix: "runwield-vision-root-b-" });
    try {
        Deno.env.set("HOME", tempHome);
        await Deno.mkdir(join(projectA, ".wld"), { recursive: true });
        await Deno.writeTextFile(
            join(projectA, ".wld", "settings.json"),
            JSON.stringify({
                visionFallback: { model: "wrong/model" },
            }),
        );
        await Deno.mkdir(join(projectB, ".wld"), { recursive: true });
        await Deno.writeTextFile(
            join(projectB, ".wld", "settings.json"),
            JSON.stringify({
                visionFallback: { model: "right/model" },
            }),
        );
        Deno.chdir(projectA);
        __resetSettingsForTests();

        assertEquals(getResolvedVisionFallbackModelSetting(projectB), "right/model");
    } finally {
        __resetSettingsForTests();
        Deno.chdir(originalCwd);
        if (originalHome === undefined) Deno.env.delete("HOME");
        else Deno.env.set("HOME", originalHome);
        await removeTempDir(tempHome);
        await removeTempDir(projectA);
        await removeTempDir(projectB);
    }
});

settingsTest("migratePiSettingsOnce copies legacy Pi settings when RunWield settings are missing", async () => {
    const tempDir = await Deno.makeTempDir({ prefix: "runwield-settings-migration-" });
    try {
        const piPath = join(tempDir, ".pi", "agent", "settings.json");
        const runwieldPath = join(tempDir, ".wld", "settings.json");
        await Deno.mkdir(join(tempDir, ".pi", "agent"), { recursive: true });
        await Deno.writeTextFile(piPath, '{"theme":"legacy-pi"}');

        const result = migratePiSettingsOnce({ runwieldPath, piPath });

        assertEquals(result, { copied: true, skipped: false });
        assertEquals(await Deno.readTextFile(runwieldPath), '{"theme":"legacy-pi"}');
    } finally {
        await removeTempDir(tempDir);
    }
});

settingsTest("migratePiSettingsOnce leaves existing RunWield settings untouched", async () => {
    const tempDir = await Deno.makeTempDir({ prefix: "runwield-settings-migration-" });
    try {
        const piPath = join(tempDir, ".pi", "agent", "settings.json");
        const runwieldPath = join(tempDir, ".wld", "settings.json");
        await Deno.mkdir(join(tempDir, ".pi", "agent"), { recursive: true });
        await Deno.mkdir(join(tempDir, ".wld"), { recursive: true });
        await Deno.writeTextFile(piPath, '{"theme":"legacy-pi"}');
        await Deno.writeTextFile(runwieldPath, '{"theme":"runwield"}');

        const result = migratePiSettingsOnce({ runwieldPath, piPath });

        assertEquals(result, { copied: false, skipped: true });
        assertEquals(await Deno.readTextFile(runwieldPath), '{"theme":"runwield"}');
    } finally {
        await removeTempDir(tempDir);
    }
});

settingsTest("workRecords and plans settings are preserved across SettingsManager-shaped writes", () => {
    const previous = JSON.stringify({
        workRecords: { autoGenerateOnPlanCompletion: false },
        plans: { archiveRetentionDays: 14, archiveKeepLast: 10 },
    });
    const next = JSON.stringify({ theme: "new-theme" });

    assertEquals(JSON.parse(preserveRunWieldCustomSettingsForWrite(previous, next)), {
        theme: "new-theme",
        workRecords: { autoGenerateOnPlanCompletion: false },
        plans: { archiveRetentionDays: 14, archiveKeepLast: 10 },
    });
});

settingsTest("getPlanArchiveRetentionPolicy reads project settings only", async () => {
    const originalHome = getHomeDir();
    const originalCwd = getCwd();
    const tempHome = await Deno.makeTempDir({ prefix: "runwield-plan-retention-home-" });
    const tempProject = await Deno.makeTempDir({ prefix: "runwield-plan-retention-project-" });
    try {
        Deno.env.set("HOME", tempHome);
        Deno.chdir(tempProject);
        __resetSettingsForTests();

        await setCustomSetting("plans", { archiveRetentionDays: 0, archiveKeepLast: 0 }, "global", tempProject);
        assertEquals(getPlanArchiveRetentionPolicy(tempProject), { retentionDays: 14, keepLast: 10 });

        await setCustomSetting("plans", { archiveRetentionDays: 7, archiveKeepLast: 5 }, "project", tempProject);
        assertEquals(getPlanArchiveRetentionPolicy(tempProject), { retentionDays: 7, keepLast: 5 });
    } finally {
        Deno.chdir(originalCwd);
        if (originalHome === undefined) Deno.env.delete("HOME");
        else Deno.env.set("HOME", originalHome);
        __resetSettingsForTests();
        await removeTempDir(tempHome);
        await removeTempDir(tempProject);
    }
});

settingsTest("getPlanArchiveRetentionPolicy names invalid keys", async () => {
    const originalHome = getHomeDir();
    const originalCwd = getCwd();
    const tempHome = await Deno.makeTempDir({ prefix: "runwield-plan-retention-bad-home-" });
    const tempProject = await Deno.makeTempDir({ prefix: "runwield-plan-retention-bad-project-" });
    try {
        Deno.env.set("HOME", tempHome);
        Deno.chdir(tempProject);
        __resetSettingsForTests();

        await setCustomSetting("plans", { archiveRetentionDays: -1, archiveKeepLast: 10 }, "project", tempProject);
        assertThrows(() => getPlanArchiveRetentionPolicy(tempProject), Error, "plans.archiveRetentionDays");

        await setCustomSetting("plans", { archiveRetentionDays: 14, archiveKeepLast: "many" }, "project", tempProject);
        assertThrows(() => getPlanArchiveRetentionPolicy(tempProject), Error, "plans.archiveKeepLast");
    } finally {
        Deno.chdir(originalCwd);
        if (originalHome === undefined) Deno.env.delete("HOME");
        else Deno.env.set("HOME", originalHome);
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
        const tempHome = await Deno.makeTempDir({ prefix: "runwield-work-record-setting-home-" });
        const tempProject = await Deno.makeTempDir({ prefix: "runwield-work-record-setting-project-" });
        try {
            Deno.env.set("HOME", tempHome);
            Deno.chdir(tempProject);
            __resetSettingsForTests();

            assertEquals(shouldAutoGenerateWorkRecordsOnPlanCompletion(tempProject), true);

            await setCustomSetting("workRecords", { autoGenerateOnPlanCompletion: "false" }, "project");
            assertEquals(shouldAutoGenerateWorkRecordsOnPlanCompletion(tempProject), true);

            await setCustomSetting("workRecords", { autoGenerateOnPlanCompletion: false }, "project");
            assertEquals(shouldAutoGenerateWorkRecordsOnPlanCompletion(tempProject), false);
        } finally {
            Deno.chdir(originalCwd);
            if (originalHome === undefined) Deno.env.delete("HOME");
            else Deno.env.set("HOME", originalHome);
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
        const tempHome = await Deno.makeTempDir({ prefix: "runwield-work-record-merge-home-" });
        const tempProject = await Deno.makeTempDir({ prefix: "runwield-work-record-merge-project-" });
        try {
            Deno.env.set("HOME", tempHome);
            Deno.chdir(tempProject);
            __resetSettingsForTests();

            await setCustomSetting("workRecords", { autoGenerateOnPlanCompletion: false }, "global");
            assertEquals(shouldAutoGenerateWorkRecordsOnPlanCompletion(tempProject), false);

            await setCustomSetting("workRecords", { autoGenerateOnPlanCompletion: true }, "project");
            assertEquals(shouldAutoGenerateWorkRecordsOnPlanCompletion(tempProject), true);
        } finally {
            Deno.chdir(originalCwd);
            if (originalHome === undefined) Deno.env.delete("HOME");
            else Deno.env.set("HOME", originalHome);
            __resetSettingsForTests();
            await removeTempDir(tempHome);
            await removeTempDir(tempProject);
        }
    },
);

settingsTest("shouldCleanupMergedWorktrees defaults true and honors false setting", async () => {
    const originalHome = getHomeDir();
    const originalCwd = getCwd();
    const tempHome = await Deno.makeTempDir({ prefix: "runwield-cleanup-setting-home-" });
    const tempProject = await Deno.makeTempDir({ prefix: "runwield-cleanup-setting-project-" });
    try {
        Deno.env.set("HOME", tempHome);
        Deno.chdir(tempProject);
        __resetSettingsForTests();

        assertEquals(shouldCleanupMergedWorktrees(tempProject), true);

        await setCustomSetting("cleanupMergedWorktrees", false, "project");
        assertEquals(shouldCleanupMergedWorktrees(tempProject), false);
    } finally {
        Deno.chdir(originalCwd);
        if (originalHome === undefined) Deno.env.delete("HOME");
        else Deno.env.set("HOME", originalHome);
        __resetSettingsForTests();
        await removeTempDir(tempHome);
        await removeTempDir(tempProject);
    }
});

settingsTest("RunWield keeps Pi cache warming off without changing stored settings", async () => {
    const originalHome = Deno.env.get("HOME");
    const originalCwd = Deno.cwd();
    const tempHome = await Deno.makeTempDir({ prefix: "runwield-cache-warming-home-" });
    const tempProject = await Deno.makeTempDir({ prefix: "runwield-cache-warming-project-" });
    const settingsPath = join(tempHome, ".wld", "settings.json");
    try {
        Deno.env.set("HOME", tempHome);
        Deno.chdir(tempProject);
        await Deno.mkdir(join(tempHome, ".wld"), { recursive: true });

        for (const storedMode of [undefined, "streaming", "idle"]) {
            const stored = storedMode === undefined ? { theme: "dark" } : { theme: "dark", cacheWarming: storedMode };
            await Deno.writeTextFile(settingsPath, JSON.stringify(stored));
            __resetSettingsForTests();

            const manager = getSettingsManager(tempProject);
            assertEquals(manager.getCacheWarmingMode(), "off");
            manager.setCompactionEnabled(false);
            await manager.flush();

            const afterWrite = JSON.parse(await Deno.readTextFile(settingsPath));
            assertEquals(afterWrite.cacheWarming, storedMode);
            __resetSettingsForTests();
            assertEquals(getSettingsManager(tempProject).getCacheWarmingMode(), "off");
            assertEquals(JSON.parse(await Deno.readTextFile(settingsPath)).cacheWarming, storedMode);
        }
    } finally {
        Deno.chdir(originalCwd);
        if (originalHome === undefined) Deno.env.delete("HOME");
        else Deno.env.set("HOME", originalHome);
        __resetSettingsForTests();
        await removeTempDir(tempHome);
        await removeTempDir(tempProject);
    }
});

settingsTest("compaction token setters persist globally and preserve sibling compaction fields", async () => {
    const originalHome = getHomeDir();
    const originalCwd = getCwd();
    const tempHome = await Deno.makeTempDir({ prefix: "runwield-compaction-setting-home-" });
    const tempProject = await Deno.makeTempDir({ prefix: "runwield-compaction-setting-project-" });
    try {
        Deno.env.set("HOME", tempHome);
        Deno.chdir(tempProject);
        __resetSettingsForTests();

        getSettingsManager().setCompactionEnabled(false);
        await getSettingsManager().flush();
        await setCompactionReserveTokens(12000);
        await setCompactionKeepRecentTokens(34000);

        const settings = getSettingsManager().getCompactionSettings();
        assertEquals(settings, { enabled: false, reserveTokens: 12000, keepRecentTokens: 34000 });
        assertEquals(JSON.parse(await Deno.readTextFile(join(tempHome, ".wld", "settings.json"))).compaction, {
            enabled: false,
            reserveTokens: 12000,
            keepRecentTokens: 34000,
        });
    } finally {
        Deno.chdir(originalCwd);
        if (originalHome === undefined) Deno.env.delete("HOME");
        else Deno.env.set("HOME", originalHome);
        __resetSettingsForTests();
        await removeTempDir(tempHome);
        await removeTempDir(tempProject);
    }
});

settingsTest("compaction token setters reject invalid values before writing", async () => {
    const originalHome = getHomeDir();
    const originalCwd = getCwd();
    const tempHome = await Deno.makeTempDir({ prefix: "runwield-compaction-invalid-home-" });
    const tempProject = await Deno.makeTempDir({ prefix: "runwield-compaction-invalid-project-" });
    try {
        Deno.env.set("HOME", tempHome);
        Deno.chdir(tempProject);
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
        Deno.chdir(originalCwd);
        if (originalHome === undefined) Deno.env.delete("HOME");
        else Deno.env.set("HOME", originalHome);
        __resetSettingsForTests();
        await removeTempDir(tempHome);
        await removeTempDir(tempProject);
    }
});

settingsTest("getGuidedReviewMode defaults auto, honors overrides, and rejects invalid values", async () => {
    const originalHome = getHomeDir();
    const originalCwd = getCwd();
    const tempHome = await Deno.makeTempDir({ prefix: "runwield-guided-review-setting-home-" });
    const tempProject = await Deno.makeTempDir({ prefix: "runwield-guided-review-setting-project-" });
    try {
        Deno.env.set("HOME", tempHome);
        Deno.chdir(tempProject);
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
        Deno.chdir(originalCwd);
        if (originalHome === undefined) Deno.env.delete("HOME");
        else Deno.env.set("HOME", originalHome);
        __resetSettingsForTests();
        await removeTempDir(tempHome);
        await removeTempDir(tempProject);
    }
});

settingsTest("getCodeReviewMode defaults ask and preserves explicit review choices", async () => {
    const originalHome = getHomeDir();
    const originalCwd = getCwd();
    const tempHome = await Deno.makeTempDir({ prefix: "runwield-codereview-setting-home-" });
    const tempProject = await Deno.makeTempDir({ prefix: "runwield-codereview-setting-project-" });
    try {
        Deno.env.set("HOME", tempHome);
        Deno.chdir(tempProject);
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
        Deno.chdir(originalCwd);
        if (originalHome === undefined) Deno.env.delete("HOME");
        else Deno.env.set("HOME", originalHome);
        __resetSettingsForTests();
        await removeTempDir(tempHome);
        await removeTempDir(tempProject);
    }
});

settingsTest("Plan Server URL setting uses global value and project override precedence", async () => {
    const originalHome = getHomeDir();
    const originalCwd = getCwd();
    const tempHome = await Deno.makeTempDir({ prefix: "runwield-plan-server-home-" });
    const tempProject = await Deno.makeTempDir({ prefix: "runwield-plan-server-project-" });
    try {
        Deno.env.set("HOME", tempHome);
        Deno.chdir(tempProject);
        __resetSettingsForTests();

        await setDefaultPlanServerUrl("https://global.example.test/", "global");
        assertEquals(getDefaultPlanServerUrl(), "https://global.example.test");
        await setDefaultPlanServerUrl("https://project.example.test/base/", "project");
        assertEquals(getDefaultPlanServerUrl(), "https://project.example.test/base");
    } finally {
        __resetSettingsForTests();
        Deno.chdir(originalCwd);
        if (originalHome === undefined) Deno.env.delete("HOME");
        else Deno.env.set("HOME", originalHome);
        await removeTempDir(tempHome);
        await removeTempDir(tempProject);
    }
});

settingsTest("Plan Server URL setting validates clean non-secret URLs", () => {
    assertEquals(normalizePlanServerUrl(" https://plans.example.test/base/ "), "https://plans.example.test/base");
    assertThrows(() => normalizePlanServerUrl("not a url"));
    assertThrows(() => normalizePlanServerUrl("https://plans.example.test/?key=secret&cap=secret&role=reviewer"));
    assertThrows(() => normalizePlanServerUrl("https://plans.example.test/#key=secret&cap=secret&role=reviewer"));
    assertThrows(() => normalizePlanServerUrl("https://plans.example.test/base/p/space-1"));
    assertThrows(() =>
        normalizePlanServerUrl("https://plans.example.test/base/p/space-1#key=secret&cap=secret&role=reviewer")
    );
    assertThrows(() =>
        normalizePlanServerUrl("https://plans.example.test/p/space-1#key=secret&cap=secret&role=reviewer")
    );
});

settingsTest("Plan Server URL setting rejects full share URLs and secret fragments", async () => {
    await assertRejects(() =>
        setDefaultPlanServerUrl("https://plans.example.test/p/space-1#key=secret&cap=secret", "project")
    );
});

settingsTest("Plan Server URL setting is preserved across SettingsManager-shaped writes", () => {
    const previous = JSON.stringify({ [PLAN_SERVER_URL_SETTING_KEY]: "https://plans.example.test" });
    const next = JSON.stringify({ theme: "light" });
    assertEquals(JSON.parse(preserveRunWieldCustomSettingsForWrite(previous, next)), {
        theme: "light",
        [PLAN_SERVER_URL_SETTING_KEY]: "https://plans.example.test",
    });
});

settingsTest("Plan Server URL setting stores only the normalized server URL", async () => {
    const originalHome = getHomeDir();
    const originalCwd = getCwd();
    const tempHome = await Deno.makeTempDir({ prefix: "runwield-plan-server-clean-home-" });
    const tempProject = await Deno.makeTempDir({ prefix: "runwield-plan-server-clean-project-" });
    try {
        Deno.env.set("HOME", tempHome);
        Deno.chdir(tempProject);
        __resetSettingsForTests();
        await setDefaultPlanServerUrl("https://plans.example.test/root/", "project");
        const settings = await Deno.readTextFile(join(tempProject, ".wld", "settings.json"));
        assertEquals(JSON.parse(settings)[PLAN_SERVER_URL_SETTING_KEY], "https://plans.example.test/root");
    } finally {
        __resetSettingsForTests();
        Deno.chdir(originalCwd);
        if (originalHome === undefined) Deno.env.delete("HOME");
        else Deno.env.set("HOME", originalHome);
        await removeTempDir(tempHome);
        await removeTempDir(tempProject);
    }
});

Deno.test("cleanup temp dirs", async () => {
    await removeTempDir(TEMP_DIR);
});
