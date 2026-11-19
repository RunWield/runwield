/** Supply Mnemoteca's pinned native runtime from Microsoft's checksum-verified PyPI wheels. */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { arch, argv, platform } from "node:process";

interface RuntimeWheel {
    filename: string;
    url: string;
    digests: { sha256: string };
}

interface RuntimeRelease {
    info: { version: string };
    urls: RuntimeWheel[];
}

const version = "1.23.1";
const wheelPlatforms: Record<string, string> = {
    "darwin-arm64": "macosx_13_0_arm64",
    "darwin-x64": "macosx_13_0_x86_64",
    "linux-arm64": "manylinux_2_27_aarch64.manylinux_2_28_aarch64",
    "linux-x64": "manylinux_2_27_x86_64.manylinux_2_28_x86_64",
};

export async function installCiOnnxRuntime(directory: string): Promise<void> {
    const wheelPlatform = wheelPlatforms[`${platform}-${arch}`];
    if (!wheelPlatform) throw new Error(`Unsupported ONNX Runtime CI platform: ${platform}-${arch}`);
    const filename = `onnxruntime-${version}-cp311-cp311-${wheelPlatform}.whl`;
    const metadata = await fetch(`https://pypi.org/pypi/onnxruntime/${version}/json`);
    if (!metadata.ok) throw new Error(`ONNX Runtime metadata: HTTP ${metadata.status}`);
    const release: RuntimeRelease = await metadata.json();
    const wheel = release.urls.find((entry) => entry.filename === filename);
    if (
        release.info.version !== version ||
        !wheel ||
        !wheel.url.startsWith("https://files.pythonhosted.org/") ||
        !/^[a-f0-9]{64}$/.test(wheel.digests.sha256)
    ) {
        throw new Error(`Missing or invalid ONNX Runtime wheel metadata: ${filename}`);
    }
    const response = await fetch(wheel.url);
    if (!response.ok) throw new Error(`ONNX Runtime wheel: HTTP ${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (createHash("sha256").update(bytes).digest("hex") !== wheel.digests.sha256) {
        throw new Error(`ONNX Runtime checksum mismatch: ${filename}`);
    }
    const temporary = await mkdtemp(join(tmpdir(), "runwield-ci-onnxruntime-"));
    try {
        const archive = join(temporary, filename);
        await writeFile(archive, bytes);
        const native = platform === "darwin" ? `libonnxruntime.${version}.dylib` : `libonnxruntime.so.${version}`;
        const libraries = [native, ...(platform === "linux" ? ["libonnxruntime_providers_shared.so"] : [])];
        execFileSync("unzip", [
            "-qj",
            archive,
            ...libraries.map((name) => `onnxruntime/capi/${name}`),
            "-d",
            temporary,
        ]);
        await mkdir(directory, { recursive: true });
        for (const name of libraries) await copyFile(join(temporary, name), join(directory, name));
        await copyFile(
            join(temporary, native),
            join(directory, platform === "darwin" ? "libonnxruntime.dylib" : "libonnxruntime.so"),
        );
        console.log(`Installed ONNX Runtime ${version} from verified ${filename}`);
    } finally {
        await rm(temporary, { recursive: true, force: true });
    }
}

if (import.meta.main) {
    if (argv.length !== 3) throw new Error("Usage: bun scripts/install-ci-onnxruntime.ts <library-directory>");
    await installCiOnnxRuntime(argv[2]);
}
