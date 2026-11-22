import { build as bundle } from "esbuild";
import { build } from "vite";
import react from "@vitejs/plugin-react";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { desktopBuild, desktopRoot } from "./desktop-paths.ts";
import { renderRunWieldThemeCss } from "../src/ui/design-system/theme-bridge.ts";

await mkdir(desktopBuild, { recursive: true });
const main = await bundle({
    entryPoints: [join(desktopRoot, "src/ui/desktop/main.ts")],
    outfile: join(desktopBuild, "main.mjs"),
    bundle: true,
    platform: "node",
    target: "node24",
    format: "esm",
    external: ["electron"],
    metafile: true,
});
await writeFile(join(desktopBuild, "main.meta.json"), JSON.stringify(main.metafile));
const preload = await bundle({
    entryPoints: [join(desktopRoot, "src/ui/desktop/preload.ts")],
    outfile: join(desktopBuild, "preload.cjs"),
    bundle: true,
    platform: "node",
    target: "node24",
    format: "cjs",
    external: ["electron"],
    metafile: true,
});
await writeFile(join(desktopBuild, "preload.meta.json"), JSON.stringify(preload.metafile));
await build({
    configFile: false,
    root: join(desktopRoot, "src/ui/desktop/renderer"),
    base: "./",
    publicDir: false,
    plugins: [
        react(),
        {
            name: "runwield-local-theme",
            resolveId(id) {
                if (id === "virtual:runwield-theme.css") return "\0runwield-theme.css";
            },
            load(id) {
                if (id === "\0runwield-theme.css") return renderRunWieldThemeCss();
            },
        },
    ],
    build: { outDir: join(desktopBuild, "renderer"), emptyOutDir: true, target: "chrome156", manifest: true },
});
