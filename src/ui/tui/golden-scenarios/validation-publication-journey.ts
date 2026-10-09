import { assert, assertEquals } from "@std/assert";

const planName = "validation-publication-journey";
const deliveredPath = "feature.txt";

interface CheckoutState {
    head: string;
    branch: string;
    status: string;
    files: Record<string, string | null>;
}

interface PublishedState {
    primaryHead: string;
    primaryBranch: string;
    primaryStatus: string;
    primaryFiles: Record<string, string | null>;
    remoteHead: string;
    remotePlanStatus: string;
    remotePlanAttrs?: { validatedCommit?: string };
    remoteTree: string;
    deliveredText: string;
    registryEntries: Array<{ id: string }>;
    worktreeBranchExists: boolean;
    remainingExecutionWorktrees: string[];
    registeredWorktrees: string[];
    executionCommitsPublished: boolean[];
    validatedCommitPublished: boolean;
}

interface JourneyState {
    publicationBaseline: CheckoutState;
    publication: PublishedState;
    validationCiRuns: Array<{ output: string; isError: boolean }>;
}

interface JourneyResult {
    state: JourneyState;
    actor: { consumed: string[]; remaining: string[] };
    events: string[];
    screenText: string;
    scrollbackText?: string;
}

/**
 * The fixture stops at implemented. From the first keypress onward only the real
 * TUI, validation controller, tools, and Git publication may change project state.
 * Model responses are the external boundary; they do not call workflow helpers.
 */
