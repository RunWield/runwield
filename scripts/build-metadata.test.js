import { test } from "node:test";
import {
    mkdir as fsMkdir,
    mkdtemp as fsMkdtemp,
    readFile as fsReadFile,
    rm as fsRm,
    stat as fsStat,
    writeFile as fsWriteFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { notDeepStrictEqual as assertNotEquals } from "node:assert/strict";
import { assertEquals, assertRejects } from "../src/testing/assertions.ts";
import { join } from "node:path";
import { computeBuildIdentity, sha256File, verifyBuildArtifact } from "./build-metadata.js";
import { prepareDevelopmentArtifacts } from "./release-assets.js";
import { writeBuildIdentityFile } from "./write-version.js";

async function fixture() {
    const root = await fsMkdtemp(join(tmpdir(), "runwield-fixture-"));
    for (const dir of [
        "src/shared",
        "scripts",
        "third_party/plannotator/packages",
        "brand",
        "dist/workspace-runtime",
        "node_modules/@earendil-works/pi-coding-agent/dist/utils",
    ]) {
        await fsMkdir(join(root, dir), { recursive: true });
    }
    for (const file of [
        "package.json",
        "bun.lock",
        "bunfig.toml",
        "tsconfig.json",
        "tsconfig.bun.json",
        "config.schema.json",
        "image-resize-worker.js",
        "src/cli.ts",
        "src/shared/version.js",
        "scripts/compile-bun.ts",
        "dist/workspace-runtime/server.mjs",
        "node_modules/@earendil-works/pi-coding-agent/dist/utils/worker.js",
    ]) {
        await fsWriteFile(join(root, file), "initial");
    }
    return root;
}

test("common identity changes for dirty included source and resources, not generated identity/version", async () => {
    const root = await fixture();
    try {
        const identity = () => computeBuildIdentity(root, "bun:1.4.3", ["compile", "--bundle"]);
        const first = await identity();
        await fsWriteFile(join(root, "deno.json"), "obsolete Deno configuration");
        await fsWriteFile(join(root, "deno.lock"), "obsolete Deno lock");
        assertEquals(await identity(), first);
        await writeBuildIdentityFile(join(root, "src/shared/build-identity.js"), first);
        await fsWriteFile(join(root, "src/shared/version.js"), "release");
        assertEquals(await identity(), first);
        await fsWriteFile(join(root, "src/cli.ts"), "dirty, same commit");
        assertNotEquals(await identity(), first);
        const changed = await identity();
        await fsWriteFile(join(root, "dist/workspace-runtime/server.mjs"), "changed resource");
        assertNotEquals(await identity(), changed);
    } finally {
        await fsRm(root, { recursive: true });
    }
});

test("common identity includes lock, compiler version/options and explicit npm resources", async () => {
    const root = await fixture();
    try {
        const identity = () => computeBuildIdentity(root, "bun:1.4.3", ["--bundle"]);
        const first = await identity();
        assertNotEquals(await computeBuildIdentity(root, "bun:1.4.4", ["--bundle"]), first);
        assertNotEquals(await computeBuildIdentity(root, "bun:1.4.3", ["--minify"]), first);
        for (const file of [
            "bun.lock",
            "package.json",
            "bunfig.toml",
            "tsconfig.json",
            "tsconfig.bun.json",
            "node_modules/@earendil-works/pi-coding-agent/dist/utils/worker.js",
        ]) {
            const before = await identity();
            await fsWriteFile(join(root, file), "changed");
            assertNotEquals(await identity(), before);
        }
    } finally {
        await fsRm(root, { recursive: true });
    }
});

test("development bundle verifies all checksums, build identities and GNU targets before staging", async () => {
    const root = await fsMkdtemp(join(tmpdir(), "runwield-fixture-"));
    const paths = ["launcher", "x64", "arm64"].map((name) => join(root, name));
    const targets = ["aarch64-apple-darwin", "x86_64-unknown-linux-gnu", "aarch64-unknown-linux-gnu"];
    const output = join(root, "bundle");
    try {
        for (let index = 0; index < paths.length; index++) {
            await fsWriteFile(paths[index], `binary ${index}`);
            await fsWriteFile(
                `${paths[index]}.build.json`,
                JSON.stringify({
                    schema: 1,
                    protocol: 1,
                    buildId: "a".repeat(64),
                    target: targets[index],
                    version: "test-build",
                    sha256: await sha256File(paths[index]),
                }),
            );
        }
        await prepareDevelopmentArtifacts(paths[0], paths[1], paths[2], output);
        assertEquals(
            (await verifyBuildArtifact(join(output, "wld-aarch64-unknown-linux-gnu"))).buildId,
            "a".repeat(64),
        );
        await fsWriteFile(paths[1], "corrupted");
        await assertRejects(
            () => prepareDevelopmentArtifacts(paths[0], paths[1], paths[2], join(root, "invalid")),
            Error,
            "checksum",
        );
        await fsWriteFile(paths[1], "binary 1");
        const bad = JSON.parse(await fsReadFile(`${paths[2]}.build.json`, "utf8"));
        bad.buildId = "b".repeat(64);
        await fsWriteFile(`${paths[2]}.build.json`, JSON.stringify(bad));
        await assertRejects(
            () => prepareDevelopmentArtifacts(paths[0], paths[1], paths[2], join(root, "invalid")),
            Error,
            "mismatched",
        );
        assertEquals(
            await fsStat(join(root, "invalid"))
                .then(() => true)
                .catch(() => false),
            false,
        );
        bad.buildId = "a".repeat(64);
        bad.version = "another-release";
        await fsWriteFile(`${paths[2]}.build.json`, JSON.stringify(bad));
        await assertRejects(
            () => prepareDevelopmentArtifacts(paths[0], paths[1], paths[2], join(root, "invalid")),
            Error,
            "VERSION",
        );
    } finally {
        await fsRm(root, { recursive: true });
    }
});
