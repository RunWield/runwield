import { assertEquals } from "../../testing/assertions.ts";
import { mkdir as fsMkdir, mkdtemp as fsMkdtemp, rm as fsRm, writeFile as fsWriteFile } from "node:fs/promises";
import { test } from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ResolvedResource } from "../package-resources.ts";
import {
    filterWldCompatibleExtensionResources,
    findPackageRootForExtensionResource,
    getWldExtensionPaths,
    isWldCompatibleExtensionManifest,
} from "./wld-extension-manifest.js";

test("isWldCompatibleExtensionManifest recognizes the WLD code-extension marker", () => {
    assertEquals(
        isWldCompatibleExtensionManifest({
            pi: {
                wld: {
                    compatible: true,
                    extensionApi: 1,
                    kind: "code-extension",
                },
            },
        }),
        true,
    );
    assertEquals(isWldCompatibleExtensionManifest({ pi: { harns: { compatible: true } } }), false);
    assertEquals(isWldCompatibleExtensionManifest({ pi: { wld: { compatible: true } } }), false);
});

test("filterWldCompatibleExtensionResources returns enabled package resources with compatible package metadata", async () => {
    const root = await fsMkdtemp(join(tmpdir(), "runwield-wld-extension-"));
    const compatiblePath = join(root, "compatible.js");
    const incompatibleRoot = join(root, "incompatible");
    const incompatiblePath = join(incompatibleRoot, "index.js");

    try {
        await fsWriteFile(
            join(root, "package.json"),
            JSON.stringify({
                pi: {
                    extensions: ["./compatible.js"],
                    wld: {
                        compatible: true,
                        extensionApi: 1,
                        kind: "code-extension",
                    },
                },
            }),
        );
        await fsWriteFile(compatiblePath, "export default () => ({});\n");
        await fsMkdir(incompatibleRoot);
        await fsWriteFile(join(incompatibleRoot, "package.json"), JSON.stringify({ pi: {} }));
        await fsWriteFile(incompatiblePath, "export default () => ({});\n");

        const resources: ResolvedResource[] = [
            {
                path: compatiblePath,
                enabled: true,
                metadata: { source: "npm:ok", scope: "user", origin: "package", baseDir: root },
            },
            {
                path: compatiblePath,
                enabled: false,
                metadata: { source: "npm:ok", scope: "user", origin: "package", baseDir: root },
            },
            {
                path: incompatiblePath,
                enabled: true,
                metadata: { source: "npm:nope", scope: "user", origin: "package", baseDir: incompatibleRoot },
            },
            {
                path: compatiblePath,
                enabled: true,
                metadata: { source: "local", scope: "user", origin: "top-level", baseDir: root },
            },
        ];

        const compatible = await filterWldCompatibleExtensionResources(resources);
        assertEquals(getWldExtensionPaths(compatible), [compatiblePath]);
    } finally {
        await fsRm(root, { recursive: true }).catch(() => {});
    }
});

test("findPackageRootForExtensionResource ascends from nested extension files", async () => {
    const root = await fsMkdtemp(join(tmpdir(), "runwield-wld-extension-root-"));
    const nested = join(root, "src", "extensions");
    const extensionPath = join(nested, "index.js");

    try {
        await fsMkdir(nested, { recursive: true });
        await fsWriteFile(join(root, "package.json"), JSON.stringify({ pi: { wld: {} } }));
        await fsWriteFile(extensionPath, "export default () => ({});\n");

        const resource: ResolvedResource = {
            path: extensionPath,
            enabled: true,
            metadata: { source: "npm:nested", scope: "user", origin: "package", baseDir: nested },
        };
        const packageRoot = await findPackageRootForExtensionResource(resource);

        assertEquals(packageRoot, root);
    } finally {
        await fsRm(root, { recursive: true }).catch(() => {});
    }
});
