import fsPromises from "node:fs/promises";
import { type NativeFileLock, openNativeFileLock } from "../native-file-lock.ts";
import { lstat as fsLstat, mkdir as fsMkdir, rm as fsRm, writeFile as fsWriteFile } from "node:fs/promises";
import process from "node:process";
import { setInterval } from "node:timers";
import { dirname, join } from "node:path";
import { getRunWieldRuntimeDir } from "../../constants.js";
import { getLockHostname } from "../process-liveness.ts";
import { migrateLegacyProjectRuntimeState, resolveProjectRuntimeLayout } from "../project-runtime-layout.ts";
import { withWorktreeRegistryLockAtPath } from "../worktree-registry.js";

interface LegacyPlanLockRecord {
    token: string;
    pid: number;
    hostname: string;
    updatedAtMs: number;
}

interface LegacyWorkRecordLockRecord {
    token: string;
    createdAt: number;
    updatedAt: number;
}

type MigrationExitEffect =
    | "journal-commit"
    | "primary-rename"
    | "secret-rename"
    | "selected-rename"
    | "stale-lock-retirement"
    | "marker-replacement"
    | "journal-cleanup"
    | "recovery-backup"
    | "recovery-controller"
    | "recovery-registry"
    | "recovery-registry-retirement"
    | "recovery-retirement";

const [command, checkoutRoot, extra] = process.argv.slice(2);

if (command === "migrate") {
    const result = await migrateLegacyProjectRuntimeState(checkoutRoot);
    console.log(JSON.stringify(result));
} else if (command === "migrate-exit-after-effect") {
    installExitAfterEffect(checkoutRoot, parseMigrationExitEffect(extra));
    const result = await migrateLegacyProjectRuntimeState(checkoutRoot);
    console.log(JSON.stringify(result));
} else if (command === "hold-controller-lock") {
    const lockPath = extra || join(getRunWieldRuntimeDir(checkoutRoot), "controller", "plans", "driver.json.lock");
    await fsMkdir(dirname(lockPath), { recursive: true }).catch(() => {});
    const file = openNativeFileLock(lockPath);
    await file.lock(true);
    console.log(JSON.stringify({ ready: true, lockPath }));
    await holdProcess();
} else if (command === "hold-registry-lock") {
    const lockPath = join(getRunWieldRuntimeDir(checkoutRoot), "worktrees.lock");
    await withWorktreeRegistryLockAtPath(lockPath, async () => {
        console.log(JSON.stringify({ ready: true, lockPath }));
        await holdProcess();
    });
} else if (command === "hold-initializing-migration-locks") {
    await holdInitializingMigrationLocks(checkoutRoot, extra);
} else if (command === "hold-plan-lock") {
    await holdLegacyPlanLock(checkoutRoot, extra || "demo");
} else if (command === "hold-work-record-lock") {
    await holdLegacyWorkRecordLock(checkoutRoot, "work-record-supersession.lock");
} else if (command === "hold-work-record-recovery-lock") {
    await holdLegacyWorkRecordLock(checkoutRoot, "work-record-supersession-recovery.lock");
} else {
    console.error(`Unknown project runtime migration process driver command: ${command}`);
    process.exit(2);
}

async function holdInitializingMigrationLocks(checkoutRoot: string, signalPath: string): Promise<void> {
    const layout = resolveProjectRuntimeLayout(checkoutRoot);
    const registryLockPath = join(getRunWieldRuntimeDir(layout.primary.checkoutRoot), "worktrees.lock");
    await fsMkdir(dirname(layout.primary.layoutMigrationLockPath), { recursive: true });
    await fsMkdir(dirname(registryLockPath), { recursive: true });
    (await fsPromises.open(layout.primary.layoutMigrationLockPath, "wx")).close();
    (await fsPromises.open(registryLockPath, "wx")).close();
    console.log(JSON.stringify({ ready: true, lockPath: registryLockPath }));
    while (!(await fsLstat(signalPath).catch(() => null))) {
        await new Promise((resolveTimer) => setTimeout(resolveTimer, 5));
    }
    await new Promise((resolveTimer) => setTimeout(resolveTimer, 50));
    const now = Date.now();
    const owner = JSON.stringify({
        token: crypto.randomUUID(),
        pid: process.pid,
        hostname: getLockHostname(),
        createdAtMs: now,
        updatedAtMs: now,
    });
    await fsWriteFile(layout.primary.layoutMigrationLockPath, owner);
    await fsWriteFile(registryLockPath, owner);
    await new Promise((resolveTimer) => setTimeout(resolveTimer, 50));
    await fsRm(registryLockPath);
    await fsRm(layout.primary.layoutMigrationLockPath);
}

async function holdLegacyPlanLock(checkoutRoot: string, planName: string): Promise<never> {
    const lockPath = join(getRunWieldRuntimeDir(checkoutRoot), "plan-locks", `${lockSafeSegment(planName)}.lock`);
    await fsMkdir(dirname(lockPath), { recursive: true });
    const file = openNativeFileLock(lockPath, "exclusive");
    file.lockSync(true);
    const token = crypto.randomUUID();
    await writePlanLockFile(file, { token, pid: process.pid, hostname: getLockHostname(), updatedAtMs: Date.now() });
    const heartbeat = setInterval(() => {
        writePlanLockFile(file, { token, pid: process.pid, hostname: getLockHostname(), updatedAtMs: Date.now() })
            .catch(
                () => {},
            );
    }, 1_000);
    // Keep the lock holder alive until the parent terminates it.
    heartbeat.ref();
    console.log(JSON.stringify({ ready: true, lockPath }));
    return await new Promise<never>(() => {});
}

