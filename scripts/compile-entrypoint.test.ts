import { test } from "node:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import process from "node:process";
import { removeExecutableFixtureDirectory } from "../src/testing/runtime-executable-fixture.ts";
import { assertEquals, assertRejects } from "../src/testing/assertions.ts";
import { compileBun } from "./compile-bun.ts";
import { captureScriptProcess } from "./script-process.ts";

test("diagnostic entrypoints compile with the real embedded runtime payload", async () => {
    await mkdir(".ci-cache", { recursive: true });
    const root = await mkdtemp(resolve(".ci-cache/compile-entry-"));
    const entry = join(root, "diagnostic.ts");
    const binary = join(root, process.platform === "win32" ? "diagnostic.exe" : "diagnostic");
    try {
        await writeFile(
            entry,
            `
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { RUNWIELD_ROOT } from "../../runtime-root.js";
console.log(JSON.stringify({ marker: "real-diagnostic-entry", logo: readFileSync(join(RUNWIELD_ROOT, "brand/logo.svg"), "utf8") }));
`,
        );
        await compileBun(binary, undefined, undefined, undefined, entry);
        const firstIdentity = JSON.parse(await readFile(`${binary}.build.json`, "utf8")).buildId;
        const firstSource = await readFile(entry, "utf8");
        await writeFile(entry, firstSource.replace("real-diagnostic-entry", "changed-diagnostic-entry"));
        const changedBinary = `${binary}.changed${process.platform === "win32" ? ".exe" : ""}`;
        await compileBun(changedBinary, undefined, undefined, undefined, entry);
        const changedIdentity = JSON.parse(await readFile(`${changedBinary}.build.json`, "utf8")).buildId;
        assertEquals(firstIdentity === changedIdentity, false, "Diagnostic source bytes must affect build identity");
        await rm(entry);
        const output = await captureScriptProcess(binary, {
            args: ["--version"],
            cwd: root,
            signal: AbortSignal.timeout(15_000),
        });
        assertEquals(output.code, 0, new TextDecoder().decode(output.stderr));
        assertEquals(JSON.parse(new TextDecoder().decode(output.stdout)), {
            marker: "real-diagnostic-entry",
            logo: await readFile("brand/logo.svg", "utf8"),
        });
    } finally {
        await removeExecutableFixtureDirectory(root);
    }
});

test("compiler rejects an entrypoint outside the repository before staging", async () => {
    await assertRejects(
        () => compileBun("unused", undefined, undefined, undefined, "../outside.ts"),
        Error,
        "inside the repository",
    );
});
