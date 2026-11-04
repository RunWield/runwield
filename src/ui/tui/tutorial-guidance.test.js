import { createUiApiFixture } from "./ui-api-test-fixture.ts";
import { withSessionViewFixture } from "./testing/session-view-fixture.ts";
import { test } from "node:test";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { resolveProjectRuntimeLayout } from "../../shared/project-runtime-layout.ts";
import { assertEquals, assertStringIncludes } from "../../testing/assertions.ts";
import { withRuntimeCommandFixture } from "../../cmd/testing/runtime-command-fixture.ts";
import { createSessionRuntime } from "../../shared/session/session-runtime.ts";
import { savePlan } from "../../plan-store.js";
import { writeControllerState } from "../../shared/workflow/controller-registry.ts";
import { RuntimeEventTypes } from "../../shared/session/session-runtime-events.js";
import { getTutorialExplanation, presentTutorialEvent, restoreVerifiedTutorialRecap } from "./tutorial-guidance.ts";
import { setCustomSetting } from "../../shared/settings.js";
import { INIT_VERIFICATION_COMMAND_PLACEHOLDER } from "../../tools/init-verification-command.ts";

/** @param {string[]} messages */
function tutorialView(messages) {
    const view = createUiApiFixture();
    const append = view.uiAPI.appendSystemMessage.bind(view.uiAPI);
    view.uiAPI.appendSystemMessage = (text, error, header) => {
        messages.push(`${header || ""}: ${text}`);
        return append(text, error, header);
    };
    const prompt = view.uiAPI.promptSelect.bind(view.uiAPI);
    view.uiAPI.promptSelect = (...args) => {
        const result = prompt(...args);
        view.terminal.pressEnter();
        return result;
    };
    return view;
}

/** @param {Parameters<Parameters<typeof withSessionViewFixture>[0]>[0]} fixture */
async function startTutorial(fixture) {
    await fixture.runtime.promptUserTurn(fixture.sessionId, {
        initialRequest: "Start tutorial",
        agentName: "planner",
        initialTutorialContext: {
            version: 1,
            guidanceEnabled: true,
            shownExplanationIds: ["choose-improvement", "implementation", "ai-review"],
            recapShown: false,
            planId: null,
        },
    });
}

/** @type {import("../../shared/session/session-runtime-events.js").RuntimeValidationCheckResults} */
const CHECKS = { ci: "passed", semanticReview: "passed", humanReview: "skipped", merge: "passed" };

/** @typedef {{ shownExplanationIds?: string[], recapShown?: boolean }} TutorialUpdate */

test("tutorial verified recap requires exact verified status", async () => {
    await withRuntimeCommandFixture("tutorial-manual-status-", async ({ projectRoot, setModelResponse }) => {
        setModelResponse("Choose a small change.");
        for (const status of /** @type {const} */ (["implemented", "user_verified", "closed_without_verification"])) {
            const planId = `${status}-plan-id`;
            const planName = `${status}-plan`;
            await savePlan(projectRoot, planName, `# ${planName}\n`, {
                planId,
                status,
                classification: "PLANNED_CHANGE",
                complexity: "LOW",
            });
            await writeControllerState(
                projectRoot,
                { planId, planName },
                {
                    verifiedAt: "2026-01-01T00:00:00.000Z",
                    deliveryEvidence: { version: 1, mode: "non_git_in_place" },
                },
            );

            const runtime = createSessionRuntime();
            const created = await runtime.createInteractiveSession({ cwd: projectRoot, mode: "new" });
            /** @type {string[]} */
            const messages = [];
            try {
                await runtime.promptUserTurn(created.sessionId, {
                    initialRequest: "Start tutorial",
                    initialImages: [],
                    agentName: "planner",
                    initialTutorialContext: {
                        version: 1,
                        guidanceEnabled: true,
                        shownExplanationIds: ["choose-improvement"],
                        recapShown: false,
                        planId: null,
                    },
                });
                await runtime.recordPlanAssociation(created.sessionId, {
                    planId,
                    planName,
                    purpose: "planning",
                });
                await runtime.updateTutorialContext(created.sessionId, { planId });
                const view = tutorialView(messages);
                try {
                    await presentTutorialEvent({
                        runtime,
                        sessionId: created.sessionId,
                        uiAPI: view.uiAPI,
                        event: /** @type {any} */ ({ type: RuntimeEventTypes.BUSY_CHANGED, busy: false }),
                    });
                } finally {
                    view.close();
                }
                assertEquals(messages, [], `${status} must not produce a verified recap`);
                assertEquals(runtime.getSessionSnapshot(created.sessionId)?.tutorialContext?.recapShown, false);
            } finally {
                await runtime.closeAllSessionsWhenIdle();
            }
        }
    });
});

