import { captureScriptProcess } from "./script-process.ts";
import process from "node:process";
import { getCwd } from "../src/constants.js";
import { PUBLIC_DOCS } from "./public-docs.ts";

const ALLOWED_PATHS = new Set([
    ...PUBLIC_DOCS.map((path) => `docs/${path}`),
    ".github/workflows/docs.yml",
    ".gitignore",
    "deno.json",
    "deno.lock",
    "scripts/check-public-docs.ts",
    "scripts/docs-branch-integration.test.ts",
    "scripts/docs-dev.ts",
    "scripts/docs-workflow.test.ts",
    "scripts/public-docs.test.ts",
    "scripts/public-docs.ts",
    "scripts/reconcile-docs-branch.sh",
    "scripts/verify-docs-source.ts",
]);

async function git(cwd: string, ...args: string[]): Promise<string> {
    const result = await captureScriptProcess("git", {
        args,
        cwd,
        stdout: "piped",
        stderr: "piped",
    });
    const stdout = new TextDecoder().decode(result.stdout).trim();
    if (!result.success) {
        throw new Error(new TextDecoder().decode(result.stderr).trim() || `git ${args.join(" ")} failed`);
    }
    return stdout;
}

function isAllowed(path: string): boolean {
    return path.startsWith("docs-site/") || ALLOWED_PATHS.has(path);
}

export async function verifyDocsSource(cwd: string, documentedTag: string, sourceSha: string): Promise<void> {
    await git(cwd, "fetch", "origin", "docs/stable:refs/remotes/origin/docs/stable");
    const currentTip = await git(cwd, "rev-parse", "refs/remotes/origin/docs/stable");
    if (sourceSha !== currentTip) throw new Error("Documentation source is stale");
    await git(cwd, "merge-base", "--is-ancestor", documentedTag, sourceSha);
    const changed = (await git(cwd, "diff", "--name-only", `${documentedTag}..${sourceSha}`))
        .split("\n").filter(Boolean);
    const productPath = changed.find((path) => !isAllowed(path));
    if (productPath) throw new Error(`Docs branch changes product path: ${productPath}`);
}

async function main(): Promise<void> {
    const [documentedTag, sourceSha] = process.argv.slice(2);
    if (!documentedTag || !sourceSha) {
        throw new Error("Usage: verify-docs-source.ts <documented-tag> <source-sha>");
    }
    await verifyDocsSource(getCwd(), documentedTag, sourceSha);
}

if (import.meta.main) await main();
