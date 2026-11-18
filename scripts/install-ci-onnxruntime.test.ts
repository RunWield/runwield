import { test } from "node:test";
import { deepStrictEqual, rejects, strictEqual } from "node:assert";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { arch, platform } from "node:process";
import { installCiOnnxRuntime } from "./install-ci-onnxruntime.ts";

async function fixture() {
    const root = await mkdtemp(join(tmpdir(), "ci-onnxruntime-test-"));
    const native = platform === "darwin" ? "libonnxruntime.1.23.1.dylib" : "libonnxruntime.so.1.23.1";
    const libraries = [native, ...(platform === "linux" ? ["libonnxruntime_providers_shared.so"] : [])];
    await mkdir(join(root, "onnxruntime/capi"), { recursive: true });
    for (const name of libraries) await writeFile(join(root, "onnxruntime/capi", name), `native bytes: ${name}`);
    const archive = join(root, "runtime.zip");
    execFileSync("zip", ["-q", archive, ...libraries.map((name) => `onnxruntime/capi/${name}`)], { cwd: root });
    const bytes = await readFile(archive);
    const suffix =
        platform === "darwin"
            ? `macosx_13_0_${arch === "arm64" ? "arm64" : "x86_64"}`
            : `manylinux_2_27_${arch === "arm64" ? "aarch64" : "x86_64"}.manylinux_2_28_${arch === "arm64" ? "aarch64" : "x86_64"}`;
    const metadata = {
        info: { version: "1.23.1" },
        urls: [
            {
                filename: `onnxruntime-1.23.1-cp311-cp311-${suffix}.whl`,
                url: "https://files.pythonhosted.org/runtime.whl",
                digests: { sha256: createHash("sha256").update(bytes).digest("hex") },
            },
        ],
    };
    const directory = join(root, "lib");
    const realFetch = globalThis.fetch;
    function serve(wheelStatus = 200) {
        globalThis.fetch = Object.assign(async (input: string | URL | Request) => {
            const url = String(input);
            if (url === "https://pypi.org/pypi/onnxruntime/1.23.1/json") return Response.json(metadata);
            strictEqual(url, metadata.urls[0].url);
            return new Response(bytes, { status: wheelStatus });
        }, realFetch);
    }
    serve();
    return {
        root,
        native,
        libraries,
        metadata,
        directory,
        serve,
        async cleanup() {
            globalThis.fetch = realFetch;
            await rm(root, { recursive: true, force: true });
        },
    };
}

test("CI installs checksum-verified native libraries from a real wheel archive", async () => {
    const f = await fixture();
    try {
        await installCiOnnxRuntime(f.directory);
        for (const name of f.libraries)
            strictEqual(await readFile(join(f.directory, name), "utf8"), `native bytes: ${name}`);
        const linkName = platform === "darwin" ? "libonnxruntime.dylib" : "libonnxruntime.so";
        strictEqual(await readFile(join(f.directory, linkName), "utf8"), `native bytes: ${f.native}`);
    } finally {
        await f.cleanup();
    }
});

test("CI rejects a corrupted wheel before changing installed libraries", async () => {
    const f = await fixture();
    try {
        await mkdir(f.directory);
        await writeFile(join(f.directory, "existing-library"), "keep");
        f.metadata.urls[0].digests.sha256 = "0".repeat(64);
        await rejects(() => installCiOnnxRuntime(f.directory), /checksum mismatch/);
        deepStrictEqual(await readdir(f.directory), ["existing-library"]);
        strictEqual(await readFile(join(f.directory, "existing-library"), "utf8"), "keep");
    } finally {
        await f.cleanup();
    }
});

for (const invalid of ["missing wheel", "wrong version", "untrusted host"]) {
    test(`CI rejects runtime metadata with ${invalid}`, async () => {
        const f = await fixture();
        try {
            if (invalid === "missing wheel") f.metadata.urls = [];
            if (invalid === "wrong version") f.metadata.info.version = "1.24.0";
            if (invalid === "untrusted host") f.metadata.urls[0].url = "https://untrusted.example/runtime.whl";
            await rejects(() => installCiOnnxRuntime(f.directory), /Missing or invalid/);
        } finally {
            await f.cleanup();
        }
    });
}

test("CI fails when the runtime wheel cannot be downloaded", async () => {
    const f = await fixture();
    try {
        f.serve(404);
        await rejects(() => installCiOnnxRuntime(f.directory), /wheel: HTTP 404/);
    } finally {
        await f.cleanup();
    }
});