test("tutorial guidance persists deduplication and requires an associated Plan for verified recap", async () => {
    await withRuntimeCommandFixture("tutorial-guidance-", async ({ projectRoot, setModelResponse }) => {
        setModelResponse("Choose a small change.");
        const runtime = createSessionRuntime();
        const created = await runtime.createInteractiveSession({ cwd: projectRoot, mode: "new" });
        const sessionId = created.sessionId;
        /** @type {string[]} */
        const messages = [];
        const view = tutorialView(messages);
        const uiAPI = view.uiAPI;
        try {
            await runtime.promptUserTurn(sessionId, {
                initialRequest: "Start tutorial",
                initialImages: [],
                agentName: "planner",
                initialTutorialContext: {
                    version: 1,
                    guidanceEnabled: true,
                    shownExplanationIds: ["choose-improvement"],
                    recapShown: false,
                    planId: null,
                },
            });
            const reviewEvent = /** @type {any} */ ({
                type: RuntimeEventTypes.INTERACTION_REQUESTED,
                interactionType: "plan_review",
            });
            await presentTutorialEvent({ runtime, sessionId, uiAPI, event: reviewEvent });
            await presentTutorialEvent({ runtime, sessionId, uiAPI, event: reviewEvent });
            assertEquals(messages.length, 1);
            assertEquals(runtime.getSessionSnapshot(sessionId)?.tutorialContext?.shownExplanationIds, [
                "choose-improvement",
                "plan-review",
            ]);

            const verifiedEvent = /** @type {any} */ ({
                type: RuntimeEventTypes.SYSTEM_STATUS,
                validationProgress: { stage: "terminal", outcome: "verified", checks: CHECKS },
            });
            await presentTutorialEvent({ runtime, sessionId, uiAPI, event: verifiedEvent });
            assertEquals(messages.length, 1, "verified recap needs committed Plan identity");

            assertEquals(
                (
                    await runtime.recordPlanAssociation(sessionId, {
                        planId: "plan-1",
                        planName: "small-change",
                        purpose: "planning",
                    })
                ).ok,
                true,
            );
            assertEquals((await runtime.updateTutorialContext(sessionId, { planId: "plan-1" })).ok, true);
            await presentTutorialEvent({ runtime, sessionId, uiAPI, event: verifiedEvent });

            assertEquals(messages.length, 1, "an association alone does not prove the active workflow was published");
            assertEquals(runtime.getSessionSnapshot(sessionId)?.tutorialContext?.recapShown, false);
        } finally {
            view.close();
            await runtime.closeAllSessionsWhenIdle();
        }
    });
});

