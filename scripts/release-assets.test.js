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
import { expectedReleaseAssetNames } from "./release.js";
import { sha256File } from "./build-metadata.js";

/** @param {string} tag */
async function fixture(tag = "v1.2.3") {
    const root = await fsMkdtemp(join(tmpdir(), "runwield-fixture-"));
    const input = join(root, "input");
    await fsMkdir(input);
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
                .map((byte) => byte.toString(16).padStart(2, "0"))
                .join("");
            await fsWriteFile(
                join(stage, "wld.build.json"),
                JSON.stringify({
                    schema: 1,
                    protocol: 1,
                    buildId: "a".repeat(64),
                    target,
                    version: tag,
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
                .map((byte) => byte.toString(16).padStart(2, "0"))
                .join("");
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
            const metadata = join(f.root, "published.json");
            await fsWriteFile(metadata, JSON.stringify({ assets: [] }));
            await assertRejects(
                () =>
                    prepareReleaseAssets(
                        f.input,
                        f.output,
                        f.tag,
                        failure === "published checksum",
                        failure === "published checksum" ? metadata : "",
                    ),
                Error,
                failure === "published checksum" ? "Published SHA256SUMS" : "",
            );
            assertEquals(
                await fsStat(f.output)
                    .then(() => true)
                    .catch(() => false),
                false,
            );
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
                    .map((byte) => byte.toString(16).padStart(2, "0"))
                    .join("");
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
                .map((byte) => byte.toString(16).padStart(2, "0"))
                .join("");
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

for (const tag of ["v1.2.3", "v1.2.3-rc.1"]) {
    test(`${tag} upload set includes docs only for Stable`, () => {
        const expected = [
            ...expectedReleaseAssetNames(tag),
            `wld-${tag}-windows-x64.zip`,
            `wld-${tag}-windows-x64.zip.sha256`,
            "runwield-windows-package.json",
        ];
        if (tag === "v1.2.3") expected.push(`runwield-docs-${tag}.tar.gz`, `runwield-docs-${tag}.tar.gz.sha256`);
        assertEquals(releaseAssetNames(tag).sort(), expected.sort());
    });
}

test("Candidate publication does not need or stage docs assets", async () => {
    const f = await fixture("v1.2.3-rc.1");
    try {
        await fsWriteFile(join(f.input, `runwield-docs-${f.tag}.tar.gz`), "incidental docs");
        await prepareReleaseAssets(f.input, f.output, f.tag);
        assertEquals((await fsReaddir(f.output)).sort(), releaseAssetNames(f.tag).sort());
    } finally {
        await fsRm(f.root, { recursive: true });
    }
});

for (const suffixes of [[".tar.gz"], [".tar.gz.sha256"], [".tar.gz", ".tar.gz.sha256"]]) {
    test(`new Stable publication rejects missing docs assets: ${suffixes.join(" and ")}`, async () => {
        const f = await fixture();
        try {
            for (const suffix of suffixes) await fsRm(join(f.input, `runwield-docs-${f.tag}${suffix}`));
            const name = `runwield-docs-${f.tag}${suffixes[0]}`;
            await assertRejects(() => prepareReleaseAssets(f.input, f.output, f.tag), Error, `Expected one ${name}`);
            assertEquals(
                await fsStat(f.output)
                    .then(() => true)
                    .catch(() => false),
                false,
            );
        } finally {
            await fsRm(f.root, { recursive: true });
        }
    });
}

test("Stable SHA256SUMS covers all archives including the docs archive", async () => {
    const f = await fixture();
    try {
        await prepareReleaseAssets(f.input, f.output, f.tag);
        const sums = (await fsReadFile(join(f.output, "SHA256SUMS"), "utf8")).trim().split("\n").sort();
        const checksums = await Promise.all(
            releaseAssetNames(f.tag)
                .filter((name) => name.endsWith(".sha256"))
                .map(async (name) => (await fsReadFile(join(f.output, name), "utf8")).trim()),
        );
        const docs = `runwield-docs-${f.tag}.tar.gz`;
        assertEquals(sums, checksums.sort());
        assertEquals(sums.includes(`${await sha256File(join(f.output, docs))}  ${docs}`), true);
    } finally {
        await fsRm(f.root, { recursive: true });
    }
});

test("Stable publication rejects a corrupt docs archive before staging", async () => {
    const f = await fixture();
    try {
        const name = `runwield-docs-${f.tag}.tar.gz`;
        await fsWriteFile(join(f.input, name), "changed docs");
        await assertRejects(
            () => prepareReleaseAssets(f.input, f.output, f.tag),
            Error,
            `Release checksum mismatch: ${name}.sha256`,
        );
        assertEquals(
            await fsStat(f.output)
                .then(() => true)
                .catch(() => false),
            false,
        );
    } finally {
        await fsRm(f.root, { recursive: true });
    }
});

async function legacyFixture() {
    const f = await fixture();
    for (const suffix of [".tar.gz", ".tar.gz.sha256"]) {
        await fsRm(join(f.input, `runwield-docs-${f.tag}${suffix}`));
    }
    const names = await fsReaddir(f.input);
    const sums = await Promise.all(
        names
            .filter((name) => name.endsWith(".sha256"))
            .map(async (name) => (await fsReadFile(join(f.input, name), "utf8")).trim()),
    );
    await fsWriteFile(join(f.input, "SHA256SUMS"), `${sums.join("\n")}\n`);
    const assets = [];
    for (const name of [...names, "SHA256SUMS"]) {
        assets.push({ name, digest: `sha256:${await sha256File(join(f.input, name))}` });
    }
    const metadata = join(f.root, "published.json");
    await fsWriteFile(metadata, JSON.stringify({ assets }));
    return { ...f, metadata, assets };
}

test("published legacy Stable recovery preserves a release with neither docs asset in metadata", async () => {
    const f = await legacyFixture();
    try {
        await prepareReleaseAssets(f.input, f.output, f.tag, true, f.metadata);
        assertEquals((await fsReaddir(f.output)).sort(), f.assets.map((asset) => asset.name).sort());
        for (const { name } of f.assets) {
            assertEquals(await fsReadFile(join(f.output, name)), await fsReadFile(join(f.input, name)));
        }
    } finally {
        await fsRm(f.root, { recursive: true });
    }
});

for (const suffix of [".tar.gz", ".tar.gz.sha256"]) {
    test(`published Stable recovery rejects metadata with only the docs ${suffix} asset`, async () => {
        const f = await legacyFixture();
        try {
            // The local files and SHA256SUMS form a valid legacy release. Partial
            // GitHub metadata must not silently select that legacy contract.
            f.assets.push({ name: `runwield-docs-${f.tag}${suffix}`, digest: `sha256:${"a".repeat(64)}` });
            await fsWriteFile(f.metadata, JSON.stringify({ assets: f.assets }));
            await assertRejects(
                () => prepareReleaseAssets(f.input, f.output, f.tag, true, f.metadata),
                Error,
                "incomplete docs asset set",
            );
            assertEquals(
                await fsStat(f.output)
                    .then(() => true)
                    .catch(() => false),
                false,
            );
        } finally {
            await fsRm(f.root, { recursive: true });
        }
    });
}

test("published Stable recovery requires docs files when metadata lists both assets", async () => {
    const f = await legacyFixture();
    try {
        for (const suffix of [".tar.gz", ".tar.gz.sha256"]) {
            f.assets.push({ name: `runwield-docs-${f.tag}${suffix}`, digest: `sha256:${"a".repeat(64)}` });
        }
        await fsWriteFile(f.metadata, JSON.stringify({ assets: f.assets }));
        await assertRejects(
            () => prepareReleaseAssets(f.input, f.output, f.tag, true, f.metadata),
            Error,
            `Expected one runwield-docs-${f.tag}.tar.gz`,
        );
        assertEquals(
            await fsStat(f.output)
                .then(() => true)
                .catch(() => false),
            false,
        );
    } finally {
        await fsRm(f.root, { recursive: true });
    }
});

test("published Stable recovery verifies the independent docs digest", async () => {
    const f = await fixture();
    try {
        await prepareReleaseAssets(f.input, f.output, f.tag);
        const docs = `runwield-docs-${f.tag}.tar.gz`;
        const assets = [];
        for (const name of releaseAssetNames(f.tag)) {
            assets.push({
                name,
                digest: `sha256:${name === docs ? "a".repeat(64) : await sha256File(join(f.output, name))}`,
            });
        }
        const metadata = join(f.root, "published.json");
        await fsWriteFile(metadata, JSON.stringify({ assets }));
        const recovered = join(f.root, "recovered");
        await assertRejects(
            () => prepareReleaseAssets(f.output, recovered, f.tag, true, metadata),
            Error,
            `Published asset digest missing or mismatched: ${docs}`,
        );
        assertEquals(
            await fsStat(recovered)
                .then(() => true)
                .catch(() => false),
            false,
        );
    } finally {
        await fsRm(f.root, { recursive: true });
    }
});