async function holdLegacyWorkRecordLock(checkoutRoot: string, lockName: string): Promise<never> {
    const lockPath = join(getRunWieldRuntimeDir(checkoutRoot), lockName);
    await fsMkdir(dirname(lockPath), { recursive: true, mode: 0o700 });
    const file = openNativeFileLock(lockPath, "exclusive");
    file.lockSync(true);
    const token = crypto.randomUUID();
    const now = Date.now();
    await writeWorkRecordLockFile(file, { token, createdAt: now, updatedAt: now });
    const heartbeat = setInterval(() => {
        writeWorkRecordLockFile(file, { token, createdAt: now, updatedAt: Date.now() }).catch(() => {});
    }, 1_000);
    // Keep the lock holder alive until the parent terminates it.
    heartbeat.ref();
    console.log(JSON.stringify({ ready: true, lockPath }));
    return await new Promise<never>(() => {});
}

function lockSafeSegment(value: string): string {
    return String(value || "plan").replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "plan";
}

async function writePlanLockFile(file: NativeFileLock, record: LegacyPlanLockRecord): Promise<void> {
    await writeJsonFile(file, `${JSON.stringify(record)}\n`);
}

async function writeWorkRecordLockFile(file: NativeFileLock, record: LegacyWorkRecordLockRecord): Promise<void> {
    await writeJsonFile(file, `${JSON.stringify(record)}\n`);
}

function writeJsonFile(file: NativeFileLock, text: string): void {
    file.replaceTextSync(text);
}

function parseMigrationExitEffect(value: string | undefined): MigrationExitEffect {
    if (
        value === "journal-commit" || value === "primary-rename" || value === "secret-rename" ||
        value === "selected-rename" ||
        value === "stale-lock-retirement" || value === "marker-replacement" || value === "journal-cleanup" ||
        value === "recovery-backup" || value === "recovery-controller" || value === "recovery-retirement" ||
        value === "recovery-registry" || value === "recovery-registry-retirement"
    ) return value;
    console.error(`Unknown migration exit effect: ${value || ""}`);
    process.exit(2);
}

function installExitAfterEffect(checkoutRoot: string, effect: MigrationExitEffect): void {
    const layout = resolveProjectRuntimeLayout(checkoutRoot);
    const legacyBase = getRunWieldRuntimeDir(checkoutRoot);
    const originalRename = fsPromises.rename;
    const originalRemove = fsPromises.rm;
    Object.defineProperty(fsPromises, "rename", {
        configurable: true,
        value: async (from: string | URL, to: string | URL): Promise<void> => {
            await originalRename(from, to);
            if (typeof from === "string" && typeof to === "string" && shouldExitAfterRename(effect, from, to, layout)) {
                process.exit(86);
            }
        },
    });
    const originalLink = fsPromises.link;
    Object.defineProperty(fsPromises, "link", {
        configurable: true,
        value: async (from: string | URL, to: string | URL): Promise<void> => {
            await originalLink(from, to);
            if (typeof from === "string" && typeof to === "string" && shouldExitAfterRename(effect, from, to, layout)) {
                process.exit(86);
            }
        },
    });
    Object.defineProperty(fsPromises, "rm", {
        configurable: true,
        value: async (path: string | URL, options?: import("node:fs").RmOptions): Promise<void> => {
            await originalRemove(path, options);
            if (typeof path === "string" && shouldExitAfterRemove(effect, path, layout, legacyBase)) {
                process.exit(86);
            }
        },
    });
}

function shouldExitAfterRename(
    effect: MigrationExitEffect,
    from: string,
    to: string,
    layout: ReturnType<typeof resolveProjectRuntimeLayout>,
): boolean {
    if (effect === "recovery-backup") return to.replaceAll("\\", "/").includes("/legacy-recovery/") && to.replaceAll("\\", "/").endsWith("/contents");
    if (effect === "recovery-controller") return to === join(layout.primary.controllerPlansDir, "plan.json");
    if (effect === "recovery-registry") return to === layout.primary.worktreeRegistryPath;
    if (effect === "journal-commit") return to === layout.primary.layoutMigrationJournalPath;
    if (effect === "primary-rename") {
        return from === join(getRunWieldRuntimeDir(layout.primary.checkoutRoot), "controller");
    }
    if (effect === "secret-rename") {
        return from.endsWith("collaboration-secrets.json") && to === layout.primary.projectSecretStorePath;
    }
    if (effect === "selected-rename") {
        return from === join(getRunWieldRuntimeDir(layout.selected.checkoutRoot), "plan-transitions");
    }
    return effect === "marker-replacement" && to === layout.primary.layoutMarkerPath;
}

function shouldExitAfterRemove(
    effect: MigrationExitEffect,
    path: string,
    layout: ReturnType<typeof resolveProjectRuntimeLayout>,
    legacyBase: string,
): boolean {
    if (effect === "recovery-registry-retirement") {
        return path === join(getRunWieldRuntimeDir(layout.primary.checkoutRoot), "worktrees.json");
    }
    if (effect === "recovery-retirement") {
        return path === join(getRunWieldRuntimeDir(layout.primary.checkoutRoot), "controller", "plans", "plan.json");
    }
    if (effect === "stale-lock-retirement") return path === join(legacyBase, "plan-locks", "demo.lock");
    return effect === "journal-cleanup" && path === layout.primary.layoutMigrationJournalPath;
}

async function holdProcess(): Promise<never> {
    // An unresolved promise alone does not keep a Deno subprocess alive.
    setInterval(() => {}, 60_000);
    return await new Promise<never>(() => {});
}
