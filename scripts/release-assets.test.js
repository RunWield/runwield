import { captureScriptProcess } from "./script-process.ts";
import { test } from "node:test";
import {
    copyFile as fsCopyFile,
    mkdir as fsMkdir,
    mkdtemp as fsMkdtemp,
    readdir as fsReaddir,
    readFile as fsReadFile,
    rm as fsRm,
    stat as fsStat,
    writeFile as fsWriteFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { assertEquals, assertRejects } from "../src/testing/assertions.ts";
import { join } from "node:path";
import { prepareReleaseAssets, releaseAssetNames } from "./release-assets.js";

async function fixture() {
    const root = await fsMkdtemp(join(tmpdir(), "runwield-fixture-"));
    const input = join(root, "input");
    await fsMkdir(input);
    const tag = "v1.2.3";
    const names = releaseAssetNames(tag);
    for (const name of names.filter((name) => !name.endsWith(".sha256") && name !== "SHA256SUMS")) {
        if (/-(darwin-(arm64|x64)|linux-(arm64|x64))\.tar\.gz$/.test(name)) {
            const suffix = name.slice(`wld-${tag}-`.length, -".tar.gz".length);
            const target = {
                "darwin-arm64": "aarch64-apple-darwin",
                "darwin-x64": "x86_64-apple-darwin",
                "linux-arm64": "aarch64-unknown-linux-gnu",
                "linux-x64": "x86_64-unknown-linux-gnu",
            }[suffix];
            const stage = join(root, `stage-${suffix}`);
            await fsMkdir(stage);
            const binary = new TextEncoder().encode(name);
            await fsWriteFile(join(stage, "wld"), binary);
            const sha256 = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", binary)))
                .map((byte) => byte.toString(16).padStart(2, "0")).join("");
            await fsWriteFile(
                join(stage, "wld.build.json"),
                JSON.stringify({
                    schema: 1,
                    protocol: 1,
                    buildId: "a".repeat(64),
                    target,
                    version: "v1.2.3",
                    sha256,
                }),
            );
            const result = await captureScriptProcess("tar", {
                args: ["-czf", join(input, name), "-C", stage, "wld", "wld.build.json"],
            });
            if (!result.success) throw new Error("Could not create test archive");
        } else await fsWriteFile(join(input, name), name);
        const bytes = await fsReadFile(join(input, name));
        if (names.includes(`${name}.sha256`)) {
            const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)))
                .map((byte) => byte.toString(16).padStart(2, "0")).join("");
            await fsWriteFile(join(input, `${name}.sha256`), `${digest}  ${name}\n`);
        }
    }
    return { root, input, tag, output: join(root, "output") };
}

test("release assets exclude incidental package JSON and produce a unique flat set", async () => {
    const f = await fixture();
    try {
        await fsMkdir(join(f.input, "other"));
        await fsWriteFile(join(f.input, "package.json"), "{}");
        await fsWriteFile(join(f.input, "other/package.json"), "{}");
        await prepareReleaseAssets(f.input, f.output, f.tag);
        const names = Array.fromAsync(await fsReaddir(f.output, { withFileTypes: true }), (entry) => entry.name);
        assertEquals((await names).sort(), releaseAssetNames(f.tag).sort());
    } finally {
        await fsRm(f.root, { recursive: true });
    }
});

for (const failure of ["duplicate", "missing", "corrupt", "unsafe checksum", "published checksum"]) {
    test(`release assets reject ${failure} before staging publication`, async () => {
        const f = await fixture();
        try {
            const name = `wld-${f.tag}-darwin-arm64.tar.gz`;
            if (failure === "duplicate") {
                await fsMkdir(join(f.input, "other"));
                await fsCopyFile(join(f.input, name), join(f.input, "other", name));
            } else if (failure === "missing") await fsRm(join(f.input, name));
            else if (failure === "corrupt") await fsWriteFile(join(f.input, name), "changed");
            else if (failure === "unsafe checksum") {
                await fsWriteFile(join(f.input, `${name}.sha256`), `${"a".repeat(64)}  ../escape\n`);
            } else await fsWriteFile(join(f.input, "SHA256SUMS"), `${"a".repeat(64)}  ${name}\n`);
            await assertRejects(
                () => prepareReleaseAssets(f.input, f.output, f.tag, failure === "published checksum", "unused.json"),
                Error,
                failure === "published checksum" ? "Published SHA256SUMS" : "",
            );
            assertEquals(await fsStat(f.output).then(() => true).catch(() => false), false);
        } finally {
            await fsRm(f.root, { recursive: true });
        }
    });
}

for (const corruptMetadata of [false, true]) {
    test(`published release recovery ${corruptMetadata ? "rejects a changed schema" : "preserves every checked byte"}`, async () => {
        const f = await fixture();
        try {
            await prepareReleaseAssets(f.input, f.output, f.tag);
            const assets = [];
            for (const name of releaseAssetNames(f.tag)) {
                const bytes = await fsReadFile(join(f.output, name));
                const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)))
                    .map((byte) => byte.toString(16).padStart(2, "0")).join("");
                assets.push({ name, digest: `sha256:${digest}` });
            }
            const metadata = join(f.root, "published.json");
            await fsWriteFile(metadata, JSON.stringify({ assets }));
            const recovered = join(f.root, "recovered");
            if (corruptMetadata) {
                await fsWriteFile(join(f.output, "config.schema.json"), "changed");
                await assertRejects(
                    () => prepareReleaseAssets(f.output, recovered, f.tag, true, metadata),
                    Error,
                    "digest",
                );
            } else {
                await prepareReleaseAssets(f.output, recovered, f.tag, true, metadata);
                for (const name of releaseAssetNames(f.tag)) {
                    assertEquals(await fsReadFile(join(recovered, name)), await fsReadFile(join(f.output, name)));
                }
            }
        } finally {
            await fsRm(f.root, { recursive: true });
        }
    });
}

for (const field of ["buildId", "version"]) {
    test(`release publication rejects a GNU runtime with a different launcher ${field}`, async () => {
        const f = await fixture();
        try {
            const name = `wld-${f.tag}-linux-x64.tar.gz`;
            const stage = join(f.root, "stage-linux-x64");
            const metadataPath = join(stage, "wld.build.json");
            const metadata = JSON.parse(await fsReadFile(metadataPath, "utf8"));
            metadata[field] = field === "buildId" ? "b".repeat(64) : "v9.8.7";
            await fsWriteFile(metadataPath, JSON.stringify(metadata));
            const result = await captureScriptProcess("tar", {
                args: ["-czf", join(f.input, name), "-C", stage, "wld", "wld.build.json"],
            });
            if (!result.success) throw new Error("Could not create test archive");
            const digest = Array.from(
                new Uint8Array(await crypto.subtle.digest("SHA-256", await fsReadFile(join(f.input, name)))),
            )
                .map((byte) => byte.toString(16).padStart(2, "0")).join("");
            await fsWriteFile(join(f.input, `${name}.sha256`), `${digest}  ${name}\n`);
            await assertRejects(() => prepareReleaseAssets(f.input, f.output, f.tag), Error, "does not match launcher");
        } finally {
            await fsRm(f.root, { recursive: true });
        }
    });
}

test("published release recovery requires independent asset digests", async () => {
    const f = await fixture();
    try {
        await prepareReleaseAssets(f.input, f.output, f.tag);
        await assertRejects(
            () => prepareReleaseAssets(f.output, join(f.root, "recovered"), f.tag, true),
            Error,
            "requires GitHub asset digests",
        );
    } finally {
        await fsRm(f.root, { recursive: true });
    }
});
