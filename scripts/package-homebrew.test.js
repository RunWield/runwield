import { serveHttp } from "../src/shared/http-server.ts";
import { test } from "node:test";
import { tmpdir } from "node:os";
import {
    copyFile as fsCopyFile,
    mkdir as fsMkdir,
    mkdtemp as fsMkdtemp,
    readFile as fsReadFile,
    rm as fsRm,
    writeFile as fsWriteFile,
} from "node:fs/promises";
import { assertEquals, assertRejects, assertStringIncludes } from "../src/testing/assertions.ts";
import { join } from "node:path";
import { packageHomebrew, parsePackageHomebrewArgs } from "./package-homebrew.js";

/** @param {Uint8Array} bytes */
async function sha256Text(bytes) {
    const input = new Uint8Array(bytes.length);
    input.set(bytes);
    const hash = await crypto.subtle.digest("SHA-256", input.buffer);
    return Array.from(new Uint8Array(hash)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * @param {string} root
 * @param {string} name
 * @param {string} text
 */
async function writeAsset(root, name, text) {
    const bytes = new TextEncoder().encode(text);
    await fsWriteFile(join(root, name), bytes);
    return await sha256Text(bytes);
}

async function makeReleaseFixture() {
    const root = await fsMkdtemp(join(tmpdir(), "runwield-homebrew-release-"));
    /**
     * @param {string} name
     * @param {string} text
     */
    async function add(name, text) {
        return await writeAsset(root, name, text);
    }

    const wldArm = await add("wld-v1.2.3-darwin-arm64.tar.gz", "wld arm");
    const wldX64 = await add("wld-v1.2.3-darwin-x64.tar.gz", "wld x64");
    await add("wld-v1.2.3-darwin-arm64.tar.gz.sha256", `${wldArm}  wld-v1.2.3-darwin-arm64.tar.gz\n`);
    await add("wld-v1.2.3-darwin-x64.tar.gz.sha256", `${wldX64}  wld-v1.2.3-darwin-x64.tar.gz\n`);
    const memArm = await add("mnemoteca_0.3.1_darwin_arm64.tar.gz", "memory arm");
    const memX64 = await add("mnemoteca_0.3.1_darwin_amd64.tar.gz", "memory x64");

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
    const port = server.addr.port;
    const baseUrl = `http://127.0.0.1:${port}`;
    const inputsPath = join(root, "inputs.json");
    await fsWriteFile(
        inputsPath,
        JSON.stringify({
            mnemoteca: {
                tag: "v0.3.1",
                license: "MIT",
                homepage: "https://github.com/gandazgul/mnemoteca",
                assets: {
                    "darwin-arm64": {
                        url: `${baseUrl}/mnemoteca_0.3.1_darwin_arm64.tar.gz`,
                        sha256: memArm,
                    },
                    "darwin-x64": {
                        url: `${baseUrl}/mnemoteca_0.3.1_darwin_amd64.tar.gz`,
                        sha256: memX64,
                    },
                },
            },
            homebrewDependencies: {
                cymbal: { formula: "1broseidon/tap/cymbal", testedVersion: "v0.7.7" },
            },
        }),
    );
    return {
        root,
        baseUrl,
        inputsPath,
        close: async () => {
            abort.abort();
            await server.finished.catch(() => {});
            await fsRm(root, { recursive: true });
        },
    };
}

test("package:homebrew renders formulas from verified immutable assets", async () => {
    const fixture = await makeReleaseFixture();
    try {
        const output = join(fixture.root, "tap");
        await packageHomebrew({
            wldTag: "v1.2.3",
            mnemotecaTag: "v0.3.1",
            output,
            inputsPath: fixture.inputsPath,
            wldBaseUrl: fixture.baseUrl,
            mnemotecaBaseUrl: fixture.baseUrl,
            testOnly: true,
        });

        const wld = await fsReadFile(join(output, "Formula", "wld.rb"), "utf8");
        const mnemoteca = await fsReadFile(join(output, "Formula", "mnemoteca.rb"), "utf8");
        assertStringIncludes(wld, "class Wld < Formula");
        assertStringIncludes(wld, '  version "1.2.3"\n');
        assertStringIncludes(wld, 'depends_on "gandazgul/tap/mnemoteca"');
        assertStringIncludes(wld, 'depends_on "ketch"');
        assertEquals(wld.includes("1broseidon/tap/ketch"), false);
        const dependencies = Array.from(wld.matchAll(/depends_on "([^"]+)"/g), (match) => match[1]);
        assertEquals(dependencies, [...dependencies].sort(), "Formula dependencies must be alphabetized");
        assertStringIncludes(wld, "runwield-install.json");
        assertStringIncludes(wld, "brew upgrade gandazgul/tap/wld");
        assertStringIncludes(wld, "license :cannot_represent");
        assertStringIncludes(wld, "depends_on :macos");
        assertStringIncludes(wld, "# test-only artifact; do not publish this formula");
        assertStringIncludes(mnemoteca, "class Mnemoteca < Formula");
        assertStringIncludes(mnemoteca, '  version "0.3.1"\n');
        assertStringIncludes(mnemoteca, "depends_on :macos");
        assertStringIncludes(mnemoteca, "mnemoteca_0.3.1_darwin_arm64.tar.gz");
        const manifest = JSON.parse(await fsReadFile(join(output, "runwield-homebrew-package.json"), "utf8"));
        assertEquals(manifest.testOnly, true);
        assertEquals(manifest.formulas, ["Formula/wld.rb", "Formula/mnemoteca.rb"]);
    } finally {
        await fixture.close();
    }
});

test("package:homebrew rejects publishable RC tags before emitting output", async () => {
    const fixture = await makeReleaseFixture();
    try {
        await assertRejects(
            () =>
                packageHomebrew({
                    wldTag: "v1.2.3-rc.1",
                    mnemotecaTag: "v0.3.1",
                    output: join(fixture.root, "tap"),
                    inputsPath: fixture.inputsPath,
                    testOnly: false,
                }),
            Error,
            "Stable tag",
        );
    } finally {
        await fixture.close();
    }
});

test("package:homebrew validates Candidate bytes only as test output", async () => {
    const fixture = await makeReleaseFixture();
    try {
        for (const arch of ["darwin-arm64", "darwin-x64"]) {
            const oldName = `wld-v1.2.3-${arch}.tar.gz`;
            const name = `wld-v1.2.3-rc.1-${arch}.tar.gz`;
            await fsCopyFile(join(fixture.root, oldName), join(fixture.root, name));
            await fsWriteFile(
                join(fixture.root, `${name}.sha256`),
                (await fsReadFile(join(fixture.root, `${oldName}.sha256`), "utf8")).replace(oldName, name),
            );
        }
        const output = join(fixture.root, "tap");
        await packageHomebrew({
            wldTag: "v1.2.3-rc.1",
            mnemotecaTag: "v0.3.1",
            output,
            inputsPath: fixture.inputsPath,
            testOnly: true,
            wldBaseUrl: fixture.baseUrl,
            mnemotecaBaseUrl: fixture.baseUrl,
        });
        const manifest = JSON.parse(await fsReadFile(join(output, "runwield-homebrew-package.json"), "utf8"));
        assertEquals(manifest.wldTag, "v1.2.3-rc.1");
        const wld = await fsReadFile(join(output, "Formula", "wld.rb"), "utf8");
        assertStringIncludes(wld, "wld-v1.2.3-rc.1-darwin-arm64.tar.gz");
        assertEquals(/^ {2}version /m.test(wld), false, "Candidate URL already gives Homebrew the exact version");
        assertEquals(manifest.testOnly, true);
    } finally {
        await fixture.close();
    }
});

test("package:homebrew rejects corrupt release bytes", async () => {
    const fixture = await makeReleaseFixture();
    try {
        await fsWriteFile(join(fixture.root, "wld-v1.2.3-darwin-arm64.tar.gz"), "corrupt");
        await assertRejects(
            () =>
                packageHomebrew({
                    wldTag: "v1.2.3",
                    mnemotecaTag: "v0.3.1",
                    output: join(fixture.root, "tap"),
                    inputsPath: fixture.inputsPath,
                    wldBaseUrl: fixture.baseUrl,
                    mnemotecaBaseUrl: fixture.baseUrl,
                    testOnly: true,
                }),
            Error,
            "Checksum mismatch",
        );
    } finally {
        await fixture.close();
    }
});

test("package:homebrew rejects incomplete platform assets", async () => {
    const fixture = await makeReleaseFixture();
    try {
        const inputs = JSON.parse(await fsReadFile(fixture.inputsPath, "utf8"));
        delete inputs.mnemoteca.assets["darwin-x64"];
        await fsWriteFile(fixture.inputsPath, JSON.stringify(inputs));
        await assertRejects(
            () =>
                packageHomebrew({
                    wldTag: "v1.2.3",
                    mnemotecaTag: "v0.3.1",
                    output: join(fixture.root, "tap"),
                    inputsPath: fixture.inputsPath,
                    wldBaseUrl: fixture.baseUrl,
                    mnemotecaBaseUrl: fixture.baseUrl,
                    testOnly: true,
                }),
            Error,
            "darwin-x64",
        );
    } finally {
        await fixture.close();
    }
});

test("package:homebrew rejects base URL overrides for publishable output", async () => {
    const fixture = await makeReleaseFixture();
    try {
        await assertRejects(
            () =>
                packageHomebrew({
                    wldTag: "v1.2.3",
                    mnemotecaTag: "v0.3.1",
                    output: join(fixture.root, "tap"),
                    inputsPath: fixture.inputsPath,
                    wldBaseUrl: fixture.baseUrl,
                    testOnly: false,
                }),
            Error,
            "Base URL overrides require --test-only",
        );
    } finally {
        await fixture.close();
    }
});

test("package:homebrew rejects missing publishable license metadata", async () => {
    const fixture = await makeReleaseFixture();
    try {
        const inputs = JSON.parse(await fsReadFile(fixture.inputsPath, "utf8"));
        delete inputs.mnemoteca.license;
        await fsWriteFile(fixture.inputsPath, JSON.stringify(inputs));
        await assertRejects(
            () =>
                packageHomebrew({
                    wldTag: "",
                    mnemotecaTag: "v0.3.1",
                    output: join(fixture.root, "tap"),
                    inputsPath: fixture.inputsPath,
                    mnemotecaBaseUrl: fixture.baseUrl,
                    testOnly: true,
                }),
            Error,
            "license and homepage",
        );
    } finally {
        await fixture.close();
    }
});

test("package:homebrew rejects publishable Mnemoteca refresh over test-only RunWield", async () => {
    const fixture = await makeReleaseFixture();
    try {
        const output = join(fixture.root, "tap");
        await fsMkdir(join(output, "Formula"), { recursive: true });
        await fsWriteFile(
            join(output, "Formula", "wld.rb"),
            'url "http://127.0.0.1/wld-v1.2.3-darwin-arm64.tar.gz"\n# test-only artifact; do not publish this formula\n',
        );
        await fsWriteFile(
            join(output, "runwield-homebrew-package.json"),
            JSON.stringify({ testOnly: true, wldTag: "v1.2.3", formulas: ["Formula/wld.rb"] }),
        );

        await assertRejects(
            () =>
                packageHomebrew({
                    wldTag: "",
                    mnemotecaTag: "v0.3.1",
                    output,
                    inputsPath: fixture.inputsPath,
                    testOnly: false,
                }),
            Error,
            "test-only RunWield formula",
        );
    } finally {
        await fixture.close();
    }
});

test("package:homebrew refreshes only Mnemoteca when wld tag is omitted", async () => {
    const fixture = await makeReleaseFixture();
    try {
        const output = join(fixture.root, "tap");
        await fsMkdir(join(output, "Formula"), { recursive: true });
        await fsWriteFile(join(output, "Formula", "wld.rb"), "preserved wld formula\n");
        await fsWriteFile(
            join(output, "runwield-homebrew-package.json"),
            JSON.stringify({ testOnly: true, wldTag: "v1.2.3", formulas: ["Formula/wld.rb"] }),
        );
        await packageHomebrew({
            wldTag: "",
            mnemotecaTag: "v0.3.1",
            output,
            inputsPath: fixture.inputsPath,
            mnemotecaBaseUrl: fixture.baseUrl,
            testOnly: true,
        });

        assertEquals(await fsReadFile(join(output, "Formula", "wld.rb"), "utf8"), "preserved wld formula\n");
        const mnemoteca = await fsReadFile(join(output, "Formula", "mnemoteca.rb"), "utf8");
        assertStringIncludes(mnemoteca, "class Mnemoteca < Formula");
        assertStringIncludes(mnemoteca, '  version "0.3.1"\n');
        const manifest = JSON.parse(await fsReadFile(join(output, "runwield-homebrew-package.json"), "utf8"));
        assertEquals(manifest.testOnly, true);
        assertEquals(manifest.wldTag, "v1.2.3");
        assertEquals(manifest.formulas, ["Formula/wld.rb", "Formula/mnemoteca.rb"]);
    } finally {
        await fixture.close();
    }
});

test("package:homebrew release workflow mixed URLs and publication versions", async () => {
    const fixture = await makeReleaseFixture();
    const realFetch = globalThis.fetch;
    // Keep release URLs in generated formulas; serve verified fixture bytes at the network boundary.
    /** @type {import("../src/shared/fetch-request.ts").FetchRequest} */
    const fixtureFetch = (input, init) => {
        const url = String(input);
        const name = url.slice(url.lastIndexOf("/") + 1).replace("0.3.3", "0.3.1").replace("-rc.1", "");
        if (url.endsWith(".sha256")) {
            return realFetch(`${fixture.baseUrl}/${name}`, init).then(async (response) =>
                new Response(
                    (await response.text()).replace("v1.2.3-", url.includes("-rc.1") ? "v1.2.3-rc.1-" : "v1.2.3-"),
                )
            );
        }
        return realFetch(`${fixture.baseUrl}/${name}`, init);
    };
    globalThis.fetch = Object.assign(fixtureFetch, realFetch);
    try {
        await fsWriteFile(
            fixture.inputsPath,
            (await fsReadFile(fixture.inputsPath, "utf8")).replaceAll("0.3.1", "0.3.3"),
        );
        for (const tag of ["v1.2.3", "v1.2.3-rc.1"]) {
            for (const mode of ["mixed", "remote-test", "publication"]) {
                const output = join(fixture.root, `${tag}-${mode}`);
                // Same arguments as release.yml: only RunWield has a local URL override.
                const args = ["--wld-tag", tag, "--mnemoteca-tag", "v0.3.3", "--output", output];
                if (mode !== "publication") args.push("--test-only");
                if (mode === "mixed") args.push("--wld-base-url", "http://127.0.0.1:8765");
                const options = parsePackageHomebrewArgs(args);
                options.inputsPath = fixture.inputsPath;
                if (mode === "publication" && tag.includes("-rc.")) {
                    await assertRejects(() => packageHomebrew(options), Error, "Stable tag");
                    continue;
                }
                await packageHomebrew(options);
                const wld = await fsReadFile(join(output, "Formula", "wld.rb"), "utf8");
                const mnemoteca = await fsReadFile(join(output, "Formula", "mnemoteca.rb"), "utf8");
                assertEquals(wld.includes('  version "'), mode === "mixed" && tag === "v1.2.3");
                assertEquals(mnemoteca.includes('  version "'), false);
                assertStringIncludes(mnemoteca, "https://github.com/gandazgul/mnemoteca/releases/download/v0.3.3/");
                assertStringIncludes(
                    wld,
                    mode === "mixed"
                        ? "http://127.0.0.1:8765/"
                        : `https://github.com/gandazgul/runwield/releases/download/${tag}/`,
                );
            }
        }
    } finally {
        globalThis.fetch = realFetch;
        await fixture.close();
    }
});
