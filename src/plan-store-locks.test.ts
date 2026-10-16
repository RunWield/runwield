import { assertEquals } from "./testing/assertions.ts";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { pid, platform } from "node:process";
import { hostname } from "node:os";
import { openNativeFileLock } from "./shared/native-file-lock.ts";
import { mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { injectFrontMatter, listPlanResources, savePlan, withPlanCatalogLock, withPlanLock } from "./plan-store.js";
import { resolveProjectRuntimeLayout } from "./shared/project-runtime-layout.ts";

async function promptly<T>(operation: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            operation,
            new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new Error("Plan operation waited on an unrelated lock")), 3_000);
            }),
        ]);
    } finally {
        clearTimeout(timer);
    }
}

test(
    "Plan writers reclaim abandoned locks even while the recorded process is alive",
    { skip: platform === "win32" },
    async () => {
        const root = await mkdtemp(join(tmpdir(), "rw-abandoned-plan-lock-"));
        try {
            await savePlan(root, "demo", "# Demo\n", { planId: "demo" });
            const layout = resolveProjectRuntimeLayout(root);
            for (const name of ["demo.lock", "catalog.lock"]) {
                const path = join(layout.selected.planLocksDir, name);
                const past = new Date(Date.now() - 60_000);
                await writeFile(
                    path,
                    JSON.stringify({
                        token: "abandoned",
                        pid: pid,
                        hostname: hostname(),
                        updatedAtMs: past.getTime(),
                    }),
                );
                await utimes(path, past, past);
                const operation = name === "catalog.lock"
                    ? withPlanCatalogLock(root, () => Promise.resolve("acquired"))
                    : withPlanLock(root, "demo", () => Promise.resolve("acquired"));
                try {
                    assertEquals(await promptly(operation), "acquired");
                } finally {
                    // Also release the pre-fix waiter, so a failing regression never
                    // leaves a five-minute task behind in the isolated test process.
                    await rm(path).catch(() => {});
                    await operation;
                }
            }
        } finally {
            await rm(root, { recursive: true });
        }
    },
);

test("Plan writers never reclaim an operating-system lock just because its heartbeat is old", {
    skip: platform === "win32",
}, async () => {
    const root = await mkdtemp(join(tmpdir(), "rw-held-plan-lock-"));
    try {
        await savePlan(root, "demo", "# Demo\n", { planId: "demo" });
        const path = join(resolveProjectRuntimeLayout(root).selected.planLocksDir, "demo.lock");
        const past = new Date(Date.now() - 60_000);
        const owner = JSON.stringify({
            token: "still-held",
            pid: pid,
            hostname: hostname(),
            updatedAtMs: past.getTime(),
        });
        await writeFile(path, owner);
        await utimes(path, past, past);
        const file = openNativeFileLock(path, false);
        file.lockSync(true);
        let acquired = false;
        const operation = withPlanLock(root, "demo", () => {
            acquired = true;
            return Promise.resolve();
        });
        try {
            await new Promise((resolve) => setTimeout(resolve, 150));
            assertEquals(acquired, false);
            assertEquals(await readFile(path, "utf8"), owner);
        } finally {
            file.close();
            // The orphan is intentionally left for ordinary acquisition to repair.
            try {
                await promptly(operation);
            } finally {
                await rm(path).catch(() => {});
                await operation;
            }
        }
    } finally {
        await rm(root, { recursive: true });
    }
});

test("Plan catalog reads remain available during a writer while identity backfills serialize", async () => {
    const root = await mkdtemp(join(tmpdir(), "rw-catalog-read-"));
    let release = () => {};
    let entered = () => {};
    const held = new Promise<void>((resolve) => entered = resolve);
    const finish = new Promise<void>((resolve) => release = resolve);
    try {
        await savePlan(root, "demo", "# Demo\n", { planId: "demo" });
        const missingIdentityPath = join(root, "docs", "plans", "missing-id.md");
        const missingIdentityText = injectFrontMatter("# Missing identity\n", { status: "draft" });
        await writeFile(missingIdentityPath, missingIdentityText);
        const writer = withPlanCatalogLock(root, async () => {
            entered();
            await finish;
        });
        await held;
        const reading = listPlanResources(root);
        let backfilled = false;
        const backfilling = listPlanResources(root, { backfillMissing: true }).then(() => backfilled = true);
        try {
            assertEquals((await promptly(reading)).some((plan) => plan.planId === "demo"), true);
            await new Promise((resolve) => setTimeout(resolve, 150));
            assertEquals(backfilled, false);
            assertEquals(await readFile(missingIdentityPath, "utf8"), missingIdentityText);
        } finally {
            release();
            await Promise.all([writer, reading, backfilling]);
        }
        assertEquals(backfilled, true);
        assertEquals((await readFile(missingIdentityPath, "utf8")).includes("planId:"), true);
    } finally {
        release();
        await rm(root, { recursive: true });
    }
});
