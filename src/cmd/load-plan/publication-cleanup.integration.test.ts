import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import { savePlan } from "../../plan-store.js";
import { defineCommittedGitFixture, git } from "../../shared/git-test-fixture.ts";
import { createSessionRuntime } from "../../shared/session/session-runtime.ts";
import { addEntry, findById } from "../../shared/worktree-registry.js";
import { withRuntimeCommandFixture } from "../testing/runtime-command-fixture.ts";
import { runLoadPlanCommand } from "./index.ts";
import type { EditorAPI, UiAPI } from "../../ui/tui/types.js";

const seed = defineCommittedGitFixture({ ".gitignore": ".wld/\n", "README.md": "Project\n" });
const driver = fromFileUrl(new URL("../../shared/workflow/testing/publication-process-driver.ts", import.meta.url));
type CrashBoundary = "verification_receipt" | "cleanup_effect" | "cleanup_receipt";
type Invocation = "named" | "picker";
type TargetChange =
    | "unchanged"
    | "advanced"
    | "rewritten"
    | "upstream_reconfigured"
    | "remote_removed"
    | "lost_registration"
    | "lost_registration_branch_gone"
    | "saved_copy_exists";

async function checkCleanupRestart(
    boundary: CrashBoundary,
    invocation: Invocation,
    targetChange: TargetChange = "unchanged",
    requestCleanup = true,
) {
    await withRuntimeCommandFixture("runwield-cleanup-command-", async () => {
        const root = await seed.checkout();
        const directory = await Deno.makeTempDir({ prefix: "runwield-cleanup-git-" });
        const tree = join(directory, "execution");
        const remote = join(directory, "remote.git");
        const runtime = createSessionRuntime();
        try {
            await savePlan(root, "demo", "# Demo\n", {
                planId: "plan-1",
                classification: "PLANNED_CHANGE",
                status: "ready_for_work",
            });
            await git(root, ["add", "docs"]);
            await git(root, ["commit", "-m", "Save Plan"]);
            const targetBefore = await git(root, ["rev-parse", "HEAD"]);
            await Deno.mkdir(remote);
            await git(remote, ["init", "--bare"]);
            await git(root, ["remote", "add", "origin", remote]);
            await git(root, ["push", "-u", "origin", "main"]);
            await git(root, ["worktree", "add", "-b", "worktree/demo", tree]);
            await Deno.writeTextFile(join(tree, "implementation.txt"), "implementation\n");
            await addEntry(root, {
                id: "attempt-1",
                planId: "plan-1",
                planName: "demo",
                baseBranch: "main",
                baseRef: "refs/heads/main",
                baseCommit: targetBefore,
                baseTree: await git(root, ["rev-parse", "HEAD^{tree}"]),
                branch: "worktree/demo",
                path: tree,
                status: "completed",
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
            });
            const configPath = join(directory, "driver.json");
            await Deno.writeTextFile(
                configPath,
                JSON.stringify({
                    projectRoot: root,
                    attemptId: "attempt-1",
                    planName: "demo",
                    targetBranch: "main",
                    executionBranch: "worktree/demo",
                    executionCwd: tree,
                    crashAfter: boundary,
                }),
            );
            const crashed = await new Deno.Command(Deno.execPath(), {
                args: ["run", "-A", driver, configPath],
                stdout: "piped",
                stderr: "piped",
            }).output();
            assertEquals(crashed.code, 86, new TextDecoder().decode(crashed.stderr));
            const before = await findById(root, "attempt-1", { migrate: false });
            assert(before?.publication);
            assertEquals(
                before.publication.phase,
                boundary === "cleanup_receipt" ? "cleanup_complete" : "publication_verified",
            );
            const lostRegistration = ["lost_registration", "lost_registration_branch_gone", "saved_copy_exists"]
                .includes(targetChange);
            if (lostRegistration) {
                const marker = await Deno.readTextFile(join(tree, ".git"));
                await Deno.remove(marker.trim().slice("gitdir: ".length), { recursive: true });
                await Deno.writeTextFile(join(tree, "implementation.txt"), "Uncommitted work to keep\n");
                await Deno.writeTextFile(join(tree, "personal-note.txt"), "Untracked work to keep\n");
                if (targetChange === "lost_registration_branch_gone") {
                    await git(root, ["branch", "-D", "worktree/demo"]);
                }
                if (targetChange === "saved_copy_exists") {
                    await Deno.mkdir(join(`${tree}.saved`, "files"), { recursive: true });
                    await Deno.writeTextFile(
                        join(`${tree}.saved`, "files", "previous.txt"),
                        "Keep previous saved files\n",
                    );
                }
            } else {
                assertEquals(
                    await Deno.stat(tree).then(() => true).catch(() => false),
                    boundary === "verification_receipt",
                );
            }
            if (targetChange === "rewritten") await git(remote, ["update-ref", "refs/heads/main", targetBefore]);
            if (targetChange === "advanced") {
                // Another developer publishes after our process exits. Do not fetch into
                // the primary checkout: recovery must observe the actual remote itself.
                const other = join(directory, "other-developer");
                await git(root, ["clone", "--branch", "main", remote, other]);
                await git(other, ["config", "user.name", "Another developer"]);
                await git(other, ["config", "user.email", "other@example.com"]);
                await Deno.writeTextFile(join(other, "later.txt"), "Later independent change\n");
                await git(other, ["add", "later.txt"]);
                await git(other, ["commit", "-m", "Later independent change"]);
                await git(other, ["push", "origin", "main"]);
            }
            if (targetChange === "upstream_reconfigured") {
                await git(root, ["config", "branch.main.remote", "."]);
                await git(root, ["config", "branch.main.merge", "refs/heads/other"]);
            }
            if (targetChange === "remote_removed") {
                // Local history alone must not authorize cleanup of a remote
                // publication whose recorded upstream can no longer be checked.
                await git(root, ["pull", "--ff-only", "origin", "main"]);
                await git(root, ["remote", "remove", "origin"]);
            }
            const primaryHead = await git(root, ["rev-parse", "HEAD"]);
            const expectedTarget = await git(remote, ["rev-parse", "refs/heads/main"]);
            const primaryPath = join(root, "docs/plans/demo.md");
            const primaryBytes =
                `---\nplanId: plan-1\nclassification: PLANNED_CHANGE\nstatus: validated\ntargetBranch: main\nvalidatedCommit: ${before.publication.validatedCommit}\n---\n# Keep my primary Plan\n\nUnsaved Plan notes.\n`;
            await Deno.writeTextFile(primaryPath, primaryBytes);
            await Deno.writeTextFile(join(root, "README.md"), "Unsaved user changes\n");
            const primaryStatus = await git(root, ["status", "--porcelain", "--untracked-files=all"]);
            const sourceBranch = await git(root, ["branch", "--list", "worktree/demo"]);
            const worktreeList = await git(root, ["worktree", "list", "--porcelain"]);

            const sessionId = await runtime.createPromptReadySession({ cwd: root, agentName: "router" });
            const messages: string[] = [];
            const prompts: string[] = [];
            let cleanupSelected = false;
            let viewed = false;
            const editor: EditorAPI = {
                disableSubmit: true,
                setText: () => {},
                setAutocompleteProvider: () => {},
                handleInput: () => {},
            };
            const uiAPI: UiAPI = {
                abortActivePrompt: () => {},
                appendSystemMessage: (message) => messages.push(message),
                appendAgentMessageStart: () => ({ appendText: () => {} }),
                requestRender: () => {},
                promptSelect: (prompt, choices) => {
                    prompts.push(prompt);
                    if (prompt !== "Load plan:" && !cleanupSelected) assertEquals(choices[0].value, "view");
                    const choice = prompt === "Load plan:"
                        ? "demo"
                        : requestCleanup && !cleanupSelected
                        ? "cleanup"
                        : !requestCleanup && !viewed
                        ? "view"
                        : "cancel";
                    assert(choices.some((option) => option.value === choice), `Missing ${choice} in ${prompt}`);
                    if (choice === "cleanup") {
                        // Loading and displaying the menu must not perform cleanup first.
                        assertEquals(messages.some((message) => message.includes("Cleanup")), false);
                        cleanupSelected = true;
                    }
                    if (choice === "view") viewed = true;
                    return Promise.resolve(choice);
                },
                promptText: () => Promise.resolve(null),
                showModelSelector: () => {},
            };
            await runLoadPlanCommand(invocation === "named" ? [primaryPath] : [], {
                sessionRuntime: runtime,
                sessionId,
                uiAPI,
                editor,
            });

            assertEquals(
                prompts,
                [
                    ...(invocation === "picker" ? ["Load plan:"] : []),
                    "What would you like to do?",
                    "What would you like to do?",
                ],
            );
            assertStringIncludes(messages.join("\n"), "Plan loaded: demo");
            if (!requestCleanup) {
                assertEquals(await findById(root, "attempt-1", { migrate: false }), before);
                assertEquals(await git(root, ["branch", "--list", "worktree/demo"]), sourceBranch);
                assertEquals(await git(root, ["worktree", "list", "--porcelain"]), worktreeList);
                assertEquals(messages.some((message) => /Cleanup|restored|leftover/i.test(message)), false);
                assertEquals(
                    await Deno.stat(tree).then(() => true).catch(() => false),
                    boundary === "verification_receipt",
                );
                if (lostRegistration) {
                    assertEquals(
                        await Deno.readTextFile(join(tree, "implementation.txt")),
                        "Uncommitted work to keep\n",
                    );
                    assertEquals(await Deno.readTextFile(join(tree, "personal-note.txt")), "Untracked work to keep\n");
                }
                if (targetChange !== "saved_copy_exists") {
                    assertEquals(await Deno.stat(`${tree}.saved`).then(() => true).catch(() => false), false);
                } else {
                    assertEquals(
                        await Deno.readTextFile(join(`${tree}.saved`, "files", "previous.txt")),
                        "Keep previous saved files\n",
                    );
                }
            } else if (targetChange === "saved_copy_exists") {
                assertEquals(await findById(root, "attempt-1", { migrate: false }), before);
                assertEquals(await Deno.readTextFile(join(tree, "personal-note.txt")), "Untracked work to keep\n");
                assertEquals(
                    await Deno.readTextFile(join(`${tree}.saved`, "files", "previous.txt")),
                    "Keep previous saved files\n",
                );
                assertStringIncludes(messages.join("\n"), "Both copies were kept");
            } else if (targetChange === "rewritten" || targetChange === "remote_removed") {
                assertEquals(await findById(root, "attempt-1", { migrate: false }), before);
                assertStringIncludes(messages.join("\n"), "Cleanup stopped for demo");
                assertStringIncludes(
                    messages.join("\n"),
                    targetChange === "rewritten"
                        ? "Published Work Record source cannot be proven on its target"
                        : "Published Work Record upstream is unavailable",
                );
                assertEquals(messages.join("\n").includes("Fix this Git issue"), false);
            } else {
                assertEquals(await findById(root, "attempt-1", { migrate: false }), null);
                assertStringIncludes(messages.join("\n"), "Cleanup is done for demo");
                if (lostRegistration) {
                    const saved = join(`${tree}.saved`, "files");
                    assertStringIncludes(messages.join("\n"), saved);
                    assertEquals(
                        await Deno.readTextFile(join(saved, "implementation.txt")),
                        "Uncommitted work to keep\n",
                    );
                    assertEquals(await Deno.readTextFile(join(saved, "personal-note.txt")), "Untracked work to keep\n");
                    assertEquals(await Deno.stat(tree).then(() => true).catch(() => false), false);
                    assertEquals(await git(root, ["branch", "--list", "worktree/demo"]), "");
                }
            }
            assertEquals(await Deno.readTextFile(primaryPath), primaryBytes);
            assertEquals(await Deno.readTextFile(join(root, "README.md")), "Unsaved user changes\n");
            assertEquals(await git(root, ["rev-parse", "HEAD"]), primaryHead);
            assertEquals(await git(root, ["status", "--porcelain", "--untracked-files=all"]), primaryStatus);
            assertEquals(await git(remote, ["rev-parse", "refs/heads/main"]), expectedTarget);
        } finally {
            runtime.closeAllSessions();
            await git(root, ["worktree", "remove", "--force", tree]).catch(() => {});
            await Deno.remove(root, { recursive: true });
            await Deno.remove(directory, { recursive: true });
        }
    });
}

