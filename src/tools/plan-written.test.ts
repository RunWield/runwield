import process from "node:process";
import {
    mkdir as fsMkdir,
    mkdtemp as fsMkdtemp,
    readFile as fsReadFile,
    rm as fsRm,
    writeFile as fsWriteFile,
} from "node:fs/promises";
import { test } from "node:test";
import { tmpdir } from "node:os";
import { assertEquals, assertStringIncludes } from "../testing/assertions.ts";
import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { HostedSession } from "../shared/session/hosted-session.js";
import { createPlanWrittenTool } from "./plan-written.ts";
import { join } from "node:path";
import { withRuntimeCommandFixture } from "../cmd/testing/runtime-command-fixture.ts";
import { loadPlan, savePlan } from "../plan-store.js";
import { enterProjectRuntime, resolveProjectRuntimeLayout } from "../shared/project-runtime-layout.ts";
import { defineCommittedGitFixture, git } from "../shared/git-test-fixture.ts";
import { makeManagedSessionFixture } from "../testing/managed-session-fixture.ts";
import { inspectWorktreeRegistry } from "../shared/worktree-registry.js";
import { existsSync } from "node:fs";
import { WORKTREE_REGISTRY_FILE } from "../constants.js";

const LINKED_REVIEW_GIT = defineCommittedGitFixture();

const EXTENSION_CONTEXT = {} as ExtensionToolContext;

test("plan_written recovers old controller files and opens review after migration", async () => {
    await withRuntimeCommandFixture("plan-written-old-runtime-", async ({ projectRoot }) => {
        const sandboxHome = process.env["WLD_TEST_SANDBOX_HOME"];
        delete process.env["WLD_TEST_SANDBOX_HOME"];
        const hostedSession = new HostedSession({ id: "plan-written-recovery", cwd: projectRoot });
        try {
            await savePlan(projectRoot, "demo", "# Demo\n\nKeep the implementation.", {
                planId: "demo",
                classification: "PLANNED_CHANGE",
                status: "approved",
            });
            await enterProjectRuntime(projectRoot);
            const layout = resolveProjectRuntimeLayout(projectRoot);
            const current = await fsReadFile(join(layout.primary.controllerPlansDir, "demo.json"), "utf8");
            const legacyDirectory = join(projectRoot, ".wld", "controller", "plans");
            await fsMkdir(legacyDirectory, { recursive: true });
            await fsWriteFile(join(legacyDirectory, "demo.json"), current);
            await fsWriteFile(join(projectRoot, ".wld", "worktrees.json"), '{"version":2,"entries":[]}');
            await fsMkdir(join(projectRoot, ".wld", "plan-locks"), { recursive: true });
            let reviews = 0;
            hostedSession.setInteractionAdapter({
                requestInteraction: async (request) => {
                    assertEquals(request.type, "plan_review");
                    reviews++;
                    const plan = await loadPlan(projectRoot, "demo");
                    return {
                        outcome: "accepted",
                        _meta: { approved: true, approvalAction: "later", revision: plan?.revision },
                    };
                },
            });
            const result = await createPlanWrittenTool({ hostedSession }).execute(
                "review-after-migration",
                { planName: "demo" },
                undefined,
                undefined,
                EXTENSION_CONTEXT,
            );
            assertEquals(reviews, 1, resultText(result));
            assertEquals((await loadPlan(projectRoot, "demo"))?.attrs.status, "ready_for_work", resultText(result));
            assertEquals((result.details as { outcome: string }).outcome, "saved");
        } finally {
            hostedSession.dispose();
            if (sandboxHome === undefined) delete process.env["WLD_TEST_SANDBOX_HOME"];
            else process.env["WLD_TEST_SANDBOX_HOME"] = sandboxHome;
        }
    });
});

function resultText(result: { content: Array<{ type: string; text?: string }> }): string {
    const item = result.content[0];
    return item?.type === "text" ? item.text || "" : "";
}

test("plan_written rejects the reserved Epic Artifact name before review", async () => {
    const cwd = await fsMkdtemp(join(tmpdir(), "plan-written-artifact-"));
    try {
        const hostedSession = new HostedSession({ id: "plan-written-artifact", cwd });
        const tool = createPlanWrittenTool({ hostedSession });

        const result = await tool.execute(
            "call",
            {
                planName: "epic/manual-qa",
            },
            undefined,
            undefined,
            EXTENSION_CONTEXT,
        );

        const details = result.details as { outcome?: string; reason?: string } | null;
        assertEquals(details?.outcome, "repair_required");
        assertEquals(details?.reason, "reserved_epic_artifact");
        assertStringIncludes(resultText(result), "reserved for an Epic Artifact");
    } finally {
        await fsRm(cwd, { recursive: true });
    }
});

