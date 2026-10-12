import { assertEquals } from "../../testing/assertions.ts";
import { runtimeSourceArgs } from "../../testing/runtime-source-args.ts";
import { captureForegroundProcess } from "../captured-process.ts";
import { getCwd } from "../../constants.js";
import { makeTempFile } from "../../testing/temp-file.ts";
import { tmpdir } from "node:os";
import {
    mkdtemp as fsMkdtemp,
    readFile as fsReadFile,
    rm as fsRm,
    stat as fsStat,
    writeFile as fsWriteFile,
} from "node:fs/promises";
import process from "node:process";
import { ok as assert } from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath as fromFileUrl } from "node:url";
import { addEntry, findById } from "../worktree-registry.js";
import { createTestWorktreeAttempt, git, makeRepo } from "../worktree-test-helpers.ts";
import { publicationRootForAttempt } from "./publication-machine.ts";

const DRIVER = join(dirname(fromFileUrl(import.meta.url)), "testing/publication-process-driver.ts");
export const CRASH_BOUNDARIES = [
    "candidate_effect",
    "candidate_receipt",
    "artifact_effect",
    "artifact_receipt",
    "integration_effect",
    "integration_receipt",
    "target_effect",
    "target_receipt",
    "verification_receipt",
    "cleanup_effect",
    "cleanup_receipt",
    "registry_pruned",
] as const;

type PublicationMode = "remote" | "local";

export async function runDriver(configPath: string, crashAfter?: string): Promise<number> {
    const config = JSON.parse(await fsReadFile(configPath, "utf8")) as Record<string, string>;
    if (crashAfter) config.crashAfter = crashAfter;
    else delete config.crashAfter;
    await fsWriteFile(configPath, JSON.stringify(config));
    const output = await captureForegroundProcess(process.execPath, {
        args: runtimeSourceArgs(["run", "-A", "--node-modules-dir=manual", DRIVER, configPath]),
        cwd: getCwd(),
    });
    if (output.code !== 0 && output.code !== 86) {
        throw new Error(new TextDecoder().decode(output.stderr) || new TextDecoder().decode(output.stdout));
    }
    return output.code;
}

export async function runCrashCase(mode: PublicationMode, crashAfter: string, advanceTarget = false): Promise<void> {
    const projectRoot = await makeRepo();
    const remoteRoot = await fsMkdtemp(join(tmpdir(), "publication-matrix-remote-"));
    const worktreeRoot = await fsMkdtemp(join(tmpdir(), "publication-matrix-worktree-"));
    const configPath = await makeTempFile({ prefix: "publication-matrix-driver-", suffix: ".json" });
    const planName = `${mode}-${crashAfter}`;
    try {
        if (mode === "remote") {
            await git(remoteRoot, ["init", "--bare"]);
            await git(projectRoot, ["remote", "add", "origin", remoteRoot]);
            await git(projectRoot, ["push", "-u", "origin", "main"]);
        }
        const worktree = await createTestWorktreeAttempt({ projectRoot, planName, worktreeRoot });
        await fsWriteFile(`${worktree.path}/implementation.txt`, `${mode}-${crashAfter}\n`);
        const targetHead = await git(projectRoot, ["rev-parse", "main"]);
        await addEntry(projectRoot, {
            id: "attempt-1",
            planId: "plan-1",
            planName,
            baseBranch: "main",
            baseRef: "refs/heads/main",
            baseCommit: targetHead,
            branch: worktree.branch,
            path: worktree.path,
            status: "completed",
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
        });
        await fsWriteFile(`${projectRoot}/untracked-user-file.txt`, "do not touch\n");
        if (mode === "remote") await fsWriteFile(`${projectRoot}/README.md`, "dirty primary checkout\n");
        const primaryHead = await git(projectRoot, ["rev-parse", "HEAD"]);
        const primaryStatus = await git(projectRoot, ["status", "--porcelain", "--untracked-files=all"]);
        await fsWriteFile(
            configPath,
            JSON.stringify({
                projectRoot,
                attemptId: "attempt-1",
                planName,
                targetBranch: "main",
                executionBranch: worktree.branch,
                executionCwd: worktree.path,
            }),
        );

        assertEquals(await runDriver(configPath, crashAfter), 86);
        let advancedHead = "";
        if (advanceTarget) {
            const target = mode === "remote" ? remoteRoot : projectRoot;
            const publishedHead = await git(target, ["rev-parse", "refs/heads/main"]);
            const other = await fsMkdtemp(join(tmpdir(), "publication-later-commit-"));
            try {
                await git(projectRoot, ["clone", "--branch", "main", target, other]);
                await git(other, ["config", "user.name", "Other developer"]);
                await git(other, ["config", "user.email", "other@example.com"]);
                await fsWriteFile(`${other}/later.txt`, "independent commit\n");
                await git(other, ["add", "later.txt"]);
                await git(other, ["commit", "-m", "Independent later commit"]);
                advancedHead = await git(other, ["rev-parse", "HEAD"]);
                if (mode === "remote") await git(other, ["push", "origin", "main"]);
                else await git(projectRoot, ["pull", "--ff-only", other, "main"]);
                await git(other, ["merge-base", "--is-ancestor", publishedHead, advancedHead]);
            } finally {
                await fsRm(other, { recursive: true });
            }
        }
        assertEquals(await runDriver(configPath), 0);

        const targetHeadAfter =
            mode === "remote"
                ? (await git(projectRoot, ["ls-remote", "origin", "refs/heads/main"])).split(/\s+/)[0]
                : await git(projectRoot, ["rev-parse", "main"]);
        if (advanceTarget) assertEquals(targetHeadAfter, advancedHead);
        if (mode === "remote") await git(projectRoot, ["fetch", "origin", "main"]);
        await git(projectRoot, ["merge-base", "--is-ancestor", targetHead, targetHeadAfter]);
        assertEquals(await git(projectRoot, ["show", `${targetHeadAfter}:artifact-count.txt`]), "1");
        assertEquals(
            await git(projectRoot, ["show", `${targetHeadAfter}:implementation.txt`]),
            `${mode}-${crashAfter}`,
        );
        const messages = await git(projectRoot, ["log", "--all", "--format=%B"]);
        assertEquals(messages.split("RunWield-Publication-Attempt: attempt-1").length - 1, 1);
        if (mode === "remote") {
            assertEquals(await git(projectRoot, ["rev-parse", "HEAD"]), primaryHead);
            assertEquals(await git(projectRoot, ["status", "--porcelain", "--untracked-files=all"]), primaryStatus);
            assertEquals(await fsReadFile(`${projectRoot}/README.md`, "utf8"), "dirty primary checkout\n");
        } else {
            assert(targetHeadAfter !== primaryHead);
            assertEquals(await fsReadFile(`${projectRoot}/untracked-user-file.txt`, "utf8"), "do not touch\n");
        }
        assertEquals(await findById(projectRoot, "attempt-1", { migrate: false }), null);
        assertEquals(
            await fsStat(worktree.path)
                .then(() => true)
                .catch(() => false),
            false,
        );
        assertEquals(
            await fsStat(publicationRootForAttempt(projectRoot, "attempt-1"))
                .then(() => true)
                .catch(() => false),
            false,
        );
        assertEquals((await git(projectRoot, ["branch", "--list", worktree.branch])).trim(), "");
    } finally {
        await fsRm(projectRoot, { recursive: true }).catch(() => {});
        await fsRm(remoteRoot, { recursive: true }).catch(() => {});
        await fsRm(worktreeRoot, { recursive: true }).catch(() => {});
        await fsRm(configPath).catch(() => {});
    }
}
