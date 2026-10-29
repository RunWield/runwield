import { assertEquals } from "../src/testing/assertions.ts";
import { captureScriptProcess } from "./script-process.ts";
import { test } from "node:test";
import { mkdir as fsMkdir, mkdtemp as fsMkdtemp, rm as fsRm, writeFile as fsWriteFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listCiFiles } from "./ci-files.ts";

test("CI file discovery includes source work but excludes Git-ignored and .wld files", async () => {
    const root = await fsMkdtemp(join(tmpdir(), "runwield-ci-files-"));
    try {
        const init = await captureScriptProcess("git", {
            args: ["init", "-q"],
            cwd: root,
            stderr: "piped",
        });
        assertEquals(init.code, 0, new TextDecoder().decode(init.stderr));

        await fsMkdir(join(root, "ignored"));
        await fsMkdir(join(root, ".wld"));
        await fsWriteFile(join(root, ".gitignore"), "ignored/\n");
        await fsWriteFile(join(root, "tracked.ts"), "export const tracked = true;\n");
        await fsWriteFile(join(root, "visible.ts"), "export const visible = true;\n");
        await fsWriteFile(join(root, "ignored", "temp.test.ts"), 'throw new Error("must not run");\n');
        await fsWriteFile(join(root, ".wld", "temp.test.ts"), 'throw new Error("must not run");\n');
        const corpusFiles = [
            "evals/reviewer/RV-D04/source/src/implementation.ts",
            "evals/reviewer/RV-D04/source/tests/public.test.ts",
            "evals/reviewer/RV-D04/variants/change.patch",
            "evals/reviewer/RV-D04/evaluation/proof.test.ts",
        ];
        const ownedFiles = [
            "scripts/reviewer-benchmark/materialize.test.ts",
            "evals/reviewer/RV-D04/scenario.yaml",
            "evals/reviewer/README.md",
            "evals/reviewer/RV-D04/source-other/kept.ts",
        ];
        for (const file of [...corpusFiles, ...ownedFiles]) {
            await fsMkdir(join(root, file, ".."), { recursive: true });
            await fsWriteFile(join(root, file), "fixture file\n");
        }

        const add = await captureScriptProcess("git", {
            args: ["add", ".gitignore", "tracked.ts"],
            cwd: root,
            stderr: "piped",
        });
        assertEquals(add.code, 0, new TextDecoder().decode(add.stderr));

        const files = await listCiFiles(root);
        assertEquals(files.includes("tracked.ts"), true);
        assertEquals(files.includes("visible.ts"), true);
        assertEquals(files.includes("ignored/temp.test.ts"), false);
        assertEquals(files.includes(".wld/temp.test.ts"), false);
        for (const file of corpusFiles) assertEquals(files.includes(file), false, file);
        for (const file of ownedFiles) assertEquals(files.includes(file), true, file);
    } finally {
        await fsRm(root, { recursive: true });
    }
});
