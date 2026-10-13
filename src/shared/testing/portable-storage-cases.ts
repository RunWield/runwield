import { createHash } from "node:crypto";
import {
    committedTranscriptMatches,
    markRecoveryAfterAbandonedWriter,
} from "../session/file-session-activation-state.ts";
import { deepEqual, equal, notEqual, ok, throws } from "node:assert/strict";
import {
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    realpathSync,
    rmSync,
    statSync,
    symlinkSync,
    utimesSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { platform } from "node:process";
import {
    catalogLockPath,
    ensureProject,
    FileSessionManifestCache,
    listManifests,
    listProjectsFromDisk,
    manifestPath,
    pathExists,
    readJson,
    recoveryDescriptorPath,
    sessionDirForRoot,
    writeManifest,
} from "../session/file-session-storage.ts";
import type { FileSessionManifest } from "../session/file-session-store-types.ts";
import { encodeCwdForSessionDir } from "../session/session-directory-name.ts";

interface PortableStorageCase {
    name: string;
    run(): void;
}

export const portableStorageCases: PortableStorageCase[] = [];
function registerCase(name: string, run: () => void): void {
    portableStorageCases.push({ name, run });
}

const timestamp = "2026-01-01T00:00:00.000Z";

function fixture() {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "portable-session-")));
    const projectRoot = join(root, "project");
    const baseDir = join(root, "sessions");
    mkdirSync(projectRoot);
    const project = ensureProject(baseDir, projectRoot);
    const sessionDir = sessionDirForRoot(baseDir, projectRoot);
    const transcriptPath = join(sessionDir, "transcript.jsonl");
    writeFileSync(transcriptPath, "transcript\n");
    const manifest: FileSessionManifest = {
        version: 1,
        runwieldSessionId: "session",
        projectId: project.projectId,
        transcriptCwd: projectRoot,
        displayName: "first",
        source: "test",
        createdAt: timestamp,
        updatedAt: timestamp,
        currentSegmentId: "segment",
        fence: 0,
        activation: {
            state: "idle",
            phase: null,
            ownerInstanceId: null,
            ownerProcessKind: null,
            operationId: null,
            expectedGeneration: null,
            acquiredAt: null,
            blockedReason: null,
        },
        generation: null,
        segments: [
            {
                segmentId: "segment",
                runwieldSessionId: "session",
                projectId: project.projectId,
                piSessionId: "pi",
                transcriptPath,
                transcriptCwd: projectRoot,
                ordinal: 0,
                kind: "planning",
                sealedAt: null,
                headerVersion: 3,
                headerTimestamp: timestamp,
                firstCatalogedAt: timestamp,
                lastCatalogedAt: timestamp,
                lineageParentSegmentId: null,
                lineageParentPiSessionId: null,
                lineageGroupKey: null,
                lineageRecordedAt: null,
                sealedByteLength: null,
                sealedDigestHex: null,
                sealedTerminalEntryId: null,
            },
        ],
    };
    const path = manifestPath(sessionDir, "session");
    writeManifest(manifest, path);
    return { root, projectRoot, baseDir, project, sessionDir, transcriptPath, manifest, path };
}

registerCase("portable project identity preserves canonical roots and directory encoding", () => {
    const f = fixture();
    try {
        equal(ensureProject(f.baseDir, f.projectRoot).projectId, f.project.projectId);
        deepEqual(listProjectsFromDisk(f.baseDir), [f.project]);
        equal(encodeCwdForSessionDir("/short/project"), "--short-project--");
        const long = "/" + "long/".repeat(40) + "project";
        equal(encodeCwdForSessionDir(long), "--project-65c718e1fabf34b83185841223db6f3a--");
        notEqual(encodeCwdForSessionDir(long), encodeCwdForSessionDir("/different" + long));
        throws(() => ensureProject(f.baseDir, "relative"), /must be absolute/);
        throws(() => ensureProject(f.baseDir, f.transcriptPath), /must be a directory/);
        if (platform !== "win32") {
            const alias = join(f.root, "alias");
            symlinkSync(f.projectRoot, alias);
            equal(ensureProject(f.baseDir, alias).projectId, f.project.projectId);
            const transcriptAlias = join(f.sessionDir, "alias.jsonl");
            symlinkSync(f.transcriptPath, transcriptAlias);
            equal(catalogLockPath(f.sessionDir, transcriptAlias), catalogLockPath(f.sessionDir, f.transcriptPath));
        }
    } finally {
        rmSync(f.root, { recursive: true, force: true });
    }
});

registerCase("portable filesystem readers distinguish absence, invalid JSON and path errors", () => {
    const f = fixture();
    try {
        const missing = join(f.root, "missing");
        equal(pathExists(missing), false);
        deepEqual(listProjectsFromDisk(missing), []);
        throws(() => readJson(missing), { code: "ENOENT" });
        if (platform === "win32") equal(pathExists(join(f.transcriptPath, "child")), false);
        else throws(() => pathExists(join(f.transcriptPath, "child")), { code: "ENOTDIR" });
        throws(() => listProjectsFromDisk(f.transcriptPath), { code: "ENOTDIR" });
        writeFileSync(f.path, "broken json");
        throws(() => readJson(f.path), SyntaxError);
        if (platform !== "win32") {
            const brokenLink = join(f.root, "broken-link");
            symlinkSync(missing, brokenLink);
            equal(pathExists(brokenLink), true);
        }
    } finally {
        rmSync(f.root, { recursive: true, force: true });
    }
});

