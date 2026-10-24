import { fauxAssistantMessage, fauxToolCall, type FauxResponseFactory } from "@earendil-works/pi-ai";
import { parseDiffFiles } from "../../src/shared/workflow/review-diff-tool.js";
import { cp, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineGitFixture } from "../../src/shared/git-test-fixture.ts";
import { captureForegroundProcess } from "../../src/shared/captured-process.ts";

export const corpusPath = fileURLToPath(new URL("../../evals/reviewer/", import.meta.url));
export const smokeIds = ["RV-D04", "RV-D05", "RV-D12", "RV-D13", "RV-M01"];
const copies = defineGitFixture(async (cwd) => {
    await cp(corpusPath, join(cwd, "fixtures"), { recursive: true });
});

export async function withFixtureCopy(id: string, action: (packageDir: string) => Promise<void>): Promise<void> {
    const cwd = await copies.checkout();
    try {
        await action(join(cwd, "fixtures", id));
    } finally {
        await rm(cwd, { recursive: true, force: true });
    }
}

export async function rawGit(cwd: string, args: string[], stdinText?: string): Promise<string> {
    const result = await captureForegroundProcess("git", { cwd, args, stdinText });
    if (result.code !== 0) throw new Error(new TextDecoder().decode(result.stderr));
    return new TextDecoder().decode(result.stdout);
}

/** Read the complete public tree, including dotfiles, without Git's metadata. */
export async function publicTree(cwd: string, prefix = ""): Promise<Record<string, string>> {
    const result: Record<string, string> = {};
    for (const entry of await readdir(join(cwd, prefix), { withFileTypes: true })) {
        if (entry.name === ".git") continue;
        const path = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) Object.assign(result, await publicTree(cwd, path));
        else result[path] = await readFile(join(cwd, path), "utf8");
    }
    return result;
}

export function inspectionSteps(diffText: string): FauxResponseFactory[] {
    return [
        () => fauxAssistantMessage(fauxToolCall("review_diff", { command: "list", scope: "full" })),
        ...parseDiffFiles(diffText).flatMap((file) => {
            const steps: FauxResponseFactory[] = [];
            for (let offsetBytes = 0; offsetBytes < file.byteLength; offsetBytes += 1024) {
                steps.push(() =>
                    fauxAssistantMessage(
                        fauxToolCall("review_diff", {
                            command: "show",
                            scope: "full",
                            path: file.path,
                            offsetBytes,
                            maxBytes: 1024,
                        }),
                    ),
                );
            }
            return steps;
        }),
    ];
}
