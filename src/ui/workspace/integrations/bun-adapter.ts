/** Astro renders requests; RunWield owns HTTP serving and static-asset policy. */
import type { AstroIntegration } from "astro";

interface WorkspaceAssetManifest {
    assets: string[];
}

interface WorkspaceManifestOptions {
    manifest: WorkspaceAssetManifest;
}

export default function bunAdapter() {
    return {
        name: "runwield/bun-workspace",
        hooks: {
            "astro:build:ssr": ({ manifest }: WorkspaceManifestOptions) => {
                // Astro discovers static files concurrently; their membership order has no meaning.
                // Canonical ordering keeps independently built release payloads byte-identical.
                manifest.assets.sort();
            },
            "astro:config:done": ({ setAdapter }) => {
                setAdapter({
                    name: "runwield/bun-workspace",
                    entrypointResolution: "auto",
                    serverEntrypoint: new URL("./bun-server-entry.ts", import.meta.url).href,
                    supportedAstroFeatures: {
                        hybridOutput: "stable",
                        staticOutput: "stable",
                        serverOutput: "stable",
                        sharpImageService: "stable",
                    },
                });
            },
        },
    } satisfies AstroIntegration;
}
