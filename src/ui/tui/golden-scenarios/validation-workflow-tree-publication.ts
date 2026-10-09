import { assert, assertEquals } from "@std/assert";
import { PLAN_RUNTIME_FIELDS } from "../../../shared/workflow/controller-state.ts";
import { RUNWIELD_GITIGNORE_BLOCK } from "../../../shared/runwield-owned-paths.ts";
import { withValidationBranches } from "./validation-workflow-tree-shared.ts";

type PublicationState = {
    scrollbackText?: string;
    screenText?: string;
    state: {
        publicationBaseline?: {
            head?: string;
            branch?: string;
            status?: string;
            files?: Record<string, string | null>;
        };
        publication?: {
            primaryHead?: string;
            primaryBranch?: string;
            primaryStatus?: string;
            primaryFiles?: Record<string, string | null>;
            remoteHead?: string;
            remotePlanStatus?: string;
            remotePlanAttrs?: { worktreeId?: string };
            remotePlanFields?: string[];
            remoteTree?: string;
            deliveredText?: string;
            registryEntries?: Array<{ status?: string }>;
            worktreeBranchExists?: boolean;
        };
        pendingPublication?: {
            registryStatus?: string;
            executionPlanStatus?: string;
            worktreeExists?: boolean;
            branchExists?: boolean;
            primaryHead?: string;
            primaryStatus?: string;
            primaryFiles?: Record<string, string | null>;
        };
        turnSequence?: string[];
        scriptedInteractions?: Array<{
            interaction?: { value?: string };
        }>;
        localPublication?: {
            head?: string;
            branch?: string;
            status?: string;
            files?: Record<string, string | null>;
            planStatus?: string;
            deliveredText?: string;
            registryEntries?: Array<{ status?: string }>;
        };
    };
};

function publicationPlan(planName: string): string {
    return `---
classification: PLANNED_CHANGE
complexity: LOW
summary: ${planName}
affectedPaths: []
status: ready_for_work
planId: ${planName}-plan
---
# ${planName}

Golden isolated publication fixture.
`;
}

function assertPublishedWithoutPrimaryMutation(result: PublicationState, deliveredText: string): void {
    const baseline = result.state.publicationBaseline;
    const published = result.state.publication;
    assert(baseline, "Expected a primary-checkout baseline before publication.");
    assert(published, "Expected published remote state.");
    assertEquals(published.primaryHead, baseline.head);
    assertEquals(published.primaryBranch, baseline.branch);
    assertEquals(published.primaryStatus, baseline.status);
    assertEquals(published.primaryFiles, baseline.files);
    assertEquals(published.remotePlanStatus, "verified");
    assertEquals(published.remotePlanAttrs?.worktreeId, undefined);
    assert(published.remotePlanFields);
    for (const field of PLAN_RUNTIME_FIELDS) {
        assert(!published.remotePlanFields.includes(field), `Published Plan contains controller field ${field}`);
    }
    assert(!published.remotePlanFields.includes("summary"));
    assertEquals(published.deliveredText, deliveredText);
    assert(String(published.remoteTree || "").includes("docs/work-records/"), "Expected a published Work Record.");
    assertEquals(published.registryEntries, []);
    assertEquals(published.worktreeBranchExists, false);
    assert(published.remoteHead !== baseline.head, "Expected publication to advance only the upstream target.");
}

