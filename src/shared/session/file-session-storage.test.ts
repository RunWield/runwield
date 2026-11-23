import { deepEqual, equal } from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { FILE_SESSION_STORE_VERSION, listSessionManifestFiles, manifestPath } from "@runwield/session-files";
import { portableStorageCases } from "../testing/portable-storage-cases.ts";

for (const testCase of portableStorageCases) test(testCase.name, testCase.run);

function manifest(runwieldSessionId: string, updatedAt: string) {
    return JSON.stringify({
        version: FILE_SESSION_STORE_VERSION,
        runwieldSessionId,
        updatedAt,
        projectId: "project",
    });
}

test("passive Session evidence prefers the primary manifest and selects the newest missing manifest", () => {
    const sessionDir = mkdtempSync(join(tmpdir(), "session-evidence-"));
    try {
        const primary = manifestPath(sessionDir, "primary");
        const missing = manifestPath(sessionDir, "missing");
        mkdirSync(dirname(primary), { recursive: true });

        const primaryText = manifest("primary", "2026-01-01T00:00:00Z");
        const newestText = manifest("missing", "2026-01-02T00:00:00Z");
        writeFileSync(primary, primaryText);
        writeFileSync(join(sessionDir, "primary.jsonl.runwield.json"), manifest("primary", "2026-01-03T00:00:00Z"));
        writeFileSync(join(sessionDir, "first.jsonl.runwield.json"), manifest("missing", "2026-01-01T00:00:00Z"));
        writeFileSync(join(sessionDir, "second.jsonl.runwield.json"), newestText);
        // Copying an old descriptor can give it a newer filesystem timestamp.
        utimesSync(join(sessionDir, "first.jsonl.runwield.json"), 2000, 2000);
        utimesSync(join(sessionDir, "second.jsonl.runwield.json"), 1000, 1000);
        writeFileSync(join(sessionDir, "unreadable.jsonl.runwield.json"), "{");

        deepEqual(
            listSessionManifestFiles(sessionDir, true).map(({ path, projectId, text }) => [path, projectId, text]),
            [
                [primary, "project", primaryText],
                [missing, "project", newestText],
            ],
        );
        const replacement = manifest("missing", "2026-01-04T00:00:00Z");
        writeFileSync(join(sessionDir, "first.jsonl.runwield.json"), replacement);
        equal(listSessionManifestFiles(sessionDir, true).find((file) => file.path === missing)?.text, replacement);
        equal(existsSync(missing), false);
    } finally {
        rmSync(sessionDir, { recursive: true, force: true });
    }
});
