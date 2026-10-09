import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { createTestWorktreeAttempt, git, makeRepo } from "./worktree-test-helpers.ts";
import { checkpointExecutionWorktree, removeWorktreeGitArtifacts } from "./worktree.js";
import { HostedSession } from "./session/hosted-session.js";
import { runLocalCI } from "./workflow/validation-local-ci.ts";
import { setExactProjectCustomSetting } from "./settings.js";
import { publishExecutionWorktreeIsolated } from "./isolated-publication.ts";
import { ensureRunWieldOwnedGitignoreBlock } from "./runwield-owned-paths.ts";

for (const tracked of [false, true]) {
    for (
        const userEdit of [
            "none",
            "before-worktree",
            "staged-before-worktree",
            "before-worktree-same",
            "staged-before-worktree-same",
            "before",
            "after",
            "staged",
        ] as const
    ) {
        Deno.test(`validation-time command repair publishes only owned settings: tracked=${tracked}, edit=${userEdit}`, async () => {
            const root = await makeRepo();
            const worktreeRoot = await Deno.makeTempDir();
            let executionRoot = "";
            let session: HostedSession | undefined;
            try {
                await Deno.writeTextFile(join(root, ".gitignore"), ".wld/\nnode_modules/\n");
                await git(root, ["add", ".gitignore"]);
                if (tracked) {
                    setExactProjectCustomSetting("codereview", "none", root);
                    await git(root, ["add", "-f", ".wld/settings.json"]);
                }
                await git(root, ["commit", "-m", "Project before validation"]);
                const sameCommand = userEdit.endsWith("-same");
                const command = sameCommand ? "test -f ci-fixed.txt" : "printf initial; exit 1";
                const repairedCommand = sameCommand ? command : "printf repaired";
                if (userEdit.includes("before-worktree")) {
                    setExactProjectCustomSetting("theme", "user-before-worktree", root);
                    if (userEdit.startsWith("staged-before-worktree")) {
                        await git(root, ["add", "-f", ".wld/settings.json"]);
                    }
                }
                const entry = await createTestWorktreeAttempt({
                    projectRoot: root,
                    planName: "settings",
                    worktreeRoot,
                });
                executionRoot = entry.path;
                await ensureRunWieldOwnedGitignoreBlock(executionRoot);
                if (userEdit === "before") setExactProjectCustomSetting("theme", "user-before", root);
                session = new HostedSession({ id: crypto.randomUUID(), cwd: executionRoot });
                let prompts = 0;
                session.setInteractionAdapter({
                    supportsInteraction: () => true,
                    requestInteraction: () => {
                        prompts++;
                        return { outcome: "text", value: command };
                    },
                });
                const first = await runLocalCI({
                    hostedSession: session,
                    cwd: executionRoot,
                    settingsPolicy: "exact-project",
                });
                assertEquals(first.kind, "completed");
                if (first.kind !== "completed") throw new Error("First command should execute");
                assertEquals(first.exitCode, 1);
                if (sameCommand) await Deno.writeTextFile(join(executionRoot, "ci-fixed.txt"), "repaired\n");
                else setExactProjectCustomSetting("verification_command", repairedCommand, executionRoot);
                const second = await runLocalCI({
                    hostedSession: session,
                    cwd: executionRoot,
                    settingsPolicy: "exact-project",
                });
                assertEquals(second.kind, "completed");
                if (second.kind !== "completed") throw new Error("Repair command should execute");
                assertEquals(second.exitCode, 0);
                if (!sameCommand) assertStringIncludes(second.output, "repaired");
                assertEquals(prompts, 1);
                if (userEdit === "after" || userEdit === "staged") {
                    const productSettings = await Deno.readTextFile(join(root, ".wld/settings.json"));
                    setExactProjectCustomSetting("theme", "user-after", root);
                    if (userEdit === "staged") {
                        await git(root, ["add", "-f", ".wld/settings.json"]);
                        await Deno.writeTextFile(join(root, ".wld/settings.json"), productSettings);
                    }
                }
                await Deno.writeTextFile(join(root, "personal-note.txt"), "Preserve unrelated work\n");
                await Deno.writeTextFile(join(executionRoot, ".wld/unrelated-private.txt"), "Must stay ignored\n");
                await Deno.writeTextFile(join(executionRoot, "implementation.txt"), "Validated change\n");
                const checkpoint = await checkpointExecutionWorktree({
                    worktreePath: executionRoot,
                    branch: entry.branch,
                    planName: "settings",
                });
                assertStringIncludes(await git(executionRoot, ["show", "HEAD:.wld/settings.json"]), repairedCommand);
                const trackedFiles = await git(executionRoot, ["ls-files"]);
                assertEquals(trackedFiles.includes(".wld/unrelated-private.txt"), false);
                assertEquals(trackedFiles.includes(".wld/internal/"), false);
                const beforeSettings = await Deno.readTextFile(join(root, ".wld/settings.json"));
                const beforeHead = await git(root, ["rev-parse", "HEAD"]);
                const beforeIndex = await git(root, ["write-tree"]);
                const publication = () =>
                    publishExecutionWorktreeIsolated({
                        projectRoot: root,
                        executionCwd: executionRoot,
                        executionBranch: entry.branch,
                        targetBranch: "main",
                        planName: "settings",
                        sealedExecutionCommit: checkpoint.executionCommit,
                        allowedPlanPaths: [],
                    });
                if (userEdit === "none") {
                    await publication();
                    assertStringIncludes(await Deno.readTextFile(join(root, ".wld/settings.json")), "printf repaired");
                    assertStringIncludes(await git(root, ["show", "HEAD:.wld/settings.json"]), "printf repaired");
                } else {
                    await assertRejects(publication);
                    assertEquals(await Deno.readTextFile(join(root, ".wld/settings.json")), beforeSettings);
                    assertEquals(await git(root, ["rev-parse", "HEAD"]), beforeHead);
                    assertEquals(await git(root, ["write-tree"]), beforeIndex);
                }
                assertStringIncludes(await Deno.readTextFile(join(root, ".gitignore")), ".wld/\nnode_modules/\n");
                assertEquals(await Deno.readTextFile(join(root, "personal-note.txt")), "Preserve unrelated work\n");
            } finally {
                session?.dispose();
                if (executionRoot) {
                    await removeWorktreeGitArtifacts({ projectRoot: root, path: executionRoot, force: true });
                }
                await Deno.remove(root, { recursive: true });
                await Deno.remove(worktreeRoot, { recursive: true });
            }
        });
    }
}