function isolatedPublicationScenario(
    name: string,
    options: { advanceRemote?: boolean; repairConflict?: boolean; agentCommits?: boolean; resumeRepair?: boolean } = {},
) {
    const deliveredPath = `${name}.txt`;
    const deliveredText = `delivered ${name}`;
    return withValidationBranches(
        {
            name: `${name}-base`,
            composedTui: true,
            initialAgentName: "guide",
            terminal: { columns: 100, rows: 30 },
            timeoutMs: options.resumeRepair ? 240000 : 120000,
            committedProjectFiles: [
                { path: ".wld/settings.json", text: `${JSON.stringify({ verification_command: "true" }, null, 4)}\n` },
                { path: "user-work.txt", text: "committed user work\n" },
                ...(options.repairConflict ? [{ path: deliveredPath, text: "original\n" }] : []),
                { path: `docs/plans/${name}.md`, text: publicationPlan(name) },
            ],
            initialProjectFiles: [],
            scriptedInteractions: [
                { type: "select", promptIncludes: "Plan recovery", value: "validate" },
                ...(options.resumeRepair
                    ? [
                        { type: "select", promptIncludes: "could not combine", value: "stop" },
                        { type: "select", promptIncludes: "Plan recovery", value: "validate" },
                    ]
                    : []),
            ],
            script: options.repairConflict
                ? [
                    {
                        id: "stage-publication-conflict-resolution",
                        agent: "engineer",
                        phase: "engineer",
                        ordinal: 1,
                        requiredTools: ["bash"],
                        toolCalls: [{
                            name: "bash",
                            arguments: {
                                command:
                                    `git rev-parse --verify MERGE_HEAD && git diff --name-only --diff-filter=U | grep -Fx '${deliveredPath}' && printf '%s\\n' '${deliveredText}' > '${deliveredPath}' && git add '${deliveredPath}'` +
                                    (options.agentCommits ? " && git commit --no-edit" : ""),
                            },
                        }],
                    },
                    {
                        id: "complete-publication-conflict-repair",
                        agent: "engineer",
                        phase: "engineer",
                        ordinal: 2,
                        ...(options.resumeRepair ? { text: "The conflict resolution is staged. Pausing here." } : {}),
                        requiredTools: options.resumeRepair ? [] : ["task_completed"],
                        toolCalls: options.resumeRepair ? [] : [{
                            name: "task_completed",
                            arguments: {
                                message: options.agentCommits
                                    ? "Resolved and committed the merge."
                                    : "Resolved and staged the conflict. No commit made.",
                            },
                        }],
                    },
                ]
                : [],
            actions: [
                {
                    type: "seedActiveWorktree",
                    planName: name,
                    status: "reviewed",
                    attrs: { humanReviewMode: "none", humanReviewDecision: "not_required" },
                    files: [{ path: deliveredPath, text: `${deliveredText}\n` }],
                },
                { type: "writeProjectFile", path: "user-work.txt", text: "unsaved user work\n" },
                { type: "writeProjectFile", path: "untracked-user-note.txt", text: "leave me alone\n" },
                {
                    type: "capturePublicationBaseline",
                    paths: ["user-work.txt", "untracked-user-note.txt", `docs/plans/${name}.md`],
                },
                ...(options.advanceRemote
                    ? [{
                        type: "advancePlanRemoteTarget",
                        planName: name,
                        path: "concurrent-remote-change.txt",
                        text: "remote work landed first\n",
                    }]
                    : []),
                ...(options.repairConflict
                    ? [{
                        type: "advancePlanRemoteTarget",
                        planName: name,
                        path: deliveredPath,
                        text: "upstream edit\n",
                    }]
                    : []),
                { type: "type", text: `/load-plan ${name}` },
                { type: "enter" },
                { type: "enter" },
                ...(options.resumeRepair
                    ? [
                        // A stable screen can precede /load-plan dispatch. Restart only after
                        // the repair has run and the user has chosen to pause publication.
                        { type: "waitForEvent", event: "runtime:tool:end:bash", timeoutMs: 90000 },
                        { type: "waitForIdle", timeoutMs: 90000 },
                        { type: "restartTui" },
                        { type: "type", text: `/load-plan ${name}` },
                        { type: "enter" },
                        { type: "enter" },
                    ]
                    : []),
                { type: "waitForRemotePlanStatus", planName: name, statuses: ["verified"], timeoutMs: 90000 },
                { type: "waitForWorktreeRegistryStatus", planName: name, statuses: ["absent"], timeoutMs: 90000 },
                { type: "waitForIdle", timeoutMs: 90000 },
                { type: "capturePublicationState", planName: name, deliveredPath },
            ],
            assertions: [
                (result: PublicationState) => {
                    assertPublishedWithoutPrimaryMutation(result, deliveredText);
                    if (options.resumeRepair) {
                        assertEquals(
                            result.state.scriptedInteractions?.map((entry) => entry.interaction?.value),
                            ["validate", "stop", "validate"],
                            "Expected publication to pause after repair, then resume after restarting the TUI.",
                        );
                    }
                    if (options.repairConflict) {
                        const text = `${result.scrollbackText || ""}\n${result.screenText || ""}`;
                        assert(!text.includes("Validation paused before it could finish"));
                    }
                    if (options.advanceRemote) {
                        assert(
                            String(result.state.publication?.remoteTree || "").includes("concurrent-remote-change.txt"),
                            "Expected the newer upstream commit to survive publication.",
                        );
                    }
                },
            ],
        },
        name,
        [name],
        options.repairConflict
            ? []
            : [options.advanceRemote ? "publication:remote-target-advance" : "publication:isolated-dirty-primary"],
    );
}

