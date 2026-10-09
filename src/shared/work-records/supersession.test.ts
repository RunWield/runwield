import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import {
    acquireRecoveryLock,
    acquireSupersessionLock,
    applyWorkRecordSupersession,
    buildWorkRecordIndexDocument,
    buildWorkRecordIndexTags,
    confirmWorkRecordSupersession,
    findWorkRecordById,
    generateWorkRecordForSource,
    listWorkRecordSupersessionProposals,
    previewWorkRecordBackfill,
    rejectWorkRecordSupersession,
    WorkRecordSupersessionRollbackError,
    writeWorkRecord,
} from "./index.ts";
import { withProcessGlobalTestLock } from "../../testing/process-global-lock.ts";
import { getRunWieldRuntimeDir, PROJECT_INTERNAL_RUNTIME_DIR_NAME } from "../../constants.js";
import { savePlan } from "../../plan-store.js";
import { defineCommittedGitFixture, git } from "../git-test-fixture.ts";
import { createWorkRecordMnemotecaFixture } from "./test-fixtures/mnemoteca-port.ts";
import { enterProjectRuntime } from "../project-runtime-layout.ts";

const linkedCheckoutFixture = defineCommittedGitFixture({ ".gitignore": ".wld/\n", "README.md": "# Fixture\n" });

const PREDECESSOR_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_ID = "22222222-2222-4222-8222-222222222222";
const SUCCESSOR_ID = "33333333-3333-4333-8333-333333333333";

type WorkRecordLockAcquire = (cwd: string) => Promise<() => Promise<void>>;

function selectedInternalPath(cwd: string, fileName: string): string {
    return join(getRunWieldRuntimeDir(Deno.realPathSync(cwd)), PROJECT_INTERNAL_RUNTIME_DIR_NAME, fileName);
}

async function assertMissing(path: string): Promise<void> {
    await assertRejects(() => Deno.stat(path), Deno.errors.NotFound);
}

async function assertLinkedWorkRecordLockExclusion(
    fileName: string,
    branchName: string,
    acquire: WorkRecordLockAcquire,
): Promise<void> {
    const root = await linkedCheckoutFixture.checkout({ prefix: "rw-work-record-lock-primary-" });
    const container = await Deno.makeTempDir({ prefix: "rw-work-record-lock-tree-" });
    const selected = join(container, "selected");
    try {
        await enterProjectRuntime(root);
        await git(root, ["worktree", "add", "-b", branchName, selected, "HEAD"]);
        await enterProjectRuntime(selected);
        const selectedPath = selectedInternalPath(selected, fileName);
        const primaryPath = selectedInternalPath(root, fileName);
        const legacySelectedPath = join(getRunWieldRuntimeDir(Deno.realPathSync(selected)), fileName);
        const entries: string[] = [];
        let releaseFirst = () => {};
        let signalFirst = () => {};
        const firstMayFinish = new Promise<void>((resolve) => releaseFirst = resolve);
        const firstEntered = new Promise<void>((resolve) => signalFirst = resolve);
        const first = (async () => {
            const release = await acquire(selected);
            try {
                entries.push("selected-first");
                assertEquals(JSON.parse(await Deno.readTextFile(selectedPath)).token.length > 0, true);
                await assertMissing(primaryPath);
                await assertMissing(legacySelectedPath);
                signalFirst();
                await firstMayFinish;
            } finally {
                await release();
            }
        })();
        await firstEntered;
        const second = (async () => {
            const release = await acquire(selected);
            try {
                entries.push("selected-second");
            } finally {
                await release();
            }
        })();
        await new Promise((resolve) => setTimeout(resolve, 75));
        assertEquals(entries, ["selected-first"]);
        const releasePrimary = await acquire(root);
        try {
            entries.push("primary");
            assertEquals(JSON.parse(await Deno.readTextFile(primaryPath)).token.length > 0, true);
        } finally {
            await releasePrimary();
        }
        releaseFirst();
        await Promise.all([first, second]);
        assertEquals(entries, ["selected-first", "primary", "selected-second"]);
        await assertMissing(selectedPath);
        await assertMissing(primaryPath);
    } finally {
        await git(root, ["worktree", "remove", "--force", selected]).catch(() => {});
        await Deno.remove(container, { recursive: true }).catch(() => {});
        await Deno.remove(root, { recursive: true }).catch(() => {});
    }
}

