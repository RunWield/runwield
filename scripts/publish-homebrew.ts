import { copyFile, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import process from "node:process";
import { captureScriptProcess } from "./script-process.ts";

export interface HomebrewPublication {
    tap: string;
    checked: string;
    base: string;
    tag: string;
}

type JsonValue = string | number | boolean | null | JsonValue[] | JsonFields;
interface JsonFields {
    [key: string]: JsonValue;
}

const MANIFEST = "runwield-homebrew-package.json";

function dependencyFields(manifest: JsonFields) {
    const { wldTag: _wldTag, testOnly: _testOnly, generatedAt: _generatedAt, ...preserved } = manifest;
    return preserved;
}

async function git(tap: string, args: string[]) {
    const result = await captureScriptProcess("git", { cwd: tap, args });
    if (!result.success) throw new Error(new TextDecoder().decode(result.stderr) || `git ${args.join(" ")} failed`);
    return new TextDecoder().decode(result.stdout).trim();
}

/** Publish only the checked RunWield update, from the exact tap revision qualified on macOS. */
export async function publishHomebrew(options: HomebrewPublication) {
    const { tap, checked, base, tag } = options;
    if (!/^[0-9a-f]{40}$/.test(base) || (await git(tap, ["rev-parse", "HEAD"])) !== base) {
        throw new Error("Publication checkout does not match the qualified tap revision.");
    }
    if (await git(tap, ["status", "--porcelain"])) throw new Error("Publication checkout must be clean.");
    const original: JsonFields = JSON.parse(await readFile(join(tap, MANIFEST), "utf8"));
    const verified: JsonFields = JSON.parse(await readFile(join(checked, MANIFEST), "utf8"));
    if (verified.wldTag !== tag || verified.testOnly !== false || typeof verified.generatedAt !== "string") {
        throw new Error("Checked output is not a publishable package for the requested tag.");
    }
    if (!isDeepStrictEqual(dependencyFields(original), dependencyFields(verified))) {
        throw new Error("Checked output changed dependency manifest fields.");
    }
    for (const path of ["Formula/mnemoteca.rb", "README.md"]) {
        if (!(await readFile(join(tap, path))).equals(await readFile(join(checked, path)))) {
            throw new Error(`Checked output changed ${path}.`);
        }
    }
    const formula = await readFile(join(checked, "Formula/wld.rb"), "utf8");
    const urls = Array.from(formula.matchAll(/url "([^"]+)"/g));
    if (
        !/^v\d+\.\d+\.\d+$/.test(tag) ||
        formula.includes("test-only artifact") ||
        urls.length !== 2 ||
        urls.some((match) => !match[1].startsWith(`https://github.com/RunWield/runwield/releases/download/${tag}/`))
    ) {
        throw new Error("Checked RunWield formula must use the requested Stable release assets.");
    }
    await copyFile(join(checked, "Formula/wld.rb"), join(tap, "Formula/wld.rb"));
    await writeFile(
        join(tap, MANIFEST),
        `${JSON.stringify({ ...original, wldTag: tag, testOnly: false, generatedAt: verified.generatedAt }, null, 4)}\n`,
    );
    await git(tap, ["add", "Formula/wld.rb", MANIFEST]);
    if (!(await git(tap, ["diff", "--cached", "--name-only"]))) {
        console.log(`Homebrew tap already matches ${tag}`);
        return;
    }
    await git(tap, [
        "-c",
        "user.name=github-actions[bot]",
        "-c",
        "user.email=41898282+github-actions[bot]@users.noreply.github.com",
        "commit",
        "-m",
        `Update RunWield to ${tag}`,
    ]);
    // Never rebase or force-push: a changed dependency requires a fresh snapshot and qualification.
    await git(tap, ["push", "origin", "HEAD:main"]);
}

if (import.meta.main) {
    const [tap, checked, base, tag] = process.argv.slice(2);
    if (!tap || !checked || !base || !tag)
        throw new Error("Usage: publish-homebrew.ts <tap> <checked> <base-sha> <tag>");
    await publishHomebrew({ tap, checked, base, tag });
}