export const validationTreePublicationRepairCompletionScenario = isolatedPublicationScenario(
    "validation-tree-publication-repair-completion",
    { repairConflict: true },
);

export const validationTreePublicationCommittedRepairCompletionScenario = isolatedPublicationScenario(
    "validation-tree-publication-committed-repair-completion",
    { repairConflict: true, agentCommits: true },
);

export const validationTreePublicationResumedRepairCompletionScenario = isolatedPublicationScenario(
    "validation-tree-publication-resumed-repair-completion",
    { repairConflict: true, resumeRepair: true },
);

const dirtyPublicationPlanName = "validation-tree-publication-dirty-checkout";

export const validationTreePublicationDirtyCheckoutScenario = withValidationBranches(
    {
        name: `${dirtyPublicationPlanName}-base`,
        composedTui: true,
        initialAgentName: "guide",
        terminal: { columns: 100, rows: 30 },
        timeoutMs: 150000,
        committedProjectFiles: [
            { path: ".wld/settings.json", text: `${JSON.stringify({ verification_command: "true" }, null, 4)}\n` },
            {
                path: `docs/plans/${dirtyPublicationPlanName}.md`,
                text: publicationPlan(dirtyPublicationPlanName),
            },
            { path: "dirty-overlap.txt", text: "committed baseline\n" },
        ],
        initialProjectFiles: [],
        scriptedInteractions: [
            { type: "select", promptIncludes: "Plan recovery", value: "validate" },
            {
                type: "select",
                promptIncludes: "have not saved to git yet",
                userFixesFirst: { path: "dirty-overlap.txt", text: "committed baseline\n" },
                value: "retry",
            },
        ],
        actions: [
            {
                type: "seedActiveWorktree",
                planName: dirtyPublicationPlanName,
                status: "reviewed",
                attrs: { humanReviewMode: "none", humanReviewDecision: "not_required" },
                files: [{ path: "dirty-overlap.txt", text: "validated implementation\n" }],
            },
            { type: "removePlanRemote", planName: dirtyPublicationPlanName },
            { type: "writeProjectFile", path: "dirty-overlap.txt", text: "my unsaved edit\n" },
            { type: "type", text: `/load-plan ${dirtyPublicationPlanName}` },
            { type: "enter" },
            { type: "enter" },
            {
                type: "waitForWorktreeRegistryStatus",
                planName: dirtyPublicationPlanName,
                statuses: ["absent"],
                timeoutMs: 90000,
            },
            { type: "waitForIdle", timeoutMs: 90000 },
            {
                type: "captureLocalPublicationState",
                planName: dirtyPublicationPlanName,
                deliveredPath: "dirty-overlap.txt",
            },
        ],
        assertions: [
            (result: PublicationState) => {
                assertEquals(result.state.localPublication?.planStatus, "verified");
                assertEquals(result.state.localPublication?.deliveredText, "validated implementation\n");
                assertEquals(result.state.localPublication?.registryEntries, []);
                const interactions = result.state.scriptedInteractions || [];
                assertEquals(interactions[1]?.interaction?.value, "retry");
            },
        ],
    },
    dirtyPublicationPlanName,
    [dirtyPublicationPlanName],
    ["publication:dirty-primary-retry"],
);

export const validationTreePublicationIsolatedDirtyPrimaryScenario = isolatedPublicationScenario(
    "validation-tree-publication-isolated-dirty-primary",
);

export const validationTreePublicationRemoteTargetAdvanceScenario = isolatedPublicationScenario(
    "validation-tree-publication-remote-target-advance",
    { advanceRemote: true },
);

const restoredPrimaryPlanName = "validation-tree-publication-primary-plan-restored";

