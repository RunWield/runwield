/** Build historical Stable content with the current, separately installed Bun toolchain. */
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import { isDeepStrictEqual } from "node:util";
import { requirePinnedBun } from "./check-bun-runtime.ts";
import { prepareDocsDependencies } from "./docs-dependencies.ts";
import { stagePublicDocs } from "./public-docs.ts";
import { checkPublicDocs } from "./check-public-docs.ts";
import { captureScriptProcess } from "./script-process.ts";

interface DocsPackage {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
    overrides?: Record<string, string>;
    resolutions?: Record<string, string>;
}

export async function prepareStableDocs(root: string): Promise<void> {
    requirePinnedBun();
    const current: DocsPackage = JSON.parse(
        await readFile(new URL("../docs-site/package.json", import.meta.url), "utf8"),
    );
    const selected: DocsPackage = JSON.parse(await readFile(join(root, "docs-site/package.json"), "utf8"));
    for (const field of [
        "dependencies",
        "devDependencies",
        "optionalDependencies",
        "overrides",
        "resolutions",
    ] as const) {
        if (!isDeepStrictEqual(current[field] ?? {}, selected[field] ?? {})) {
            throw new Error(
                `Stable docs ${field} differ from the frozen Bun tooling graph; qualify that graph before deployment`,
            );
        }
    }
    await prepareDocsDependencies(root);
}

export async function buildStableDocs(root: string): Promise<void> {
    requirePinnedBun();
    await stagePublicDocs(root, join(root, "docs-site/src/content/docs"));
    const astro = join(root, "docs-site/node_modules/astro/bin/astro.mjs");
    for (const command of ["check", "build"]) {
        const result = await captureScriptProcess(process.execPath, {
            args: [astro, command],
            cwd: join(root, "docs-site"),
            stdout: "piped",
            stderr: "piped",
        });
        if (!result.success) {
            throw new Error(new TextDecoder().decode(result.stdout) + new TextDecoder().decode(result.stderr));
        }
    }
    await checkPublicDocs(root);
}

if (import.meta.main) {
    const [source, ...extra] = process.argv.slice(2);
    if (!source || extra.length) throw new Error("Usage: build-stable-docs.ts <documentation-source-checkout>");
    const root = resolve(source);
    const toolingRoot = fileURLToPath(new URL("../", import.meta.url));
    if (root === resolve(toolingRoot)) throw new Error("Stable documentation source must be separate from tooling");
    await prepareStableDocs(root);
    await buildStableDocs(root);
}