for (const inherit of [false, true]) {
    Deno.test(`JSONC settings support validation command entry, inheritance and repair: inherit=${inherit}`, async () => {
        const root = await makeRepo();
        const worktreeRoot = await Deno.makeTempDir();
        let executionRoot = "";
        let session: HostedSession | undefined;
        try {
            await Deno.mkdir(join(root, ".wld"), { recursive: true });
            await Deno.writeTextFile(join(root, ".gitignore"), ".wld/\n");
            const command = "printf initial; exit 1";
            const jsonc = '{ // Project preferences\n "codereview": "none",\n' +
                (inherit ? ` "verification_command": "${command}",\n` : "") + "}\n";
            // An older execution checkout exercises inheritance from a clean primary JSONC file.
            const entry = inherit
                ? await createTestWorktreeAttempt({ projectRoot: root, planName: "jsonc", worktreeRoot })
                : null;
            if (entry) executionRoot = entry.path;
            await Deno.writeTextFile(join(root, ".wld/settings.json"), jsonc);
            await git(root, ["add", "-f", ".gitignore", ".wld/settings.json"]);
            await git(root, ["commit", "-m", "Supported JSONC settings"]);
            const execution = entry ??
                await createTestWorktreeAttempt({ projectRoot: root, planName: "jsonc", worktreeRoot });
            executionRoot = execution.path;
            await ensureRunWieldOwnedGitignoreBlock(executionRoot);
            session = new HostedSession({ id: crypto.randomUUID(), cwd: executionRoot });
            let prompts = 0;
            session.setInteractionAdapter({
                supportsInteraction: () => true,
                requestInteraction: () => {
                    prompts++;
                    return { outcome: "text", value: command };
                },
            });
            const first = await runLocalCI({
                hostedSession: session,
                cwd: executionRoot,
                settingsPolicy: "exact-project",
            });
            assertEquals(first.kind, "completed");
            if (first.kind !== "completed") throw new Error("Command should execute with JSONC settings");
            assertEquals(first.exitCode, 1);
            assertEquals(prompts, inherit ? 0 : 1);
            setExactProjectCustomSetting("verification_command", "printf repaired", executionRoot);
            const second = await runLocalCI({
                hostedSession: session,
                cwd: executionRoot,
                settingsPolicy: "exact-project",
            });
            assertEquals(second.kind, "completed");
            if (second.kind !== "completed") throw new Error("Repaired command should execute");
            assertEquals(second.exitCode, 0);
            // Bring the target's already-committed JSONC file into the older worktree's history,
            // preserving the validated settings content rather than manufacturing a merge conflict.
            if (inherit) {
                const repaired = await Deno.readTextFile(join(executionRoot, ".wld/settings.json"));
                await git(executionRoot, ["reset", "--hard", "main"]);
                await Deno.writeTextFile(join(executionRoot, ".wld/settings.json"), repaired);
                await ensureRunWieldOwnedGitignoreBlock(executionRoot);
            }
            const checkpoint = await checkpointExecutionWorktree({
                worktreePath: executionRoot,
                branch: execution.branch,
                planName: "jsonc",
            });
            await publishExecutionWorktreeIsolated({
                projectRoot: root,
                executionCwd: executionRoot,
                executionBranch: execution.branch,
                targetBranch: "main",
                planName: "jsonc",
                sealedExecutionCommit: checkpoint.executionCommit,
                allowedPlanPaths: [],
            });
            assertStringIncludes(await git(root, ["show", "HEAD:.wld/settings.json"]), "printf repaired");
        } finally {
            session?.dispose();
            if (executionRoot) {
                await removeWorktreeGitArtifacts({ projectRoot: root, path: executionRoot, force: true });
            }
            await Deno.remove(root, { recursive: true });
            await Deno.remove(worktreeRoot, { recursive: true });
        }
    });
}
