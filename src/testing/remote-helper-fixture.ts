import { mkdir, readFile, writeFile, chmod } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** Copy production code with fixture artifact metadata. All owned behavior stays intact. */
export async function writeFixtureHelperModule(root: string, manifestPath: string): Promise<string> {
    const sourceUrl = new URL("../shared/remote/helpers.ts", import.meta.url);
    const source = (await readFile(sourceUrl, "utf8")).replace(/from "(\.[^"]+)"/g, (_match, relative: string) => {
        const path = relative.endsWith("tested-dependencies.json")
            ? manifestPath
            : fileURLToPath(new URL(relative, sourceUrl));
        return `from ${JSON.stringify(path)}`;
    });
    const path = join(root, "helpers.ts");
    await writeFile(path, source);
    return path;
}
import { captureForegroundProcess } from "../shared/captured-process.ts";
import { sha256Bytes } from "../../scripts/build-metadata.ts";
import { remoteHelperPaths, type RemoteHelperPin } from "../shared/remote/helpers.ts";

export interface HelperArtifactFixture {
    pins: RemoteHelperPin[];
    manifestPath: string;
}

/** Small real archives replace upstream artifact data, never cache or preparation machinery. */
export async function writeRemoteHelperArtifacts(root: string): Promise<HelperArtifactFixture> {
    const pins: RemoteHelperPin[] = [];
    for (const name of ["cymbal", "ketch"]) {
        const directory = join(root, name);
        await mkdir(directory, { recursive: true });
        const binary = new TextEncoder().encode(
            `#!/bin/sh\n[ "$1" = --help ] || exit 2\n[ "$REMOTE_HELPER_FIXTURE_DENY_HELP" != 1 ] || exit 7\necho '${name} fixture'\n`,
        );
        const notice = new TextEncoder().encode(`MIT ${name} fixture notice\n`);
        await writeFile(join(directory, name), binary);
        await writeFile(join(directory, "LICENSE"), notice);
        await chmod(join(directory, name), 0o700);
        const archive = join(directory, "archive.tar.gz");
        const result = await captureForegroundProcess("tar", {
            cwd: directory,
            args: ["-czf", archive, name, "LICENSE"],
        });
        if (result.code !== 0) throw new Error(new TextDecoder().decode(result.stderr));
        for (const target of ["x86_64-unknown-linux-gnu", "aarch64-unknown-linux-gnu"]) {
            pins.push({
                name,
                binary: name,
                version: "v1.2.3",
                target,
                url: `https://helpers.invalid/${name}/${target}.tar.gz`,
                sha256: await sha256Bytes(await readFile(archive)),
                binarySha256: await sha256Bytes(binary),
                license: "MIT",
                licenseUrl: `https://helpers.invalid/${name}/LICENSE`,
                licenseSha256: await sha256Bytes(notice),
            });
        }
    }
    const manifestPath = join(root, "tested-dependencies.json");
    await writeFile(manifestPath, JSON.stringify({ helpers: pins }));
    return { pins, manifestPath };
}

export async function seedLaptopHelpers(root: string, home: string, pins: RemoteHelperPin[]): Promise<void> {
    for (const pin of pins) {
        const cache = remoteHelperPaths(pin, "", home).laptop;
        await mkdir(cache, { recursive: true });
        await writeFile(join(cache, "archive.tar.gz"), await readFile(join(root, pin.name, "archive.tar.gz")));
        await writeFile(join(cache, "LICENSE"), await readFile(join(root, pin.name, "LICENSE")));
    }
}

export async function seedRemoteHelpers(root: string, home: string, pins: RemoteHelperPin[]): Promise<void> {
    for (const pin of pins) {
        const cache = remoteHelperPaths(pin, home).remote;
        const relative = cache.slice(home.length + 1).split("/");
        let path = home;
        for (const part of relative) {
            path = join(path, part);
            await mkdir(path, { mode: 0o700, recursive: true });
            await chmod(path, 0o700);
        }
        for (const name of [pin.binary, "LICENSE"]) {
            await writeFile(join(cache, name), await readFile(join(root, pin.name, name)));
            await chmod(join(cache, name), name === "LICENSE" ? 0o600 : 0o700);
        }
    }
}
