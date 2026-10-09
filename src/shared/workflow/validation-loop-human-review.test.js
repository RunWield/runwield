import { assertEquals, assertStrictEquals, assertStringIncludes } from "@std/assert";

import { executeWorkflowTestTools } from "../../testing/workflow-agent-tools.ts";
import { loadPlan, savePlan } from "../../plan-store.js";
import { HostedSession } from "../session/hosted-session.js";
import {
    attachRecorder,
    git,
    makeRecordedSession,
    makeUi,
    makeValidationProjectRoot,
    NO_ISOLATED_AGENT_PORT,
    runValidationLoop,
    runValidationPhase,
} from "./validation-test-helpers.js";

function makeValidationUi() {
    const uiAPI = makeUi();
    return { uiAPI, hostedSession: makeRecordedSession("validation-human-review-test", uiAPI) };
}

/** @param {HostedSession} hostedSession @param {(request: any) => Promise<any>} requestInteraction */
function setInteraction(hostedSession, requestInteraction) {
    hostedSession.setInteractionAdapter({ requestInteraction });
}

Deno.test("human Code Review metadata uses the Plan heading as the review title", async () => {
    const projectRoot = await Deno.makeTempDir({ prefix: "runwield-human-review-title-" });
    await savePlan(projectRoot, "filename-fallback", "# Readable Plan Title\n\nBody.", {
        classification: "QUICK_FIX",
        status: "reviewed",
        humanReviewMode: "always",
        humanReviewDecision: null,
    });
    const { hostedSession } = makeValidationUi();
    hostedSession.setActiveExecutionWorkflow({
        planName: "filename-fallback",
        triageMeta: { classification: "QUICK_FIX", status: "reviewed", humanReviewMode: "always" },
        executionAgent: "engineer",
        projectRoot,
        executionCwd: projectRoot,
        nonGitInPlace: true,
    });
    let planTitle = "";
    setInteraction(hostedSession, (request) => {
        planTitle = request._meta?.planTitle || "";
        return Promise.resolve({ outcome: "selected", _meta: { approved: true, feedback: "" } });
    });

    await runValidationPhase({
        hostedSession,
        planName: "filename-fallback",
        planContent: "# stale caller body",
        triageMeta: { classification: "QUICK_FIX", status: "reviewed", humanReviewMode: "always" },
        semanticReviewPort: NO_ISOLATED_AGENT_PORT,
    });

    assertEquals(planTitle, "Readable Plan Title");
});

Deno.test("human Code Review metadata falls back to the Plan filename when no title heading exists", async () => {
    const projectRoot = await Deno.makeTempDir({ prefix: "runwield-human-review-title-" });
    await savePlan(projectRoot, "filename-fallback", "## Ignored Section\n\n#\n", {
        classification: "QUICK_FIX",
        status: "reviewed",
        humanReviewMode: "always",
        humanReviewDecision: null,
    });
    const { hostedSession } = makeValidationUi();
    hostedSession.setActiveExecutionWorkflow({
        planName: "filename-fallback",
        triageMeta: { classification: "QUICK_FIX", status: "reviewed", humanReviewMode: "always" },
        executionAgent: "engineer",
        projectRoot,
        executionCwd: projectRoot,
        nonGitInPlace: true,
    });
    let planTitle = "";
    setInteraction(hostedSession, (request) => {
        planTitle = request._meta?.planTitle || "";
        return Promise.resolve({ outcome: "selected", _meta: { approved: true, feedback: "" } });
    });

    await runValidationPhase({
        hostedSession,
        planName: "filename-fallback",
        planContent: "# stale caller body",
        triageMeta: { classification: "QUICK_FIX", status: "reviewed", humanReviewMode: "always" },
        semanticReviewPort: NO_ISOLATED_AGENT_PORT,
    });

    assertEquals(planTitle, "filename-fallback");
});

