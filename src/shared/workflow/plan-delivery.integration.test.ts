import { join } from "node:path";
import { getCwd } from "../../constants.js";
import process from "node:process";
import { readFile as fsReadFile, rm as fsRm, stat as fsStat, writeFile as fsWriteFile } from "node:fs/promises";
import { test } from "node:test";
import { ok as assert } from "node:assert/strict";
import { assertEquals, assertStringIncludes } from "../../testing/assertions.ts";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { withRuntimeCommandFixture } from "../../cmd/testing/runtime-command-fixture.ts";
import { archivePlan, loadPlan, savePlan, updatePlanFrontMatter } from "../../plan-store.js";
import { defineCommittedGitFixture, git } from "../git-test-fixture.ts";
import { HostedSession } from "../session/hosted-session.js";
import { setCustomSetting } from "../settings.js";
import { createGitPort } from "../git-port.ts";
import { listEntries } from "../worktree-registry.js";
import { createWorkRecordMnemotecaFixture } from "../work-records/test-fixtures/mnemoteca-port.ts";
import { loadPublishedWorkRecordSource } from "../work-records/published-source.ts";
import { executeWorkflowTestTools } from "../../testing/workflow-agent-tools.ts";
import { executePlan } from "./plan-executor.ts";
import { runWorkflowValidationToStableBoundary } from "./validation.ts";
import { verifyRecordedPublication } from "./validation-merge-verification.ts";
import { inspectControllerView } from "./controller-registry.ts";
import { resolveWorkflowPlanLocation } from "./plan-location.ts";

const repo = defineCommittedGitFixture();

