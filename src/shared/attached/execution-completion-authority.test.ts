import { openPlanFixturePackageLocks } from "../testing/plan-state-fixture.ts";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { writeFile as fsWriteFile } from "node:fs/promises";
import { ok as assert } from "node:assert/strict";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import process from "node:process";
import { assertEquals, assertStringIncludes } from "../../testing/assertions.ts";

import { loadPlan } from "../testing/plan-query-fixture.ts";
import { findById } from "../worktree-registry.ts";
import { withProject } from "./attached-test-fixture.ts";
import { completionInput, implementing } from "./execution-test-fixture.ts";
import type { AttachedOperationResult } from "./operations.ts";

const STARTUP_DEADLINE_MS = 15_000;
const LOCK_DEADLINE_MS = 3_000;
const LOADED = "Attached command loaded";
const CONTENDED = "waiting for exact Plan lock";

function startCompletion(root: string, planLockPath: string) {
    const script = fileURLToPath(new URL("./execution-completion-lock-fixture.ts", import.meta.url));
    const child = spawn(process.execPath, ["run", "--no-install", script, planLockPath], {
        cwd: root,
        stdio: ["pipe", "pipe", "pipe"],
    });
    const lines = createInterface({ input: child.stdout });
    const receipts = new Set<string>();
    let wake = () => {};
    let reply = "";
    let stderrBytes = 0;
    let stdinFailed = false;
    let spawnFailed = false;
    child.stderr.on("data", (chunk: Buffer) => (stderrBytes += chunk.length));
    child.stdin.on("error", () => (stdinFailed = true));
    child.on("error", () => (spawnFailed = true));
    lines.on("line", (line) => {
        if (line === LOADED || line === CONTENDED) receipts.add(line);
        else if (line.startsWith("{")) reply = line;
        wake();
    });
    const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
        child.on("close", (code, signal) => resolve({ code, signal }));
    });
    const describe = () =>
        [
            "pid=" + (child.pid ?? "none"),
            "loaded=" + receipts.has(LOADED),
            "contended=" + receipts.has(CONTENDED),
            "stdinFailed=" + stdinFailed,
            "spawnFailed=" + spawnFailed,
            "replyReceived=" + Boolean(reply),
            "stderrBytes=" + stderrBytes,
        ].join("; ");
    return {
        async waitFor(receipt: string, budget: number) {
            if (receipts.has(receipt)) return;
            let timeout: ReturnType<typeof setTimeout> | undefined;
            try {
                await Promise.race([
                    new Promise<void>((resolve) => {
                        wake = () => {
                            if (receipts.has(receipt)) resolve();
                        };
                    }),
                    closed.then(({ code, signal }) => {
                        if (receipts.has(receipt)) return;
                        throw new Error(
                            "Completion exited before " +
                                receipt +
                                "; code=" +
                                code +
                                "; signal=" +
                                signal +
                                "; " +
                                describe(),
                        );
                    }),
                    new Promise<never>((_resolve, reject) => {
                        timeout = setTimeout(
                            () => reject(new Error("Completion did not report " + receipt + "; " + describe())),
                            budget,
                        );
                    }),
                ]);
            } finally {
                clearTimeout(timeout);
                wake = () => {};
            }
        },
        send(input: ReturnType<typeof completionInput>) {
            child.stdin.end(JSON.stringify(input));
        },
        async result() {
            const { code, signal } = await closed;
            assert(reply, "Completion exited without a reply; code=" + code + "; signal=" + signal + "; " + describe());
            return { code, result: JSON.parse(reply) as AttachedOperationResult };
        },
        async stop() {
            if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
            await closed;
        },
    };
}

test("completion rejects a Plan body edit made while Core waits for the real Plan lock", async () => {
    await withProject(async (root) => {
        const started = await implementing(root);
        const execution = started.workflow.execution;
        assert(execution?.executionCwd && execution.worktreeId);
        const plan = await loadPlan(execution.executionCwd, "dark-mode-toggle");
        assert(plan);
        const locks = await openPlanFixturePackageLocks(execution.executionCwd, "dark-mode-toggle");
        const completion = startCompletion(root, locks.planPath);
        try {
            await completion.waitFor(LOADED, STARTUP_DEADLINE_MS);
            assert(locks.catalog.tryLockSync(true), "The catalog must be free before completion starts.");
            locks.catalog.unlockSync();
            assert(locks.plan.tryLockSync(true), "The fixture must hold the canonical Plan lock.");
            completion.send(completionInput(started.workflow));
            await completion.waitFor(CONTENDED, LOCK_DEADLINE_MS);
            assert(
                !locks.catalog.tryLockSync(true),
                "Core must hold the catalog before it waits for the canonical Plan.",
            );
            await fsWriteFile(plan.path, plan.markdown + "\nChanged scope while completion waits.\n");
            locks.plan.unlockSync();
            const { code, result } = await completion.result();
            assertEquals(code, 1);
            assert(!result.ok, JSON.stringify(result));
            assertStringIncludes(result.rejection.message, "Required Plan documents changed");
            assertEquals((await loadPlan(execution.executionCwd, "dark-mode-toggle"))?.attrs.status, "in_progress");
            assertEquals((await findById(root, execution.worktreeId))?.status, "active");
        } finally {
            await completion.stop();
            locks.plan.close();
            locks.catalog.close();
        }
    });
});
