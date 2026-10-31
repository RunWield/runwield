/** Laptop-only committed lineage reader. Never acquires or repairs a writer. */
import { closeSync, openSync, readSync, fstatSync } from "node:fs";
import type { FileSessionManifest } from "../session/file-session-store-types.ts";
import { parseRemoteSessionTranscript, sessionDigest } from "./session-protocol.ts";

function savedPrefix(path: string, byteLength: number, digestHex: string, sealed: boolean): string {
    const file = openSync(path, "r");
    const bytes = new Uint8Array(byteLength);
    try {
        if (sealed && fstatSync(file).size !== byteLength) throw new Error("Changed sealed Session evidence");
        let offset = 0;
        while (offset < bytes.length) {
            const count = readSync(file, bytes, offset, bytes.length - offset, offset);
            if (count === 0) throw new Error("Saved Session prefix is incomplete");
            offset += count;
        }
    } finally {
        closeSync(file);
    }
    if (sessionDigest(bytes) !== digestHex) throw new Error("Saved Session digest changed");
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

export function readCommittedRemoteLineage(manifest: FileSessionManifest) {
    const generation = manifest.generation;
    if (!generation || generation.currentSegmentId !== manifest.currentSegmentId)
        throw new Error("Saved Session generation is unavailable");
    const segments = new Map(manifest.segments.map((segment) => [segment.segmentId, segment]));
    if (segments.size !== manifest.segments.length) throw new Error("Duplicate saved Session segment");
    let expectedOrdinal = segments.get(generation.currentSegmentId)?.ordinal;
    const lineage = [];
    const seen = new Set<string>();
    let segmentId: string | null = generation.currentSegmentId;
    let currentContents = "";
    while (segmentId) {
        if (seen.has(segmentId)) throw new Error("Saved Session lineage is cyclic");
        seen.add(segmentId);
        const segment = segments.get(segmentId);
        if (
            !segment ||
            segment.runwieldSessionId !== manifest.runwieldSessionId ||
            segment.projectId !== manifest.projectId ||
            segment.ordinal !== expectedOrdinal
        )
            throw new Error("Saved Session lineage is incomplete");
        const current = segmentId === generation.currentSegmentId;
        const length = current ? generation.byteLength : segment.sealedByteLength;
        const digest = current ? generation.digestHex : segment.sealedDigestHex;
        const terminal = current ? generation.terminalEntryId : segment.sealedTerminalEntryId;
        if (length === null || !digest || (!current && !segment.sealedAt))
            throw new Error("Saved Session seal is unavailable");
        const contents = savedPrefix(segment.transcriptPath, length, digest, !current);
        const entries = parseRemoteSessionTranscript(contents);
        const header = entries[0];
        const last = entries.at(-1)!;
        if (
            header.type !== "session" ||
            header.cwd !== segment.transcriptCwd ||
            header.id !== segment.piSessionId ||
            (last.type === "session" ? null : last.id) !== terminal
        )
            throw new Error("Invalid saved Session identity");
        if (current) currentContents = contents;
        lineage.unshift(entries);
        segmentId = segment.lineageParentSegmentId;
        expectedOrdinal = segment.ordinal - 1;
    }
    if (expectedOrdinal !== -1) throw new Error("Saved Session lineage does not start at its root");
    const entries = lineage.flatMap((entries, index) => (index ? entries.slice(1) : entries));
    return { entries, currentContents };
}
