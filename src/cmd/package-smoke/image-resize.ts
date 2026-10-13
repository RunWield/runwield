import { versions } from "node:process";
import { isStandaloneExecutable } from "../../shared/runtime-identity.ts";
import { Worker } from "node:worker_threads";
import { resizeImage } from "@earendil-works/pi-coding-agent";
import { encodeCreatedImage } from "../../shared/image-generation.ts";

interface ResizeWorkerResponse {
    error?: string;
    result?: { width: number; height: number; wasResized: boolean };
}

/** Require the compiled Bun worker itself, so Pi's fallback cannot hide a missing asset. */
async function checkBunWorker(bytes: Uint8Array): Promise<void> {
    const worker = new Worker("./src/utils/image-resize-worker.ts");
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        const response = await new Promise<ResizeWorkerResponse>((resolve, reject) => {
            timer = setTimeout(() => reject(new Error("Packaged image worker timed out")), 10_000);
            worker.once("message", resolve);
            worker.once("error", reject);
            worker.once("exit", (code) => reject(new Error(`Packaged image worker exited ${code} before replying`)));
            worker.postMessage({ inputBytes: bytes, mimeType: "image/png", options: { maxWidth: 2, maxHeight: 2 } });
        });
        if (
            response.error || response.result?.width !== 2 || response.result.height !== 1 ||
            !response.result.wasResized
        ) {
            throw new Error(`Packaged Bun image worker failed: ${response.error || "invalid resize response"}`);
        }
    } finally {
        clearTimeout(timer);
        await worker.terminate();
    }
}

/** Exercise the real worker and Photon WASM inside the packaged executable. */
export async function checkPackagedImageResize(): Promise<void> {
    // A four-by-two red PNG, small enough to keep the package check self-contained.
    const png = "iVBORw0KGgoAAAANSUhEUgAAAAQAAAACCAIAAADwyuo0AAAAEElEQVR4nGP4z8AARwzIHABvqgf5gNwAKAAAAABJRU5ErkJggg==";
    const bytes = Uint8Array.from(atob(png), (character) => character.charCodeAt(0));
    if (versions.bun && isStandaloneExecutable()) await checkBunWorker(bytes);
    const result = await resizeImage(bytes, "image/png", { maxWidth: 2, maxHeight: 2 });
    if (
        !result?.wasResized || result.originalWidth !== 4 || result.originalHeight !== 2 ||
        result.width !== 2 || result.height !== 1 || !result.data
    ) {
        throw new Error("Packaged image resize did not resize the fixture from 4x2 to 2x1.");
    }
    const decoded = await resizeImage(
        Uint8Array.from(atob(result.data), (character) => character.charCodeAt(0)),
        result.mimeType,
    );
    if (!decoded || decoded.width !== 2 || decoded.height !== 1 || decoded.wasResized) {
        throw new Error("Packaged image resize produced an invalid image.");
    }
    // create_image uses Photon directly to honor the requested output extension.
    for (const mimeType of ["image/jpeg", "image/webp"]) {
        const encoded = encodeCreatedImage({ type: "image", data: png, mimeType: "image/png" }, mimeType);
        const preview = await resizeImage(encoded.bytes, mimeType);
        if (!preview || preview.width !== 4 || preview.height !== 2) {
            throw new Error(`Packaged create_image conversion failed for ${mimeType}.`);
        }
    }
}

if (import.meta.main) await checkPackagedImageResize();
