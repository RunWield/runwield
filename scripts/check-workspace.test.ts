import { test } from "node:test";
import { match, notStrictEqual, strictEqual } from "node:assert";
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import process from "node:process";
import { captureScriptProcess } from "./script-process.ts";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));

async function fixture() {
    const root = await mkdtemp(join(tmpdir(), "runwield-workspace-check-"));
    await mkdir(join(root, "scripts"));
    await mkdir(join(root, "src/ui/workspace"), { recursive: true });
    for (const name of ["check-workspace.ts", "check-bun-runtime.ts", "script-process.ts"]) {
        await copyFile(join(repositoryRoot, "scripts", name), join(root, "scripts", name));
    }
    await copyFile(join(repositoryRoot, ".bun-version"), join(root, ".bun-version"));
    const manifest = JSON.parse(await readFile(join(repositoryRoot, "package.json"), "utf8"));
    await writeFile(
        join(root, "package.json"),
        JSON.stringify({ type: "module", scripts: { "workspace:check": manifest.scripts["workspace:check"] } }),
    );
    await writeFile(
        join(root, "tsconfig.json"),
        JSON.stringify({ compilerOptions: { strict: true, skipLibCheck: true }, include: ["src/**/*.astro"] }),
    );
    return root;
}

async function run(root: string) {
    return await captureScriptProcess(process.execPath, {
        args: [
            "run",
            "workspace:check",
            "--noSync",
            "--root",
            "src/ui/workspace",
            "--tsconfig",
            join(root, "tsconfig.json"),
        ],
        cwd: root,
        env: { CI: "1" },
    });
}

for (const dependency of ["@astrojs/check", "typescript"]) {
    for (const state of ["missing", "unloadable"]) {
        test(`workspace:check fails before Astro when ${dependency} is ${state}`, async () => {
            const root = await fixture();
            try {
                for (const name of ["@astrojs/check", "typescript"]) {
                    if (name === dependency && state === "missing") continue;
                    const directory = join(root, "node_modules", name);
                    await mkdir(directory, { recursive: true });
                    await writeFile(
                        join(directory, "package.json"),
                        JSON.stringify({ name, type: "module", main: "index.js" }),
                    );
                    await writeFile(
                        join(directory, "index.js"),
                        name === dependency
                            ? 'throw new Error("unloadable checker fixture");'
                            : "export const loaded = true;",
                    );
                }
                const astro = join(root, "node_modules/astro/bin");
                await mkdir(astro, { recursive: true });
                await writeFile(join(astro, "astro.mjs"), 'console.log("ASTRO_WAS_INVOKED"); process.exit(0);');
                const result = await run(root);
                notStrictEqual(result.code, 0);
                match(new TextDecoder().decode(result.stderr), /Workspace checking could not run/);
                strictEqual(new TextDecoder().decode(result.stdout).includes("ASTRO_WAS_INVOKED"), false);
            } finally {
                await rm(root, { recursive: true, force: true });
            }
        });
    }
}

test("workspace:check actually diagnoses Astro types with a relative project root", async () => {
    const root = await fixture();
    try {
        await symlink(
            join(repositoryRoot, "node_modules"),
            join(root, "node_modules"),
            process.platform === "win32" ? "junction" : "dir",
        );
        const page = join(root, "src/ui/workspace/control.astro");
        await writeFile(
            page,
            '---\nconst auditNegativeControl: number = "must fail type checking";\n---\n<div>{auditNegativeControl}</div>\n',
        );
        const failed = await run(root);
        notStrictEqual(failed.code, 0, new TextDecoder().decode(failed.stdout));
        match(new TextDecoder().decode(failed.stdout), /Type 'string' is not assignable to type 'number'/);
        await writeFile(
            page,
            "---\nconst auditNegativeControl: number = 42;\n---\n<div>{auditNegativeControl}</div>\n",
        );
        const passed = await run(root);
        strictEqual(passed.code, 0, new TextDecoder().decode(passed.stderr));
        match(new TextDecoder().decode(passed.stdout), /0 errors/);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