export const validationTreePublicationPrimaryPlanRestoredScenario = withValidationBranches(
    {
        name: `${restoredPrimaryPlanName}-base`,
        composedTui: true,
        initialAgentName: "guide",
        terminal: { columns: 100, rows: 30 },
        timeoutMs: 150000,
        committedProjectFiles: [
            { path: ".wld/settings.json", text: `${JSON.stringify({ verification_command: "true" }, null, 4)}\n` },
            {
                path: `docs/plans/${restoredPrimaryPlanName}.md`,
                text: publicationPlan(restoredPrimaryPlanName),
            },
        ],
        initialProjectFiles: [],
        scriptedInteractions: [{ type: "select", promptIncludes: "Plan recovery", value: "validate" }],
        actions: [
            {
                type: "seedActiveWorktree",
                planName: restoredPrimaryPlanName,
                status: "reviewed",
                attrs: { humanReviewMode: "none", humanReviewDecision: "not_required" },
                files: [{ path: "restored-primary-plan.txt", text: "safe implementation\n" }],
            },
            { type: "deleteProjectFile", path: `docs/plans/${restoredPrimaryPlanName}.md` },
            {
                type: "capturePublicationBaseline",
                paths: [`docs/plans/${restoredPrimaryPlanName}.md`],
            },
            { type: "type", text: `/load-plan ${restoredPrimaryPlanName}` },
            { type: "enter" },
            { type: "enter" },
            {
                type: "waitForRemotePlanStatus",
                planName: restoredPrimaryPlanName,
                statuses: ["verified"],
                timeoutMs: 90000,
            },
            {
                type: "waitForWorktreeRegistryStatus",
                planName: restoredPrimaryPlanName,
                statuses: ["absent"],
                timeoutMs: 90000,
            },
            { type: "waitForIdle", timeoutMs: 90000 },
            {
                type: "capturePublicationState",
                planName: restoredPrimaryPlanName,
                deliveredPath: "restored-primary-plan.txt",
            },
        ],
        assertions: [
            (result: PublicationState) => {
                const baseline = result.state.publicationBaseline;
                const publication = result.state.publication;
                assert(baseline && publication, "Expected restored-primary publication evidence.");
                assertEquals(baseline.files?.[`docs/plans/${restoredPrimaryPlanName}.md`], null);
                assertEquals(
                    publication.primaryFiles?.[`docs/plans/${restoredPrimaryPlanName}.md`],
                    null,
                    "Loading the execution Plan must leave the deleted primary file alone.",
                );
                assertEquals(publication.primaryHead, baseline.head);
                assertEquals(publication.remotePlanStatus, "verified");
                assertEquals(publication.deliveredText, "safe implementation");
                assertEquals(publication.registryEntries, []);
                assertEquals(publication.worktreeBranchExists, false);
            },
        ],
    },
    restoredPrimaryPlanName,
    [restoredPrimaryPlanName],
    ["publication:primary-plan-restored"],
);

const localPublicationPlanName = "validation-tree-publication-local-only";

