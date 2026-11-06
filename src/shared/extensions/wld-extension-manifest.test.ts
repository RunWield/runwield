import { assertEquals } from "../../testing/assertions.ts";
import { mkdir as fsMkdir, mkdtemp as fsMkdtemp, rm as fsRm, writeFile as fsWriteFile } from "node:fs/promises";
import { test } from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ResolvedResource } from "../package-resources.ts";
import { filterWldCompatibleExtensionResources, getWldExtensionPaths } from "./wld-extension-manifest.ts";

test("filterWldCompatibleExtensionResources returns enabled package resources with compatible package metadata", async () => {
    const root = await fsMkdtemp(join(tmpdir(), "runwield-wld-extension-"));
    const nested = join(root, "src", "extensions");
    const compatiblePath = join(nested, "compatible.js");
    const incompatibleRoot = join(root, "incompatible");
    const incompatiblePath = join(incompatibleRoot, "index.js");

    try {
        await fsMkdir(nested, { recursive: true });
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
                metadata: { source: "npm:ok", scope: "user", origin: "package", baseDir: nested },
            },
            {
                path: compatiblePath,
                enabled: false,
                metadata: { source: "npm:ok", scope: "user", origin: "package", baseDir: nested },
            },
            {
                path: incompatiblePath,
                enabled: true,
                metadata: { source: "npm:nope", scope: "user", origin: "package", baseDir: incompatibleRoot },
            },
            {
                path: compatiblePath,
                enabled: true,
                metadata: { source: "local", scope: "user", origin: "top-level", baseDir: nested },
            },
        ];

        const compatible = await filterWldCompatibleExtensionResources(resources);
        assertEquals(getWldExtensionPaths(compatible), [compatiblePath]);
        for (const pi of [
            { harns: { compatible: true } },
            { wld: { compatible: true } },
            { wld: { compatible: true, extensionApi: 2, kind: "code-extension" } },
        ]) {
            await fsWriteFile(join(root, "package.json"), JSON.stringify({ pi }));
            assertEquals(await filterWldCompatibleExtensionResources(resources), []);
        }
    } finally {
        await fsRm(root, { recursive: true }).catch(() => {});
    }
});