Deno.test("runValidationLoop runs always human review after semantic approval and before merge", async () => {
    const projectRoot = await makeValidationProjectRoot("p", {
        classification: "QUICK_FIX",
        status: "reviewed",
        humanReviewMode: "always",
        humanReviewDecision: null,
    });
    const { hostedSession } = makeValidationUi();
    hostedSession.setActiveExecutionWorkflow({
        planName: "p",
        triageMeta: { classification: "QUICK_FIX", status: "reviewed", humanReviewMode: "always" },
        executionAgent: "engineer",
        projectRoot,
        executionCwd: projectRoot,
        nonGitInPlace: true,
    });
    const requests = /** @type {string[]} */ ([]);
    setInteraction(hostedSession, (request) => {
        requests.push(request.type);
        return Promise.resolve({ outcome: "selected", _meta: { approved: true, feedback: "" } });
    });

    const result = await runValidationPhase({
        hostedSession,
        planName: "p",
        planContent: "# p",
        triageMeta: { classification: "QUICK_FIX", status: "reviewed", humanReviewMode: "always" },
        semanticReviewPort: NO_ISOLATED_AGENT_PORT,
    });

    const plan = await loadPlan(projectRoot, "p");
    assertEquals(result.kind, "paused");
    assertEquals(requests, ["code_review"]);
    assertEquals(plan?.attrs.status, "reviewed");
    assertEquals(plan?.attrs.humanReviewMode, "always");
    assertEquals(plan?.attrs.humanReviewDecision, "approved");
});

Deno.test("runValidationLoop ask mode can skip human review and merge", async () => {
    const projectRoot = await makeValidationProjectRoot("p", {
        classification: "QUICK_FIX",
        status: "reviewed",
        humanReviewMode: "ask",
        humanReviewDecision: null,
    });
    const { hostedSession, uiAPI } = makeValidationUi();
    hostedSession.setActiveExecutionWorkflow({
        planName: "p",
        triageMeta: { classification: "QUICK_FIX", status: "reviewed", humanReviewMode: "ask" },
        executionAgent: "engineer",
        projectRoot,
        executionCwd: projectRoot,
        nonGitInPlace: true,
    });
    setInteraction(hostedSession, (request) => {
        assertEquals(request._meta?.presentation, "code_review_offer");
        return Promise.resolve({ outcome: "selected", value: "skip" });
    });

    const result = await runValidationPhase({
        hostedSession,
        planName: "p",
        planContent: "# p",
        triageMeta: { classification: "QUICK_FIX", status: "reviewed", humanReviewMode: "ask" },
        semanticReviewPort: NO_ISOLATED_AGENT_PORT,
    });

    const plan = await loadPlan(projectRoot, "p");
    assertEquals(result.kind, "paused");
    assertEquals(plan?.attrs.status, "reviewed");
    assertEquals(plan?.attrs.humanReviewDecision, "skipped");
    assertEquals(uiAPI.messages.filter((/** @type {string} */ message) => message === "Code Review skipped").length, 1);
    assertEquals(uiAPI.messages.some((/** @type {string} */ message) => message.includes("You approved")), false);
});

Deno.test("runValidationLoop ask mode opens code review before merge when approved", async () => {
    const projectRoot = await makeValidationProjectRoot("p", {
        classification: "QUICK_FIX",
        status: "reviewed",
        humanReviewMode: "ask",
        humanReviewDecision: null,
    });
    const { hostedSession } = makeValidationUi();
    hostedSession.setActiveExecutionWorkflow({
        planName: "p",
        triageMeta: { classification: "QUICK_FIX", status: "reviewed", humanReviewMode: "ask" },
        executionAgent: "engineer",
        projectRoot,
        executionCwd: projectRoot,
        nonGitInPlace: true,
    });
    let calls = 0;
    setInteraction(hostedSession, (request) => {
        calls += 1;
        if (request.type === "select") return Promise.resolve({ outcome: "selected", value: "open" });
        return Promise.resolve({ outcome: "selected", _meta: { approved: true, feedback: "" } });
    });

    const result = await runValidationPhase({
        hostedSession,
        planName: "p",
        planContent: "# p",
        triageMeta: { classification: "QUICK_FIX", status: "reviewed", humanReviewMode: "ask" },
        semanticReviewPort: NO_ISOLATED_AGENT_PORT,
    });

    const plan = await loadPlan(projectRoot, "p");
    assertEquals(result.kind, "paused");
    assertEquals(calls, 2);
    assertEquals(plan?.attrs.humanReviewMode, "ask");
    assertEquals(plan?.attrs.humanReviewDecision, "approved");
});

