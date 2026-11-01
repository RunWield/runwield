import { test } from "node:test";
import { equal, notEqual, ok } from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { Terminal, spawn as spawnPty } from "bun";
import { defineCommittedGitFixture, git } from "./git-test-fixture.ts";
import { admitProjectIdentity, inspectProjectIdentity, type ProjectLaunchContext } from "./project-identity.ts";

const fixture = defineCommittedGitFixture();
interface InteractiveResult {
    output: string;
    sawPrompt: boolean;
}
async function runInteractive(root: string, home: string, keys: string): Promise<InteractiveResult> {
    let output = "";
    let sawPrompt = false;
    const terminal = new Terminal({
        cols: 140,
        rows: 30,
        data(term, bytes) {
            output += Buffer.from(bytes).toString();
            if (
                !sawPrompt &&
                output.includes("matches known Projects") &&
                output.includes("Create a separate Project")
            ) {
                sawPrompt = true;
                term.write(keys);
            }
        },
    });
    const cli = fileURLToPath(new URL("../cli.ts", import.meta.url));
    const child = spawnPty([process.execPath, "--no-env-file", "--no-install", cli, "plans"], {
        cwd: root,
        terminal,
        env: { ...process.env, HOME: home, WLD_TEST_SANDBOX_HOME: home, BUN_FEATURE_FLAG_NO_ORPHANS: "0" },
    });
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
        const code = await Promise.race([
            child.exited,
            new Promise<never>((_resolve, reject) => {
                deadline = setTimeout(
                    () => reject(new Error(`Interactive identity entry timed out:\n${output}`)),
                    10000,
                );
            }),
        ]);
        equal(code, 0, output);
        return { output, sawPrompt };
    } finally {
        clearTimeout(deadline);
        child.kill("SIGKILL");
        terminal.close();
    }
}

test(
    "real terminal clone selector accepts, declines, cancels, and remembers explicit decisions",
    {
        skip: process.platform === "win32" ? "POSIX PTY acceptance" : false,
        timeout: 40000,
    },
    async () => {
        const home = await mkdtemp(join(tmpdir(), "identity-interactive-"));
        const source = await fixture.checkout();
        const context: ProjectLaunchContext = {
            executionAccountHome: home,
            personalOwner: { kind: "execution-account", identity: home },
        };
        try {
            const roots = ["known", "linked", "separate", "canceled"].map((name) => join(home, name));
            for (const root of roots) await git(source, ["clone", source, root]);
            const original = await admitProjectIdentity(roots[0], { context });
            if (original.kind !== "existing") throw new Error(JSON.stringify(original));
            ok((await runInteractive(roots[1], home, "\x1b[B\x1b[B\r")).sawPrompt);
            const linked = inspectProjectIdentity(roots[1], { context });
            if (linked.kind !== "existing") throw new Error(JSON.stringify(linked));
            equal(linked.identity.projectId, original.identity.projectId);
            notEqual(linked.identity.repositoryId, original.identity.repositoryId);
            ok((await runInteractive(roots[2], home, "\x1b[B\r")).sawPrompt);
            const separate = inspectProjectIdentity(roots[2], { context });
            if (separate.kind !== "existing") throw new Error(JSON.stringify(separate));
            notEqual(separate.identity.projectId, original.identity.projectId);
            ok((await runInteractive(roots[3], home, "\r")).sawPrompt);
            equal(inspectProjectIdentity(roots[3], { context }).kind, "pending");
            equal((await runInteractive(roots[1], home, "\r")).sawPrompt, false);
            equal((await runInteractive(roots[2], home, "\r")).sawPrompt, false);
        } finally {
            await rm(home, { recursive: true, force: true });
            await rm(source, { recursive: true, force: true });
        }
    },
);