function attrs(recordId: string) {
    return {
        kind: "work_record" as const,
        recordId,
        status: "approved" as const,
        scope: "quick_fix" as const,
        origin: "external" as const,
        completionMode: "verified" as const,
        createdAt: "2026-08-01T00:00:00.000Z",
    };
}

async function seed(cwd: string, withProposal = true) {
    await writeWorkRecord(cwd, attrs(PREDECESSOR_ID), "# Old\n\n## Summary\n\nOld work.", { fileName: "old.md" });
    await writeWorkRecord(cwd, attrs(OTHER_ID), "# Other\n\n## Summary\n\nOther work.", { fileName: "other.md" });
    await writeWorkRecord(
        cwd,
        {
            ...attrs(SUCCESSOR_ID),
            ...(withProposal
                ? {
                    supersessionProposal: {
                        candidates: [
                            { recordId: PREDECESSOR_ID, reason: "Replaced by the complete result." },
                            { recordId: OTHER_ID, reason: "Combined into the complete result." },
                        ],
                    },
                }
                : {}),
        },
        "# New\n\n## Summary\n\nNew work.",
        { fileName: "new.md" },
    );
}

Deno.test("Work Record supersession applies canonical files and keeps the index derived", async () => {
    const cwd = await Deno.makeTempDir();
    try {
        await seed(cwd, false);
        const mnemotecaPort = createWorkRecordMnemotecaFixture();
        const result = await applyWorkRecordSupersession(cwd, {
            successorRecordId: SUCCESSOR_ID,
            predecessorRecordIds: [PREDECESSOR_ID],
            mnemotecaPort,
        });
        assertEquals(result.indexWarning, undefined);
        assertEquals((await findWorkRecordById(cwd, PREDECESSOR_ID))?.attrs.supersededBy, SUCCESSOR_ID);
        assertEquals((await findWorkRecordById(cwd, SUCCESSOR_ID))?.attrs.supersedes, [PREDECESSOR_ID]);
        assertEquals(mnemotecaPort.snapshot().length, 2);
    } finally {
        await Deno.remove(cwd, { recursive: true });
    }
});

Deno.test("Work Record locks exclude the same linked checkout but not the primary checkout", async () => {
    await assertLinkedWorkRecordLockExclusion(
        "work-record-supersession.lock",
        "worktree/work-record-supersession-locks",
        acquireSupersessionLock,
    );
    await assertLinkedWorkRecordLockExclusion(
        "work-record-supersession-recovery.lock",
        "worktree/work-record-recovery-locks",
        acquireRecoveryLock,
    );
});

Deno.test("supersession lock release does not remove a replacement owned by another token", async () => {
    const cwd = await Deno.makeTempDir();
    try {
        await seed(cwd, false);
        const fixture = createWorkRecordMnemotecaFixture();
        let signalSync: (() => void) | undefined;
        const syncStarted = new Promise<void>((resolve) => signalSync = resolve);
        let releaseSync: (() => void) | undefined;
        const syncGate = new Promise<void>((resolve) => releaseSync = resolve);
        let delayed = false;
        const mnemotecaPort = {
            async run(args: string[], options?: { cwd?: string }) {
                if (!delayed && args[0] === "add") {
                    delayed = true;
                    signalSync?.();
                    await syncGate;
                }
                return await fixture.run(args, options);
            },
        };
        const operation = applyWorkRecordSupersession(cwd, {
            successorRecordId: SUCCESSOR_ID,
            predecessorRecordIds: [PREDECESSOR_ID],
            mnemotecaPort,
        });
        await syncStarted;

        const lockPath = selectedInternalPath(cwd, "work-record-supersession.lock");
        await Deno.remove(lockPath);
        const replacementTime = Date.now();
        await Deno.writeTextFile(
            lockPath,
            JSON.stringify({ token: "replacement-owner", createdAt: replacementTime, updatedAt: replacementTime }),
            { createNew: true },
        );
        releaseSync?.();
        await operation;

        assertEquals(JSON.parse(await Deno.readTextFile(lockPath)).token, "replacement-owner");
    } finally {
        await Deno.remove(cwd, { recursive: true });
    }
});