Deno.test("runValidationLoop resumes at reviewed and records durable human-review metadata before publication", async () => {
    const projectRoot = await makeValidationProjectRoot("p", {
        classification: "QUICK_FIX",
        status: "reviewed",
        humanReviewMode: "none",
        humanReviewDecision: null,
    });
    const { hostedSession } = makeValidationUi();
    hostedSession.setActiveExecutionWorkflow({
        planName: "p",
        triageMeta: {
            classification: "QUICK_FIX",
            status: "reviewed",
            humanReviewMode: "none",
            humanReviewDecision: null,
        },
        executionAgent: "engineer",
        projectRoot,
        executionCwd: projectRoot,
        nonGitInPlace: true,
    });

    const result = await runValidationPhase({
        hostedSession,
        planName: "p",
        planContent: "# p",
        triageMeta: {
            classification: "QUICK_FIX",
            status: "reviewed",
            humanReviewMode: "none",
            humanReviewDecision: null,
        },
        semanticReviewPort: NO_ISOLATED_AGENT_PORT,
    });

    const plan = await loadPlan(projectRoot, "p");
    assertEquals(result.kind, "paused");
    assertEquals(plan?.attrs.status, "reviewed");
    assertEquals(plan?.attrs.humanReviewMode, "none");
    assertEquals(plan?.attrs.humanReviewDecision, "not_required");
});

/** @param {Record<string, unknown>} [extra] */
async function makeAwaitingReview(extra = {}) {
    const projectRoot = await makeValidationProjectRoot("p", {
        classification: "QUICK_FIX",
        status: "reviewed",
        humanReviewMode: "always",
        humanReviewDecision: null,
        ...extra,
    });
    // A real repository, because the review phase computes a real diff. Faking that
    // would fake the thing the user is being shown.
    await git(projectRoot, ["init", "-b", "main"]);
    await git(projectRoot, ["config", "user.email", "runwield@example.com"]);
    await git(projectRoot, ["config", "user.name", "RunWield Test"]);
    await git(projectRoot, ["add", "."]);
    await git(projectRoot, ["commit", "-m", "plan"]);
    // The session's own cwd is the project, not the repository this suite runs in:
    // once a phase clears the active workflow, later phases fall back to it, and a
    // multi-phase run would otherwise start reading the developer's own checkout.
    const uiAPI = makeUi();
    const hostedSession = attachRecorder(
        new HostedSession({ id: "validation-human-review-test", cwd: projectRoot }),
        uiAPI,
    );
    hostedSession.setActiveExecutionWorkflow({
        planName: "p",
        triageMeta: { classification: "QUICK_FIX", status: "reviewed", humanReviewMode: "always" },
        executionAgent: "engineer",
        projectRoot,
        executionCwd: projectRoot,
        nonGitInPlace: true,
    });
    return { projectRoot, hostedSession, uiAPI };
}

/** @param {import("./validation-session-adapter.ts").IsolatedAgentSessionOptions} options */
async function completedRepairMessages(options) {
    await executeWorkflowTestTools(options, [{
        name: "task_completed",
        arguments: { message: "- Renamed the helper." },
    }]);
    return [];
}

Deno.test("a code review closed with no answer asks instead of throwing the work back to the start", async () => {
    const { projectRoot, hostedSession, uiAPI } = await makeAwaitingReview();
    setInteraction(hostedSession, (request) => {
        if (request.type === "select") {
            uiAPI.promptSelections.push(String(request.prompt));
            return Promise.resolve({ outcome: "selected", value: "stop" });
        }
        return Promise.resolve({ outcome: "canceled" });
    });

    const result = await runValidationPhase({
        hostedSession,
        planName: "p",
        planContent: "# p",
        triageMeta: { classification: "QUICK_FIX", status: "reviewed", humanReviewMode: "always" },
        semanticReviewPort: NO_ISOLATED_AGENT_PORT,
    });

    assertEquals(uiAPI.promptSelections.length, 1);
    assertStringIncludes(uiAPI.promptSelections[0], "without approving it");
    assertEquals(result.kind, "paused");
    assertStringIncludes(result.reason || "", "without approving it");
    // The approved semantic review and passing tests survive: the Plan is still one
    // approval away from publishing, not back at the beginning.
    assertEquals((await loadPlan(projectRoot, "p"))?.attrs.status, "reviewed");
});

