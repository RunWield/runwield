import { openNativeFileLock } from "../../shared/native-file-lock.ts";
import { realpathSync as fsRealpathSync } from "node:fs";
import { test } from "node:test";
import {
    mkdir as fsMkdir,
    mkdtemp as fsMkdtemp,
    readFile as fsReadFile,
    rm as fsRm,
    stat as fsStat,
    utimes as fsUtimes,
    writeFile as fsWriteFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { getCwd } from "../../constants.js";
import process from "node:process";
import { assertEquals, assertRejects } from "../../testing/assertions.ts";
import { dirname, join } from "node:path";
import { injectFrontMatter, listPlans, savePlan } from "../../plan-store.js";
import { getRunWieldRuntimeDir, PROJECT_INTERNAL_RUNTIME_DIR_NAME } from "../../constants.js";
import { addEntry, findById, getWorktreeRegistryPath, listEntries } from "../../shared/worktree-registry.js";
import {
    listTransitionRecoveryRecords,
    runExecutionPreparationTransition,
    runValidationOutcomeTransition,
} from "../../shared/workflow/state-transition.ts";
import { runPlansDoctor, runPlansDoctorCommand } from "./doctor.ts";
import { runPlansCommand } from "./index.ts";
import { defineGitFixture, git } from "../../shared/git-test-fixture.ts";
import { withProcessGlobalTestLock } from "../../testing/process-global-lock.ts";
import { enterProjectRuntime } from "../../shared/project-runtime-layout.ts";
import { getLockHostname } from "../../shared/process-liveness.ts";
import { inspectTargetBranchPlansByParent } from "../../shared/workflow/planning-worktree.ts";
import { writeControllerState } from "../../shared/workflow/controller-registry.ts";

type WorktreeRegistryEntry = import("../../shared/worktree-registry.js").WorktreeRegistryEntry;
type WorktreeDeliveryEvidence = import("../../plan-store.js").WorktreeDeliveryEvidence;

interface DoctorCommandFixture {
    projectRoot: string;
}

interface RegistryFixtureEntry {
    id: string;
    planName: string;
    planId?: string;
    baseBranch: string;
    baseRef: string;
    baseCommit: string;
    branch: string;
    path: string;
    status: string;
    createdAt: string;
    updatedAt: string;
}

interface RegistryFixtureFile {
    version: number;
    entries: RegistryFixtureEntry[];
}

async function withDoctorCommandFixture(run: (fixture: DoctorCommandFixture) => Promise<void>): Promise<void> {
    await withProcessGlobalTestLock(async () => {
        const previousHome = process.env["HOME"];
        const previousSandboxHome = process.env["WLD_TEST_SANDBOX_HOME"];
        const previousCwd = getCwd();
        const fixtureRoot = await fsMkdtemp(join(tmpdir(), "runwield-plans-doctor-command-"));
        const homeDir = join(fixtureRoot, "home");
        const projectRoot = join(fixtureRoot, "project");
        await Promise.all([
            fsMkdir(homeDir, { recursive: true }),
            fsMkdir(projectRoot, { recursive: true }),
        ]);
        try {
            process.env["HOME"] = homeDir;
            process.env["WLD_TEST_SANDBOX_HOME"] = homeDir;
            process.chdir(projectRoot);
            await run({ projectRoot });
        } finally {
            process.chdir(previousCwd);
            if (previousHome === undefined) delete process.env["HOME"];
            else process.env["HOME"] = previousHome;
            if (previousSandboxHome === undefined) delete process.env["WLD_TEST_SANDBOX_HOME"];
            else process.env["WLD_TEST_SANDBOX_HOME"] = previousSandboxHome;
            await fsRm(fixtureRoot, { recursive: true }).catch(() => {});
        }
    });
}

async function captureConsoleLog(run: () => Promise<void>): Promise<string> {
    const originalLog = console.log;
    const logs: string[] = [];
    console.log = (message = "") => logs.push(String(message));
    try {
        await run();
    } finally {
        console.log = originalLog;
    }
    return logs.join("\n");
}

async function captureConsoleOutput(run: () => Promise<void>): Promise<string> {
    const originalLog = console.log;
    const originalWarn = console.warn;
    const originalError = console.error;
    const lines: string[] = [];
    const capture = (message = "") => lines.push(String(message));
    console.log = capture;
    console.warn = capture;
    console.error = capture;
    try {
        await run();
    } finally {
        console.log = originalLog;
        console.warn = originalWarn;
        console.error = originalError;
    }
    return lines.join("\n");
}

async function seedMissingSettledWorktree(projectRoot: string, worktreeId: string): Promise<void> {
    await savePlan(projectRoot, "demo", "# Demo\n", {
        planId: "plan-command-demo",
        classification: "FEATURE",
        complexity: "LOW",
        summary: "Doctor command fixture.",
        affectedPaths: [],
        createdAt: "2026-01-01T00:00:00.000Z",
        status: "implemented",
        worktreeId,
        worktreeStatus: "abandoned",
    });
    await addEntry(projectRoot, {
        id: worktreeId,
        planName: "demo",
        planId: "plan-command-demo",
        baseBranch: "main",
        baseRef: "HEAD",
        baseCommit: "abc",
        branch: `runwield/worktree/demo-${worktreeId}`,
        path: join(projectRoot, "missing-worktree"),
        status: "abandoned",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
    });
}

// main, plus a side branch carrying work that never reached it.
const ancestryRepo = defineGitFixture(async (repo) => {
    await fsWriteFile(join(repo, "file.txt"), "base\n");
    await git(repo, ["add", "."]);
    await git(repo, ["commit", "-m", "base"]);
    await git(repo, ["checkout", "-b", "side"]);
    await fsWriteFile(join(repo, "file.txt"), "unpublished\n");
    await git(repo, ["commit", "-am", "unpublished"]);
    await git(repo, ["checkout", "main"]);
});

test("plans doctor reports missing worktree paths without abandoning attempts automatically", async () => {
    const cwd = await fsMkdtemp(join(tmpdir(), "runwield-plans-doctor-"));
    try {
        await addEntry(cwd, {
            id: "wt1",
            planName: "demo",
            planId: "plan-1",
            baseBranch: "main",
            baseRef: "HEAD",
            baseCommit: "abc",
            branch: "runwield/worktree/demo-wt1",
            path: `${cwd}/missing-worktree`,
            status: "active",
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
        });
        const report = await runPlansDoctor(cwd, true);
        assertEquals(report.issues.some((issue) => issue.kind === "missing_worktree_path"), true);
        assertEquals(report.repaired, 0);
        assertEquals((await findById(cwd, "wt1"))?.status, "active");
    } finally {
        await fsRm(cwd, { recursive: true }).catch(() => {});
    }
});

test("plans doctor repair prunes missing settled worktree registry artifacts", async () => {
    const cwd = await fsMkdtemp(join(tmpdir(), "runwield-plans-doctor-prune-"));
    try {
        await addEntry(cwd, {
            id: "wt-settled",
            planName: "demo",
            planId: "plan-1",
            baseBranch: "main",
            baseRef: "HEAD",
            baseCommit: "abc",
            branch: "runwield/worktree/demo-wt-settled",
            path: `${cwd}/missing-merged-worktree`,
            status: "abandoned",
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
        });
        const report = await runPlansDoctor(cwd, true);
        assertEquals(report.issues.some((issue) => issue.kind === "missing_worktree_path"), false);
        assertEquals(report.repaired, 1);
        assertEquals(await listEntries(cwd), []);
    } finally {
        await fsRm(cwd, { recursive: true }).catch(() => {});
    }
});

test("plans doctor is report-only without repair", async () => {
    const cwd = await fsMkdtemp(join(tmpdir(), "runwield-plans-doctor-readonly-"));
    try {
        await savePlan(cwd, "missing-id", "# Missing", { status: "ready_for_work", classification: "FEATURE" });
        const registryPath = getWorktreeRegistryPath(cwd);
        await fsMkdir(dirname(registryPath), { recursive: true });
        await fsWriteFile(
            registryPath,
            JSON.stringify({
                version: 1,
                entries: [{
                    id: "legacy-wt",
                    planName: "missing-id",
                    baseBranch: "main",
                    baseRef: "HEAD",
                    baseCommit: "abc",
                    branch: "runwield/worktree/missing-id-legacy-wt",
                    path: `${cwd}/missing-worktree`,
                    status: "active",
                    createdAt: "2026-01-01T00:00:00.000Z",
                    updatedAt: "2026-01-01T00:00:00.000Z",
                }],
            }),
        );
        const beforePlan = await fsReadFile(join(cwd, "docs", "plans", "missing-id.md"), "utf8");
        const beforeRegistry = await fsReadFile(registryPath, "utf8");

        const report = await runPlansDoctor(cwd, false);
        assertEquals(report.issues.some((issue) => issue.kind === "registry_missing_plan_id"), true);
        assertEquals(await fsReadFile(join(cwd, "docs", "plans", "missing-id.md"), "utf8"), beforePlan);
        assertEquals(await fsReadFile(registryPath, "utf8"), beforeRegistry);
    } finally {
        await fsRm(cwd, { recursive: true }).catch(() => {});
    }
});

test("plans doctor check preserves controller recovery, Plan identity, and catalog locks", async () => {
    const cwd = await ancestryRepo.checkout({ prefix: "runwield-plans-doctor-controller-check-" });
    try {
        const layout = await enterProjectRuntime(cwd);
        await savePlan(cwd, "controller-check", "# Controller check\n", {
            planId: "plan-controller-check",
            classification: "FEATURE",
            status: "in_progress",
            summary: "Controller inspection fixture.",
            affectedPaths: [],
        });
        await writeControllerState(
            cwd,
            { planId: "plan-controller-check", planName: "controller-check" },
            { executionReport: "preserve this report" },
            {
                recovery: {
                    worktreeId: "controller-check-attempt",
                    worktreePath: cwd,
                    worktreeBranch: "runwield/worktree/controller-check",
                    worktreeBaseBranch: "main",
                    worktreeStatus: "active",
                },
            },
        );
        await addEntry(cwd, {
            id: "controller-check-attempt",
            planName: "controller-check",
            planId: "plan-controller-check",
            baseBranch: "main",
            baseRef: "HEAD",
            baseCommit: await git(cwd, ["rev-parse", "HEAD"]),
            branch: "runwield/worktree/controller-check",
            path: cwd,
            status: "active",
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
        });
        const missingIdPath = join(cwd, "docs", "plans", "missing-id-check.md");
        await fsWriteFile(missingIdPath, "---\nclassification: FEATURE\nstatus: ready_for_work\n---\n# Missing ID\n");
        const controllerPath = join(layout.primary.controllerPlansDir, "plan-controller-check.json");
        const beforeController = await fsReadFile(controllerPath, "utf8");
        const beforePlan = await fsReadFile(missingIdPath, "utf8");
        const beforeMtime = (await fsStat(missingIdPath)).mtime?.getTime();

        const report = await runPlansDoctor(cwd, false);

        assertEquals(report.issues.some((issue) => issue.kind === "obsolete_controller_recovery"), true);
        assertEquals(report.issues.some((issue) => issue.kind === "missing_plan_id"), true);
        assertEquals(await fsReadFile(controllerPath, "utf8"), beforeController);
        assertEquals(JSON.parse(beforeController).recovery.worktreeId, "controller-check-attempt");
        assertEquals(await fsReadFile(missingIdPath, "utf8"), beforePlan);
        assertEquals((await fsStat(missingIdPath)).mtime?.getTime(), beforeMtime);
        assertEquals(
            await fsStat(layout.selected.planCatalogLockPath).then(() => true).catch(() => false),
            false,
        );
    } finally {
        await fsRm(cwd, { recursive: true }).catch(() => {});
    }
});

test("plans doctor ignores Epic manual QA artifacts", async () => {
    const cwd = await fsMkdtemp(join(tmpdir(), "runwield-plans-doctor-manual-qa-"));
    try {
        await fsMkdir(join(cwd, "docs", "plans", "tow-mvp-epic"), { recursive: true });
        await fsWriteFile(join(cwd, "docs", "plans", "tow-mvp-epic", "manual-qa.md"), "# Manual QA\n");
        await fsMkdir(join(cwd, "docs", "plans", "archived", "tow-mvp-epic"), { recursive: true });
        await fsWriteFile(
            join(cwd, "docs", "plans", "archived", "tow-mvp-epic", "manual-qa.md"),
            "---\n: bad yaml\n---\n# Archived Manual QA\n",
        );

        const report = await runPlansDoctor(cwd, false);
        assertEquals(report.issues.map((issue) => issue.kind), ["runtime_adoption_pending"]);
    } finally {
        await fsRm(cwd, { recursive: true }).catch(() => {});
    }
});

test("plans doctor applies identity and evidence checks to archived Plans", async () => {
    const cwd = await fsMkdtemp(join(tmpdir(), "runwield-plans-doctor-archived-"));
    try {
        await savePlan(cwd, "active", "# Active", {
            planId: "same-plan-id",
            status: "ready_for_work",
            classification: "FEATURE",
        });
        await fsMkdir(join(cwd, "docs", "plans", "archived"), { recursive: true });
        await fsWriteFile(
            join(cwd, "docs", "plans", "archived", "old.md"),
            injectFrontMatter("# Old", {
                planId: "same-plan-id",
                status: "verified",
                classification: "FEATURE",
                deliveryEvidence: {
                    version: 1,
                    mode: "worktree_merge",
                    executionCommit: "a".repeat(40),
                    targetBranch: "main",
                    targetHeadBeforeMerge: "b".repeat(40),
                },
            }),
        );

        const report = await runPlansDoctor(cwd, false);
        assertEquals(report.issues.some((issue) => issue.kind === "duplicate_plan_id"), true);
        assertEquals(
            report.issues.some((issue) => issue.kind === "verified_without_evidence"),
            false,
            "A non-Git Plan needs no publication receipt; duplicate identity is still reported",
        );
    } finally {
        await fsRm(cwd, { recursive: true }).catch(() => {});
    }
});

test("plans doctor reports archived legacy recovery without importing it", async () => {
    const cwd = await ancestryRepo.checkout({ prefix: "runwield-plans-doctor-archived-recovery-" });
    try {
        const layout = await enterProjectRuntime(cwd);
        const archivedDir = join(cwd, "docs", "plans", "archived");
        await fsMkdir(archivedDir, { recursive: true });
        await fsWriteFile(
            join(archivedDir, "legacy.md"),
            injectFrontMatter("# Legacy archived\n", {
                planId: "plan-legacy-archived",
                classification: "FEATURE",
                status: "failed",
                worktreeId: "lost-attempt",
                worktreeStatus: "active",
            }),
        );
        const controllerPath = join(layout.primary.controllerPlansDir, "plan-legacy-archived.json");

        const report = await runPlansDoctor(cwd, false);

        assertEquals(report.issues.some((issue) => issue.kind === "controller_import_pending"), true);
        assertEquals(report.issues.some((issue) => issue.kind === "archived_plan_with_recoverable_attempt"), true);
        assertEquals(await fsStat(controllerPath).then(() => true).catch(() => false), false);
    } finally {
        await fsRm(cwd, { recursive: true }).catch(() => {});
    }
});

test("plans doctor reports a pending import from the live execution document", async () => {
    const cwd = await ancestryRepo.checkout({ prefix: "runwield-plans-doctor-execution-import-" });
    const executionRoot = await fsMkdtemp(join(tmpdir(), "runwield-plans-doctor-execution-import-worktree-"));
    try {
        const layout = await enterProjectRuntime(cwd);
        const primaryPath = join(cwd, "docs", "plans", "execution-import.md");
        const executionPath = join(executionRoot, "docs", "plans", "execution-import.md");
        await fsMkdir(dirname(primaryPath), { recursive: true });
        await fsMkdir(dirname(executionPath), { recursive: true });
        await fsWriteFile(
            primaryPath,
            injectFrontMatter("# Primary\n", {
                planId: "plan-execution-import",
                classification: "FEATURE",
            }),
        );
        const executionDocument = injectFrontMatter("# Execution\n", {
            planId: "plan-execution-import",
            classification: "FEATURE",
            status: "in_progress",
        });
        await fsWriteFile(executionPath, executionDocument);
        await addEntry(cwd, {
            id: "live-execution-import",
            planName: "execution-import",
            planId: "plan-execution-import",
            baseBranch: "main",
            baseRef: "HEAD",
            baseCommit: await git(cwd, ["rev-parse", "HEAD"]),
            branch: "runwield/worktree/execution-import",
            path: executionRoot,
            status: "active",
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
        });
        const controllerPath = join(layout.primary.controllerPlansDir, "plan-execution-import.json");

        const report = await runPlansDoctor(cwd, false);

        assertEquals(
            report.issues.some((issue) =>
                issue.kind === "controller_import_pending" && issue.planName === "execution-import"
            ),
            true,
        );
        assertEquals(await fsReadFile(executionPath, "utf8"), executionDocument);
        assertEquals(await fsStat(controllerPath).then(() => true).catch(() => false), false);
    } finally {
        await fsRm(executionRoot, { recursive: true }).catch(() => {});
        await fsRm(cwd, { recursive: true }).catch(() => {});
    }
});

test("plans doctor uses a reopened retired execution document", async () => {
    const cwd = await ancestryRepo.checkout({ prefix: "runwield-plans-doctor-retired-document-" });
    const executionRoot = await fsMkdtemp(join(tmpdir(), "runwield-plans-doctor-retired-execution-"));
    try {
        await savePlan(cwd, "reopened", "# Primary\n", {
            planId: "plan-reopened",
            classification: "FEATURE",
            status: "ready_for_work",
        });
        const unpublishedCommit = await git(cwd, ["rev-parse", "side"]);
        await savePlan(executionRoot, "reopened", "# Execution\n", {
            planId: "plan-reopened",
            classification: "FEATURE",
            status: "verified",
            targetBranch: "main",
            validatedCommit: unpublishedCommit,
        });
        await addEntry(cwd, {
            id: "retired-attempt",
            planName: "reopened",
            planId: "plan-reopened",
            baseBranch: "main",
            baseRef: "HEAD",
            baseCommit: await git(cwd, ["rev-parse", "HEAD"]),
            branch: "runwield/worktree/reopened-retired",
            path: executionRoot,
            status: "abandoned",
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
        });
        await writeControllerState(
            cwd,
            { planId: "plan-reopened", planName: "reopened" },
            { documentWorktreeId: "retired-attempt" },
        );

        const report = await runPlansDoctor(cwd, false);

        assertEquals(
            report.issues.some((issue) => issue.kind === "uncertain_publication" && issue.planName === "reopened"),
            true,
            "Doctor uses the selected execution document instead of the reopened primary copy",
        );
    } finally {
        await fsRm(executionRoot, { recursive: true }).catch(() => {});
        await fsRm(cwd, { recursive: true }).catch(() => {});
    }
});

test("plans doctor repairs every safe issue to a fixed point and preserves protected work", async () => {
    await withDoctorCommandFixture(async ({ projectRoot }) => {
        await seedMissingSettledWorktree(projectRoot, "wt-command-report");

        const output = await captureConsoleLog(async () => {
            await runPlansDoctorCommand([]);
        });

        assertEquals(output.includes("Fixed 1 safe Plan problem"), true);
        assertEquals(output.includes("registry"), false);
        assertEquals(await findById(projectRoot, "wt-command-report"), null);
        const secondOutput = await captureConsoleLog(async () => {
            await runPlansDoctorCommand([]);
        });
        assertEquals(secondOutput.includes("Your Plans look good"), true);
    });
});

test("plans doctor command --check reports without changing files", async () => {
    await withDoctorCommandFixture(async ({ projectRoot }) => {
        await seedMissingSettledWorktree(projectRoot, "wt-command-check");
        const registryPath = getWorktreeRegistryPath(projectRoot);
        const before = await fsReadFile(registryPath, "utf8");

        const output = await captureConsoleLog(async () => {
            await runPlansDoctorCommand(["--check"]);
        });

        assertEquals(await fsReadFile(registryPath, "utf8"), before);
        assertEquals((await findById(projectRoot, "wt-command-check"))?.status, "abandoned");
        assertEquals(output.includes("Plans doctor diagnosis: 2 issues found"), true);
        assertEquals(output.includes("Worktree registry"), true);
        assertEquals(output.includes("wt-command-check"), true);
        assertEquals(output.includes("Next steps:"), true);
        assertEquals(output.includes("No files changed"), true);
    });
});

test("plans doctor dispatch check and help never adopt raw legacy state", async () => {
    await withProcessGlobalTestLock(async () => {
        const cwd = await ancestryRepo.checkout({ prefix: "runwield-plans-doctor-dispatch-check-" });
        const previousCwd = getCwd();
        try {
            process.chdir(cwd);
            const legacyRegistry = join(cwd, ".wld", "worktrees.json");
            await fsMkdir(dirname(legacyRegistry), { recursive: true });
            await fsWriteFile(legacyRegistry, `${JSON.stringify({ version: 1, entries: [] })}\n`);
            await fsWriteFile(join(cwd, ".gitignore"), "custom-rule\n");
            const beforeRegistry = await fsReadFile(legacyRegistry, "utf8");
            const beforeIgnore = await fsReadFile(join(cwd, ".gitignore"), "utf8");
            const beforeRefs = await git(cwd, ["show-ref"]);
            const beforeIndex = await git(cwd, ["write-tree"]);

            const checkOutput = await captureConsoleLog(async () => {
                await runPlansCommand(["doctor", "--check", "--repair"]);
            });
            assertEquals(checkOutput.includes("runtime_adoption_pending"), true);
            assertEquals(checkOutput.includes("No files changed"), true);
            assertEquals(await fsReadFile(legacyRegistry, "utf8"), beforeRegistry);
            assertEquals(await fsReadFile(join(cwd, ".gitignore"), "utf8"), beforeIgnore);
            assertEquals(await git(cwd, ["show-ref"]), beforeRefs);
            assertEquals(await git(cwd, ["write-tree"]), beforeIndex);
            assertEquals(
                await fsStat(join(cwd, ".wld", PROJECT_INTERNAL_RUNTIME_DIR_NAME)).then(() => true).catch(() => false),
                false,
            );

            await captureConsoleLog(async () => {
                await runPlansCommand(["doctor", "--help"]);
            });
            assertEquals(await fsReadFile(legacyRegistry, "utf8"), beforeRegistry);
            assertEquals(await fsReadFile(join(cwd, ".gitignore"), "utf8"), beforeIgnore);
        } finally {
            process.chdir(previousCwd);
            await fsRm(cwd, { recursive: true }).catch(() => {});
        }
    });
});

test("plans doctor tells users to preserve populated fallback worktrees", async () => {
    await withDoctorCommandFixture(async ({ projectRoot }) => {
        const fallbackRoot = join(getRunWieldRuntimeDir(projectRoot), "worktrees");
        await fsMkdir(fallbackRoot, { recursive: true });
        await fsWriteFile(join(fallbackRoot, "preserve.txt"), "user work\n");

        const output = await captureConsoleOutput(async () => {
            await runPlansDoctorCommand(["--check"]);
        });

        assertEquals(output.includes("Preserve the populated project-local fallback worktree directory"), true);
        assertEquals(output.includes("Move the project or runtime authority"), false);
        assertEquals(await fsReadFile(join(fallbackRoot, "preserve.txt"), "utf8"), "user work\n");
    });
});

test("plans doctor reports broad ignore rules without removing them", async () => {
    const cwd = await ancestryRepo.checkout({ prefix: "runwield-plans-doctor-broad-ignore-" });
    try {
        const ignorePath = join(cwd, ".gitignore");
        await fsWriteFile(ignorePath, ".wld/\n");
        const checked = await runPlansDoctor(cwd, false);
        assertEquals(checked.issues.some((issue) => issue.kind === "broad_wld_ignore"), true);
        assertEquals(await fsReadFile(ignorePath, "utf8"), ".wld/\n");

        const repaired = await runPlansDoctor(cwd, true);
        assertEquals(repaired.issues.some((issue) => issue.kind === "broad_wld_ignore"), true);
        const after = await fsReadFile(ignorePath, "utf8");
        assertEquals(after.includes(".wld/\n"), true);
        assertEquals(after.includes(".wld/internal/"), true);
    } finally {
        await fsRm(cwd, { recursive: true }).catch(() => {});
    }
});

test("plans doctor tracked-secret refusal never prints secret contents", async () => {
    await withProcessGlobalTestLock(async () => {
        const cwd = await ancestryRepo.checkout({ prefix: "runwield-plans-doctor-secret-" });
        const previousCwd = getCwd();
        const sentinel = "DO_NOT_PRINT_THIS_SECRET";
        try {
            process.chdir(cwd);
            const secretPath = join(cwd, ".wld", "internal", "collaboration-secrets.json");
            const tempPath = `${secretPath}.write.tmp`;
            await fsMkdir(dirname(secretPath), { recursive: true });
            await fsWriteFile(secretPath, `${JSON.stringify({ token: sentinel })}\n`);
            await fsWriteFile(tempPath, `${JSON.stringify({ token: `${sentinel}_TEMP` })}\n`);
            await git(cwd, [
                "add",
                "-f",
                ".wld/internal/collaboration-secrets.json",
                ".wld/internal/collaboration-secrets.json.write.tmp",
            ]);
            const output = await captureConsoleOutput(async () => {
                await runPlansCommand(["doctor", "--check"]);
            });
            assertEquals(output.includes(sentinel), false);
            assertEquals(output.includes("remove it from repository history"), true);
            assertEquals(output.includes("rotate"), true);
            assertEquals(output.includes("collaboration-secrets.json"), true);
            assertEquals(output.includes("collaboration-secrets.json.write.tmp"), true);
            assertEquals(await fsReadFile(secretPath, "utf8"), `${JSON.stringify({ token: sentinel })}\n`);
            assertEquals(await fsReadFile(tempPath, "utf8"), `${JSON.stringify({ token: `${sentinel}_TEMP` })}\n`);
        } finally {
            process.chdir(previousCwd);
            await fsRm(cwd, { recursive: true }).catch(() => {});
        }
    });
});

test("plans doctor preserves old live and unattributable Plan locks", async () => {
    const cwd = await ancestryRepo.checkout({ prefix: "runwield-plans-doctor-lock-preserve-" });
    try {
        const layout = await enterProjectRuntime(cwd);
        await savePlan(cwd, "live", "# Live lock\n", {
            classification: "FEATURE",
            status: "ready_for_work",
        });
        await fsMkdir(layout.selected.planLocksDir, { recursive: true });
        const livePath = join(layout.selected.planLocksDir, "live.lock");
        const uncertainPath = join(layout.selected.planLocksDir, "uncertain.lock");
        await fsWriteFile(livePath, JSON.stringify({ pid: process.pid, hostname: getLockHostname(), updatedAtMs: 0 }));
        await fsWriteFile(uncertainPath, "truncated");
        const old = new Date(Date.now() - 60 * 60_000);
        await fsUtimes(livePath, old, old);
        await fsUtimes(uncertainPath, old, old);

        const report = await runPlansDoctor(cwd, true);
        assertEquals(report.issues.some((issue) => issue.kind === "stale_plan_lock"), false);
        assertEquals(report.issues.some((issue) => issue.kind === "missing_plan_id"), true);
        assertEquals((await listPlans(cwd)).find((plan) => plan.name === "live")?.attrs.planId, undefined);
        assertEquals(await fsReadFile(livePath, "utf8").then(() => true).catch(() => false), true);
        assertEquals(await fsReadFile(uncertainPath, "utf8").then(() => true).catch(() => false), true);
    } finally {
        await fsRm(cwd, { recursive: true }).catch(() => {});
    }
});

test("plans doctor command --repair applies safe repairs through the real doctor", async () => {
    await withDoctorCommandFixture(async ({ projectRoot }) => {
        await seedMissingSettledWorktree(projectRoot, "wt-command-repair");

        const output = await captureConsoleLog(async () => {
            await runPlansDoctorCommand(["--repair"]);
        });

        assertEquals(await findById(projectRoot, "wt-command-repair"), null);
        assertEquals(output.includes("Fixed 1 safe Plan problem"), true);
        assertEquals(output.includes("look good now"), true);
        assertEquals(output.includes("Worktree registry"), false);
        assertEquals(output.includes("Diagnosis:"), false);
        assertEquals(output.includes("Next steps:"), false);
    });
});

test("plans doctor command --repair summarizes remaining problems without repeating their details", async () => {
    await withDoctorCommandFixture(async ({ projectRoot }) => {
        await seedMissingSettledWorktree(projectRoot, "wt-command-partial-repair");
        await fsWriteFile(join(projectRoot, "docs", "plans", "broken.md"), "---\nstatus: [\n---\n# Broken\n");

        const output = await captureConsoleLog(async () => {
            await runPlansDoctorCommand(["--repair"]);
        });

        assertEquals(output.includes("Fixed 1 safe problem"), true);
        assertEquals(output.includes("1 problem needs your attention"), true);
        assertEquals(output.includes("Run wld plans doctor --check to see next steps"), true);
        assertEquals(output.includes("broken"), false);
        assertEquals(output.includes("Plan files"), false);
        assertEquals(output.includes("Diagnosis:"), false);
        assertEquals(output.includes("Next steps:"), false);
    });
});

test("plans doctor --repair fixes provable registry drift without touching Git artifacts", async () => {
    const cwd = await ancestryRepo.checkout({ prefix: "runwield-plans-doctor-repair-" });
    const attemptA = `${cwd}-wt-a`;
    const attemptB = `${cwd}-wt-b`;
    try {
        await savePlan(cwd, "renamed-plan", "# Renamed\n", {
            planId: "plan-a",
            classification: "FEATURE",
            status: "in_progress",
            summary: "s",
            affectedPaths: [],
            worktreeId: "wt-a",
        });
        await savePlan(cwd, "legacy-plan", "# Legacy\n", {
            planId: "plan-b",
            classification: "FEATURE",
            status: "in_progress",
            summary: "s",
            affectedPaths: [],
            worktreeId: "wt-b",
        });
        // Legacy evidence must really exist on disk: current writers no longer
        // serialize runtime fields, and joined views are not independent proof.
        const legacyPath = join(cwd, "docs/plans/legacy-plan.md");
        await fsWriteFile(
            legacyPath,
            (await fsReadFile(legacyPath, "utf8")).replace("---\n", "---\nworktreeId: wt-b\n"),
        );
        await git(cwd, ["add", "docs"]);
        await git(cwd, ["commit", "-m", "Plan identity evidence"]);
        await git(cwd, ["worktree", "add", "-b", "runwield/worktree/a", attemptA]);
        await git(cwd, ["worktree", "add", "-b", "runwield/worktree/b", attemptB]);
        const beforeGit = await git(cwd, ["worktree", "list", "--porcelain"]);
        const beforePlan = await fsReadFile(legacyPath, "utf8");
        const base: Omit<WorktreeRegistryEntry, "id" | "planName" | "branch" | "path"> = {
            baseBranch: "main",
            baseRef: "HEAD",
            baseCommit: await git(cwd, ["rev-parse", "HEAD"]),
            status: "active",
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
        };
        // planName drifted away from the Plan that owns the planId.
        await addEntry(cwd, {
            ...base,
            id: "wt-a",
            planName: "old-name",
            planId: "plan-a",
            branch: "runwield/worktree/a",
            path: attemptA,
        });
        // Legacy entry with no planId, but the Plan points back at this exact
        // attempt. addEntry refuses to create one, so write it as v1 data would be.
        const registryPath = getWorktreeRegistryPath(cwd);
        const registry = JSON.parse(await fsReadFile(registryPath, "utf8")) as RegistryFixtureFile;
        registry.entries.push({
            ...base,
            id: "wt-b",
            planName: "stale-legacy-name",
            branch: "runwield/worktree/b",
            path: attemptB,
        });
        await fsWriteFile(registryPath, `${JSON.stringify(registry, null, 2)}\n`);

        assertEquals((await listPlans(cwd)).map((plan) => plan.name), ["legacy-plan"]);

        const report = await runPlansDoctor(cwd, true);
        assertEquals(report.repaired >= 2, true, `expected both drifts repaired, got ${report.repaired}`);
        assertEquals((await findById(cwd, "wt-a"))?.planName, "renamed-plan");
        // Bound by the Plan's worktreeId back-pointer, which name-based migration
        // cannot use because the entry's cached name no longer matches any Plan.
        assertEquals((await findById(cwd, "wt-b"))?.planId, "plan-b");
        assertEquals((await findById(cwd, "wt-b"))?.planName, "legacy-plan");
        // Repair is metadata-only: no attempt may be removed.
        assertEquals((await listEntries(cwd)).length, 2);
        assertEquals(await fsReadFile(legacyPath, "utf8"), beforePlan);
        assertEquals(await git(cwd, ["worktree", "list", "--porcelain"]), beforeGit);
    } finally {
        await git(cwd, ["worktree", "remove", "--force", attemptA]).catch(() => {});
        await git(cwd, ["worktree", "remove", "--force", attemptB]).catch(() => {});
        await fsRm(cwd, { recursive: true }).catch(() => {});
    }
});

test("plans doctor does not report an archived Plan's attempt as a dangling planId", async () => {
    const cwd = await fsMkdtemp(join(tmpdir(), "runwield-plans-doctor-archived-"));
    try {
        await fsMkdir(join(cwd, "docs", "plans", "archived"), { recursive: true });
        await fsWriteFile(
            join(cwd, "docs", "plans", "archived", "done.md"),
            injectFrontMatter("# Done\n", {
                planId: "plan-archived",
                classification: "FEATURE",
                status: "verified",
                summary: "s",
                affectedPaths: [],
            }),
        );
        await addEntry(cwd, {
            id: "wt-archived",
            planName: "done",
            planId: "plan-archived",
            baseBranch: "main",
            baseRef: "HEAD",
            baseCommit: "abc",
            branch: "runwield/worktree/done",
            path: join(cwd, "wt-archived"),
            status: "abandoned",
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
        });
        const report = await runPlansDoctor(cwd, false);
        assertEquals(
            report.issues.some((issue) => issue.kind === "registry_plan_id_not_found"),
            false,
            "an archived Plan still owns its planId",
        );
    } finally {
        await fsRm(cwd, { recursive: true }).catch(() => {});
    }
});

test("plans doctor diagnoses a registry conflict instead of going blind on it", async () => {
    const cwd = await fsMkdtemp(join(tmpdir(), "runwield-plans-doctor-conflict-"));
    try {
        await savePlan(cwd, "demo", "# Demo\n", {
            planId: "plan-1",
            classification: "FEATURE",
            status: "in_progress",
            summary: "s",
            affectedPaths: [],
            worktreeId: "wt-a",
        });
        const base = {
            baseBranch: "main",
            baseRef: "HEAD",
            baseCommit: "abc",
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
        };
        // Two live attempts for one Plan: legacy v1 shape, which the invariant-enforcing
        // readers refuse to load at all.
        const registryPath = getWorktreeRegistryPath(cwd);
        await fsMkdir(dirname(registryPath), { recursive: true });
        await fsWriteFile(
            registryPath,
            JSON.stringify({
                version: 1,
                entries: [
                    {
                        ...base,
                        id: "wt-a",
                        planName: "demo",
                        branch: "rw/a",
                        path: join(cwd, "wt-a"),
                        status: "completed",
                    },
                    {
                        ...base,
                        id: "wt-b",
                        planName: "demo",
                        branch: "rw/b",
                        path: join(cwd, "wt-b"),
                        status: "active",
                    },
                ],
            }),
        );

        // Read-only mode names the conflict. Repair mode can bind the attempt named
        // by the Plan and leave every other worktree untouched.
        for (const repair of [false, true]) {
            const report = await runPlansDoctor(cwd, repair);
            const kinds = report.issues.map((issue) => issue.kind);
            assertEquals(
                kinds.includes("registry_integrity_error"),
                false,
                `repair=${repair}: "could not be loaded" is not a diagnosis`,
            );
            assertEquals(kinds.includes("duplicate_live_attempt"), true, `repair=${repair}: names the conflict`);
            const conflict = report.issues.find((issue) => issue.kind === "duplicate_live_attempt");
            assertEquals(conflict?.message.includes("wt-a"), true);
            assertEquals(conflict?.message.includes("wt-b"), true);
            assertEquals((conflict?.commands || []).length > 0, true, "the user needs commands, not a verdict");
        }
    } finally {
        await fsRm(cwd, { recursive: true }).catch(() => {});
    }
});

test("plans doctor closes a journal whose durable effects the repository proves", async () => {
    const cwd = await fsMkdtemp(join(tmpdir(), "runwield-plans-doctor-journal-"));
    try {
        await savePlan(cwd, "demo", "# Demo\n", {
            planId: "plan-1",
            classification: "FEATURE",
            status: "implemented",
            summary: "s",
            affectedPaths: [],
        });
        await addEntry(cwd, {
            id: "wt-1",
            planName: "demo",
            planId: "plan-1",
            baseBranch: "main",
            baseRef: "HEAD",
            baseCommit: "abc",
            branch: "runwield/worktree/demo",
            path: join(cwd, "wt-1"),
            status: "validation_failed",
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
        });
        // A merge-failure settlement interrupted after its registry write: the effect is
        // atomic, so there is no half-applied row to be afraid of.
        const failure = await runValidationOutcomeTransition({
            projectRoot: cwd,
            planName: "demo",
            worktreeId: "wt-1",
            outcome: "merge_failed",
            settle: async ({ markEffect }) => {
                await markEffect("worktree_registry_updated", { worktreeId: "wt-1", status: "validation_failed" });
                throw new Error("interrupted before settling");
            },
        });
        assertEquals(failure.status, "needs_recovery");

        const reported = await runPlansDoctor(cwd, false);
        const unresolved = reported.issues.find((issue) => issue.kind === "unresolved_transition");
        assertEquals(Boolean(unresolved), true);
        assertEquals(unresolved?.repairable, true);
        assertEquals(unresolved?.message.includes("demo"), true, "the message names the Plan, not just an id");

        const repaired = await runPlansDoctor(cwd, true);
        assertEquals(repaired.repaired >= 1, true);
        assertEquals(
            repaired.issues.some((issue) => issue.kind === "unresolved_transition"),
            false,
            "RunWield must be able to close its own bookkeeping",
        );
        assertEquals((await listTransitionRecoveryRecords(cwd)).length, 0);
        assertEquals((await findById(cwd, "wt-1"))?.status, "validation_failed", "the attempt is left untouched");
    } finally {
        await fsRm(cwd, { recursive: true }).catch(() => {});
    }
});

test("plans doctor keeps a journal whose worktree may still hold work", async () => {
    const cwd = await fsMkdtemp(join(tmpdir(), "runwield-plans-doctor-keep-"));
    try {
        await savePlan(cwd, "demo", "# Demo\n", {
            planId: "plan-1",
            classification: "FEATURE",
            status: "ready_for_work",
            summary: "s",
            affectedPaths: [],
        });
        const orphanPath = join(cwd, "orphan-worktree");
        await fsMkdir(orphanPath, { recursive: true });
        const failure = await runExecutionPreparationTransition({
            projectRoot: cwd,
            planName: "demo",
            worktreeId: "wt-1",
            prepare: async ({ markEffect }) => {
                await markEffect("git_worktree_created", { worktreeId: "wt-1", path: orphanPath, branch: "rw/demo" });
                throw new Error("registry settlement interrupted");
            },
        });
        assertEquals(failure.status, "needs_recovery");

        const report = await runPlansDoctor(cwd, true);
        const unresolved = report.issues.find((issue) => issue.kind === "unresolved_transition");
        assertEquals(Boolean(unresolved), true, "an unclaimed worktree is never closed automatically");
        assertEquals(unresolved?.repairable, false);
        assertEquals(unresolved?.message.includes(orphanPath), true, "the message names the directory to inspect");
        assertEquals(
            (unresolved?.commands || []).some((command) => command.includes(orphanPath)),
            true,
            "and the command that shows whether anything is in it",
        );
        assertEquals(await fsStat(orphanPath).then((stat) => stat.isDirectory()), true, "nothing is deleted");
    } finally {
        await fsRm(cwd, { recursive: true }).catch(() => {});
    }
});

test("plans doctor preserves a held native lock while repairing another abandoned lock", async () => {
    const cwd = await ancestryRepo.checkout({ prefix: "runwield-doctor-held-lock-" });
    try {
        const layout = await enterProjectRuntime(cwd);
        await fsMkdir(layout.selected.planLocksDir, { recursive: true });
        const livePath = join(layout.selected.planLocksDir, "aaa-live.lock");
        const stalePath = join(layout.selected.planLocksDir, "zzz-stale.lock");
        const text = JSON.stringify({ token: "held-owner", pid: process.pid, hostname: getLockHostname() });
        const owner = openNativeFileLock(livePath, "exclusive");
        try {
            owner.lockSync(true);
            owner.replaceTextSync(text);
            await fsWriteFile(stalePath, JSON.stringify({ pid: 2_147_483_647, hostname: getLockHostname() }));
            const report = await runPlansDoctor(cwd, false);
            const staleIssues = report.issues.filter((issue) => issue.kind === "stale_plan_lock");
            assertEquals(staleIssues.length, 1);
            assertEquals(staleIssues[0].message.includes("zzz-stale.lock"), true);
            assertEquals(await fsStat(stalePath).then(() => true), true);
            const repaired = await runPlansDoctor(cwd, true);
            assertEquals(repaired.repaired >= 1, true);
            await assertRejects(() => fsStat(stalePath), Error, "ENOENT");
            assertEquals(owner.readSnapshotSync().text, text);
            const contender = openNativeFileLock(livePath, false);
            try {
                assertEquals(contender.tryLockSync(true), false);
            } finally {
                contender.close();
            }
        } finally {
            owner.close();
        }
        assertEquals(await fsReadFile(livePath, "utf8"), text);
    } finally {
        await fsRm(cwd, { recursive: true });
    }
});

test("plans doctor clears a recently abandoned Plan lock", async () => {
    const cwd = await fsMkdtemp(join(tmpdir(), "runwield-plans-doctor-lock-"));
    try {
        await enterProjectRuntime(cwd);
        const resolvedCwd = fsRealpathSync(cwd);
        const lockDir = join(getRunWieldRuntimeDir(resolvedCwd), PROJECT_INTERNAL_RUNTIME_DIR_NAME, "plan-locks");
        const lockPath = join(lockDir, "demo.lock");
        const legacyLockPath = join(getRunWieldRuntimeDir(resolvedCwd), "plan-locks", "demo.lock");
        await fsMkdir(lockDir, { recursive: true });
        await fsWriteFile(
            lockPath,
            JSON.stringify({ pid: 2_147_483_647, hostname: getLockHostname(), updatedAtMs: 0 }),
        );
        const reported = await runPlansDoctor(cwd, false);
        const stale = reported.issues.find((issue) => issue.kind === "stale_plan_lock");
        assertEquals(Boolean(stale), true);
        assertEquals(stale?.repairable, true);
        assertEquals(await fsStat(lockPath).then(() => true), true, "report-only leaves it in place");

        const repaired = await runPlansDoctor(cwd, true);
        assertEquals(repaired.repaired >= 1, true);
        assertEquals(await fsStat(lockPath).then(() => true).catch(() => false), false);
        assertEquals(await fsStat(legacyLockPath).then(() => true).catch(() => false), false);
    } finally {
        await fsRm(cwd, { recursive: true }).catch(() => {});
    }
});

test("doctor uses committed validation stamps without controller records and ignores superseded evidence", async () => {
    const cwd = await ancestryRepo.checkout({ prefix: "runwield-doctor-stamps-" });
    try {
        const publishedCommit = await git(cwd, ["rev-parse", "main"]);
        const unpublishedCommit = await git(cwd, ["rev-parse", "side"]);
        for (const [name, commit] of [["published", publishedCommit], ["unpublished", unpublishedCommit]]) {
            await savePlan(cwd, name, `# ${name}\n`, {
                planId: name,
                classification: "PLANNED_CHANGE",
                status: "validated",
                targetBranch: "main",
                validatedCommit: commit,
            });
        }
        await savePlan(cwd, "reopened", "# Reopened\n", {
            planId: "reopened",
            classification: "PLANNED_CHANGE",
            status: "ready_for_work",
            deliveryEvidence: {
                version: 1,
                mode: "worktree_merge",
                executionCommit: unpublishedCommit,
                targetBranch: "main",
                targetHeadBeforeMerge: publishedCommit,
            },
        });
        const report = await runPlansDoctor(cwd, false);
        assertEquals(
            report.issues.filter((issue) => issue.kind === "uncertain_publication").map((issue) => issue.planName),
            ["unpublished"],
        );
        assertEquals(
            await fsReadFile(join(cwd, "docs/plans/published.md"), "utf8").then((text) =>
                text.includes(publishedCommit)
            ),
            true,
        );
    } finally {
        await fsRm(cwd, { recursive: true });
    }
});

test("doctor distinguishes committed archived history from a still-active publication", async () => {
    const cwd = await ancestryRepo.checkout({ prefix: "runwield-doctor-archive-proof-" });
    try {
        const commit = await git(cwd, ["rev-parse", "side"]);
        await savePlan(cwd, "archived/done", "# Archived\n", {
            planId: "archived-history",
            classification: "PLANNED_CHANGE",
            status: "validated",
            archivedAt: "2026-09-19T00:00:00.000Z",
            archivedFromStatus: "validated",
            targetBranch: "removed-feature",
            validatedCommit: commit,
        });
        const uncommittedReport = await runPlansDoctor(cwd, false);
        assertEquals(uncommittedReport.issues.some((issue) => issue.kind === "uncertain_publication"), true);
        await git(cwd, ["add", "docs/plans/archived/done.md"]);
        await git(cwd, ["commit", "-m", "Archive completed feature"]);
        const report = await runPlansDoctor(cwd, false);
        assertEquals(report.issues.some((issue) => issue.kind === "uncertain_publication"), false);
        assertEquals(report.issues, [], "Committed archived history has nothing for Doctor to repair");
        await addEntry(cwd, {
            id: "still-publishing",
            planId: "archived-history",
            planName: "done",
            branch: "side",
            path: join(cwd, "missing-execution-tree"),
            baseBranch: "main",
            baseRef: "main",
            baseCommit: await git(cwd, ["rev-parse", "main"]),
            status: "active",
            createdAt: "2026-09-19T00:00:00.000Z",
            updatedAt: "2026-09-19T00:00:00.000Z",
        });
        const activeReport = await runPlansDoctor(cwd, false);
        assertEquals(activeReport.issues.some((issue) => issue.kind === "uncertain_publication"), true);
    } finally {
        await fsRm(cwd, { recursive: true });
    }
});

test("doctor proves publication from real Git ancestry in both directions", async () => {
    // The only test here that runs real Git, and the reason it has to: every other
    // ancestry assertion lives in a directory with no repository, where the check
    // fails for lack of Git rather than for lack of ancestry. Those tests would pass
    // just as happily with the arguments reversed. This one pins what
    // `merge-base --is-ancestor` actually means for us, so the faked tests above are
    // safe to trust about everything else.
    const cwd = await ancestryRepo.checkout({ prefix: "runwield-plans-doctor-git-" });
    try {
        const publishedCommit = await git(cwd, ["rev-parse", "main"]);
        const unpublishedCommit = await git(cwd, ["rev-parse", "side"]);

        const evidenceFor = (commit: string): WorktreeDeliveryEvidence => ({
            version: 1,
            mode: "worktree_merge",
            executionCommit: commit,
            targetBranch: "main",
            targetHeadBeforeMerge: publishedCommit,
        });

        await savePlan(cwd, "published", "# Published\n", {
            planId: "plan-published",
            classification: "FEATURE",
            status: "verified",
            summary: "s",
            affectedPaths: [],
            deliveryEvidence: evidenceFor(publishedCommit),
        });
        const publishedReport = await runPlansDoctor(cwd, false);
        assertEquals(
            publishedReport.issues.some((issue) => issue.kind === "uncertain_publication"),
            false,
            "a commit contained in the target branch is proven published",
        );

        await savePlan(cwd, "unpublished", "# Unpublished\n", {
            planId: "plan-unpublished",
            classification: "FEATURE",
            status: "verified",
            summary: "s",
            affectedPaths: [],
            deliveryEvidence: evidenceFor(unpublishedCommit),
        });
        const unpublishedReport = await runPlansDoctor(cwd, false);
        const uncertain = unpublishedReport.issues.filter((issue) => issue.kind === "uncertain_publication");
        assertEquals(uncertain.length, 1, "a commit that never reached the target branch is not proven");
        assertEquals(uncertain[0].planName, "unpublished");
    } finally {
        await fsRm(cwd, { recursive: true }).catch(() => {});
    }
});

test("doctor discovers remote children while local target is behind and reports inspection failure", async () => {
    const cwd = await ancestryRepo.checkout({ prefix: "runwield-plans-doctor-remote-child-" });
    const remoteRoot = await fsMkdtemp(join(tmpdir(), "runwield-plans-doctor-remote-child-origin-"));
    try {
        await git(remoteRoot, ["init", "--bare"]);
        await git(cwd, ["remote", "add", "origin", remoteRoot]);
        await git(cwd, ["push", "-u", "origin", "main"]);
        await savePlan(cwd, "project", "# Project\n", {
            planId: "plan-project",
            classification: "PROJECT",
            status: "in_progress",
            summary: "Remote child fixture.",
            affectedPaths: [],
            targetBranch: "main",
        });
        await git(cwd, ["add", "docs/plans/project.md"]);
        await git(cwd, ["commit", "-m", "Add project Plan"]);
        await git(cwd, ["push", "origin", "main"]);
        const localTarget = await git(cwd, ["rev-parse", "main"]);
        const unpublishedCommit = await git(cwd, ["rev-parse", "side"]);

        await git(cwd, ["checkout", "-b", "remote-child"]);
        await savePlan(cwd, "remote-child", "# Remote child\n", {
            planId: "plan-remote-child",
            parentPlan: "project",
            classification: "FEATURE",
            status: "verified",
            summary: "Only the authoritative remote contains this child.",
            affectedPaths: [],
            deliveryEvidence: {
                version: 1,
                mode: "worktree_merge",
                executionCommit: unpublishedCommit,
                targetBranch: "main",
                targetHeadBeforeMerge: localTarget,
            },
        });
        const childPath = join(cwd, "docs/plans/remote-child.md");
        await fsWriteFile(
            childPath,
            injectFrontMatter(await fsReadFile(childPath, "utf8"), {
                deliveryEvidence: {
                    version: 1,
                    mode: "worktree_merge",
                    executionCommit: unpublishedCommit,
                    targetBranch: "main",
                    targetHeadBeforeMerge: localTarget,
                },
            }),
        );
        await git(cwd, ["add", "docs/plans/remote-child.md"]);
        await git(cwd, ["commit", "-m", "Add remote child"]);
        await git(cwd, ["push", "origin", "HEAD:main"]);
        await git(cwd, ["checkout", "main"]);
        assertEquals(
            await fsStat(join(cwd, "docs/plans/remote-child.md")).then(() => true).catch(() => false),
            false,
        );
        await savePlan(cwd, "remote-child", "# Stale local child\n", {
            planId: "plan-remote-child",
            parentPlan: "project",
            classification: "FEATURE",
            status: "ready_for_work",
            summary: "The local child is behind its authoritative target copy.",
            affectedPaths: [],
        });

        const fetchHeadPath = join(cwd, ".git", "FETCH_HEAD");
        const gitSnapshot = async () => ({
            refs: await git(cwd, ["show-ref"]),
            index: await git(cwd, ["write-tree"]),
            objects: await git(cwd, ["cat-file", "--batch-check", "--batch-all-objects"]),
            fetchHead: await fsReadFile(fetchHeadPath, "utf8").catch(() => null),
        });
        const beforeInspection = await gitSnapshot();
        const remoteChildren = await inspectTargetBranchPlansByParent(cwd, "main", "project");
        assertEquals(remoteChildren.map((plan) => plan.name), ["remote-child"]);
        assertEquals(remoteChildren[0].attrs.deliveryEvidence, {
            version: 1,
            mode: "worktree_merge",
            executionCommit: unpublishedCommit,
            targetBranch: "main",
            targetHeadBeforeMerge: localTarget,
        });
        const discovered = await runPlansDoctor(cwd, false);
        assertEquals(await gitSnapshot(), beforeInspection, "remote inspection must not mutate primary Git storage");
        assertEquals(
            discovered.issues.some((issue) =>
                issue.kind === "uncertain_publication" && issue.planName === "remote-child"
            ),
            true,
            "Doctor inspects children from the authoritative remote, not the behind local branch",
        );

        await savePlan(cwd, "local-publication-claim", "# Local claim\n", {
            planId: "plan-local-claim",
            classification: "FEATURE",
            status: "verified",
            summary: "Remote inspection must remain authoritative.",
            affectedPaths: [],
            deliveryEvidence: {
                version: 1,
                mode: "worktree_merge",
                executionCommit: localTarget,
                targetBranch: "main",
                targetHeadBeforeMerge: localTarget,
            },
        });
        await git(cwd, ["remote", "set-url", "origin", join(remoteRoot, "missing")]);
        const failed = await runPlansDoctor(cwd, false);
        assertEquals(failed.issues.some((issue) => issue.kind === "target_branch_inspection_error"), true);
        assertEquals(
            failed.issues.some((issue) =>
                issue.kind === "publication_inspection_error" && issue.planName === "local-publication-claim"
            ),
            true,
            "local ancestry must not hide a remote inspection failure",
        );
    } finally {
        await fsRm(cwd, { recursive: true }).catch(() => {});
        await fsRm(remoteRoot, { recursive: true }).catch(() => {});
    }
});

test("doctor proves remote publication while the local target checkout is behind", async () => {
    const cwd = await ancestryRepo.checkout({ prefix: "runwield-plans-doctor-remote-git-" });
    const remoteRoot = await fsMkdtemp(join(tmpdir(), "runwield-plans-doctor-remote-"));
    try {
        await git(remoteRoot, ["init", "--bare"]);
        await git(cwd, ["remote", "add", "origin", remoteRoot]);
        await git(cwd, ["push", "-u", "origin", "main"]);
        const localTargetCommit = await git(cwd, ["rev-parse", "main"]);

        await git(cwd, ["checkout", "-b", "published-source"]);
        await fsWriteFile(join(cwd, "published-remotely.txt"), "published\n");
        await git(cwd, ["add", "published-remotely.txt"]);
        await git(cwd, ["commit", "-m", "Published only to the remote target"]);
        const publishedCommit = await git(cwd, ["rev-parse", "HEAD"]);
        await git(cwd, ["push", "origin", `${publishedCommit}:refs/heads/main`]);
        await git(cwd, ["checkout", "main"]);
        assertEquals(await git(cwd, ["rev-parse", "main"]), localTargetCommit);

        await savePlan(cwd, "remote-published", "# Remote Published\n", {
            planId: "plan-remote-published",
            classification: "FEATURE",
            status: "verified",
            summary: "s",
            affectedPaths: [],
            deliveryEvidence: {
                version: 1,
                mode: "worktree_merge",
                executionCommit: publishedCommit,
                targetBranch: "main",
                targetHeadBeforeMerge: localTargetCommit,
            },
        });

        const report = await runPlansDoctor(cwd, false);
        assertEquals(
            report.issues.some((issue) =>
                issue.kind === "uncertain_publication" && issue.planName === "remote-published"
            ),
            false,
        );
    } finally {
        await fsRm(cwd, { recursive: true }).catch(() => {});
        await fsRm(remoteRoot, { recursive: true }).catch(() => {});
    }
});