Deno.test("supersession recovers malformed locks only after their file mtimes are stale", async () => {
    const cwd = await Deno.makeTempDir();
    try {
        await seed(cwd, false);
        await enterProjectRuntime(cwd);
        const runtimeDir = join(getRunWieldRuntimeDir(Deno.realPathSync(cwd)), PROJECT_INTERNAL_RUNTIME_DIR_NAME);
        const lockPath = join(runtimeDir, "work-record-supersession.lock");
        const recoveryLockPath = join(runtimeDir, "work-record-supersession-recovery.lock");
        await Deno.mkdir(runtimeDir, { recursive: true });
        await Deno.writeTextFile(lockPath, '{"token":');
        await Deno.writeTextFile(recoveryLockPath, '{"createdAt":');
        const staleTime = new Date(Date.now() - 11 * 60_000);
        await Deno.utime(lockPath, staleTime, staleTime);
        await Deno.utime(recoveryLockPath, staleTime, staleTime);

        await applyWorkRecordSupersession(cwd, {
            successorRecordId: SUCCESSOR_ID,
            predecessorRecordIds: [PREDECESSOR_ID],
            mnemotecaPort: createWorkRecordMnemotecaFixture(),
        });

        assertEquals((await findWorkRecordById(cwd, PREDECESSOR_ID))?.attrs.supersededBy, SUCCESSOR_ID);
    } finally {
        await Deno.remove(cwd, { recursive: true });
    }
});

Deno.test("concurrent supersession projection indexes the latest canonical successor", async () => {
    const cwd = await Deno.makeTempDir();
    try {
        await seed(cwd, false);
        const fixture = createWorkRecordMnemotecaFixture();
        let signalFirstSync: (() => void) | undefined;
        const firstSync = new Promise<void>((resolve) => signalFirstSync = resolve);
        let releaseFirstSync: (() => void) | undefined;
        const firstSyncGate = new Promise<void>((resolve) => releaseFirstSync = resolve);
        let delayed = false;
        const mnemotecaPort = {
            async run(args: string[], options?: { cwd?: string }) {
                if (!delayed && args[0] === "add") {
                    delayed = true;
                    signalFirstSync?.();
                    await firstSyncGate;
                }
                return await fixture.run(args, options);
            },
        };

        const first = applyWorkRecordSupersession(cwd, {
            successorRecordId: SUCCESSOR_ID,
            predecessorRecordIds: [PREDECESSOR_ID],
            mnemotecaPort,
        });
        await firstSync;
        const second = applyWorkRecordSupersession(cwd, {
            successorRecordId: SUCCESSOR_ID,
            predecessorRecordIds: [OTHER_ID],
            mnemotecaPort,
        });
        releaseFirstSync?.();
        await Promise.all([first, second]);

        const successor = await findWorkRecordById(cwd, SUCCESSOR_ID);
        if (!successor) throw new Error("Expected the canonical successor Work Record.");
        assertEquals(successor.attrs.supersedes, [PREDECESSOR_ID, OTHER_ID]);
        const indexed = fixture.snapshot().find((document) => document.tags.includes(`work-record:${SUCCESSOR_ID}`));
        assertEquals(indexed?.content, buildWorkRecordIndexDocument(successor));
        assertEquals(indexed?.tags, buildWorkRecordIndexTags(successor));
    } finally {
        await Deno.remove(cwd, { recursive: true });
    }
});