Deno.test("Retry reopens the code review that was closed without an answer", async () => {
    const { projectRoot, hostedSession, uiAPI } = await makeAwaitingReview();
    let opened = 0;
    setInteraction(hostedSession, (request) => {
        if (request.type === "select") {
            uiAPI.promptSelections.push(String(request.prompt));
            return Promise.resolve({ outcome: "selected", value: "retry" });
        }
        opened += 1;
        return Promise.resolve(
            opened === 1 ? { outcome: "canceled" } : { outcome: "selected", _meta: { approved: true, feedback: "" } },
        );
    });

    const result = await runValidationPhase({
        hostedSession,
        planName: "p",
        planContent: "# p",
        triageMeta: { classification: "QUICK_FIX", status: "reviewed", humanReviewMode: "always" },
        semanticReviewPort: NO_ISOLATED_AGENT_PORT,
    });

    assertEquals(opened, 2, "Retry must open the same review again in this run");
    assertEquals(uiAPI.promptSelections.length, 1);
    assertEquals(result.kind, "paused");
    assertEquals((await loadPlan(projectRoot, "p"))?.attrs.humanReviewDecision, "approved");
});

Deno.test("Code Review chat repairs rerun CI before reopening the fresh diff", async () => {
    const { projectRoot, hostedSession } = await makeAwaitingReview();
    const sourcePath = `${projectRoot}/review-chat.ts`;
    await Deno.writeTextFile(sourcePath, "export const label = 'base';\n");
    await git(projectRoot, ["add", "review-chat.ts"]);
    await git(projectRoot, ["commit", "-m", "review chat fixture"]);
    const baselineTree = await git(projectRoot, ["rev-parse", "HEAD"]);
    await Deno.writeTextFile(sourcePath, "export const label = 'first';\n");
    hostedSession.setActiveExecutionWorkflow({
        planName: "p",
        triageMeta: { classification: "QUICK_FIX", status: "reviewed", humanReviewMode: "always" },
        executionAgent: "engineer",
        projectRoot,
        executionCwd: projectRoot,
        executionMode: "worktree",
        baselineTree,
        worktreeId: "review-chat-worktree",
        worktreeBranch: "review-chat-branch",
        worktreeBaseBranch: "main",
    });

    /** @type {string[]} */
    const patches = [];
    /** @type {string[]} */
    const targetBranches = [];
    /** @type {any[]} */
    const conversations = [];
    let reviewRound = 0;
    setInteraction(hostedSession, (request) => {
        if (request.type !== "code_review") return Promise.resolve({ outcome: "canceled" });
        reviewRound += 1;
        patches.push(String(request._meta?.diffText || ""));
        targetBranches.push(String(request._meta?.targetBranch || ""));
        conversations.push(request._meta?.reviewConversation);
        if (reviewRound === 1) {
            return Promise.resolve({
                outcome: "selected",
                _meta: {
                    approved: false,
                    feedback: "Rename the exported label.",
                    annotations: [],
                    conversationTurn: true,
                },
            });
        }
        return Promise.resolve({ outcome: "canceled" });
    });

    let ciRuns = 0;
    const result = await runValidationLoop({
        localCI: {
            run: () => {
                ciRuns += 1;
                return Promise.resolve({ kind: "completed", exitCode: 0, output: "ok" });
            },
        },
        hostedSession,
        planName: "p",
        planContent: "# p",
        triageMeta: { classification: "QUICK_FIX", status: "reviewed", humanReviewMode: "always" },
        semanticReviewPort: {
            runIsolatedAgentSession: async (options) => {
                await Deno.writeTextFile(sourcePath, "export const label = 'second';\n");
                return await completedRepairMessages(options);
            },
        },
    });

    assertEquals(reviewRound, 2);
    assertEquals(targetBranches, ["main", "main"]);
    assertStringIncludes(patches[0], "+export const label = 'first';");
    assertStringIncludes(patches[1], "+export const label = 'second';");
    assertEquals(ciRuns, 1);
    assertStrictEquals(conversations[1], conversations[0]);
    assertEquals(conversations[1].events.length, 1);
    assertEquals(conversations[1].events[0].type, "assistant_text_delta");
    assertEquals(result.kind, "paused");
    assertEquals((await loadPlan(projectRoot, "p"))?.attrs.humanReviewDecision, "changes_requested");
});

