import { assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { withProcessGlobalTestLock } from "../../testing/process-global-lock.ts";
import {
    createRootSessionManager,
    getRootSessionBranchEntries,
    getRunWieldSessionDir,
    getRunWieldSessionMemoryBackupDir,
    isPathInside,
    listCatalogSafeRootSessionLocators,
    listPersistedRootSessions,
    openPersistedRootSession,
    readCatalogSafeRootSessionLocator,
    resolveCreatedRootSessionPath,
} from "./root-session.js";
import { encodeCwdForSessionDir } from "../project-directory-key.ts";

Deno.test("root-session path containment accepts children but rejects sibling prefixes", () => {
    const base = join("root", "sessions");
    assertEquals(isPathInside(base, base), true);
    assertEquals(isPathInside(join(base, "session.jsonl"), base), true);
    assertEquals(isPathInside(`${base}-other`, base), false);
});

Deno.test("root-session persists a new transcript without Pi's private rewrite method", async () => {
    await withProcessGlobalTestLock(async () => {
        const previousHome = Deno.env.get("HOME");
        const home = await Deno.makeTempDir();
        const cwd = join(home, "repo");
        Deno.env.set("HOME", home);
        await Deno.mkdir(cwd);
        try {
            const manager = await createRootSessionManager("new", cwd);
            for (const method of ["_rewriteFile", "_persist"]) {
                Object.defineProperty(manager, method, {
                    configurable: true,
                    value: () => {
                        throw new Error(`private ${method} must not be used`);
                    },
                });
            }
            const transcriptPath = await resolveCreatedRootSessionPath(cwd, manager);
            manager.appendModelChange("anthropic", "test-model");
            const lines = (await Deno.readTextFile(transcriptPath)).trim().split("\n").map((line) => JSON.parse(line));
            assertEquals(lines[0].id, manager.getSessionId());
            assertEquals(lines[1].type, "model_change");

            const reopened = await openPersistedRootSession({
                cwd,
                sessionId: manager.getSessionId(),
                sessionPath: transcriptPath,
            });
            Object.defineProperty(reopened.sessionManager, "_persist", {
                configurable: true,
                value: () => {
                    throw new Error("private persistence must not be used after reopen");
                },
            });
            reopened.sessionManager.appendModelChange("anthropic", "reopened-model");
            const reopenedLines = (await Deno.readTextFile(transcriptPath)).trim().split("\n");
            assertEquals(reopenedLines.length, 3);
        } finally {
            if (previousHome === undefined) Deno.env.delete("HOME");
            else Deno.env.set("HOME", previousHome);
            await Deno.remove(home, { recursive: true });
        }
    });
});

Deno.test("root-session cwd directory encoding stays inside filename limits for long worktree paths", () => {
    const longWorktreeCwd = `/tmp/${"deep-directory-name-".repeat(12)}/.wld/worktrees/${
        "nested-project-path-".repeat(10)
    }/follow-up-repaint`;
    const encoded = encodeCwdForSessionDir(longWorktreeCwd);
    assertEquals(encoded.length < 255, true);
    assertEquals(encoded.startsWith("--follow-up-repaint-"), true);
    assertEquals(encoded.endsWith("--"), true);
});

Deno.test("root-session opens a validated transcript stored under the Project session directory with a worktree cwd", async () => {
    await withProcessGlobalTestLock(async () => {
        const previousHome = Deno.env.get("HOME");
        const home = await Deno.makeTempDir();
        Deno.env.set("HOME", home);
        let manager;
        let opened;
        try {
            const { SessionManager } = await import("@earendil-works/pi-coding-agent");
            const projectRoot = `${home}/repo`;
            const worktreeRoot = `${home}/worktree`;
            await Deno.mkdir(projectRoot, { recursive: true });
            await Deno.mkdir(worktreeRoot, { recursive: true });
            const projectSessionDir = getRunWieldSessionDir(projectRoot);
            manager = SessionManager.create(worktreeRoot, projectSessionDir, { id: "worktree-header" });
            manager.appendMessage(
                /** @type {any} */ ({
                    role: "user",
                    timestamp: Date.now(),
                    content: [{ type: "text", text: "repair context" }],
                }),
            );
            const transcriptPath = manager.getSessionFile?.();
            if (!transcriptPath) throw new Error("Expected a persisted transcript path");
            const writableManager = /** @type {any} */ (manager);
            if (typeof writableManager._rewriteFile === "function") writableManager._rewriteFile();

            await assertRejects(
                () =>
                    openPersistedRootSession({
                        cwd: worktreeRoot,
                        sessionId: "worktree-header",
                        sessionPath: transcriptPath,
                    }),
                Error,
                "outside the RunWield session directory",
            );

            await assertRejects(
                () =>
                    openPersistedRootSession({
                        cwd: worktreeRoot,
                        sessionId: "worktree-header",
                        sessionPath: transcriptPath,
                        sessionDir: projectSessionDir,
                    }),
                Error,
                "managed Project evidence",
            );

            await assertRejects(
                () =>
                    openPersistedRootSession({
                        cwd: projectRoot,
                        sessionId: "worktree-header",
                        sessionPath: transcriptPath,
                        sessionDir: projectSessionDir,
                        managedProjectRoot: projectRoot,
                        managedSegmentCwd: projectRoot,
                    }),
                Error,
                "Persisted session cwd does not match requested cwd",
            );

            opened = await openPersistedRootSession({
                cwd: worktreeRoot,
                sessionId: "worktree-header",
                sessionPath: transcriptPath,
                sessionDir: projectSessionDir,
                managedProjectRoot: projectRoot,
                managedSegmentCwd: worktreeRoot,
            });
            assertEquals(opened.resolved.cwd, await Deno.realPath(worktreeRoot));
            assertEquals(opened.resolved.sessionDir, projectSessionDir);
            assertEquals(opened.resolved.sessionPath, transcriptPath);
            assertEquals(opened.sessionManager.getSessionId(), "worktree-header");
            assertEquals(getRootSessionBranchEntries(opened.sessionManager).length, 1);

            await assertRejects(
                () =>
                    openPersistedRootSession({
                        cwd: worktreeRoot,
                        sessionId: "wrong-session",
                        sessionPath: transcriptPath,
                        sessionDir: projectSessionDir,
                        managedProjectRoot: projectRoot,
                        managedSegmentCwd: worktreeRoot,
                    }),
                Error,
                "Persisted session not found",
            );
        } finally {
            await Promise.resolve((/** @type {any} */ (opened?.sessionManager))?.dispose?.());
            await Promise.resolve((/** @type {any} */ (manager))?.dispose?.());
            if (previousHome === undefined) Deno.env.delete("HOME");
            else Deno.env.set("HOME", previousHome);
            await removeTempDirBestEffort(home);
        }
    });
});

Deno.test("root-session persisted helpers list open and guard cwd paths", async () => {
    await withProcessGlobalTestLock(async () => {
        const previousHome = Deno.env.get("HOME");
        const home = await Deno.makeTempDir();
        Deno.env.set("HOME", home);
        try {
            const { SessionManager } = await import("@earendil-works/pi-coding-agent");
            const cwd = `${home}/repo`;
            await Deno.mkdir(cwd, { recursive: true });
            const sessionDir = getRunWieldSessionDir(cwd);
            assertEquals(
                getRunWieldSessionMemoryBackupDir(cwd, "persisted-test"),
                `${sessionDir}/persisted-test_memory-backups`,
            );
            const manager = SessionManager.create(cwd, sessionDir, { id: "persisted-test" });
            manager.appendMessage(
                /** @type {any} */ ({
                    role: "user",
                    timestamp: Date.now(),
                    content: [{ type: "text", text: "hello" }],
                }),
            );
            manager.appendMessage(
                /** @type {any} */ ({
                    role: "assistant",
                    timestamp: Date.now(),
                    api: "test",
                    provider: "test",
                    model: "test",
                    usage: {},
                    cost: {},
                    stopReason: "end_turn",
                    content: [{ type: "text", text: "hi" }],
                }),
            );

            Deno.env.set("HOME", home);
            const sessions = await listPersistedRootSessions(cwd);
            assertEquals(sessions.length, 1);
            assertEquals(sessions[0].id, "persisted-test");

            let opened;
            for (let attempt = 0; attempt < 5; attempt++) {
                try {
                    Deno.env.set("HOME", home);
                    opened = await openPersistedRootSession({ cwd, sessionId: "persisted-test" });
                    break;
                } catch (error) {
                    if (!(error instanceof Error) || !error.message.includes("Persisted session not found")) {
                        throw error;
                    }
                    if (attempt === 4) throw error;
                    await new Promise((resolve) => setTimeout(resolve, 20));
                }
            }
            if (!opened) throw new Error("Expected persisted session to open");
            assertEquals(opened.resolved.sessionId, "persisted-test");
            assertEquals(opened.sessionManager.getSessionId(), "persisted-test");
            assertEquals(getRootSessionBranchEntries(opened.sessionManager).length, 2);

            await assertRejects(
                () =>
                    openPersistedRootSession({
                        cwd,
                        sessionId: "persisted-test",
                        sessionPath: `${home}/outside.jsonl`,
                    }),
                Error,
                "outside the RunWield session directory",
            );
        } finally {
            if (previousHome === undefined) Deno.env.delete("HOME");
            else Deno.env.set("HOME", previousHome);
            await removeTempDirBestEffort(home);
        }
    });
});

Deno.test("root-session helpers create list and open through canonical cwd aliases", async () => {
    await withProcessGlobalTestLock(async () => {
        const previousHome = Deno.env.get("HOME");
        const home = await Deno.makeTempDir();
        Deno.env.set("HOME", home);
        try {
            const realCwd = `${home}/repo`;
            const linkedCwd = `${home}/repo-link`;
            await Deno.mkdir(realCwd, { recursive: true });
            await Deno.symlink(realCwd, linkedCwd);
            const manager = await createRootSessionManager("new", linkedCwd);
            manager.appendMessage({ role: "user", timestamp: Date.now(), content: [{ type: "text", text: "hello" }] });
            manager.appendMessage(
                /** @type {any} */ ({
                    role: "assistant",
                    timestamp: Date.now(),
                    api: "test",
                    provider: "test",
                    model: "test",
                    usage: {},
                    cost: {},
                    stopReason: "end_turn",
                    content: [{ type: "text", text: "hi" }],
                }),
            );
            const sessionId = manager.getSessionId();

            const sessions = await listPersistedRootSessions(realCwd);
            assertEquals(sessions.some((session) => session.id === sessionId), true);
            const opened = await openPersistedRootSession({ cwd: realCwd, sessionId });
            assertEquals(opened.sessionManager.getSessionId(), sessionId);
        } finally {
            if (previousHome === undefined) Deno.env.delete("HOME");
            else Deno.env.set("HOME", previousHome);
            await removeTempDirBestEffort(home);
        }
    });
});

Deno.test("root-session helpers reopen Claude CLI entries in the existing RunWield JSONL", async () => {
    await withProcessGlobalTestLock(async () => {
        const previousHome = Deno.env.get("HOME");
        const home = await Deno.makeTempDir();
        Deno.env.set("HOME", home);
        try {
            const { SessionManager } = await import("@earendil-works/pi-coding-agent");
            const cwd = `${home}/repo`;
            await Deno.mkdir(cwd, { recursive: true });
            const sessionDir = getRunWieldSessionDir(cwd);
            const manager = SessionManager.create(cwd, sessionDir, { id: "claude-root" });
            manager.appendCustomEntry("runwield.execution_backend", { version: 1, backend: "claude-cli" });
            manager.appendMessage({ role: "user", timestamp: Date.now(), content: [{ type: "text", text: "hello" }] });
            manager.appendModelChange("claude-cli", "sonnet");
            manager.appendMessage({
                role: "assistant",
                timestamp: Date.now(),
                api: "anthropic-messages",
                provider: "claude-cli",
                model: "sonnet",
                usage: {
                    input: 0,
                    output: 0,
                    cacheRead: 0,
                    cacheWrite: 0,
                    totalTokens: 0,
                    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
                },
                stopReason: "stop",
                content: [{ type: "text", text: "hi" }],
            });

            const opened = await openPersistedRootSession({ cwd, sessionId: "claude-root" });
            const serialized = JSON.stringify(getRootSessionBranchEntries(opened.sessionManager));
            assertEquals(opened.resolved.sessionId, "claude-root");
            assertEquals(serialized.includes("runwield.execution_backend"), true);
            assertEquals(serialized.includes("model_change"), true);
            assertEquals(serialized.includes("hi"), true);
        } finally {
            if (previousHome === undefined) Deno.env.delete("HOME");
            else Deno.env.set("HOME", previousHome);
            await removeTempDirBestEffort(home);
        }
    });
});

Deno.test("catalog-safe root session locators read only header metadata and preserve transcript bytes", async () => {
    await withProcessGlobalTestLock(async () => {
        const previousHome = Deno.env.get("HOME");
        const home = await Deno.makeTempDir();
        Deno.env.set("HOME", home);
        try {
            const cwd = `${home}/repo`;
            await Deno.mkdir(cwd, { recursive: true });
            const sessionDir = getRunWieldSessionDir(cwd);
            await Deno.mkdir(sessionDir, { recursive: true });
            const sessionPath = `${sessionDir}/2026-01-01T00-00-00-000Z_pi-safe.jsonl`;
            const text = JSON.stringify({
                type: "session",
                version: 3,
                id: "pi-safe",
                timestamp: "2026-01-01T00:00:00.000Z",
                cwd,
            }) + "\n" + JSON.stringify({ type: "message", message: { role: "user", content: "secret" } }) + "\n";
            await Deno.writeTextFile(sessionPath, text);
            const before = await Deno.stat(sessionPath);

            const locator = await readCatalogSafeRootSessionLocator({ cwd, sessionPath });
            const listed = await listCatalogSafeRootSessionLocators(cwd);
            const after = await Deno.stat(sessionPath);

            assertEquals(locator.piSessionId, "pi-safe");
            assertEquals(locator.headerCwd, cwd);
            assertEquals(listed.locators.length, 1);
            assertEquals(listed.diagnostics, []);
            assertEquals(await Deno.readTextFile(sessionPath), text);
            assertEquals(before.mtime?.getTime(), after.mtime?.getTime());
        } finally {
            if (previousHome === undefined) Deno.env.delete("HOME");
            else Deno.env.set("HOME", previousHome);
            await removeTempDirBestEffort(home);
        }
    });
});

Deno.test("catalog-safe root session locator validates exact Pi filename structure", async () => {
    await withProcessGlobalTestLock(async () => {
        const previousHome = Deno.env.get("HOME");
        const home = await Deno.makeTempDir();
        Deno.env.set("HOME", home);
        try {
            const cwd = `${home}/repo`;
            await Deno.mkdir(cwd, { recursive: true });
            const sessionDir = getRunWieldSessionDir(cwd);
            await Deno.mkdir(sessionDir, { recursive: true });
            const substringPath = `${sessionDir}/2026-01-01T00-00-00-000Z_not-pi-safe.jsonl`;
            await Deno.writeTextFile(
                substringPath,
                JSON.stringify({
                    type: "session",
                    version: 3,
                    id: "pi-safe",
                    timestamp: "2026-01-01T00:00:00.000Z",
                    cwd,
                }) + "\n",
            );
            await assertRejects(
                () => readCatalogSafeRootSessionLocator({ cwd, sessionPath: substringPath }),
                Error,
                "exactly match",
            );

            const timestampPath = `${sessionDir}/2026-01-02T00-00-00-000Z_pi-safe.jsonl`;
            await Deno.writeTextFile(
                timestampPath,
                JSON.stringify({
                    type: "session",
                    version: 3,
                    id: "pi-safe",
                    timestamp: "2026-01-01T00:00:00.000Z",
                    cwd,
                }) + "\n",
            );
            await assertRejects(
                () => readCatalogSafeRootSessionLocator({ cwd, sessionPath: timestampPath }),
                Error,
                "timestamp does not match",
            );
        } finally {
            if (previousHome === undefined) Deno.env.delete("HOME");
            else Deno.env.set("HOME", previousHome);
            await removeTempDirBestEffort(home);
        }
    });
});

Deno.test("catalog-safe root session locator rejects headers that exceed the catalog limit", async () => {
    await withProcessGlobalTestLock(async () => {
        const previousHome = Deno.env.get("HOME");
        const home = await Deno.makeTempDir();
        Deno.env.set("HOME", home);
        try {
            const cwd = `${home}/repo`;
            await Deno.mkdir(cwd, { recursive: true });
            const sessionDir = getRunWieldSessionDir(cwd);
            await Deno.mkdir(sessionDir, { recursive: true });
            const sessionPath = `${sessionDir}/2026-01-01T00-00-00-000Z_pi-long.jsonl`;
            await Deno.writeTextFile(
                sessionPath,
                `{"type":"session","id":"pi-long","cwd":"${cwd}","padding":"${"x".repeat(256)}`,
            );
            await assertRejects(
                () => readCatalogSafeRootSessionLocator({ cwd, sessionPath, maxHeaderBytes: 128 }),
                Error,
                "exceeds catalog limit",
            );
        } finally {
            if (previousHome === undefined) Deno.env.delete("HOME");
            else Deno.env.set("HOME", previousHome);
            await removeTempDirBestEffort(home);
        }
    });
});

Deno.test("catalog-safe root session locator list limits header reads to newest candidates", async () => {
    await withProcessGlobalTestLock(async () => {
        const previousHome = Deno.env.get("HOME");
        const home = await Deno.makeTempDir();
        Deno.env.set("HOME", home);
        try {
            const cwd = `${home}/repo`;
            await Deno.mkdir(cwd, { recursive: true });
            const sessionDir = getRunWieldSessionDir(cwd);
            await Deno.mkdir(sessionDir, { recursive: true });
            const oldMalformed = `${sessionDir}/malformed.jsonl`;
            await Deno.writeTextFile(oldMalformed, "not-json\n");
            const oldTime = new Date(Date.UTC(2025, 0, 1));
            await Deno.utime(oldMalformed, oldTime, oldTime);
            for (let index = 0; index < 31; index++) {
                const timestamp = new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString();
                const id = `pi-${String(index).padStart(2, "0")}`;
                const sessionPath = `${sessionDir}/${timestamp.replace(/[:.]/g, "-")}_${id}.jsonl`;
                await Deno.writeTextFile(
                    sessionPath,
                    JSON.stringify({ type: "session", version: 3, id, timestamp, cwd }) + "\n",
                );
                const modified = new Date(Date.UTC(2026, 1, 1, 0, 0, index));
                await Deno.utime(sessionPath, modified, modified);
            }

            const listed = await listCatalogSafeRootSessionLocators(cwd, { recentLimit: 30 });

            assertEquals(listed.diagnostics, []);
            assertEquals(listed.locators.length, 30);
            assertEquals(listed.locators.some((locator) => locator.sessionPath === oldMalformed), false);
        } finally {
            if (previousHome === undefined) Deno.env.delete("HOME");
            else Deno.env.set("HOME", previousHome);
            await removeTempDirBestEffort(home);
        }
    });
});

Deno.test("catalog-safe root session locator rejects malformed or out-of-directory files", async () => {
    await withProcessGlobalTestLock(async () => {
        const previousHome = Deno.env.get("HOME");
        const home = await Deno.makeTempDir();
        Deno.env.set("HOME", home);
        try {
            const cwd = `${home}/repo`;
            await Deno.mkdir(cwd, { recursive: true });
            const sessionDir = getRunWieldSessionDir(cwd);
            await Deno.mkdir(sessionDir, { recursive: true });
            const malformed = `${sessionDir}/malformed.jsonl`;
            await Deno.writeTextFile(malformed, "not-json\n");
            const listed = await listCatalogSafeRootSessionLocators(cwd);
            assertEquals(listed.locators, []);
            assertEquals(listed.diagnostics.length, 1);

            await assertRejects(
                () => readCatalogSafeRootSessionLocator({ cwd, sessionPath: `${home}/outside.jsonl` }),
                Error,
                "outside the RunWield session directory",
            );

            const outsideTarget = `${home}/outside-target.jsonl`;
            await Deno.writeTextFile(
                outsideTarget,
                JSON.stringify({ type: "session", version: 3, id: "outside-target", cwd }) + "\n",
            );
            const symlinkPath = `${sessionDir}/2026-01-01T00-00-00-000Z_outside-target.jsonl`;
            await Deno.symlink(outsideTarget, symlinkPath);
            await assertRejects(
                () => readCatalogSafeRootSessionLocator({ cwd, sessionPath: symlinkPath }),
                Error,
                "resolves outside the RunWield session directory",
            );
        } finally {
            if (previousHome === undefined) Deno.env.delete("HOME");
            else Deno.env.set("HOME", previousHome);
            await removeTempDirBestEffort(home);
        }
    });
});

/**
 * Retries temp-dir cleanup because Pi SessionManager can finish flushing session
 * files just after a test assertion on macOS, causing transient ENOTEMPTY.
 * @param {string} path
 */
async function removeTempDirBestEffort(path) {
    for (let attempt = 0; attempt < 5; attempt += 1) {
        try {
            await Deno.remove(path, { recursive: true });
            return;
        } catch (error) {
            if (error instanceof Deno.errors.NotFound) return;
            if (attempt === 4) throw error;
            await new Promise((resolve) => setTimeout(resolve, 25));
        }
    }
}
