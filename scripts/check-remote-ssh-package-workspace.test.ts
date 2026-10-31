import { test } from "node:test";
import { deepStrictEqual, equal } from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { withProcessGlobalTestLock } from "../src/testing/process-global-lock.ts";
import { createQualificationWorkspace, retainQualificationEvidence } from "./check-remote-ssh-package.ts";

test("server workspace remains traversable when the runner's temporary directory is private", async () => {
    await withProcessGlobalTestLock(async () => {
        const runner = await mkdtemp(join(tmpdir(), "private-runner-"));
        const original = process.env.RUNNER_TEMP;
        const originalTmp = process.env.TMPDIR;
        process.env.RUNNER_TEMP = runner;
        process.env.TMPDIR = runner;
        try {
            const workspace = await createQualificationWorkspace();
            try {
                equal(dirname(workspace.root), "/tmp", "The second account cannot traverse the runner's private HOME");
                equal((await stat(workspace.root)).mode & 0o777, 0o755);
                equal(dirname(workspace.evidence), runner);
                equal((await stat(workspace.evidence)).mode & 0o777, 0o700);
            } finally {
                await rm(workspace.root, { recursive: true, force: true });
            }
        } finally {
            if (original === undefined) delete process.env.RUNNER_TEMP;
            else process.env.RUNNER_TEMP = original;
            if (originalTmp === undefined) delete process.env.TMPDIR;
            else process.env.TMPDIR = originalTmp;
            await rm(runner, { recursive: true, force: true });
        }
    });
});

test("uploadable evidence excludes account homes, SSH keys and symlinks on failed runs", async () => {
    const root = await mkdtemp(join(tmpdir(), "qualification-evidence-"));
    const source = join(root, "workspace");
    const evidence = join(root, "upload");
    try {
        await mkdir(source);
        await mkdir(evidence);
        await mkdir(join(source, "server"), { mode: 0o000 });
        await writeFile(join(source, "client-key"), "private key");
        await writeFile(join(source, "terminal.log"), "SSH startup failed");
        await writeFile(join(source, "sshd.log"), "server diagnostic");
        await symlink(join(source, "client-key"), join(source, "provider.jsonl"));
        await retainQualificationEvidence(source, evidence);
        deepStrictEqual((await readdir(evidence)).sort(), ["sshd.log", "terminal.log"]);
        equal(await readFile(join(evidence, "terminal.log"), "utf8"), "SSH startup failed");
    } finally {
        await chmod(join(source, "server"), 0o700);
        await rm(root, { recursive: true, force: true });
    }
});