Deno.test("human code-review annotations are not duplicated in the engineer repair request", async () => {
    const { hostedSession } = await makeAwaitingReview();
    let capturedRequest = "";
    setInteraction(hostedSession, (request) => {
        if (request.type !== "code_review") return Promise.resolve({ outcome: "canceled" });
        return Promise.resolve({
            outcome: "selected",
            _meta: {
                approved: false,
                feedback: "# Code Review Feedback\n\n## General\n\nUse the existing keybinding machinery.",
                annotations: [{ text: "Use the existing keybinding machinery." }],
            },
        });
    });

    await runValidationPhase({
        hostedSession,
        planName: "p",
        planContent: "# p",
        triageMeta: { classification: "QUICK_FIX", status: "reviewed", humanReviewMode: "always" },
        semanticReviewPort: {
            runIsolatedAgentSession: (request) => {
                capturedRequest = String(request.userRequest || "");
                return completedRepairMessages(request);
            },
        },
    });

    assertEquals(capturedRequest.match(/Use the existing keybinding machinery\./g)?.length, 1);
});

Deno.test("your feedback goes to the engineer, then the tests, then straight back to you", async () => {
    const { projectRoot, hostedSession } = await makeAwaitingReview();
    /** @type {string[]} */
    const opened = [];
    let reviews = 0;
    let isolatedRuns = 0;
    setInteraction(hostedSession, (request) => {
        opened.push(String(request.type));
        if (request.type !== "code_review") return Promise.resolve({ outcome: "canceled" });
        reviews += 1;
        return Promise.resolve(
            reviews === 1
                ? { outcome: "selected", _meta: { approved: false, feedback: "rename the helper" } }
                : { outcome: "selected", _meta: { approved: true, feedback: "" } },
        );
    });

    // Round one: read the diff, ask for a change. Round two: approve the repair.
    const result = await runValidationLoop({
        hostedSession,
        planName: "p",
        planContent: "# p",
        triageMeta: { classification: "QUICK_FIX", status: "reviewed", humanReviewMode: "always" },
        semanticReviewPort: {
            runIsolatedAgentSession: (request) => {
                isolatedRuns += 1;
                return completedRepairMessages(request);
            },
        },
        localCI: {
            run: () => Promise.resolve({ kind: "completed", exitCode: 0, output: "ok" }),
        },
    });

    // Two code reviews and nothing else: the Semantic Code Reviewer never ran a
    // second time, and the "ask" gate never reappeared between rounds.
    assertEquals(opened, ["code_review", "code_review"]);
    // Exactly one isolated Agent run: the repair. A second would be the Semantic Code
    // Reviewer sweeping a diff the user had already taken ownership of.
    assertEquals(isolatedRuns, 1);
    assertEquals(result.kind, "verified");
    const plan = await loadPlan(projectRoot, "p");
    assertEquals(plan?.attrs.status, "verified");
    assertEquals(plan?.attrs.humanReviewDecision, "approved");
});

