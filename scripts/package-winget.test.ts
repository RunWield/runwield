import { serveHttp } from "../src/shared/http-server.ts";
import { captureScriptProcess } from "./script-process.ts";
import { test } from "node:test";
import { tmpdir } from "node:os";
import {
    mkdir as fsMkdir,
    mkdtemp as fsMkdtemp,
    readFile as fsReadFile,
    rm as fsRm,
    writeFile as fsWriteFile,
} from "node:fs/promises";
import { assertEquals, assertRejects, assertStringIncludes } from "../src/testing/assertions.ts";
import { join } from "node:path";
import { packageWinget } from "./package-winget.js";
import { sha256 } from "./package-windows.js";

async function run(command: string, args: string[], cwd?: string): Promise<void> {
    const result = await captureScriptProcess(command, { args, cwd, stdout: "piped", stderr: "piped" });
    const decoder = new TextDecoder();
    assertEquals(result.code, 0, `${decoder.decode(result.stdout)}${decoder.decode(result.stderr)}`);
}

async function makeReleaseZip(root: string, tag = "v1.2.3") {
    const dir = join(root, "zip-root");
    await fsMkdir(join(dir, "runtime", "helpers"), { recursive: true });
    await fsMkdir(join(dir, "licenses"), { recursive: true });
    await fsWriteFile(join(dir, "wld.exe"), `runwield ${tag} binary`);
    await fsWriteFile(
        join(dir, "runwield-install.json"),
        JSON.stringify({
            schemaVersion: 1,
            packageManager: "winget",
            packageIdentifier: "Gandazgul.RunWield",
            updateCommand: "winget upgrade --id Gandazgul.RunWield --exact",
            repairCommand: "winget repair --id Gandazgul.RunWield --exact",
            installDirectory: ".",
            version: tag,
        }),
    );
    for (const helper of ["mnemoteca", "cymbal", "ketch", "agent-browser"]) {
        await fsWriteFile(join(dir, "runtime", "helpers", `${helper}.exe`), `${helper} helper`);
        await fsWriteFile(join(dir, "licenses", `${helper}-LICENSE.txt`), `${helper} license`);
    }
    await fsWriteFile(join(dir, "licenses", "RUNWIELD-LICENSE.txt"), "runwield license");
    const zip = join(root, `wld-${tag}-windows-x64.zip`);
    await run("zip", ["-qr", zip, "."], dir);
    const checksum = await sha256(await fsReadFile(zip));
    await fsWriteFile(`${zip}.sha256`, `${checksum}  wld-${tag}-windows-x64.zip\n`);
    return zip;
}

function serve(root: string) {
    const abort = new AbortController();
    const server = serveHttp(
        { port: 0, hostname: "127.0.0.1", signal: abort.signal, onListen() {} },
        async (request) => {
            const path = new URL(request.url).pathname.slice(1);
            try {
                return new Response(await fsReadFile(join(root, path)));
            } catch {
                return new Response("not found", { status: 404 });
            }
        },
    );
    return {
        baseUrl: `http://127.0.0.1:${server.addr.port}`,
        close: async () => {
            abort.abort();
            await server.finished.catch(() => {});
        },
    };
}