for (const autoMerge of [false, true]) {
    test(`standalone delivery (${autoMerge ? "on" : "off"}) uses the default branch and survives a setting toggle`, async () => {
        await withRuntimeCommandFixture("plan-delivery-", async ({ setModelMessages }) => {
            const originalCwd = getCwd();
            const root = await repo.checkout();
            process.chdir(root);
            const hostedSession = new HostedSession({ id: crypto.randomUUID(), cwd: root });
            const sessionManager = SessionManager.inMemory(root);
            hostedSession.setRootSessionManager(sessionManager);
            try {
                // Main is the default, but execution is requested from an unrelated checkout.
                await fsWriteFile(`${root}/unrelated.txt`, "original\n");
                await git(root, ["add", "unrelated.txt"]);
                await git(root, ["commit", "-m", "Unrelated source file"]);
                const mainBefore = await git(root, ["rev-parse", "main"]);
                await git(root, ["switch", "-c", "scratch"]);
                await git(root, ["commit", "--allow-empty", "-m", "Scratch-only commit"]);
                const primaryHead = await git(root, ["rev-parse", "HEAD"]);
                await setCustomSetting("codereview", "none", "project", root);
                await setCustomSetting("plans", { autoMergeIntoTargetBranch: autoMerge }, "project", root);
                await savePlan(root, "Full Delivery Name", "# Full Delivery Name\n\nImplement the fixture.\n", {
                    planId: "standalone-delivery",
                    classification: "PLANNED_CHANGE",
                    status: "ready_for_work",
                    executionAgent: "engineer",
                    affectedPaths: ["implemented.txt"],
                    humanReviewMode: "none",
                });
                setModelMessages([
                    fauxAssistantMessage(fauxToolCall("write", { path: "implemented.txt", content: "delivered\n" })),
                    fauxAssistantMessage(fauxToolCall("task_completed", { message: "Implemented the fixture." })),
                ]);
                const execution = await executePlan({
                    planName: "Full Delivery Name",
                    hostedSession,
                    sessionManager,
                    triageMeta: { classification: "PLANNED_CHANGE" },
                });
                assertEquals(execution.executionComplete, true, JSON.stringify(execution));
                const cwd = execution.executionContext?.executionCwd;
                assert(cwd);
                const landing = autoMerge ? "main" : "plan/full-delivery-name";
                assertEquals((await listEntries(root))[0].baseBranch, landing);
                const plan = await loadPlan(cwd, "Full Delivery Name");
                assert(plan);
                assertEquals(plan.attrs.targetBranch, "main");
                assertEquals(plan.attrs.deliveryBranch, landing);
                assertStringIncludes(
                    await fsReadFile(`${root}/docs/plans/Full Delivery Name.md`, "utf8"),
                    `deliveryBranch: "${landing}"`,
                );
                if (autoMerge) {
                    assertEquals(await git(root, ["branch", "--list", "plan/full-delivery-name"]), "");
                }
                // The original primary Plan is untracked, and primary user work is dirty.
                // Edit the primary body after execution starts. Publication must not replace it.
                const primaryPath = join(root, "docs", "plans", "Full Delivery Name.md");
                await fsWriteFile(primaryPath, (await fsReadFile(primaryPath, "utf8")) + "\nNewer user notes.\n");
                const primaryPlan = await fsReadFile(primaryPath, "utf8");
                await fsWriteFile(`${root}/unrelated.txt`, "user changes must survive\n");
                await setCustomSetting("plans", { autoMergeIntoTargetBranch: !autoMerge }, "project", root);
                // A target edit cannot redirect a recorded delivery attempt.
                await updatePlanFrontMatter(cwd, "Full Delivery Name", { targetBranch: "scratch" }, plan.attrs, {
                    expectedRevision: plan.revision,
                });
                setModelMessages([
                    fauxAssistantMessage(
                        fauxToolCall("manual_qa_completed", {
                            checklistMarkdown:
                                "Manual verification steps for Full Delivery Name\n\n- [ ] Read the delivered file.",
                        }),
                    ),
                    fauxAssistantMessage(
                        fauxToolCall("work_record_completed", {
                            title: "Standalone Delivery",
                            summary: "Delivered the fixture to its recorded landing branch.",
                        }),
                    ),
                ]);
                const validation = await runWorkflowValidationToStableBoundary({
                    hostedSession,
                    planName: "Full Delivery Name",
                    planContent: plan.markdown,
                    triageMeta: plan.attrs,
                    git: createGitPort(),
                    localCI: { run: () => Promise.resolve({ kind: "completed", exitCode: 0, output: "passed" }) },
                    semanticReviewPort: {
                        runIsolatedAgentSession: async (options) => {
                            await executeWorkflowTestTools(options, [
                                {
                                    name: "review_diff",
                                    arguments: { command: "show", path: ".gitignore", scope: "full" },
                                },
                                {
                                    name: "review_diff",
                                    arguments: { command: "show", path: ".wld/settings.json", scope: "full" },
                                },
                                {
                                    name: "review_diff",
                                    arguments: { command: "show", path: "implemented.txt", scope: "full" },
                                },
                                {
                                    name: "review_diff",
                                    arguments: {
                                        command: "show",
                                        path: "docs/plans/Full Delivery Name.md",
                                        scope: "full",
                                    },
                                },
                                {
                                    name: "review_complete",
                                    arguments: { approved: true, findings: [], advisories: [] },
                                },
                            ]);
                            return [];
                        },
                    },
                    workRecordMnemotecaPort: createWorkRecordMnemotecaFixture(),
                });
                assertEquals(validation.kind, "verified", JSON.stringify(validation));
                assertEquals(await git(root, ["rev-parse", "HEAD"]), primaryHead);
                assertEquals(await fsReadFile(`${root}/unrelated.txt`, "utf8"), "user changes must survive\n");
                assertEquals(await fsReadFile(`${root}/docs/plans/Full Delivery Name.md`, "utf8"), primaryPlan);
                assertEquals(await git(root, ["show", `${landing}:implemented.txt`]), "delivered");
                if (!autoMerge) assertEquals(await git(root, ["rev-parse", "main"]), mainBefore);
                assertEquals(
                    await fsStat(cwd)
                        .then(() => true)
                        .catch(() => false),
                    false,
                );
                assertEquals(await listEntries(root), []);
                const delivered = await loadPublishedWorkRecordSource(root, "Full Delivery Name");
                assert(delivered);
                assertEquals(delivered.attrs.status, "verified");
                assertEquals(delivered.attrs.targetBranch, "scratch");
                assertEquals(delivered.attrs.deliveryBranch, landing);
                assertEquals(
                    delivered.attrs.workRecord?.status,
                    "generated",
                    JSON.stringify(delivered.attrs.workRecord),
                );
                assertStringIncludes(
                    await git(root, ["show", `${landing}:docs/plans/Full Delivery Name.md`]),
                    'status: "verified"',
                );
                assertEquals(
                    (
                        await verifyRecordedPublication(root, delivered.attrs, {
                            planName: "Full Delivery Name",
                            markdown: delivered.markdown,
                        })
                    ).published,
                    true,
                );
                const evidence = await inspectControllerView(
                    root,
                    {
                        planId: "standalone-delivery",
                        planName: "Full Delivery Name",
                    },
                    {},
                );
                assertEquals(evidence.state.publicationReceipt?.targetBranch, landing);
                const location = await resolveWorkflowPlanLocation(root, "Full Delivery Name", { readOnly: true });
                assertEquals(location.plan?.attrs.deliveryBranch, landing);
                assertEquals(location.plan?.path, primaryPath);
                assertEquals(location.plan?.markdown, primaryPlan);
                assertEquals(location.plan?.attrs.status, "verified");
                assert(location.plan);
                await updatePlanFrontMatter(
                    root,
                    "Full Delivery Name",
                    { status: "user_verified" },
                    location.plan.attrs,
                    {
                        expectedRevision: location.plan.revision,
                    },
                );
                const reloaded = await resolveWorkflowPlanLocation(root, "Full Delivery Name");
                assertEquals(reloaded.plan?.attrs.status, "user_verified");
                assertStringIncludes(reloaded.plan?.body || "", "Newer user notes.");
                const archived = await archivePlan(root, "Full Delivery Name");
                assertEquals(archived.attrs.status, "user_verified");
                assertStringIncludes(await fsReadFile(archived.toPath, "utf8"), "Newer user notes.");
            } finally {
                hostedSession.dispose();
                process.chdir(originalCwd);
                await fsRm(root, { recursive: true });
            }
        });
    });
}