test("direct Plan retains explicit verification through skipped Init, reload, and deliberate changes", async () => {
    await withRuntimeCommandFixture("plan-command-", async ({ projectRoot }) => {
        const { getExactProjectCustomSetting, setExactProjectCustomSetting } = await import("../shared/settings.js");
        const { runLocalCI } = await import("../shared/workflow/validation-local-ci.ts");
        const session = new HostedSession({ id: "plan-command", cwd: projectRoot });
        try {
            await savePlan(projectRoot, "demo", "# Demo", { classification: "PLANNED_CHANGE", status: "draft" });
            session.setInteractionAdapter({
                requestInteraction: (request) => {
                    assertEquals(request.type, "plan_review");
                    return Promise.resolve({ outcome: "canceled" });
                },
            });
            const tool = createPlanWrittenTool({ hostedSession: session });
            const submit = (command: string, intent: "discovered" | "user_selected") =>
                tool.execute(
                    crypto.randomUUID(),
                    {
                        planName: "demo",
                        executionAgent: "engineer",
                        collaborationRecommendation: "autonomous",
                        verificationCommand: { command, intent },
                    },
                    undefined,
                    undefined,
                    EXTENSION_CONTEXT,
                );
            const command =
                process.platform === "win32"
                    ? `  (echo whole suite-ok) && (exit /b 0)  `
                    : `  CHECK='whole suite' sh -c 'printf "%s" "$CHECK"' && printf '%s' '-ok'  `;
            await submit(command, "user_selected");
            assertEquals(getExactProjectCustomSetting("verification_command", projectRoot), command);
            const reloaded = new HostedSession({ id: "command-reloaded", cwd: projectRoot });
            reloaded.setInteractionAdapter({
                requestInteraction: () => Promise.reject(new Error("must not ask again")),
            });
            try {
                const result = await runLocalCI({
                    hostedSession: reloaded,
                    cwd: projectRoot,
                    settingsPolicy: "exact-project",
                });
                assertEquals(result.kind, "completed");
                if (result.kind === "completed") {
                    assertEquals(result.exitCode, 0);
                    assertStringIncludes(result.output, "whole suite-ok");
                }
                const escapedSpace = process.platform === "win32" ? "echo verify^ " : "printf '%s' verify\\ ";
                await submit(escapedSpace, "user_selected");
                assertEquals(getExactProjectCustomSetting("verification_command", projectRoot), escapedSpace);
                const escapedResult = await runLocalCI({
                    hostedSession: reloaded,
                    cwd: projectRoot,
                    settingsPolicy: "exact-project",
                });
                if (escapedResult.kind !== "completed") throw new Error("Expected command to run");
                assertStringIncludes(escapedResult.output, "verify ");
                setExactProjectCustomSetting("verification_command", "printf repaired", projectRoot);
                await submit("printf discovered", "discovered");
                assertEquals(getExactProjectCustomSetting("verification_command", projectRoot), "printf repaired");
                await submit("printf replacement", "user_selected");
                assertEquals(getExactProjectCustomSetting("verification_command", projectRoot), "printf replacement");
            } finally {
                reloaded.dispose();
            }
        } finally {
            session.dispose();
        }
    });
});

test("plan_written returns a conversation outcome and the reply-or-revise rule without changing the Plan", async () => {
    await withRuntimeCommandFixture("plan-written-conversation-", async ({ projectRoot }) => {
        await savePlan(projectRoot, "target", "# Target\n\n## Context\n\nKeep this scope.\n", {
            classification: "PLANNED_CHANGE",
            status: "ready_for_work",
            affectedPaths: [],
            executionAgent: "engineer",
            collaborationRecommendation: "autonomous",
        });
        const { ensurePlanIdentity } = await import("../plan-store.js");
        const before = await ensurePlanIdentity(projectRoot, "target");
        const session = new HostedSession({ id: crypto.randomUUID(), cwd: projectRoot });
        try {
            session.setInteractionAdapter({
                requestInteraction: () => ({
                    outcome: "selected",
                    _meta: {
                        approved: false,
                        conversationTurn: true,
                        feedback: "Why this scope?",
                    },
                }),
            });
            const result = await createPlanWrittenTool({ hostedSession: session }).execute(
                "conversation",
                { planName: "target" },
                undefined,
                undefined,
                EXTENSION_CONTEXT,
            );
            assertEquals((result.details as { outcome: string }).outcome, "conversation");
            assertStringIncludes(resultText(result), "Why this scope?");
            assertStringIncludes(resultText(result), "Reply in chat");
            assertStringIncludes(resultText(result), "scope, behavior, a decision, or verification");
            assertStringIncludes(resultText(result), "When in doubt, revise.");
            assertStringIncludes(resultText(result), "do not call plan_written for an unchanged Plan");
            assertEquals(await fsReadFile(before.path, "utf8"), before.markdown);
            assertEquals((await loadPlan(projectRoot, "target"))?.attrs.status, "ready_for_work");
        } finally {
            await session.dispose();
        }
    });
});

