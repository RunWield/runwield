#!/usr/bin/env bun
import { captureScriptProcess } from "./script-process.ts";
import {
    mkdir as fsMkdir,
    mkdtemp as fsMkdtemp,
    readFile as fsReadFile,
    rm as fsRm,
    writeFile as fsWriteFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import process from "node:process";

import { basename, join } from "node:path";
import { SNIP_FILTERS_DIR } from "../src/constants.js";

const FILTERS = ["deno-check.yaml", "deno-fmt.yaml", "deno-lint.yaml", "deno-test.yaml", "deno-task.yaml"];

function assertGenericFilter(fileName: string, content: string): void {
    if (!content.includes('command: "deno"')) throw new Error(`${fileName} does not match Deno directly.`);
    if (!content.includes('on_error: "fail"')) throw new Error(`${fileName} must fail closed on pipeline errors.`);
    if (/runwield|harns|\bhns\b|scripts\//i.test(content)) {
        throw new Error(`${fileName} contains repository-specific matching.`);
    }
}

export async function checkSnipFilters(): Promise<void> {
    const tempHome = await fsMkdtemp(join(tmpdir(), "runwield-snip-check-"));
    try {
        const filtersDir = join(tempHome, ".config", "snip", "filters");
        await fsMkdir(filtersDir, { recursive: true });
        for (const fileName of FILTERS) {
            const content = await fsReadFile(join(SNIP_FILTERS_DIR, fileName), "utf8");
            assertGenericFilter(fileName, content);
            await fsWriteFile(join(filtersDir, fileName), content);
        }

        const configPath = join(tempHome, ".config", "snip", "config.toml");
        await fsWriteFile(
            configPath,
            `[tracking]\ndb_path = ${JSON.stringify(join(tempHome, "tracking.db"))}\n\n[filters]\ndir = ${JSON.stringify(filtersDir)}\n\n[tee]\nenabled = false\n`,
        );
        const result = await captureScriptProcess("snip", {
            args: ["verify"],
            // Go resolves the Windows home from USERPROFILE, including Snip's trust root.
            env: { ...process.env, HOME: tempHome, USERPROFILE: tempHome, SNIP_CONFIG: configPath },
            stdout: "piped",
            stderr: "piped",
        });
        const decoder = new TextDecoder();
        const output = `${decoder.decode(result.stdout)}${decoder.decode(result.stderr)}`;
        if (!result.success) throw new Error(`Snip filter verification failed:\n${output}`);
        for (const fileName of FILTERS) {
            const name = basename(fileName, ".yaml");
            if (!new RegExp(`^${name} \\.{3,} [0-9]+/[0-9]+ passed$`, "m").test(output)) {
                throw new Error(`Snip did not verify ${name}.\n${output}`);
            }
        }
        console.log("Snip verified all generic Deno filters.");
    } finally {
        await fsRm(tempHome, { recursive: true }).catch(() => {});
    }
}

if (import.meta.main) await checkSnipFilters();