Deno.test("Work Record proposals list, confirm only pending IDs, and retain unrequested candidates", async () => {
    const cwd = await Deno.makeTempDir();
    try {
        await seed(cwd);
        assertEquals((await listWorkRecordSupersessionProposals(cwd)).length, 2);
        await assertRejects(
            () =>
                confirmWorkRecordSupersession(cwd, {
                    successorRecordId: SUCCESSOR_ID,
                    predecessorRecordIds: ["44444444-4444-4444-8444-444444444444"],
                    mnemotecaPort: createWorkRecordMnemotecaFixture(),
                }),
            Error,
            "not found",
        );
        await confirmWorkRecordSupersession(cwd, {
            successorRecordId: SUCCESSOR_ID,
            predecessorRecordIds: [PREDECESSOR_ID],
            mnemotecaPort: createWorkRecordMnemotecaFixture(),
        });
        const successor = await findWorkRecordById(cwd, SUCCESSOR_ID);
        assertEquals(successor?.attrs.supersessionProposal?.candidates.map((item) => item.recordId), [OTHER_ID]);
    } finally {
        await Deno.remove(cwd, { recursive: true });
    }
});

Deno.test("apply validates duplicate, self, missing, conflict, and idempotent requests case-insensitively", async () => {
    const cwd = await Deno.makeTempDir();
    try {
        await seed(cwd, false);
        const options = { mnemotecaPort: createWorkRecordMnemotecaFixture() };
        await assertRejects(
            () =>
                applyWorkRecordSupersession(cwd, {
                    ...options,
                    successorRecordId: SUCCESSOR_ID,
                    predecessorRecordIds: [PREDECESSOR_ID, PREDECESSOR_ID.toUpperCase()],
                }),
            Error,
            "duplicates",
        );
        await assertRejects(
            () =>
                applyWorkRecordSupersession(cwd, {
                    ...options,
                    successorRecordId: SUCCESSOR_ID.toUpperCase(),
                    predecessorRecordIds: [SUCCESSOR_ID],
                }),
            Error,
            "cannot supersede itself",
        );
        await assertRejects(
            () =>
                applyWorkRecordSupersession(cwd, {
                    ...options,
                    successorRecordId: SUCCESSOR_ID,
                    predecessorRecordIds: ["44444444-4444-4444-8444-444444444444"],
                }),
            Error,
            "was not found",
        );

        await applyWorkRecordSupersession(cwd, {
            ...options,
            successorRecordId: SUCCESSOR_ID.toUpperCase(),
            predecessorRecordIds: [PREDECESSOR_ID.toUpperCase()],
        });
        await applyWorkRecordSupersession(cwd, {
            ...options,
            successorRecordId: SUCCESSOR_ID,
            predecessorRecordIds: [PREDECESSOR_ID],
        });
        assertEquals((await findWorkRecordById(cwd, PREDECESSOR_ID))?.attrs.supersededBy, SUCCESSOR_ID);
        assertEquals((await findWorkRecordById(cwd, SUCCESSOR_ID))?.attrs.supersedes, [PREDECESSOR_ID]);

        await assertRejects(
            () =>
                applyWorkRecordSupersession(cwd, {
                    ...options,
                    successorRecordId: OTHER_ID,
                    predecessorRecordIds: [PREDECESSOR_ID],
                }),
            Error,
            "already superseded by",
        );
    } finally {
        await Deno.remove(cwd, { recursive: true });
    }
});

Deno.test("partial supersession write rolls back canonical records", async () => {
    await withProcessGlobalTestLock(async () => {
        const cwd = await Deno.makeTempDir();
        const originalRename = Deno.rename;
        try {
            await seed(cwd, false);
            let calls = 0;
            Deno.rename = (oldpath, newpath) => {
                calls += 1;
                if (calls === 2) return Promise.reject(new Error("injected second replacement failure"));
                return originalRename(oldpath, newpath);
            };
            await assertRejects(
                () =>
                    applyWorkRecordSupersession(cwd, {
                        successorRecordId: SUCCESSOR_ID,
                        predecessorRecordIds: [PREDECESSOR_ID],
                        mnemotecaPort: createWorkRecordMnemotecaFixture(),
                    }),
                Error,
                "injected second replacement failure",
            );
            assertEquals((await findWorkRecordById(cwd, SUCCESSOR_ID))?.attrs.supersedes, undefined);
            assertEquals((await findWorkRecordById(cwd, PREDECESSOR_ID))?.attrs.status, "approved");
        } finally {
            Deno.rename = originalRename;
            await Deno.remove(cwd, { recursive: true });
        }
    });
});