for (const invocation of ["named", "picker"] as const) {
    for (const boundary of ["verification_receipt", "cleanup_effect", "cleanup_receipt"] as const) {
        Deno.test(`load-plan ${invocation} views a published Plan without cleanup after ${boundary}`, async () => {
            await checkCleanupRestart(boundary, invocation, "unchanged", false);
        });
    }
    for (const target of ["lost_registration", "saved_copy_exists", "rewritten", "remote_removed"] as const) {
        Deno.test(`load-plan ${invocation} opens the menu without cleanup or file movement: ${target}`, async () => {
            await checkCleanupRestart(
                target.startsWith("lost") || target === "saved_copy_exists" ? "verification_receipt" : "cleanup_effect",
                invocation,
                target,
                false,
            );
        });
    }
    Deno.test(`load-plan ${invocation} explicitly requested cleanup preserves leftover files with a missing Git registration`, async () => {
        await checkCleanupRestart("verification_receipt", invocation, "lost_registration");
    });
    Deno.test(`load-plan ${invocation} requested cleanup preserves files when registration and branch are gone`, async () => {
        await checkCleanupRestart("verification_receipt", invocation, "lost_registration_branch_gone");
    });
    Deno.test(`load-plan ${invocation} requested cleanup never overwrites a saved copy`, async () => {
        await checkCleanupRestart("verification_receipt", invocation, "saved_copy_exists");
    });
    for (const boundary of ["cleanup_effect", "cleanup_receipt"] as const) {
        Deno.test(`load-plan ${invocation} requested cleanup after ${boundary} returns to the menu without overwriting primary`, async () => {
            await checkCleanupRestart(boundary, invocation);
        });
        Deno.test(`load-plan ${invocation} requested cleanup after ${boundary} accepts remote advancement`, async () => {
            await checkCleanupRestart(boundary, invocation, "advanced");
        });
    }
    Deno.test(`load-plan ${invocation} requested cleanup preserves the receipt when the target was rewritten`, async () => {
        await checkCleanupRestart("cleanup_effect", invocation, "rewritten");
    });
    Deno.test(`load-plan ${invocation} requested cleanup checks the recorded upstream after configuration changes`, async () => {
        await checkCleanupRestart("cleanup_effect", invocation, "upstream_reconfigured");
    });
    Deno.test(`load-plan ${invocation} requested cleanup keeps publication evidence when only local history is available`, async () => {
        await checkCleanupRestart("cleanup_effect", invocation, "remote_removed");
    });
}
