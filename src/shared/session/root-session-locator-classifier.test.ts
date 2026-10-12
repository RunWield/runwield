import { assertEquals } from "../../testing/assertions.ts";
import { rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { mkdtemp } from "node:fs/promises";
import { mkdir as fsMkdir, readFile as fsReadFile, writeFile as fsWriteFile } from "node:fs/promises";
import { test } from "node:test";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { openFileSessionStore } from "./file-session-store.ts";
import { classifyRootSessionLocator, getRunWieldSessionDir } from "./root-session.js";

async function makeRoot(name: string): Promise<string> {
    return await mkdtemp(join(tmpdir(), `${name}-`));
}

async function writeTranscript(cwd: string, piSessionId: string): Promise<string> {
    const sessionDir = getRunWieldSessionDir(cwd);
    await fsMkdir(sessionDir, { recursive: true });
    const timestamp = "2026-01-01T00:00:00.000Z";
    const path = join(sessionDir, `${timestamp.replace(/[:.]/g, "-")}_${piSessionId}.jsonl`);
    await fsWriteFile(path, `${JSON.stringify({ type: "session", id: piSessionId, timestamp, cwd })}\n`);
    return path;
}

function assertNoSensitivePayload(result: { reason?: string }, root: string): void {
    const payload = JSON.stringify(result);
    assertEquals(payload.includes(root), false);
    assertEquals(payload.includes("proof"), false);
    assertEquals(payload.includes("operation"), false);
}

test("classifyRootSessionLocator uses the file catalog and returns safe blocked reasons", async () => {
    const cases: Array<{
        name: string;
        expected: string;
        run: () => Promise<{ result: { kind: string; reason?: string }; root: string }>;
    }> = [
        {
            name: "cataloged Project requires a transcript path for an unknown Pi id",
            expected: "session_path_required",
            run: async () => {
                const root = await makeRoot("classifier-current-root");
                const store = openFileSessionStore();
                try {
                    store.ensureRuntimeProject({ root });
                    return {
                        result: await classifyRootSessionLocator({
                            cwd: root,
                            sessionId: "pi-1",
                            ownerCoordinationStore: store,
                        }),
                        root,
                    };
                } finally {
                    store.close();
                }
            },
        },
        {
            name: "nested working directory",
            expected: "nested_project_root",
            run: async () => {
                const root = await makeRoot("classifier-nested-root");
                const nested = join(root, "nested");
                await fsMkdir(nested);
                const store = openFileSessionStore();
                try {
                    store.ensureRuntimeProject({ root });
                    return {
                        result: await classifyRootSessionLocator({
                            cwd: nested,
                            sessionId: "pi-2",
                            ownerCoordinationStore: store,
                        }),
                        root,
                    };
                } finally {
                    store.close();
                }
            },
        },
        {
            name: "cataloging explicitly disabled",
            expected: "session_not_cataloged",
            run: async () => {
                const root = await makeRoot("classifier-uncataloged-root");
                const store = openFileSessionStore();
                try {
                    const project = store.ensureRuntimeProject({ root });
                    const sessionPath = await writeTranscript(root, "pi-3");
                    assertEquals(project.lifecycle, "enabled");
                    return {
                        result: await classifyRootSessionLocator({
                            cwd: root,
                            sessionId: "pi-3",
                            sessionPath,
                            ownerCoordinationStore: store,
                            allowCatalog: false,
                        }),
                        root,
                    };
                } finally {
                    store.close();
                }
            },
        },
        {
            name: "stale transcript path",
            expected: "invalid_transcript_locator",
            run: async () => {
                const root = await makeRoot("classifier-stale-root");
                const store = openFileSessionStore();
                try {
                    store.ensureRuntimeProject({ root });
                    return {
                        result: await classifyRootSessionLocator({
                            cwd: root,
                            sessionId: "pi-4",
                            sessionPath: join(root, "missing.jsonl"),
                            ownerCoordinationStore: store,
                        }),
                        root,
                    };
                } finally {
                    store.close();
                }
            },
        },
        {
            name: "missing Project root",
            expected: "project_root_unavailable",
            run: async () => {
                const root = await makeRoot("classifier-moved-root");
                const store = openFileSessionStore();
                try {
                    store.ensureRuntimeProject({ root });
                    await rmdir(root);
                    return {
                        result: await classifyRootSessionLocator({
                            cwd: root,
                            sessionId: "pi-5",
                            ownerCoordinationStore: store,
                        }),
                        root,
                    };
                } finally {
                    store.close();
                }
            },
        },
    ];

    for (const item of cases) {
        const { result, root } = await item.run();
        assertEquals(result.kind, "blocked", item.name);
        assertEquals(result.reason, item.expected, item.name);
        assertNoSensitivePayload(result, root);
    }
});

test("classifyRootSessionLocator silently catalogs Projects and legacy transcripts", async () => {
    const root = await makeRoot("classifier-automatic-root");
    const store = openFileSessionStore();
    try {
        assertEquals(
            await classifyRootSessionLocator({ cwd: root, ownerCoordinationStore: store }),
            { kind: "uncataloged", reason: "session_project_absent" },
        );
        const project = store.ensureRuntimeProject({ root });
        const sessionPath = await writeTranscript(root, "legacy-pi");
        const result = await classifyRootSessionLocator({
            cwd: root,
            sessionId: "legacy-pi",
            sessionPath,
            ownerCoordinationStore: store,
        });
        assertEquals(result.kind, "managed");
        assertEquals(result.project?.projectId, project.projectId);
        assertEquals(result.session?.piSessionId, "legacy-pi");
    } finally {
        store.close();
    }
});

test("classifyRootSessionLocator blocks only when no Session store was composed", async () => {
    const root = await makeRoot("classifier-no-store-root");
    const result = await classifyRootSessionLocator({ cwd: root, ownerCoordinationStore: null });
    assertEquals(result.kind, "blocked");
    assertEquals(result.reason, "session_store_unavailable");
});

test("classifyRootSessionLocator resumes a cataloged repair segment from the Project root", async () => {
    const root = await makeRoot("classifier-repair-root");
    const worktree = await makeRoot("classifier-repair-worktree");
    const store = openFileSessionStore();
    try {
        const project = store.ensureRuntimeProject({ root });
        const planningPath = await writeTranscript(root, "planning-pi");
        const session = await store.ensureSessionCatalogRecord({
            projectId: project.projectId,
            piSessionId: "planning-pi",
            transcriptPath: planningPath,
            transcriptCwd: root,
            source: "created",
        });
        const current = store.getCurrentSessionSegment(session.runwieldSessionId)!;
        const bytes = await fsReadFile(planningPath);
        store.sealSessionTranscriptSegment({
            runwieldSessionId: session.runwieldSessionId,
            segmentId: current.segmentId,
            evidence: {
                byteLength: bytes.byteLength,
                digestHex: createHash("sha256").update(bytes).digest("hex"),
                terminalEntryId: null,
            },
        });
        const sessionPath = await writeTranscript(worktree, "repair-pi");
        await store.appendSessionTranscriptSegment({
            runwieldSessionId: session.runwieldSessionId,
            projectId: project.projectId,
            piSessionId: "repair-pi",
            transcriptPath: sessionPath,
            transcriptCwd: worktree,
            kind: "semantic_repair",
        });
        const result = await classifyRootSessionLocator({
            cwd: root,
            sessionId: "repair-pi",
            sessionPath,
            ownerCoordinationStore: store,
        });
        assertEquals(result.kind, "managed");
        assertEquals(result.session?.runwieldSessionId, session.runwieldSessionId);

        const uncatalogedPath = await writeTranscript(worktree, "uncataloged-pi");
        const uncataloged = await classifyRootSessionLocator({
            cwd: root,
            sessionId: "uncataloged-pi",
            sessionPath: uncatalogedPath,
            ownerCoordinationStore: store,
        });
        assertEquals(uncataloged.kind, "blocked");
        assertEquals(uncataloged.reason, "invalid_transcript_locator");
    } finally {
        store.close();
    }
});
