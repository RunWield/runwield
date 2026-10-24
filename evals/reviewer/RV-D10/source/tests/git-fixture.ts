import { mkdtemp, rm, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git } from "../src/git.ts";

export interface PublicationFixture {
    root: string;
    remote: string;
    repair: string;
    other: string;
    attemptFile: string;
    initialTarget: string;
    candidate: string;
}

export async function withPublicationFixture(run: (fixture: PublicationFixture) => Promise<void>): Promise<void> {
    const root = await mkdtemp(join(tmpdir(), "publication-git-"));
    try {
        const remote = join(root, "remote.git");
        const repair = join(root, "repair");
        const other = join(root, "other");
        git(root, ["init", "--bare", "--initial-branch=main", remote]);
        git(root, ["init", "--initial-branch=main", repair]);
        await writeFile(join(repair, "base.txt"), "Initial target\n");
        git(repair, ["add", "."]);
        git(repair, ["commit", "-m", "Initial target"]);
        const initialTarget = git(repair, ["rev-parse", "HEAD"]);
        git(repair, ["remote", "add", "origin", remote]);
        git(repair, ["push", "origin", "HEAD:refs/heads/main"]);
        git(root, ["clone", remote, other]);
        git(repair, ["checkout", "-b", "repair"]);
        await writeFile(join(repair, "candidate.txt"), "Validated repair\n");
        git(repair, ["add", "."]);
        git(repair, ["commit", "-m", "Validated repair"]);
        const candidate = git(repair, ["rev-parse", "HEAD"]);
        await run({ root, remote, repair, other, attemptFile: join(root, "attempt.json"), initialTarget, candidate });
    } finally {
        await rm(root, { recursive: true, force: true });
    }
}

export async function rejectPushes(fixture: PublicationFixture, reject: boolean): Promise<void> {
    const hook = join(fixture.remote, "hooks", "pre-receive");
    if (reject) {
        await writeFile(hook, "#!/bin/sh\necho 'Publication maintenance window' >&2\nexit 1\n");
        await chmod(hook, 0o755);
    } else {
        await rm(hook, { force: true });
    }
}

export async function advanceTarget(fixture: PublicationFixture): Promise<string> {
    await writeFile(join(fixture.other, "target-note.txt"), "Independent target work\n");
    git(fixture.other, ["add", "."]);
    git(fixture.other, ["commit", "-m", "Independent target work"]);
    git(fixture.other, ["push", "origin", "HEAD:refs/heads/main"]);
    return git(fixture.other, ["rev-parse", "HEAD"]);
}