test("completed tutorial recap restores after reload without changing saved progress and requires current proof", async () => {
    await withRuntimeCommandFixture("tutorial-recap-reload-", async ({ projectRoot, setModelResponse }) => {
        setModelResponse("Choose a small change.");
        const runtime = createSessionRuntime();
        const restarted = createSessionRuntime();
        const planId = "reloaded-tutorial-plan";
        const planName = "tutorial-change";
        await savePlan(projectRoot, planName, "# Delivered tutorial change\n", {
            planId,
            status: "verified",
            classification: "PLANNED_CHANGE",
        });
        await writeControllerState(
            projectRoot,
            { planId, planName },
            {
                verifiedAt: "2026-01-01T00:00:00.000Z",
                deliveryEvidence: { version: 1, mode: "non_git_in_place" },
            },
        );
        /** @type {string[]} */
        const messages = [];
        const view = tutorialView(messages);
        const uiAPI = view.uiAPI;
        try {
            const created = await runtime.createInteractiveSession({ cwd: projectRoot, mode: "new" });
            await runtime.promptUserTurn(created.sessionId, {
                initialRequest: "Start tutorial",
                agentName: "planner",
                initialTutorialContext: {
                    version: 1,
                    guidanceEnabled: true,
                    shownExplanationIds: ["choose-improvement"],
                    recapShown: false,
                    planId: null,
                },
            });
            await runtime.recordPlanAssociation(created.sessionId, { planId, planName, purpose: "execution" });
            await runtime.updateTutorialContext(created.sessionId, { planId });
            const idle = /** @type {any} */ ({ type: RuntimeEventTypes.BUSY_CHANGED, busy: false });
            await presentTutorialEvent({ runtime, sessionId: created.sessionId, uiAPI, event: idle });
            assertEquals(messages.length, 1);
            const saved = runtime.getSessionSnapshot(created.sessionId);
            assertEquals(saved?.tutorialContext?.recapShown, true);
            const savedContext = structuredClone(saved?.tutorialContext);
            const savedGeneration = saved?.managed?.generation;
            const managed = saved?.managed;
            await runtime.closeAllSessionsWhenIdle();
            const loaded = await restarted.createInteractiveSession({
                cwd: projectRoot,
                mode: "continue",
                resumeSessionId: managed?.runwieldSessionId || "",
            });
            messages.length = 0;
            await restarted.replaySession(loaded.sessionId);
            await restoreVerifiedTutorialRecap({ runtime: restarted, sessionId: loaded.sessionId, uiAPI });
            assertEquals(messages.length, 1);
            assertStringIncludes(messages[0], "Tutorial complete");
            assertStringIncludes(messages[0], "Plan:");
            assertStringIncludes(messages[0], "tutorial-change.md");
            await presentTutorialEvent({ runtime: restarted, sessionId: loaded.sessionId, uiAPI, event: idle });
            assertEquals(messages.length, 1, "Ordinary idle events must not repeat the restored recap.");
            const restored = restarted.getSessionSnapshot(loaded.sessionId);
            assertEquals(restored?.tutorialContext, savedContext);
            assertEquals(restored?.managed?.generation, savedGeneration);

            await writeControllerState(projectRoot, { planId, planName }, { verifiedAt: null, deliveryEvidence: null });
            messages.length = 0;
            await restarted.replaySession(loaded.sessionId);
            await restoreVerifiedTutorialRecap({ runtime: restarted, sessionId: loaded.sessionId, uiAPI });
            assertEquals(messages, [], "A persisted completion flag alone must not restore an unproven recap.");
            assertEquals(restarted.getSessionSnapshot(loaded.sessionId)?.tutorialContext, savedContext);
            // A legacy document hint is pending authority, not permission to import it for a recap.
            const planPath = join(projectRoot, "docs/plans", `${planName}.md`);
            const legacyMarkdown = (await readFile(planPath, "utf8")).replace(
                "---\n",
                "---\nverifiedAt: 2026-01-01T00:00:00.000Z\n",
            );
            await writeFile(planPath, legacyMarkdown);
            const internalRoot = resolveProjectRuntimeLayout(projectRoot).primary.internalRoot;
            const paths = await readdir(internalRoot, { recursive: true, withFileTypes: true });
            const files = paths.filter((entry) => entry.isFile()).map((entry) => join(entry.parentPath, entry.name));
            const beforeFiles = await Promise.all(files.map((path) => readFile(path, "base64")));
            for (let repeat = 0; repeat < 2; repeat++) {
                await restoreVerifiedTutorialRecap({ runtime: restarted, sessionId: loaded.sessionId, uiAPI });
                assertEquals(messages, []);
            }
            await new Promise((resolve) => setTimeout(resolve, 20));
            assertEquals(await readFile(planPath, "utf8"), legacyMarkdown);
            assertEquals(await Promise.all(files.map((path) => readFile(path, "base64"))), beforeFiles);
            assertEquals(
                (await readdir(internalRoot, { recursive: true })).sort(),
                paths.map((entry) => join(entry.parentPath, entry.name).slice(internalRoot.length + 1)).sort(),
            );
        } finally {
            view.close();
            await runtime.closeAllSessionsWhenIdle();
            await restarted.closeAllSessionsWhenIdle();
        }
    });
});

