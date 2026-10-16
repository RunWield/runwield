/** Photon is a CommonJS/WASM boundary, kept out of Deno's ESM compile graph. */
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL as toFileUrl } from "node:url";
import type { PhotonImage } from "@silvia-odwyer/photon-node";
import { RUNWIELD_ROOT } from "../../runtime-root.js";

interface PhotonModule {
    PhotonImage: typeof PhotonImage;
}

// The Bun compiler substitutes this boundary with the same real npm module as
// an ESM import, allowing its bundler to embed Photon and its WASM together.
export function loadPhoton(): PhotonModule {
    const entry = toFileUrl(join(RUNWIELD_ROOT, "node_modules", "@silvia-odwyer", "photon-node", "photon_rs.js"));
    return createRequire(entry)("./photon_rs.js") as PhotonModule;
}