Deno.test("rollback failure reports original error and every uncertain canonical path", async () => {
    await withProcessGlobalTestLock(async () => {
        const cwd = await Deno.makeTempDir();
        const originalRename = Deno.rename;
        try {
            await seed(cwd, false);
            await enterProjectRuntime(cwd);
            let calls = 0;
            Deno.rename = (oldpath, newpath) => {
                calls += 1;
                if (calls >= 2) return Promise.reject(new Error(`injected rename failure ${calls}`));
                return originalRename(oldpath, newpath);
            };
            const error = await assertRejects(
                () =>
                    applyWorkRecordSupersession(cwd, {
                        successorRecordId: SUCCESSOR_ID,
                        predecessorRecordIds: [PREDECESSOR_ID],
                        mnemotecaPort: createWorkRecordMnemotecaFixture(),
                    }),
                WorkRecordSupersessionRollbackError,
                "Original error: injected rename failure 2",
            );
            assertEquals(error.uncertainRelativePaths, ["docs/work-records/new.md"]);
            assertStringIncludes(error.message, "docs/work-records/new.md");
            assertEquals(error.originalError.message, "injected rename failure 2");
        } finally {
            Deno.rename = originalRename;
            await Deno.remove(cwd, { recursive: true });
        }
    });
});

Deno.test("generation preserves its successor when supersession rollback is incomplete", async () => {
    await withProcessGlobalTestLock(async () => {
        const cwd = await Deno.makeTempDir();
        const originalRename = Deno.rename;
        try {
            await writeWorkRecord(cwd, attrs(PREDECESSOR_ID), "# Old\n\n## Summary\n\nOld work.", {
                fileName: "old.md",
            });
            await savePlan(cwd, "successor", "# Successor\n\n## Plan\n\nReplace old work.", {
                planId: "plan-successor",
                classification: "FEATURE",
                complexity: "LOW",
                summary: "Replacement result.",
                affectedPaths: [],
                createdAt: "2026-08-02T00:00:00.000Z",
                status: "verified",
                supersedes: [PREDECESSOR_ID],
            });
            const source = (await previewWorkRecordBackfill(cwd)).eligible[0];
            let calls = 0;
            Deno.rename = (oldpath, newpath) => {
                calls += 1;
                if (calls >= 2) return Promise.reject(new Error(`injected generation rename failure ${calls}`));
                return originalRename(oldpath, newpath);
            };
            const outcome = await generateWorkRecordForSource(cwd, source, {
                idGenerator: () => SUCCESSOR_ID,
                now: () => new Date("2026-08-03T00:00:00.000Z"),
                runRecorderStep: () => Promise.resolve({ title: "Successor", summary: "Replacement complete." }),
                mnemotecaPort: createWorkRecordMnemotecaFixture(),
            });

            assertEquals(outcome.status, "failed");
            assertStringIncludes(outcome.error || "", "rollback was incomplete");
            assertStringIncludes(outcome.error || "", "docs/work-records/2026-08-03-successor.md");
            assertEquals((await findWorkRecordById(cwd, SUCCESSOR_ID))?.attrs.recordId, SUCCESSOR_ID);
        } finally {
            Deno.rename = originalRename;
            await Deno.remove(cwd, { recursive: true });
        }
    });
});

Deno.test("reject removes only named pending proposal and reports index failure as a warning", async () => {
    const cwd = await Deno.makeTempDir();
    try {
        await seed(cwd);
        const result = await rejectWorkRecordSupersession(cwd, {
            successorRecordId: SUCCESSOR_ID,
            predecessorRecordIds: [PREDECESSOR_ID],
            mnemotecaPort: {
                run: () =>
                    Promise.resolve({
                        success: false,
                        code: 1,
                        stdout: new Uint8Array(),
                        stderr: new TextEncoder().encode("offline"),
                    }),
            },
        });
        assertStringIncludes(result.indexWarning || "", "index rebuild");
        assertEquals(result.record.attrs.supersessionProposal?.candidates.map((item) => item.recordId), [OTHER_ID]);
        assertEquals((await findWorkRecordById(cwd, PREDECESSOR_ID))?.attrs.status, "approved");
    } finally {
        await Deno.remove(cwd, { recursive: true });
    }
});
