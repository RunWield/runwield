import {
    mkdir as fsMkdir,
    mkdtemp as fsMkdtemp,
    realpath as fsRealpath,
    rm as fsRm,
    symlink as fsSymlink,
    writeFile as fsWriteFile,
} from "node:fs/promises";
import { test } from "node:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { assertEquals, assertRejects } from "../../testing/assertions.ts";
import { readSessionArtifact } from "./read-session-artifact.ts";
import type { SessionArtifactReference } from "./file-session-store-types.ts";

test("artifact readers share canonical Markdown loading and reject escaped paths", async () => {
    const root = await fsMkdtemp(join(tmpdir(), "portable-fixture-"));
    const outside = await fsMkdtemp(join(tmpdir(), "portable-fixture-"));
    const artifact: SessionArtifactReference = {
        artifactId: "prd-1",
        kind: "prd",
        path: "docs/requirements.md",
        title: "Requirements",
        registeredAt: "2026-09-19T00:00:00.000Z",
        registeredBy: "Ideator",
        sourceSegmentId: "segment-1",
    };
    try {
        await fsMkdir(join(root, `docs`));
        await fsWriteFile(join(root, `${artifact.path}`), "# Requirements\n\nShared reader.\n");
        const document = await readSessionArtifact(root, artifact);
        assertEquals(document.markdown, "# Requirements\n\nShared reader.\n");
        assertEquals(document.imageBaseDir, join(await fsRealpath(root), "docs"));
        assertEquals(document.kind, "prd");
        await fsWriteFile(join(outside, `private.md`), "outside project");
        await fsSymlink(join(outside, `private.md`), join(root, `escape.md`));
        await assertRejects(
            () => readSessionArtifact(root, { ...artifact, path: "escape.md" }),
            Error,
            "outside its Project",
        );
    } finally {
        await fsRm(root, { recursive: true });
        await fsRm(outside, { recursive: true });
    }
});
