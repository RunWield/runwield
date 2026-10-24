import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { captureForegroundProcess } from "../../src/shared/captured-process.ts";
import type { RunConfiguration } from "./records.ts";
import { getReviewerConfiguration } from "../../src/shared/workflow/standalone-reviewer.ts";
import type { FixtureReviewOptions } from "./reviewer.ts";

export const checkoutRoot = fileURLToPath(new URL("../../", import.meta.url));
export const corpusRoot = join(checkoutRoot, "evals/reviewer");
const promptPaths = [
    "src/agent-definitions/subagent-definitions/reviewer-prompt.md",
    "src/agent-definitions/subagent-definitions/reviewer-verify-prompt.md",
    "src/agent-definitions/shared-practice/review-practice.md",
];

/** Report files are outputs, not changes to the configuration under evaluation. */
export async function captureCheckoutIdentity(root: string, outputDirectory?: string) {
    async function git(args: string[]): Promise<string> {
        const result = await captureForegroundProcess("git", { cwd: root, args, timeoutMs: 30000 });
        if (result.code !== 0)
            throw new Error(`Cannot establish checkout identity: ${new TextDecoder().decode(result.stderr)}`);
        return new TextDecoder().decode(result.stdout).trim();
    }
    const revision = await git(["rev-parse", "HEAD"]);
    if (!/^[a-f0-9]{40,64}$/.test(revision)) throw new Error("Cannot establish checkout revision");
    const excluded: string[] = [];
    if (outputDirectory) {
        const path = relative(root, outputDirectory);
        if (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`)) {
            for (const name of [
                "run.json",
                "results.jsonl",
                "summary.json",
                "summary.md",
                "adjudications.json",
                ".lock",
            ])
                excluded.push(`:(top,literal,exclude)${join(path, name).split(sep).join("/")}`);
        }
    }
    const status = await git(["status", "--porcelain", "--untracked-files=all", "--", ".", ...excluded]);
    return { revision, dirty: status.length > 0 };
}

export async function captureConfiguration(
    options: FixtureReviewOptions,
    outputDirectory?: string,
): Promise<RunConfiguration> {
    const selected = await getReviewerConfiguration(options);
    const identity = await captureCheckoutIdentity(checkoutRoot, outputDirectory);
    const promptHashes: Record<string, string> = {};
    for (const path of promptPaths)
        promptHashes[path] = createHash("sha256")
            .update(await readFile(join(checkoutRoot, path)))
            .digest("hex");
    return { ...identity, promptHashes, ...selected, bunVersion: Bun.version };
}

/** Include hidden verification inputs as well as source, so resume cannot mix different ground truth. */
export async function fixtureHash(directory: string): Promise<string> {
    const hash = createHash("sha256");
    async function visit(prefix: string): Promise<void> {
        const entries = await readdir(join(directory, prefix), { withFileTypes: true });
        for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
            const path = prefix ? `${prefix}/${entry.name}` : entry.name;
            if (entry.isDirectory()) await visit(path);
            else if (entry.isFile())
                hash.update(JSON.stringify([path, (await readFile(join(directory, path))).toString("base64")]));
            else throw new Error(`Cannot hash non-regular fixture entry: ${path}`);
        }
    }
    await visit("");
    return hash.digest("hex");
}