export const validationPublicationJourneyScenario = {
    // This scenario isolates automated delivery; human policy gates have dedicated journeys.
    globalSettings: { defaultProvider: "golden", defaultModel: "faux", codereview: "none" },
    name: planName,
    composedTui: true,
    initialAgentName: "guide",
    terminal: { columns: 120, rows: 35 },
    timeoutMs: 180000,
    committedProjectFiles: [
        {
            path: ".wld/settings.json",
            text: JSON.stringify({ verification_command: "sh verify.sh" }),
        },
        {
            path: "verify.sh",
            // Unlike `true`, this fails for the original/conflicted implementation.
            // Its output lets the assertion prove CI actually executed the fixture.
            text: "#!/bin/sh\nset -eu\ntest \"$(cat feature.txt)\" = 'implemented'\necho JOURNEY_CI_PASSED\n",
        },
        { path: deliveredPath, text: "original\n" },
        { path: "user-work.txt", text: "committed user work\n" },
        {
            path: `docs/plans/${planName}.md`,
            text: `---
classification: PLANNED_CHANGE
complexity: LOW
status: ready_for_work
planId: validation-publication-journey-plan
targetBranch: main
---
# Validation through publication

Replace the original feature with the implemented feature.
`,
        },
    ],
    // No scriptedInteractions: select validation through the actual TUI menu.
    script: [
        {
            id: "reviewer-reads-implementation",
            agent: "reviewer",
            phase: "semantic_review",
            ordinal: 1,
            toolCalls: [
                { name: "review_diff", arguments: { command: "list" } },
                { name: "review_diff", arguments: { command: "show", path: deliveredPath } },
                { name: "review_diff", arguments: { command: "show", path: `docs/plans/${planName}.md` } },
            ],
        },
        {
            id: "reviewer-approves-implementation",
            agent: "reviewer",
            phase: "semantic_review",
            ordinal: 2,
            toolCalls: [{
                name: "review_complete",
                arguments: { approved: true, feedback: "Implementation matches." },
            }],
        },
        {
            id: "engineer-stages-conflict-resolution",
            agent: "engineer",
            phase: "engineer",
            ordinal: 1,
            toolCalls: [{
                name: "bash",
                arguments: {
                    command:
                        "git rev-parse --verify MERGE_HEAD && git diff --name-only --diff-filter=U | grep -Fx feature.txt && printf 'implemented\\n' > feature.txt && git add feature.txt && sh verify.sh",
                },
            }],
        },
        {
            id: "engineer-reports-staged-repair",
            agent: "engineer",
            phase: "engineer",
            ordinal: 2,
            toolCalls: [{
                name: "task_completed",
                arguments: { message: "Resolved and staged feature.txt; verification passed. Merge not committed." },
            }],
        },
    ],
    actions: [
        // Setup only: an implemented attempt and a concurrent upstream edit.
        // No validated status, review receipt, publication attempt, or merge is seeded.
        {
            type: "seedActiveWorktree",
            planName,
            status: "implemented",
            attrs: { humanReviewMode: "none", humanReviewDecision: "not_required" },
            files: [{ path: deliveredPath, text: "implemented\n" }],
        },
        { type: "advancePlanRemoteTarget", planName, path: deliveredPath, text: "upstream edit\n" },
        { type: "writeProjectFile", path: "user-work.txt", text: "unsaved user work\n" },
        { type: "writeProjectFile", path: "untracked-note.txt", text: "keep this note\n" },
        {
            type: "capturePublicationBaseline",
            paths: ["user-work.txt", "untracked-note.txt", `docs/plans/${planName}.md`],
        },
        { type: "type", text: `/load-plan ${planName}` },
        { type: "enter" },
        { type: "waitForScreen", text: "Plan recovery (implemented)", timeoutMs: 30000 },
        { type: "type", text: "Retry Workflow Validation" },
        { type: "enter" },
        // Observation only from here. No retries, resets, status writes, or Git fixes.
        { type: "waitForRemotePlanStatus", planName, statuses: ["verified"], timeoutMs: 90000 },
        { type: "waitForWorktreeRegistryStatus", planName, statuses: ["absent"], timeoutMs: 30000 },
        { type: "waitForIdle", timeoutMs: 30000 },
        { type: "capturePublicationState", planName, deliveredPath },
    ],
    assertions: [
        (result: JourneyResult) => {
            const baseline = result.state.publicationBaseline;
            const published = result.state.publication;
            assert(baseline);
            assert(published);
            assertEquals(published.primaryHead, baseline.head);
            assertEquals(published.primaryBranch, baseline.branch);
            assertEquals(published.primaryStatus, baseline.status);
            assertEquals(published.primaryFiles, baseline.files);
            assertEquals(published.remotePlanStatus, "verified");
            assert(/^[a-f0-9]{40,64}$/i.test(published.remotePlanAttrs?.validatedCommit || ""));
            assertEquals(
                published.validatedCommitPublished,
                true,
                "The persisted stamp must name a commit on the remote target.",
            );
            assertEquals(published.deliveredText, "implemented");
            assert(published.remoteHead !== baseline.head);
            assert(published.remoteTree.includes("docs/work-records/"));
            assertEquals(published.registryEntries, []);
            assertEquals(published.worktreeBranchExists, false);
            assertEquals(
                published.executionCommitsPublished,
                [true],
                "The implementation commit must reach the remote.",
            );
            assertEquals(published.remainingExecutionWorktrees, []);
            assertEquals(published.registeredWorktrees.length, 1);
            assertEquals(result.actor.remaining, []);
            assertEquals(result.actor.consumed, [
                "reviewer-reads-implementation",
                "reviewer-approves-implementation",
                "engineer-stages-conflict-resolution",
                "engineer-reports-staged-repair",
            ]);
            for (const tool of ["review_diff", "review_complete", "bash", "task_completed"]) {
                assert(result.events.includes(`runtime:tool:end:${tool}`), `Missing real ${tool} completion.`);
            }
            const ci = result.events.indexOf("runtime:validation-ci:passed");
            const review = result.events.indexOf("runtime:tool:end:review_complete");
            const repair = result.events.indexOf("runtime:tool:end:task_completed");
            const publishedEvent = result.events.indexOf(`publication:remote-plan-status:${planName}:verified`);
            assert(ci >= 0 && ci < review && review < repair && repair < publishedEvent);
            // Default model responses still invoke real QA/record tools. Exactly
            // one call each: silently repeating ancillary LLM calls is not success.
            for (
                const event of [
                    "model:faux-provider:manual-qa:manual_qa",
                    "model:faux-provider:recorder:work_record",
                ]
            ) {
                assertEquals(result.events.filter((candidate) => candidate === event).length, 1, event);
            }
            const visible = `${result.scrollbackText}\n${result.screenText}`;
            assert(
                result.state.validationCiRuns.some((run) => !run.isError && run.output.includes("JOURNEY_CI_PASSED")),
                "Real fixture CI must execute successfully, not merely display a passing status.",
            );
            assert(
                visible.includes(`Plan: ${planName}`) && visible.includes("Published commit confirmed on main"),
                "TUI must report the delivered Plan and confirmed publication.",
            );
            assert(!visible.includes("Validation paused before it could finish"));
        },
    ],
};
