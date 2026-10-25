import process from "node:process";
import { writeFile as fsWriteFile } from "node:fs/promises";
import { test } from "node:test";
import { assertEquals, assertExists, assertRejects, assertStringIncludes } from "../../testing/assertions.ts";
import { executeWorkflowTestTools } from "../../testing/workflow-agent-tools.ts";
import { withProcessGlobalTestLock } from "../../testing/process-global-lock.ts";
import {
    captureWorktreeTree,
    diffTrees,
    getWorktreeReviewDiff,
    WorktreeReviewComparisonError,
} from "../../shared/workflow/git-snapshot.ts";
import { parseDiffFiles } from "../../shared/workflow/review-diff-tool.js";
import {
    git,
    makeRecordedSession,
    makeUi,
    makeValidationProjectRoot,
    runValidationPhase,
} from "../../shared/workflow/validation-test-helpers.js";
import { WorkspaceSessionContinuationService } from "../workspace/server/session-continuation.js";
import { startCodeReviewSurface } from "./review-launcher.ts";
import { reviewFileContentApi } from "../workspace/routes/api/review-file-handlers.ts";

/** @param {Array<Record<string, string>>} findings */
function reviewerMessages(findings) {
    return /** @type {any} */ ([
        {
            role: "toolResult",
            toolName: "review_diff",
            details: { command: "list", scope: "full", fileCount: 1 },
        },
        {
            role: "toolResult",
            toolName: "review_complete",
            details: {
                outcome: "feedback",
                approved: false,
                feedback: "Missing guard",
                findings,
                advisories: [],
            },
        },
    ]);
}

/** @param {Function} runIsolatedAgentSession */
function reviewPort(runIsolatedAgentSession) {
    return /** @type {any} */ ({
        runIsolatedAgentSession: async (/** @type {any} */ options) => {
            const messages = await runIsolatedAgentSession(options);
            await executeWorkflowTestTools(
                options,
                messages.flatMap((/** @type {any} */ message) => {
                    const call = { name: message.toolName, arguments: message.details || {} };
                    if (call.name !== "review_diff") return [call];
                    const tool = options.customTools.find(
                        (/** @type {any} */ candidate) => candidate.name === "review_diff",
                    );
                    return [
                        call,
                        ...parseDiffFiles(tool.__runwieldReviewDiffs.full).map((file) => ({
                            name: "review_diff",
                            arguments: { command: "show", scope: "full", path: file.path },
                        })),
                    ];
                }),
            );
            return messages;
        },
    });
}