test("plan_written reviews a Plan that exists only in an unregistered linked checkout", async () => {
    await withRuntimeCommandFixture("plan-written-linked-", async ({ homeDir, alternateRoot }) => {
        const primary = await LINKED_REVIEW_GIT.checkout();
        const linked = join(alternateRoot, "linked");
        await git(primary, ["worktree", "add", "-b", "linked-review", linked]);
        const fixture = await makeManagedSessionFixture({ home: homeDir, projectRoot: linked });
        const handle = fixture.openRuntime("test", "linked-review-writer");
        try {
            await savePlan(linked, "linked-only", "# Linked only\n\nReview the selected checkout.\n", {
                planId: "linked-only-id",
                classification: "PLANNED_CHANGE",
                status: "approved",
                executionAgent: "engineer",
                collaborationRecommendation: "autonomous",
                affectedPaths: [],
            });
            const plan = await loadPlan(linked, "linked-only");
            if (!plan) throw new Error("Linked Plan missing");
            assertEquals(existsSync(join(primary, "docs", "plans")), false);
            assertEquals((await inspectWorktreeRegistry(linked)).entries, []);
            const primaryHead = await git(primary, ["rev-parse", "HEAD"]);
            const primaryStatus = await git(primary, ["status", "--porcelain"]);
            let reviewed = false;
            handle.runtime.setInteractionAdapter(handle.adoptedSessionId, {
                requestInteraction: (request) => {
                    if (request.type !== "plan_review") return { outcome: "canceled" };
                    assertEquals(request._meta?.planId, "linked-only-id");
                    assertEquals(request._meta?.planPath, plan.path);
                    assertEquals(request._meta?.expectedRevision, plan.revision);
                    assertEquals(request._meta?.reviewedSource, {
                        planName: "linked-only",
                        path: plan.path,
                        markdown: plan.markdown,
                        revision: plan.revision,
                        attrs: plan.attrs,
                    });
                    assertEquals(request._meta?.expectedWorktree, { kind: "none" });
                    reviewed = true;
                    return {
                        outcome: "accepted",
                        _meta: { approved: true, approvalAction: "later", revision: plan.revision },
                    };
                },
            });
            const result = await handle.runtime.reviewSavedPlan(handle.adoptedSessionId, "linked-only-id");
            assertEquals(reviewed, true, JSON.stringify(result));
            assertEquals(result.kind, "saved");
            assertEquals(
                handle.runtime.getSessionSnapshot(handle.adoptedSessionId)?.workflowContext?.canReopenPlanReview,
                true,
            );
            const reference = fixture.store.getLastPlanReview(
                fixture.session.runwieldSessionId,
                fixture.project.projectId,
            );
            assertEquals(reference?.planId, "linked-only-id");
            assertEquals(reference?.planName, "linked-only");
            assertEquals(reference?.planningAgentName, "planner");
            assertEquals((await loadPlan(linked, "linked-only"))?.attrs.status, "ready_for_work");
            assertEquals(existsSync(join(primary, "docs", "plans")), false);
            assertEquals(await git(primary, ["rev-parse", "HEAD"]), primaryHead);
            assertEquals(await git(primary, ["status", "--porcelain"]), primaryStatus);
            assertEquals((await inspectWorktreeRegistry(primary)).entries, []);
            assertEquals((await inspectWorktreeRegistry(linked)).entries, []);
            const layout = resolveProjectRuntimeLayout(linked);
            assertEquals(
                layout.primary.worktreeRegistryPath,
                resolveProjectRuntimeLayout(primary).primary.worktreeRegistryPath,
            );
            assertEquals(existsSync(join(layout.selected.internalRoot, WORKTREE_REGISTRY_FILE)), false);
        } finally {
            await handle.close();
            await fixture.cleanup();
            await fsRm(primary, { recursive: true, force: true });
        }
    });
});
