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
import { create, documents, packageFixture } from "../testing/plan-package-fixture.ts";
import { assertEquals, assertRejects } from "../../testing/assertions.ts";
import { readSessionArtifact } from "./read-session-artifact.ts";
import type { SessionArtifactReference } from "./file-session-store-types.ts";

const artifact: SessionArtifactReference = {
    artifactId: "artifact-1",
    kind: "prd",
    path: "docs/requirements.md",
    title: "Requirements",
    registeredAt: "2026-09-19T00:00:00.000Z",
    registeredBy: "Ideator",
    sourceSegmentId: "segment-1",
};

test("artifact readers share canonical Markdown loading and reject escaped paths", async () => {
    const root = await fsMkdtemp(join(tmpdir(), "portable-fixture-"));
    const outside = await fsMkdtemp(join(tmpdir(), "portable-fixture-"));
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

test("reopening Plan and Epic references uses the owning store and rejects stale checkout copies", async () => {
    const { root, identity, cleanup } = await packageFixture();
    const path = "docs/plans/epic/integration-report.md";
    const plan = { ...artifact, kind: "plan", path: "docs/plans/epic.md" } as const;
    const epic = { ...artifact, kind: "epic-artifact", path } as const;
    try {
        await create(identity, {
            planId: "epic.legacy",
            name: "epic",
            definition: { classification: "PROJECT", status: "draft" },
            documents: {
                ...documents,
                "context.md": "# Current Plan\n",
                "integration-report.md": "# Latest integration\n",
            },
        });
        await fsMkdir(join(root, "docs/plans/epic"), { recursive: true });
        await fsWriteFile(join(root, plan.path), "# Older Plan copy\n");
        await fsWriteFile(join(root, path), "# Older integration copy\n");
        await fsWriteFile(join(root, "docs/plans/epic/manual-qa.md"), "# Older manual QA copy\n");

        const savedPlan = await readSessionArtifact(root, plan);
        assertEquals(savedPlan.markdown, "# Current Plan\n");
        assertEquals(savedPlan.imageBaseDir, join(root, "docs/plans"));
        for (const reference of [path, "plans/epic.legacy/integration-report.md"]) {
            const savedEpic = await readSessionArtifact(root, { ...epic, path: reference });
            assertEquals(savedEpic.markdown, "# Latest integration\n");
            assertEquals(savedEpic.imageBaseDir, join(root, "docs/plans/epic"));
        }
        await assertRejects(
            () => readSessionArtifact(root, { ...epic, path: "docs/plans/epic/manual-qa.md" }),
            Error,
            "not available in the authoritative Plan store",
        );
        await fsWriteFile(join(root, "docs/plans/missing.md"), "# Unowned checkout copy\n");
        await assertRejects(
            () => readSessionArtifact(root, { ...plan, path: "docs/plans/missing.md" }),
            Error,
            "not available in the authoritative Plan store",
        );
    } finally {
        await cleanup();
    }
});

test("legacy Session Plan file references retain contained Markdown and image paths", async () => {
    const root = await fsMkdtemp(join(tmpdir(), "portable-fixture-"));
    try {
        await fsWriteFile(join(root, "artifact.md"), "# Legacy file\n");
        const legacy = await readSessionArtifact(root, { ...artifact, kind: "plan", path: "artifact.md" });
        assertEquals(legacy.markdown, "# Legacy file\n");
        assertEquals(legacy.imageBaseDir, await fsRealpath(root));
    } finally {
        await fsRm(root, { recursive: true });
    }
});
