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
import { pathToFileURL as toFileUrl } from "node:url";
import { normalizeGitHubBlobUrl, packageWindows, sha256 } from "./package-windows.js";

async function run(command: string, args: string[], cwd?: string): Promise<string> {
    const result = await captureScriptProcess(command, { args, cwd, stdout: "piped", stderr: "piped" });
    const decoder = new TextDecoder();
    const output = `${decoder.decode(result.stdout)}${decoder.decode(result.stderr)}`;
    assertEquals(result.code, 0, output);
    return output;
}

async function makeZip(root: string, name: string, entryName: string): Promise<{ url: string; sha256: string }> {
    const dir = join(root, `${name}-dir`);
    await fsMkdir(dir, { recursive: true });
    await fsWriteFile(join(dir, entryName), `${name} executable`);
    const zip = join(root, `${name}.zip`);
    await run("zip", ["-qr", zip, "."], dir);
    const bytes = await fsReadFile(zip);
    return { url: toFileUrl(zip).href, sha256: await sha256(bytes) };
}

async function makeFixture() {
    const root = await fsMkdtemp(join(tmpdir(), "runwield-windows-package-test-"));
    const binary = join(root, "wld.exe");
    await fsWriteFile(binary, 'compiledVersion="v1.2.3"; runwield binary');
    const mnemoteca = await makeZip(root, "mnemoteca", "mnemoteca.exe");
    const cymbal = await makeZip(root, "cymbal", "cymbal.exe");
    const ketch = await makeZip(root, "ketch", "ketch.exe");
    const agentBrowser = join(root, "agent-browser.exe");
    await fsWriteFile(agentBrowser, "agent browser exe");
    const licensePath = join(root, "LICENSE.txt");
    await fsWriteFile(licensePath, "fixture license text");
    const agentBrowserBytes = await fsReadFile(agentBrowser);
    const inputsPath = join(root, "inputs.json");
    await fsWriteFile(
        inputsPath,
        JSON.stringify({
            packageIdentifier: "Gandazgul.RunWield",
            helpers: [
                {
                    name: "mnemoteca",
                    version: "v1",
                    ...mnemoteca,
                    license: "MIT",
                    licenseUrl: toFileUrl(licensePath).href,
                    requiredFiles: ["mnemoteca.exe"],
                },
                {
                    name: "cymbal",
                    version: "v1",
                    ...cymbal,
                    license: "MIT",
                    licenseUrl: toFileUrl(licensePath).href,
                    requiredFiles: ["cymbal.exe"],
                },
                {
                    name: "ketch",
                    version: "v1",
                    ...ketch,
                    license: "MIT",
                    licenseUrl: toFileUrl(licensePath).href,
                    requiredFiles: ["ketch.exe"],
                },
                {
                    name: "agent-browser",
                    version: "v1",
                    url: toFileUrl(agentBrowser).href,
                    sha256: await sha256(agentBrowserBytes),
                    license: "Apache-2.0",
                    licenseUrl: toFileUrl(licensePath).href,
                    requiredFiles: ["agent-browser.exe"],
                },
            ],
        }),
    );
    return { root, binary, inputsPath, close: () => fsRm(root, { recursive: true }) };
}

test("package:windows creates a complete ZIP with helpers, notices and metadata", async () => {
    const fixture = await makeFixture();
    try {
        const output = join(fixture.root, "out");
        await packageWindows({ tag: "v1.2.3", binary: fixture.binary, output, inputsPath: fixture.inputsPath });
        const zipPath = join(output, "wld-v1.2.3-windows-x64.zip");
        const listing = await run("unzip", ["-l", zipPath]);
        assertStringIncludes(listing, "wld.exe");
        assertStringIncludes(listing, "runwield-install.json");
        assertStringIncludes(listing, "runtime/helpers/mnemoteca.exe");
        assertStringIncludes(listing, "runtime/helpers/agent-browser.exe");
        assertStringIncludes(listing, "licenses/RUNWIELD-LICENSE.txt");
        assertStringIncludes(listing, "licenses/mnemoteca-LICENSE.txt");
        const checksum = await fsReadFile(`${zipPath}.sha256`, "utf8");
        assertStringIncludes(checksum, "wld-v1.2.3-windows-x64.zip");
    } finally {
        await fixture.close();
    }
});

test("package:windows resolves GitHub blob license URLs to raw upstream files", () => {
    assertEquals(
        normalizeGitHubBlobUrl("https://github.com/gandazgul/mnemoteca/blob/v0.3.1/LICENSE"),
        "https://raw.githubusercontent.com/gandazgul/mnemoteca/v0.3.1/LICENSE",
    );
});

test("package:windows rejects non-exact binary release identity", async () => {
    const fixture = await makeFixture();
    try {
        await fsWriteFile(fixture.binary, 'compiledVersion="v1.2.30"; runwield binary');
        await assertRejects(
            () =>
                packageWindows({
                    tag: "v1.2.3",
                    binary: fixture.binary,
                    output: join(fixture.root, "out"),
                    inputsPath: fixture.inputsPath,
                }),
            Error,
            "exact RunWield v1.2.3 release identity",
        );
    } finally {
        await fixture.close();
    }
});

test("package:windows rejects corrupt helper bytes", async () => {
    const fixture = await makeFixture();
    try {
        const inputs = JSON.parse(await fsReadFile(fixture.inputsPath, "utf8"));
        inputs.helpers[0].sha256 = "0".repeat(64);
        await fsWriteFile(fixture.inputsPath, JSON.stringify(inputs));
        await assertRejects(
            () =>
                packageWindows({
                    tag: "v1.2.3",
                    binary: fixture.binary,
                    output: join(fixture.root, "out"),
                    inputsPath: fixture.inputsPath,
                }),
            Error,
            "Checksum mismatch",
        );
    } finally {
        await fixture.close();
    }
});

test("package:windows rejects missing required helper files", async () => {
    const fixture = await makeFixture();
    try {
        const inputs = JSON.parse(await fsReadFile(fixture.inputsPath, "utf8"));
        inputs.helpers[1].requiredFiles = ["missing.exe"];
        await fsWriteFile(fixture.inputsPath, JSON.stringify(inputs));
        await assertRejects(
            () =>
                packageWindows({
                    tag: "v1.2.3",
                    binary: fixture.binary,
                    output: join(fixture.root, "out"),
                    inputsPath: fixture.inputsPath,
                }),
            Error,
            "missing.exe",
        );
    } finally {
        await fixture.close();
    }
});