test("verified tutorial recap links a registered QA artifact from its real Session", async () => {
    await withSessionViewFixture(async (fixture) => {
        const { projectRoot, runtime, sessionId, store } = fixture;
        await startTutorial(fixture);
        const planId = "verified-plan-id",
            planName = "verified-plan";
        await savePlan(projectRoot, planName, "# Verified Plan\n", {
            planId,
            status: "verified",
            classification: "PLANNED_CHANGE",
        });
        await writeControllerState(
            projectRoot,
            { planId, planName },
            { verifiedAt: "2026-01-01T00:00:00.000Z", deliveryEvidence: { version: 1, mode: "non_git_in_place" } },
        );
        await runtime.recordPlanAssociation(sessionId, { planId, planName, purpose: "execution" });
        await runtime.updateTutorialContext(sessionId, { planId });
        const managed = runtime.getSessionSnapshot(sessionId)?.managed;
        if (!managed) throw new Error("Missing managed tutorial Session");
        const proof = store.acquireSessionActivation({
            runwieldSessionId: managed.runwieldSessionId,
            projectId: managed.projectId,
            ownerInstanceId: "tutorial-artifacts",
            ownerProcessKind: "test",
        });
        try {
            store.registerSessionArtifact(proof, {
                kind: "report",
                path: "docs/reports/manual-qa.md",
                title: "Manual QA report",
                registeredBy: "Engineer",
            });
        } finally {
            store.releaseUnchangedActivation(proof);
        }
        await runtime.synchronizeManagedSession(sessionId);
        const view = createUiApiFixture();
        try {
            await presentTutorialEvent({
                runtime,
                sessionId,
                uiAPI: view.uiAPI,
                event: {
                    type: RuntimeEventTypes.BUSY_CHANGED,
                    busy: false,
                    sessionId,
                    timestamp: new Date().toISOString(),
                },
            });
            assertStringIncludes(view.allText(), "Review/QA Artifact: docs/reports/manual-qa.md");
            assertEquals(runtime.getSessionSnapshot(sessionId)?.tutorialContext?.recapShown, true);
        } finally {
            view.close();
        }
    });
});

test("tutorial does not label repeated implementation as AI repair and discloses placeholder checks", async () => {
    await withSessionViewFixture(async (fixture) => {
        const { projectRoot, runtime, sessionId } = fixture;
        await startTutorial(fixture);
        await runtime.recordPlanAssociation(sessionId, { planId: "plan-1", planName: "plan", purpose: "recovery" });
        await runtime.updateTutorialContext(sessionId, { planId: "plan-1" });
        await setCustomSetting("verification_command", INIT_VERIFICATION_COMMAND_PLACEHOLDER, "project", projectRoot);
        const view = createUiApiFixture();
        try {
            await presentTutorialEvent({
                runtime,
                sessionId,
                uiAPI: view.uiAPI,
                event: {
                    type: RuntimeEventTypes.AGENT_CHANGED,
                    messageId: "repair-agent",
                    sessionId,
                    timestamp: new Date().toISOString(),
                    agentName: "plan-engineer",
                    rootHandoff: true,
                },
            });
            assertEquals(view.allText().trim(), "");
            assertEquals(
                runtime.getSessionSnapshot(sessionId)?.tutorialContext?.shownExplanationIds.includes("ai-repair"),
                false,
            );
            await presentTutorialEvent({
                runtime,
                sessionId,
                uiAPI: view.uiAPI,
                event: {
                    type: RuntimeEventTypes.SYSTEM_STATUS,
                    messageId: "project-checks",
                    sessionId,
                    timestamp: new Date().toISOString(),
                    message: "Checking project",
                    level: "info",
                    validationProgress: {
                        kind: "workflow",
                        stage: "ci",
                        outcome: "running",
                        cycle: 1,
                        maxCycles: 3,
                        totalCycle: 1,
                        checks: CHECKS,
                    },
                },
            });
            assertStringIncludes(view.allText(), "placeholder command, not real test coverage");
            assertEquals(
                runtime.getSessionSnapshot(sessionId)?.tutorialContext?.shownExplanationIds.includes("project-checks"),
                true,
            );
        } finally {
            view.close();
        }
    });
});