for (const mode of ["local", "remote"]) {
    test(`AI, repair, and both human review surfaces receive the same ${mode} target patch`, () =>
        withProcessGlobalTestLock(async () => {
            const projectRoot = await makeValidationProjectRoot("p", {
                classification: "QUICK_FIX",
                status: "validated_ci",
            });
            const hostedSession = makeRecordedSession("review-consumers-test", makeUi());
            await git(projectRoot, ["init", "-b", "target"]);
            await git(projectRoot, ["config", "user.email", "runwield@example.com"]);
            await git(projectRoot, ["config", "user.name", "RunWield Test"]);
            await fsWriteFile(`${projectRoot}/.gitignore`, "docs/plans/\n");
            await fsWriteFile(`${projectRoot}/shared.md`, "original target\n");
            await git(projectRoot, ["add", "."]);
            await git(projectRoot, ["commit", "-m", "execution baseline"]);
            let baselineTree = await git(projectRoot, ["rev-parse", "HEAD^{tree}"]);
            let expectedBaseTree = baselineTree;
            let targetBaseRef = "refs/heads/target";
            let expectedBefore = "original target\n";
            await git(projectRoot, ["switch", "-c", "execution"]);
            await git(projectRoot, ["switch", "target"]);
            await fsWriteFile(`${projectRoot}/target-only.js`, "export const targetOnly = true;\n");
            await git(projectRoot, ["add", "target-only.js"]);
            await git(projectRoot, ["commit", "-m", "target-only behavior"]);
            await git(projectRoot, ["switch", "execution"]);
            if (mode === "remote") {
                await fsWriteFile(`${projectRoot}/delivered.ts`, "export const delivered = true;\n");
                await fsWriteFile(`${projectRoot}/shared.md`, "published target\n");
                await git(projectRoot, ["add", "delivered.ts", "shared.md"]);
                await git(projectRoot, ["commit", "-m", "previous remote delivery"]);
                expectedBaseTree = await git(projectRoot, ["rev-parse", "HEAD^{tree}"]);
                expectedBefore = "published target\n";
                const remote = `${projectRoot}/.git/review-remote.git`;
                await git(projectRoot, ["clone", "--bare", ".", remote]);
                await git(projectRoot, [
                    "--git-dir",
                    remote,
                    "update-ref",
                    "refs/heads/target",
                    "refs/heads/execution",
                ]);
                await git(projectRoot, ["remote", "add", "origin", remote]);
                await git(projectRoot, ["fetch", "origin"]);
                targetBaseRef = "refs/remotes/origin/target";
                await fsWriteFile(`${projectRoot}/retained.md`, "still proposed from an earlier execution\n");
                await git(projectRoot, ["add", "retained.md"]);
                await git(projectRoot, ["commit", "-m", "retained proposal"]);
                baselineTree = await captureWorktreeTree(projectRoot);
            }
            await fsWriteFile(`${projectRoot}/shared.md`, "current review proposal\n");
            const implementation =
                Array.from({ length: 40 }, (_, index) => `export const planned${index} = true;`).join("\n") + "\n";
            await fsWriteFile(`${projectRoot}/plan-change.js`, implementation);
            hostedSession.setActiveExecutionWorkflow({
                planName: "p",
                triageMeta: { classification: "QUICK_FIX", status: "validated_ci" },
                executionAgent: "engineer",
                projectRoot,
                executionCwd: projectRoot,
                baselineTree,
                executionMode: "worktree",
                worktreeId: "wt-review-consumers",
                worktreeBranch: "execution",
                worktreeBaseBranch: "target",
                worktreeBaseRef: targetBaseRef,
            });
            let aiPatch = "";
            const findings = [{ title: "Missing guard", requirement: "Step 1", evidence: "plan-change.js" }];

            const result = await runValidationPhase({
                hostedSession,
                planName: "p",
                planContent: "# p",
                triageMeta: { classification: "QUICK_FIX", status: "validated_ci" },
                supportsSemanticRepairHandoff: true,
                semanticReviewPort: reviewPort(async (/** @type {any} */ options) => {
                    const tool = options.customTools.find(
                        (/** @type {any} */ candidate) => candidate.name === "review_diff",
                    );
                    const listed = await tool.execute("list-full", { command: "list", scope: "full" });
                    assertStringIncludes(listed.content[0].text, "plan-change.js");
                    const paths = Array.from(
                        String(listed.content[0].text).matchAll(/^\| `([^`]+)` \|/gm),
                        (match) => match[1],
                    );
                    for (const path of paths) {
                        let offsetBytes = 0;
                        for (;;) {
                            const page = await tool.execute(`show-${path}-${offsetBytes}`, {
                                command: "show",
                                scope: "full",
                                path,
                                offsetBytes,
                                maxBytes: 256,
                            });
                            const content = String(page.content[0].text).match(/```diff\n([\s\S]*?)\n```$/)?.[1];
                            assertExists(content);
                            aiPatch += content;
                            if (!page.details.truncated) break;
                            offsetBytes = page.details.nextOffsetBytes;
                        }
                    }
                    return reviewerMessages(findings);
                }),
            });

            assertEquals(result.kind, "semantic_repair_handoff");
            const repairPatch = result.semanticRepairHandoff?.diffText;
            const currentTree = await captureWorktreeTree(projectRoot);
            const expectedPatch = await diffTrees(projectRoot, expectedBaseTree, currentTree);
            assertEquals(await getWorktreeReviewDiff(projectRoot, "target"), expectedPatch);
            const previousDisableBuiltServer = process.env["WLD_WORKSPACE_DISABLE_BUILT_SERVER"];
            process.env["WLD_WORKSPACE_DISABLE_BUILT_SERVER"] = "1";
            const standalone = await startCodeReviewSurface({
                rawPatch: "stale patch",
                gitRef: "target-relative",
                agentCwd: projectRoot,
                targetBranch: "target",
                targetBaseRef,
                browser: { open: () => Promise.resolve(false) },
            });
            let standalonePatch;
            try {
                const html = await (await fetch(standalone.url)).text();
                const embedded =
                    html.match(/<script[^>]*data-code-review-payload[^>]*>([\s\S]*?)<\/script>/)?.[1] || "{}";
                standalonePatch = JSON.parse(embedded).rawPatch;
                const fileUrl = new URL("/api/file-content", standalone.url);
                fileUrl.searchParams.set("path", "shared.md");
                fileUrl.searchParams.set("token", new URL(standalone.url).searchParams.get("token") || "");
                const fileResponse = await (await fetch(fileUrl)).json();
                assertEquals(fileResponse.oldContent, expectedBefore);
                assertEquals(fileResponse.newContent, "current review proposal\n");
                if (mode === "remote") {
                    await git(projectRoot, ["remote", "remove", "origin"]);
                    // The page and before-file route must retain the recorded remote
                    // requirement, rather than silently switching to the stale local target.
                    assertEquals((await fetch(standalone.url)).status, 500);
                    const missingBase = await (await fetch(fileUrl)).json();
                    assertEquals(missingBase.oldContent, null);
                    assertEquals(missingBase.newContent, "current review proposal\n");
                    await git(projectRoot, ["remote", "add", "origin", `${projectRoot}/.git/review-remote.git`]);
                    await git(projectRoot, ["fetch", "origin"]);
                }
            } finally {
                await standalone.stop();
                if (previousDisableBuiltServer === undefined) delete process.env["WLD_WORKSPACE_DISABLE_BUILT_SERVER"];
                else process.env["WLD_WORKSPACE_DISABLE_BUILT_SERVER"] = previousDisableBuiltServer;
            }

            const workspace = new WorkspaceSessionContinuationService({ store: /** @type {any} */ ({}) });
            try {
                workspace.operations.set("operation-review", {
                    status: "running",
                    projectId: "project-1",
                    runwieldSessionId: "session-1",
                    events: [],
                });
                const interaction = workspace
                    .createInteractionAdapter({ operationId: "operation-review" })
                    .requestInteraction({
                        id: "interaction-review",
                        type: "code_review",
                        prompt: "Review the code changes.",
                        _meta: {
                            diffText: "stale patch",
                            planName: "p",
                            executionCwd: projectRoot,
                            targetBranch: "target",
                            targetBaseRef,
                        },
                    });
                const liveReview = await workspace.getLiveCodeReview({
                    projectId: "project-1",
                    runwieldSessionId: "session-1",
                    operationId: "operation-review",
                    interactionId: "interaction-review",
                });
                const workspacePatch = liveReview?.request?.codeReview?.rawPatch;
                const checkout = await workspace.getLiveCodeReviewCheckout({
                    projectId: "project-1",
                    runwieldSessionId: "session-1",
                    operationId: "operation-review",
                    interactionId: "interaction-review",
                });
                assertEquals(checkout, { cwd: projectRoot, targetBranch: "target", targetBaseRef });
                const workspaceFile = await (
                    await reviewFileContentApi(
                        new Request("http://localhost/api/file-content?path=shared.md"),
                        checkout || {},
                    )
                ).json();
                assertEquals(workspaceFile.oldContent, expectedBefore);
                assertEquals(workspaceFile.newContent, "current review proposal\n");
                if (mode === "remote") {
                    await git(projectRoot, ["remote", "remove", "origin"]);
                    await assertRejects(
                        () =>
                            workspace.getLiveCodeReview({
                                projectId: "project-1",
                                runwieldSessionId: "session-1",
                                operationId: "operation-review",
                                interactionId: "interaction-review",
                            }),
                        WorktreeReviewComparisonError,
                    );
                    const missingBase = await (
                        await reviewFileContentApi(
                            new Request("http://localhost/api/file-content?path=shared.md"),
                            checkout || {},
                        )
                    ).json();
                    assertEquals(missingBase.oldContent, null);
                    assertEquals(missingBase.newContent, "current review proposal\n");
                }
                workspace.operations.get("operation-review")?.answer?.resolve({ outcome: "canceled" });
                await interaction;

                assertEquals(aiPatch, expectedPatch);
                assertEquals(repairPatch, expectedPatch);
                assertEquals(standalonePatch, expectedPatch);
                assertEquals(workspacePatch, expectedPatch);
                assertStringIncludes(expectedPatch, "plan-change.js");
                assertEquals(expectedPatch.includes("target-only.js"), false);
                assertStringIncludes(expectedPatch, `-${expectedBefore.trim()}`);
                if (mode === "remote") {
                    assertEquals(expectedPatch.includes("delivered.ts"), false);
                    assertStringIncludes(expectedPatch, "retained.md");
                }
            } finally {
                workspace.close();
            }
        }));
}
