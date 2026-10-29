import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { captureForegroundProcess } from "../../src/shared/captured-process.ts";
import { getWorktreeReviewDiff } from "../../src/shared/workflow/git-snapshot.ts";
import { fixtureVariant, readFixturePatch, validateSourceTree } from "./fixtures.ts";
import type { ReviewerFixture, VariantId } from "./fixtures.ts";

export interface MaterializedProject {
    cwd: string;
    planContent: string;
    diffText: string;
    /** The caller must await cleanup, including after Reviewer or provider failure. Idempotent. */
    cleanup: () => Promise<void>;
}

/** Neutral directories cannot reveal which scenario or variant is being reviewed. */
export async function createProjectDirectory(): Promise<string> {
    const checkout = await realpath(join(dirname(fileURLToPath(import.meta.url)), "../.."));
    const cwd = await mkdtemp(join(tmpdir(), "project-"));
    const rel = relative(checkout, await realpath(cwd));
    if (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`)) {
        await rm(cwd, { recursive: true, force: true });
        throw new Error("Reviewer projects must be outside the RunWield checkout");
    }
    return cwd;
}

export async function projectGit(cwd: string, args: string[], stdinText?: string): Promise<string> {
    const result = await captureForegroundProcess("git", { cwd, args, stdinText, timeoutMs: 30000 });
    const stdout = new TextDecoder().decode(result.stdout);
    if (result.code !== 0)
        throw new Error(`Fixture Git operation failed: ${new TextDecoder().decode(result.stderr) || stdout}`);
    return stdout;
}

export async function applyFixturePatch(cwd: string, fixture: ReviewerFixture, patchPath: string): Promise<void> {
    const patch = await readFixturePatch(fixture, patchPath);
    await projectGit(cwd, ["apply", "--check", "-"], patch);
    await projectGit(cwd, ["apply", "-"], patch);
    // Keep new files visible to ordinary Git diff as well as the production snapshot diff.
    await projectGit(cwd, ["add", "-N", "--", "."]);
}

/** Copy only public source, commit a neutral baseline, and apply exactly one variant. */
export async function materializeFixture(fixture: ReviewerFixture, variant: VariantId): Promise<MaterializedProject> {
    const selected = fixtureVariant(fixture, variant);
    await validateSourceTree(fixture.sourceDir);
    const cwd = await createProjectDirectory();
    const cleanup = () => rm(cwd, { recursive: true, force: true });
    try {
        await cp(fixture.sourceDir, cwd, { recursive: true });
        await projectGit(cwd, ["-c", "init.templateDir=", "init", "-b", "main"]);
        await projectGit(cwd, ["config", "user.name", "Developer"]);
        await projectGit(cwd, ["config", "user.email", "developer@example.test"]);
        await projectGit(cwd, ["config", "commit.gpgsign", "false"]);
        await projectGit(cwd, ["config", "core.autocrlf", "false"]);
        await projectGit(cwd, ["config", "core.hooksPath", ".git/hooks"]);
        await mkdir(join(cwd, ".git/info"), { recursive: true });
        await writeFile(join(cwd, ".git/info/exclude"), "/.wld/\n");
        await projectGit(cwd, ["add", "--", "."]);
        await projectGit(cwd, ["commit", "-m", "Initial project"]);
        await projectGit(cwd, ["checkout", "-b", "change"]);
        await applyFixturePatch(cwd, fixture, selected.patch);
        const planContent = await readFile(join(cwd, fixture.manifest.planPath), "utf8");
        const diffText = await getWorktreeReviewDiff(cwd, "main");
        if (!diffText.trim()) throw new Error("Fixture variant has no review diff");
        return { cwd, planContent, diffText, cleanup };
    } catch (error) {
        await cleanup();
        throw error;
    }
}