registerCase("manifest cache observes atomic replacements even with the same length and mtime", () => {
    const f = fixture();
    try {
        const cache = new FileSessionManifestCache(f.baseDir);
        cache.rememberProject(f.project);
        const oldTime = new Date("2026-01-02T00:00:00.000Z");
        utimesSync(f.path, oldTime, oldTime);
        cache.remember(f.path, f.manifest);
        const first = cache.readPath(f.path);
        ok(first);
        first.manifest.displayName = "caller mutation";
        first.manifest.segments[0].transcriptPath = "caller-mutated transcript";
        first.manifest.activation.state = "uncertain";
        equal(cache.readPath(f.path)?.manifest.displayName, "first");
        equal(cache.readPath(f.path)?.manifest.segments[0].transcriptPath, f.transcriptPath);
        equal(cache.readPath(f.path)?.manifest.activation.state, "idle");
        const before = statSync(f.path);
        f.manifest.displayName = "other";
        writeManifest(f.manifest, f.path);
        utimesSync(f.path, oldTime, oldTime);
        equal(statSync(f.path).size, before.size);
        equal(statSync(f.path).mtime.getTime(), before.mtime.getTime());
        equal(cache.readPath(f.path)?.manifest.displayName, "other");
        equal(cache.findByTranscriptPath(f.transcriptPath)?.manifest.displayName, "other");
        rmSync(f.path);
        equal(cache.readPath(f.path), null);
        equal(cache.resolve("session", f.project.projectId)?.manifest.displayName, "other");
        equal(pathExists(f.path), true);
    } finally {
        rmSync(f.root, { recursive: true, force: true });
    }
});

registerCase("recovery preserves damaged manifests and restores transcript-adjacent evidence", () => {
    const f = fixture();
    try {
        deepEqual(readJson(recoveryDescriptorPath(f.transcriptPath)), readJson(f.path));
        writeFileSync(f.path, "corrupt original bytes");
        const recovered = listManifests(f.sessionDir);
        equal(recovered.length, 1);
        equal(recovered[0].manifest.runwieldSessionId, "session");
        const damaged = readdirSync(join(f.sessionDir, ".runwield", "session-bundles", "session")).find((name) =>
            name.startsWith("manifest.json.damaged-"),
        );
        ok(damaged);
        equal(
            readFileSync(join(f.sessionDir, ".runwield", "session-bundles", "session", damaged), "utf8"),
            "corrupt original bytes",
        );
    } finally {
        rmSync(f.root, { recursive: true, force: true });
    }
});

registerCase("abandoned initial writers reconcile changed bytes and release unchanged baselines", () => {
    const f = fixture();
    try {
        const bytes = readFileSync(f.transcriptPath);
        const active = {
            ...f.manifest.activation,
            state: "active" as const,
            baselineByteLength: bytes.byteLength,
            baselineDigestHex: createHash("sha256").update(bytes).digest("hex"),
        };
        f.manifest.activation = { ...active };
        markRecoveryAfterAbandonedWriter(f.manifest, timestamp);
        equal(f.manifest.activation.state, "uninitialized");
        f.manifest.activation = { ...active };
        const changed = Buffer.from(bytes);
        changed[0] ^= 1;
        writeFileSync(f.transcriptPath, changed);
        markRecoveryAfterAbandonedWriter(f.manifest, timestamp);
        equal(f.manifest.activation.state, "reconcile_required");
        equal(f.manifest.activation.blockedReason, "transcript_changed_before_initial_checkpoint");
        equal(f.manifest.activation.baselineDigestHex, active.baselineDigestHex);
        f.manifest.activation = { ...active };
        f.manifest.currentSegmentId = "missing";
        markRecoveryAfterAbandonedWriter(f.manifest, timestamp);
        equal(f.manifest.activation.state, "uncertain");
        equal(f.manifest.activation.blockedReason, "session_transcript_is_unavailable");
    } finally {
        rmSync(f.root, { recursive: true, force: true });
    }
});

registerCase("committed transcript verification rejects changed or appended bytes and missing evidence", () => {
    const f = fixture();
    try {
        const bytes = readFileSync(f.transcriptPath);
        f.manifest.generation = {
            runwieldSessionId: "session",
            projectId: f.project.projectId,
            generation: 1,
            evidenceVersion: 1,
            digestAlgorithm: "sha256",
            byteLength: bytes.byteLength,
            terminalEntryId: null,
            digestHex: createHash("sha256").update(bytes).digest("hex"),
            operationId: "operation",
            fence: 1,
            currentSegmentId: "segment",
            committedAt: timestamp,
        };
        equal(committedTranscriptMatches(f.manifest), true);
        f.manifest.activation.state = "active";
        markRecoveryAfterAbandonedWriter(f.manifest, timestamp);
        equal(f.manifest.activation.state, "idle");
        const changed = Buffer.from(bytes);
        changed[0] ^= 1;
        for (const altered of [changed, Buffer.concat([bytes, Buffer.from("appended")])]) {
            writeFileSync(f.transcriptPath, altered);
            equal(committedTranscriptMatches(f.manifest), false);
            f.manifest.activation.state = "active";
            markRecoveryAfterAbandonedWriter(f.manifest, timestamp);
            equal(f.manifest.activation.state, "reconcile_required");
            equal(f.manifest.activation.blockedReason, "transcript_changed_before_writer_checkpoint");
        }
        rmSync(f.transcriptPath);
        equal(committedTranscriptMatches(f.manifest), false);
        f.manifest.currentSegmentId = "missing";
        equal(committedTranscriptMatches(f.manifest), false);
    } finally {
        rmSync(f.root, { recursive: true, force: true });
    }
});