test("package:winget renders standard manifests from published ZIP bytes", async () => {
    const root = await fsMkdtemp(join(tmpdir(), "runwield-winget-test-"));
    const server = serve(root);
    try {
        await makeReleaseZip(root);
        const output = join(root, "out");
        await packageWinget({ tag: "v1.2.3", output, baseUrl: server.baseUrl, testOnly: true });
        const manifestDir = join(output, "Gandazgul.RunWield", "1.2.3");
        const version = await fsReadFile(join(manifestDir, "Gandazgul.RunWield.yaml"), "utf8");
        const installer = await fsReadFile(join(manifestDir, "Gandazgul.RunWield.installer.yaml"), "utf8");
        const locale = await fsReadFile(join(manifestDir, "Gandazgul.RunWield.locale.en-US.yaml"), "utf8");
        assertStringIncludes(version, "$schema=https://aka.ms/winget-manifest.version.1.10.0.schema.json");
        assertStringIncludes(installer, "$schema=https://aka.ms/winget-manifest.installer.1.10.0.schema.json");
        assertStringIncludes(locale, "$schema=https://aka.ms/winget-manifest.defaultLocale.1.10.0.schema.json");
        assertStringIncludes(installer, "InstallerType: zip");
        assertStringIncludes(installer, "NestedInstallerType: portable");
        assertStringIncludes(installer, "ArchiveBinariesDependOnPath: true");
        assertStringIncludes(installer, "PortableCommandAlias: wld");
        assertStringIncludes(installer, "PackageIdentifier: Git.Git");
        assertStringIncludes(locale, "License: Free Use License");
        const summary = JSON.parse(await fsReadFile(join(output, "runwield-winget-package.json"), "utf8"));
        assertEquals(summary.packageIdentifier, "Gandazgul.RunWield");
    } finally {
        await server.close();
        await fsRm(root, { recursive: true });
    }
});

test("package:winget rejects RC tags", async () => {
    await assertRejects(
        () => packageWinget({ tag: "v1.2.3-rc.1", output: "out", baseUrl: "http://127.0.0.1", testOnly: true }),
        Error,
        "Stable tag",
    );
});

test("package:winget rejects ZIPs with incomplete package metadata", async () => {
    const root = await fsMkdtemp(join(tmpdir(), "runwield-winget-bad-metadata-"));
    const server = serve(root);
    try {
        const zip = await makeReleaseZip(root);
        const work = join(root, "rewrite");
        await fsMkdir(work, { recursive: true });
        await run("unzip", ["-q", zip, "-d", work]);
        await fsWriteFile(
            join(work, "runwield-install.json"),
            JSON.stringify({ packageManager: "winget", packageIdentifier: "Gandazgul.RunWield", version: "v1.2.3" }),
        );
        await fsRm(zip);
        await run("zip", ["-qr", zip, "."], work);
        const checksum = await sha256(await fsReadFile(zip));
        await fsWriteFile(`${zip}.sha256`, `${checksum}  wld-v1.2.3-windows-x64.zip\n`);
        await assertRejects(
            () => packageWinget({ tag: "v1.2.3", output: join(root, "out"), baseUrl: server.baseUrl, testOnly: true }),
            Error,
            "invalid schemaVersion",
        );
    } finally {
        await server.close();
        await fsRm(root, { recursive: true });
    }
});

test("package:winget rejects releases without the Windows ZIP", async () => {
    const root = await fsMkdtemp(join(tmpdir(), "runwield-winget-missing-"));
    const server = serve(root);
    try {
        await assertRejects(
            () => packageWinget({ tag: "v1.2.3", output: join(root, "out"), baseUrl: server.baseUrl, testOnly: true }),
            Error,
            "Download failed 404",
        );
    } finally {
        await server.close();
        await fsRm(root, { recursive: true });
    }
});

test("package:winget rejects ZIPs without package metadata", async () => {
    const root = await fsMkdtemp(join(tmpdir(), "runwield-winget-incomplete-"));
    const server = serve(root);
    try {
        const dir = join(root, "zip-root");
        await fsMkdir(dir, { recursive: true });
        await fsWriteFile(join(dir, "wld.exe"), "binary");
        const zip = join(root, "wld-v1.2.3-windows-x64.zip");
        await run("zip", ["-qr", zip, "."], dir);
        const checksum = await sha256(await fsReadFile(zip));
        await fsWriteFile(`${zip}.sha256`, `${checksum}  wld-v1.2.3-windows-x64.zip\n`);
        await assertRejects(
            () => packageWinget({ tag: "v1.2.3", output: join(root, "out"), baseUrl: server.baseUrl, testOnly: true }),
            Error,
            "missing runwield-install.json",
        );
    } finally {
        await server.close();
        await fsRm(root, { recursive: true });
    }
});
