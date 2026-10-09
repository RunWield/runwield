import { assertEquals, assertExists, assertStringIncludes } from "@std/assert";
import { executeWorkflowTestTools } from "../../testing/workflow-agent-tools.ts";
import { withProcessGlobalTestLock } from "../../testing/process-global-lock.ts";
import { captureWorktreeTree, diffTrees, getWorktreeReviewDiff } from "../../shared/workflow/git-snapshot.ts";
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

/** @param {Array<Record<string, string>>} findings */
function reviewerMessages(findings) {
    return /** @type {any} */ ([{
        role: "toolResult",
        toolName: "review_diff",
        details: { command: "list", scope: "full", fileCount: 1 },
    }, {
        role: "toolResult",
        toolName: "review_complete",
        details: {
            outcome: "feedback",
            approved: false,
            feedback: "Missing guard",
            findings,
            advisories: [],
        },
    }]);
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

Deno.test("AI, repair, and both human review surfaces receive the same patch", () =>
    withProcessGlobalTestLock(async () => {
        const projectRoot = await makeValidationProjectRoot("p", {
            classification: "QUICK_FIX",
            status: "validated_ci",
        });
        const hostedSession = makeRecordedSession("review-consumers-test", makeUi());
        await git(projectRoot, ["init", "-b", "target"]);
        await git(projectRoot, ["config", "user.email", "runwield@example.com"]);
        await git(projectRoot, ["config", "user.name", "RunWield Test"]);
        await Deno.writeTextFile(`${projectRoot}/.gitignore`, "docs/plans/\n");
        await git(projectRoot, ["add", "."]);
        await git(projectRoot, ["commit", "-m", "execution baseline"]);
        const baselineTree = await git(projectRoot, ["rev-parse", "HEAD^{tree}"]);
        await git(projectRoot, ["switch", "-c", "execution"]);
        await git(projectRoot, ["switch", "target"]);
        await Deno.writeTextFile(`${projectRoot}/target-only.js`, "export const targetOnly = true;\n");
        await git(projectRoot, ["add", "target-only.js"]);
        await git(projectRoot, ["commit", "-m", "target-only behavior"]);
        await git(projectRoot, ["switch", "execution"]);
        const implementation = Array.from(
            { length: 40 },
            (_, index) => `export const planned${index} = true;`,
        ).join("\n") + "\n";
        await Deno.writeTextFile(`${projectRoot}/plan-change.js`, implementation);
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
        });
        let aiPatch = "";
        const findings = [{ title: "Missing guard", requirement: "Step 1", evidence: "plan-change.js" }];

        const result = await runValidationPhase({
            hostedSession,
            planName: "p",
            planContent: "# p",
            triageMeta: { classification: "QUICK_FIX", status: "validated_ci" },
            supportsSemanticRepairHandoff: true,
            semanticReviewPort: reviewPort(
                async (/** @type {any} */ options) => {
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
                },
            ),
        });

        assertEquals(result.kind, "semantic_repair_handoff");
        const repairPatch = result.semanticRepairHandoff?.diffText;
        const currentTree = await captureWorktreeTree(projectRoot);
        const expectedPatch = await diffTrees(projectRoot, baselineTree, currentTree);
        assertEquals(await getWorktreeReviewDiff(projectRoot, "target"), expectedPatch);
        const previousDisableBuiltServer = Deno.env.get("WLD_WORKSPACE_DISABLE_BUILT_SERVER");
        Deno.env.set("WLD_WORKSPACE_DISABLE_BUILT_SERVER", "1");
        const standalone = await startCodeReviewSurface({
            rawPatch: "stale patch",
            gitRef: "target-relative",
            agentCwd: projectRoot,
            targetBranch: "target",
            browser: { open: () => Promise.resolve(false) },
        });
        let standalonePatch;
        try {
            const html = await (await fetch(standalone.url)).text();
            const embedded = html.match(/<script[^>]*data-code-review-payload[^>]*>([\s\S]*?)<\/script>/)?.[1] ||
                "{}";
            standalonePatch = JSON.parse(embedded).rawPatch;
        } finally {
            await standalone.stop();
            if (previousDisableBuiltServer === undefined) Deno.env.delete("WLD_WORKSPACE_DISABLE_BUILT_SERVER");
            else Deno.env.set("WLD_WORKSPACE_DISABLE_BUILT_SERVER", previousDisableBuiltServer);
        }

        const workspace = new WorkspaceSessionContinuationService({ store: /** @type {any} */ ({}) });
        try {
            workspace.operations.set("operation-review", {
                status: "running",
                projectId: "project-1",
                runwieldSessionId: "session-1",
                events: [],
            });
            const interaction = workspace.createInteractionAdapter({ operationId: "operation-review" })
                .requestInteraction({
                    id: "interaction-review",
                    type: "code_review",
                    prompt: "Review the code changes.",
                    _meta: {
                        diffText: "stale patch",
                        planName: "p",
                        executionCwd: projectRoot,
                        targetBranch: "target",
                    },
                });
            const liveReview = await workspace.getLiveCodeReview({
                projectId: "project-1",
                runwieldSessionId: "session-1",
                operationId: "operation-review",
                interactionId: "interaction-review",
            });
            const workspacePatch = liveReview?.request?.codeReview?.rawPatch;
            workspace.operations.get("operation-review")?.answer?.resolve({ outcome: "canceled" });
            await interaction;

            assertEquals(aiPatch, expectedPatch);
            assertEquals(repairPatch, expectedPatch);
            assertEquals(standalonePatch, expectedPatch);
            assertEquals(workspacePatch, expectedPatch);
            assertStringIncludes(expectedPatch, "plan-change.js");
            assertEquals(expectedPatch.includes("target-only.js"), false);
        } finally {
            workspace.close();
        }
    }));
