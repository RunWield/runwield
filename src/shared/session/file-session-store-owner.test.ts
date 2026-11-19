import { test } from "node:test";
import { ok as assert, throws } from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getRunWieldSessionDir } from "./root-session.ts";
import { openFileSessionStore } from "./file-session-store.ts";
import { FileSessionStoreOwner } from "./file-session-store-owner.ts";

for (const borrowed of [false, true]) {
    test(`closing a SessionRuntime ${borrowed ? "preserves a caller-owned" : "releases its owned"} Session writer lock`, async () => {
        const root = await realpath(await mkdtemp(join(tmpdir(), "session-store-owner-")));
        const callerStore = borrowed ? openFileSessionStore() : null;
        const owner = new FileSessionStoreOwner(callerStore);
        const store = owner.ensure();
        const contender = openFileSessionStore();
        try {
            const sessionDir = getRunWieldSessionDir(root);
            await mkdir(sessionDir, { recursive: true });
            const transcriptPath = join(sessionDir, "2026-01-01T00-00-00-000Z_owned.jsonl");
            await writeFile(
                transcriptPath,
                `${JSON.stringify({ type: "session", version: 3, id: "owned", timestamp: "2026-01-01T00:00:00.000Z", cwd: root })}\n`,
            );
            const project = store.ensureRuntimeProject({ root });
            const session = await store.ensureSessionCatalogRecord({
                projectId: project.projectId,
                piSessionId: "owned",
                transcriptPath,
                transcriptCwd: root,
                source: "created",
            });
            const segment = store.getCurrentSessionSegment(session.runwieldSessionId);
            assert(segment);
            const request = {
                runwieldSessionId: session.runwieldSessionId,
                projectId: project.projectId,
                ownerInstanceId: "runtime",
                ownerProcessKind: "test" as const,
                expectedGeneration: null,
                expectedCurrentSegmentId: segment.segmentId,
            };
            store.acquireSessionActivation(request);
            const compete = () => contender.acquireSessionActivation({ ...request, ownerInstanceId: "second-surface" });
            throws(compete, /another RunWield surface/);
            owner.closeOwned();
            if (borrowed) {
                throws(compete, /another RunWield surface/);
                callerStore?.close();
            }
            const recovered = compete();
            contender.releaseUnchangedActivation(recovered);
        } finally {
            store.close();
            contender.close();
            await rm(root, { recursive: true, force: true });
        }
    });
}