export const validationTreePublicationLocalOnlyScenario = withValidationBranches(
    {
        name: `${localPublicationPlanName}-base`,
        composedTui: true,
        initialAgentName: "guide",
        terminal: { columns: 100, rows: 30 },
        timeoutMs: 120000,
        committedProjectFiles: [
            { path: ".wld/settings.json", text: `${JSON.stringify({ verification_command: "true" }, null, 4)}\n` },
            {
                path: `docs/plans/${localPublicationPlanName}.md`,
                text: publicationPlan(localPublicationPlanName),
            },
        ],
        initialProjectFiles: [],
        scriptedInteractions: [{ type: "select", promptIncludes: "Plan recovery", value: "validate" }],
        actions: [
            {
                type: "seedActiveWorktree",
                planName: localPublicationPlanName,
                status: "reviewed",
                attrs: { humanReviewMode: "none", humanReviewDecision: "not_required" },
                files: [{ path: "local-publication.txt", text: "local-only delivery\n" }],
            },
            { type: "removePlanRemote", planName: localPublicationPlanName },
            {
                type: "writeProjectFile",
                path: ".gitignore",
                text: RUNWIELD_GITIGNORE_BLOCK,
            },
            { type: "writeProjectFile", path: "untracked-user-note.txt", text: "preserve local note\n" },
            {
                type: "capturePublicationBaseline",
                paths: [".gitignore", "untracked-user-note.txt", `docs/plans/${localPublicationPlanName}.md`],
            },
            { type: "type", text: `/load-plan ${localPublicationPlanName}` },
            { type: "enter" },
            { type: "enter" },
            {
                type: "waitForWorktreeRegistryStatus",
                planName: localPublicationPlanName,
                statuses: ["absent"],
                timeoutMs: 90000,
            },
            { type: "waitForIdle", timeoutMs: 90000 },
            {
                type: "captureLocalPublicationState",
                planName: localPublicationPlanName,
                deliveredPath: "local-publication.txt",
            },
        ],
        assertions: [
            (result: PublicationState) => {
                const baseline = result.state.publicationBaseline;
                const published = result.state.localPublication;
                assert(baseline && published, "Expected local publication evidence.");
                assert(published.head !== baseline.head, "Expected local main to advance.");
                assertEquals(published.branch, "main");
                assertEquals(published.planStatus, "verified");
                assertEquals(published.deliveredText, "local-only delivery\n");
                assertEquals(published.files?.["untracked-user-note.txt"], "preserve local note\n");
                assertEquals(published.registryEntries, []);
                assert(
                    `${result.scrollbackText || ""}\n${result.screenText || ""}`.includes("No remote is configured"),
                    "Expected RunWield to explain the local publication fallback.",
                );
            },
        ],
    },
    localPublicationPlanName,
    [localPublicationPlanName],
    [],
);

export const validationTreePublicationMissingTargetBranchScenario = withValidationBranches(
    {
        name: "validation-tree-publication-missing-target-branch-base",
        composedTui: true,
        initialAgentName: "guide",
        terminal: { columns: 100, rows: 30 },
        timeoutMs: 120000,
        committedProjectFiles: [
            { path: ".wld/settings.json", text: `${JSON.stringify({ verification_command: "true" }, null, 4)}\n` },
        ],
        initialProjectFiles: [{
            path: "docs/plans/publication-missing-target-branch.md",
            text:
                "---\nclassification: PLANNED_CHANGE\ncomplexity: LOW\nsummary: Publication missing target branch\naffectedPaths: []\nstatus: ready_for_work\nplanId: publication-missing-target-branch-plan\n---\n# Publication missing target branch\n\nDraft content.\n",
        }],
        scriptedInteractions: [{
            type: "select",
            promptIncludes: "Plan recovery (reviewed)",
            value: "validate",
        }],
        actions: [
            {
                type: "seedActiveWorktree",
                planName: "publication-missing-target-branch",
                status: "reviewed",
                attrs: { humanReviewMode: "none", humanReviewDecision: "not_required" },
                files: [{ path: "publication-missing-target-branch.txt", text: "done\n" }],
            },
            { type: "deletePlanWorktreeBaseBranch", planName: "publication-missing-target-branch" },
            { type: "type", text: "/load-plan publication-missing-target-branch" },
            { type: "enter" },
            { type: "enter" },
            { type: "sleep", ms: 1000 },
            {
                type: "waitForPlanStatus",
                planName: "publication-missing-target-branch",
                statuses: ["reviewed"],
                timeoutMs: 30000,
            },
            { type: "captureProjectState", planNames: ["publication-missing-target-branch"] },
        ],
        assertions: [],
    },
    "validation-tree-publication-missing-target-branch",
    ["publication-missing-target-branch"],
    ["publication:missing-target-branch"],
);

export const validationWorkflowPublicationScenarios = [
    validationTreePublicationResumedRepairCompletionScenario,
    validationTreePublicationRepairCompletionScenario,
    validationTreePublicationCommittedRepairCompletionScenario,
    validationTreePublicationDirtyCheckoutScenario,
    validationTreePublicationIsolatedDirtyPrimaryScenario,
    validationTreePublicationRemoteTargetAdvanceScenario,
    validationTreePublicationPrimaryPlanRestoredScenario,
    validationTreePublicationLocalOnlyScenario,
    validationTreePublicationMissingTargetBranchScenario,
];
