import { deepStrictEqual, equal, ok, rejects } from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { build, createLogger, mergeConfig, type InlineConfig } from "vite";
import bunAdapter from "./bun-adapter.ts";

function configureBuild(target: "client" | "server", initial: InlineConfig): InlineConfig {
    let config = initial;
    bunAdapter().hooks["astro:build:setup"]({
        target,
        // Astro merges hook updates into its existing Vite configuration.
        updateConfig: (update) => {
            config = mergeConfig(config, update);
        },
    });
    return config;
}

test("server diagnostic override preserves other build options and leaves client checks unchanged", () => {
    const initial: InlineConfig = {
        build: {
            minify: false,
            chunkSizeWarningLimit: 200,
            rolldownOptions: {
                checks: { circularDependency: true, ineffectiveDynamicImport: true },
                output: { entryFileNames: "entry.mjs" },
            },
        },
    };
    const server = configureBuild("server", initial);
    equal(server.build?.minify, false);
    equal(server.build?.chunkSizeWarningLimit, 200);
    deepStrictEqual(server.build?.rolldownOptions?.output, { entryFileNames: "entry.mjs" });
    deepStrictEqual(server.build?.rolldownOptions?.checks, {
        circularDependency: true,
        ineffectiveDynamicImport: false,
    });
    deepStrictEqual(configureBuild("client", initial), initial);
    equal(initial.build?.rolldownOptions?.checks?.ineffectiveDynamicImport, true);
});

for (const target of ["client", "server"] as const) {
    test(`${target} build keeps mixed-import results and unrelated warnings`, async () => {
        const root = await mkdtemp(join(tmpdir(), "wld-adapter-warnings-"));
        try {
            await writeFile(join(root, "shared.js"), "export const value = 42;\n");
            await writeFile(
                join(root, "entry.js"),
                'import { value } from "./shared.js";\n' +
                    "export const staticValue = value;\n" +
                    'export async function dynamicValue() { return (await import("./shared.js")).value; }\n',
            );
            const warnings: string[] = [];
            const logger = createLogger("silent");
            logger.warn = (message) => warnings.push(message);
            await build(
                configureBuild(target, {
                    root,
                    configFile: false,
                    customLogger: logger,
                    plugins: [
                        {
                            name: "adapter-fixture-warning",
                            buildStart() {
                                this.warn("unrelated fixture warning");
                            },
                        },
                    ],
                    build: {
                        outDir: join(root, "output"),
                        minify: false,
                        lib: { entry: join(root, "entry.js"), formats: ["es"], fileName: () => "entry.mjs" },
                    },
                }),
            );
            equal(
                warnings.some((message) => message.includes("INEFFECTIVE_DYNAMIC_IMPORT")),
                target === "client",
            );
            ok(warnings.some((message) => message.includes("unrelated fixture warning")));
            const output = await import(pathToFileURL(join(root, "output", "entry.mjs")).href);
            equal(output.staticValue, 42);
            equal(await output.dynamicValue(), 42);
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });
}

test("server build still fails on an invalid import", async () => {
    const root = await mkdtemp(join(tmpdir(), "wld-adapter-error-"));
    try {
        await writeFile(join(root, "entry.js"), 'export { missing } from "./absent.js";\n');
        await rejects(
            build(
                configureBuild("server", {
                    root,
                    configFile: false,
                    logLevel: "silent",
                    build: {
                        write: false,
                        lib: { entry: join(root, "entry.js"), formats: ["es"] },
                    },
                }),
            ),
            /absent\.js/,
        );
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
