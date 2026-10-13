import { captureForegroundProcess } from "../captured-process.ts";
import { mkdir as fsMkdir, mkdtemp as fsMkdtemp, rm as fsRm, writeFile as fsWriteFile } from "node:fs/promises";
import { test } from "node:test";
import { tmpdir } from "node:os";
import { assertEquals, assertRejects, assertThrows } from "../../testing/assertions.ts";
import { join } from "node:path";
import { sha256Bytes } from "../../../scripts/build-metadata.js";
import { extractReleaseRuntime, releaseRuntimeName } from "./release-artifact.ts";

test("release names select only the VERSION-tagged GNU target", () => {
    assertEquals(releaseRuntimeName("v1.2.3-rc.1", "linux-arm64"), "wld-v1.2.3-rc.1-linux-arm64.tar.gz");
    assertThrows(() => releaseRuntimeName("latest", "linux-x64"), Error, "Invalid launcher release tag");
    assertThrows(() => releaseRuntimeName("v1.2.3", "linux-musl"), Error, "Unsupported release runtime");
});

test("release extraction checks binary bytes, target, build and archive members", async () => {
    const root = await fsMkdtemp(join(tmpdir(), "portable-fixture-"));
    try {
        const stage = join(root, "stage");
        const output = join(root, "out");
        await fsMkdir(stage);
        await fsMkdir(output);
        const binary = new TextEncoder().encode("runtime");
        await fsWriteFile(join(stage, "wld"), binary);
        const metadata = {
            schema: 1,
            protocol: 1,
            target: "x86_64-unknown-linux-gnu",
            buildId: "a".repeat(64),
            version: "v1.2.3",
            sha256: await sha256Bytes(binary),
        };
        const path = join(stage, "wld.build.json");
        const archive = join(root, "runtime.tar.gz");
        const pack = async (members = ["wld", "wld.build.json"]) => {
            const result = await captureForegroundProcess("tar", {
                cwd: root,
                args: ["-czf", archive, "-C", stage, ...members],
            });
            if (result.code !== 0) throw new Error("Could not create test archive");
        };
        await fsWriteFile(path, JSON.stringify(metadata));
        await pack();
        assertEquals(
            (await extractReleaseRuntime(archive, "linux-x64", {
                buildId: metadata.buildId,
                protocol: 1,
                version: "v1.2.3",
            }, output))
                .metadata,
            metadata,
        );
        await assertRejects(() => extractReleaseRuntime(archive, "linux-arm64", null, output), Error, "target");
        await assertRejects(
            () =>
                extractReleaseRuntime(
                    archive,
                    "linux-x64",
                    { buildId: "b".repeat(64), protocol: 1, version: "v1.2.3" },
                    output,
                ),
            Error,
            "launcher build",
        );
        await fsWriteFile(path, JSON.stringify({ ...metadata, sha256: "b".repeat(64) }));
        await pack();
        await assertRejects(
            () => extractReleaseRuntime(archive, "linux-x64", null, output),
            Error,
            "checksum mismatch",
        );
        await pack(["wld"]);
        await assertRejects(() => extractReleaseRuntime(archive, "linux-x64", null, output), Error, "only wld");
    } finally {
        await fsRm(root, { recursive: true });
    }
});