Deno.test("asking for changes makes you the reviewer, so the reviewer agent stands down", async () => {
    const projectRoot = await makeValidationProjectRoot("p", {
        classification: "QUICK_FIX",
        status: "validated_ci",
        humanReviewMode: "always",
        humanReviewDecision: "changes_requested",
    });
    const { hostedSession } = makeValidationUi();
    hostedSession.setActiveExecutionWorkflow({
        planName: "p",
        triageMeta: { classification: "QUICK_FIX", status: "validated_ci", humanReviewMode: "always" },
        executionAgent: "engineer",
        projectRoot,
        executionCwd: projectRoot,
        executionMode: "worktree",
    });
    let reviewerRuns = 0;

    const result = await runValidationPhase({
        hostedSession,
        planName: "p",
        planContent: "# p",
        triageMeta: {
            classification: "QUICK_FIX",
            status: "validated_ci",
            humanReviewMode: "always",
            humanReviewDecision: "changes_requested",
        },
        semanticReviewPort: {
            runIsolatedAgentSession: () => {
                reviewerRuns += 1;
                return Promise.resolve([]);
            },
        },
    });

    assertEquals(reviewerRuns, 0, "the Semantic Code Reviewer must not sweep a diff the user already owns");
    assertEquals(result.kind, "paused");
    assertStringIncludes(result.reason || "", "Reopening your code review");
    assertEquals((await loadPlan(projectRoot, "p"))?.attrs.status, "reviewed");
});

Deno.test("an unconfigured Plan offers human review and cancellation pauses before delivery", async () => {
    const projectRoot = await makeValidationProjectRoot("default-review", {
        classification: "QUICK_FIX",
        status: "reviewed",
    });
    const { hostedSession } = makeValidationUi();
    hostedSession.setActiveExecutionWorkflow({
        planName: "default-review",
        triageMeta: { classification: "QUICK_FIX", status: "reviewed" },
        executionAgent: "engineer",
        projectRoot,
        executionCwd: projectRoot,
        nonGitInPlace: true,
    });
    /** @type {import("../session/session-runtime-interactions.js").RuntimeInteractionRequest[]} */
    const requests = [];
    setInteraction(hostedSession, (request) => {
        requests.push(request);
        return Promise.resolve({ outcome: "canceled" });
    });
    const result = await runValidationPhase({
        hostedSession,
        planName: "default-review",
        planContent: "# Default",
        triageMeta: { classification: "QUICK_FIX", status: "reviewed" },
        semanticReviewPort: NO_ISOLATED_AGENT_PORT,
    });
    assertEquals(result.kind, "paused");
    assertEquals(requests.length, 1);
    assertEquals(requests[0].type, "select");
    assertEquals(requests[0].options?.map((option) => option.value), ["open", "skip", "close"]);
    assertEquals((await loadPlan(projectRoot, "default-review"))?.attrs.status, "reviewed");
});

for (const answer of [{ outcome: "canceled" }, { outcome: "selected", value: "close" }]) {
    Deno.test(`Code Review offer ${answer.value || answer.outcome} stays pending without a skipped or approved outcome`, async () => {
        const projectRoot = await makeValidationProjectRoot("p", {
            classification: "QUICK_FIX",
            status: "validated_reviewer",
            humanReviewMode: "ask",
            humanReviewDecision: null,
        });
        const { hostedSession, uiAPI } = makeValidationUi();
        hostedSession.setActiveExecutionWorkflow({
            planName: "p",
            triageMeta: { classification: "QUICK_FIX", status: "reviewed", humanReviewMode: "ask" },
            executionAgent: "engineer",
            projectRoot,
            executionCwd: projectRoot,
            nonGitInPlace: true,
        });
        setInteraction(hostedSession, () => Promise.resolve(answer));
        const result = await runValidationPhase({
            hostedSession,
            planName: "p",
            planContent: "# p",
            triageMeta: { classification: "QUICK_FIX", status: "reviewed", humanReviewMode: "ask" },
            semanticReviewPort: NO_ISOLATED_AGENT_PORT,
        });
        assertEquals(result.kind, "paused");
        assertEquals((await loadPlan(projectRoot, "p"))?.attrs.humanReviewDecision, null);
        assertEquals(
            uiAPI.messages.some((/** @type {string} */ message) =>
                message.includes("Code Review skipped") || message.includes("You approved")
            ),
            false,
        );
    });
}
