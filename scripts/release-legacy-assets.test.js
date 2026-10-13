import { assertEquals } from "../src/testing/assertions.ts";
import { captureScriptProcess } from "./script-process.ts";
import { test } from "node:test";
import {
    mkdir as fsMkdir,
    mkdtemp as fsMkdtemp,
    readFile as fsReadFile,
    rm as fsRm,
    writeFile as fsWriteFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareReleaseAssets, releaseAssetNames } from "./release-assets.js";
import { sha256File } from "./build-metadata.js";

test("published recovery keeps immutable pre-metadata release archives", async () => {
    const root = await fsMkdtemp(join(tmpdir(), "runwield-fixture-"));
    const input = join(root, "published");
    const output = join(root, "recovered");
    const tag = "v0.9.0";
    try {
        await fsMkdir(input);
        const sums = [];
        const assets = [];
        for (
            const name of releaseAssetNames(tag).filter((name) => !name.endsWith(".sha256") && name !== "SHA256SUMS")
        ) {
            const path = join(input, name);
            if (name.endsWith(".tar.gz")) {
                const binary = join(root, "wld");
                await fsWriteFile(binary, name);
                const result = await captureScriptProcess("tar", { args: ["-czf", path, "-C", root, "wld"] });
                if (!result.success) throw new Error("Could not create legacy archive");
            } else await fsWriteFile(path, name);
            if (releaseAssetNames(tag).includes(`${name}.sha256`)) {
                const sum = `${await sha256File(path)}  ${name}`;
                sums.push(sum);
                await fsWriteFile(`${path}.sha256`, `${sum}\n`);
            }
        }
        await fsWriteFile(join(input, "SHA256SUMS"), `${sums.join("\n")}\n`);
        for (const name of releaseAssetNames(tag)) {
            assets.push({ name, digest: `sha256:${await sha256File(join(input, name))}` });
        }
        const metadata = join(root, "published.json");
        await fsWriteFile(metadata, JSON.stringify({ assets }));
        await prepareReleaseAssets(input, output, tag, true, metadata);
        for (const name of releaseAssetNames(tag)) {
            assertEquals(await fsReadFile(join(output, name)), await fsReadFile(join(input, name)));
        }
    } finally {
        await fsRm(root, { recursive: true });
    }
});
