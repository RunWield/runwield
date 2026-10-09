import { DEV_DELIVERY_REPORT } from "./dev-delivery-fixture.ts";
import type { OwnerPlanProgress } from "./owner-plan-progress.ts";

export const DEV_OWNER_PROJECT = {
    projectId: "dev-project",
    displayName: "RunWield Dev Project",
    rootLabel: "current dev checkout",
    lifecycle: "enabled",
    healthStatus: "available",
    healthEvidence: [],
    enabled: true,
};

export const DEV_OWNER_SECOND_PROJECT = {
    ...DEV_OWNER_PROJECT,
    projectId: "dev-project-b",
    displayName: "RunWield Dev Project B with a long descriptive Project name",
    rootLabel: "second dev checkout",
};

export const DEV_OWNER_SESSIONS = [
    {
        runwieldSessionId: "agy-cli-gemini-flash",
        projectId: DEV_OWNER_PROJECT.projectId,
        displayName: "Agy CLI Gemini Flash",
        headerTimestamp: "2026-08-29T15:30:00.000Z",
        lastCatalogedAt: "2026-08-29T15:30:00.000Z",
        state: "idle",
        generation: 1,
        activeSurface: null,
        recoveryCategory: "idle",
        bootstrapRequired: false,
    },
    {
        runwieldSessionId: "choose-terraform-folder-name",
        projectId: DEV_OWNER_PROJECT.projectId,
        displayName: "Choose Terraform folder name",
        headerTimestamp: "2026-08-29T15:00:00.000Z",
        lastCatalogedAt: "2026-08-29T15:00:00.000Z",
        state: "idle",
        generation: 3,
        activeSurface: null,
        recoveryCategory: "idle",
        bootstrapRequired: false,
    },
    {
        runwieldSessionId: "monitor-app-tls",
        projectId: DEV_OWNER_PROJECT.projectId,
        displayName: "Monitor app TLS",
        headerTimestamp: "2026-08-29T14:00:00.000Z",
        lastCatalogedAt: "2026-08-29T14:00:00.000Z",
        state: "idle",
        generation: 2,
        activeSurface: null,
        recoveryCategory: "idle",
        bootstrapRequired: false,
    },
    {
        runwieldSessionId: "fix-plan-evidence",
        projectId: DEV_OWNER_PROJECT.projectId,
        displayName: "Fix Plan evidence",
        headerTimestamp: "2026-08-29T13:00:00.000Z",
        lastCatalogedAt: "2026-08-29T13:00:00.000Z",
        state: "idle",
        generation: 5,
        activeSurface: null,
        recoveryCategory: "idle",
        bootstrapRequired: false,
    },
    {
        runwieldSessionId: "migrate-runtime-credentials",
        projectId: DEV_OWNER_PROJECT.projectId,
        displayName: "Migrate runtime credentials",
        headerTimestamp: "2026-08-29T12:00:00.000Z",
        lastCatalogedAt: "2026-08-29T12:00:00.000Z",
        state: "active",
        generation: 8,
        activeSurface: "workspace",
        recoveryCategory: "wait_for_owner",
        bootstrapRequired: false,
    },
    {
        runwieldSessionId: "refresh-pr9-file-split",
        projectId: DEV_OWNER_PROJECT.projectId,
        displayName: "Refresh PR9 file split",
        headerTimestamp: "2026-08-29T11:00:00.000Z",
        lastCatalogedAt: "2026-08-29T11:00:00.000Z",
        state: "idle",
        generation: 1,
        activeSurface: null,
        recoveryCategory: "idle",
        bootstrapRequired: false,
    },
    {
        runwieldSessionId: "review-sidebar-prototype",
        projectId: DEV_OWNER_PROJECT.projectId,
        displayName: "Review sidebar prototype",
        headerTimestamp: "2026-08-29T10:00:00.000Z",
        lastCatalogedAt: "2026-08-29T10:00:00.000Z",
        state: "idle",
        generation: 1,
        activeSurface: null,
        recoveryCategory: "idle",
        bootstrapRequired: false,
    },
];

export const DEV_OWNER_DEVICE = {
    deviceId: "dev-device",
    label: "Dev browser",
    createdAt: "today",
    lastSeenAt: "just now",
    revokedAt: null,
};

export function devOwnerProjects() {
    return [DEV_OWNER_PROJECT, DEV_OWNER_SECOND_PROJECT];
}

const devArchivedSessions = new Map<string, string>();

export function devOwnerSetSessionArchive(sessionId: string, archived: boolean, confirmed: boolean) {
    const session = DEV_OWNER_SESSIONS.find((row) => row.runwieldSessionId === sessionId);
    if (!session) return { error: "Session not found.", status: 404 };
    if (archived && session.state === "active" && !confirmed) {
        return { error: "Confirm stopping current work before archive.", status: 409 };
    }
    if (archived) devArchivedSessions.set(sessionId, devArchivedSessions.get(sessionId) || new Date().toISOString());
    else devArchivedSessions.delete(sessionId);
    return { runwieldSessionId: sessionId, archivedAt: devArchivedSessions.get(sessionId) || null, status: 200 };
}

export function devOwnerSessionPage(page = 0, pageSize = 30, archived = false) {
    const start = page * pageSize;
    const selected = DEV_OWNER_SESSIONS.filter((row) => devArchivedSessions.has(row.runwieldSessionId) === archived);
    const sessions = selected.slice(start, start + pageSize).map((row) => ({
        ...row,
        archivedAt: devArchivedSessions.get(row.runwieldSessionId) || null,
    }));
    return {
        sessions,
        diagnostics: [],
        page,
        pageSize,
        total: selected.length,
        hasNext: start + pageSize < selected.length,
        hasPrevious: page > 0 && start < selected.length,
    };
}

export function devOwnerSidebar() {
    return {
        projects: [{
            ...DEV_OWNER_PROJECT,
            sessions: devOwnerSessionPage(0, 5).sessions,
            hasMoreSessions: devOwnerSessionPage(0, 5).hasNext,
        }, {
            ...DEV_OWNER_SECOND_PROJECT,
            sessions: [],
            hasMoreSessions: false,
        }],
    };
}

type WorkflowShowcaseDetails = {
    routingIntent?: string;
    workKind?: string;
    complexity?: string;
    summary?: string;
    title?: string;
    checklistMarkdown?: string;
    deviationsFromPlan?: string;
    deferredWork?: string;
    futurePlanningNotes?: string;
    advisories?: Array<{ title: string; detail: string }>;
};

type WorkflowShowcaseCase = {
    toolName: string;
    agentName: string;
    output: string;
    details?: WorkflowShowcaseDetails;
};

const WORKFLOW_SHOWCASE_CASES: WorkflowShowcaseCase[] = [
    {
        toolName: "triage_report",
        agentName: "Router",
        output: "Use a small planned change to standardize the Terraform folder name.",
        details: {
            routingIntent: "PLANNED_CHANGE",
            workKind: "refactor",
            complexity: "LOW",
            summary:
                "Rename `infra/terraform` to `infrastructure/terraform` and update scripts and documentation together.",
        },
    },
    {
        toolName: "user_interview",
        agentName: "Ideator",
        output:
            "### Decisions\n\n- Prefer `infrastructure/terraform` for clarity.\n- Keep existing state and environments.\n- Update CI references in the same change.\n\n**Open questions:** None.",
    },
    {
        toolName: "artifact_written",
        agentName: "Ideator",
        output:
            "**Terraform folder naming**\n\nSaved the agreed naming rules and migration requirements in `docs/prd/terraform-layout.md`.\n\nExisting deployments must continue to use the same state backend.",
    },
    {
        toolName: "slicer_finalize_decomposition",
        agentName: "Architect",
        output:
            "### Delivery sequence\n\n1. Rename the directory and update local scripts.\n2. Update CI paths and contributor documentation.\n3. Verify every environment before publication.\n\nNo parallel work is required for this change.",
    },
    {
        toolName: "slicer_finalize",
        agentName: "Architect",
        output:
            "**Sequence ready.**\n\nThe implementation and verification steps are ordered. Each step preserves the existing Terraform state and deployment behavior.",
    },
    {
        toolName: "plan_written",
        agentName: "Planner",
        output:
            "### Standardize the Terraform folder\n\n- Rename the directory.\n- Update relative paths in scripts and CI.\n- Refresh setup documentation.\n\n**Acceptance:** `terraform validate` passes and no references to the old path remain.",
    },
    {
        toolName: "pair_checkpoint",
        agentName: "Engineer",
        output:
            "**Pair checkpoint 1.**\n\nThe folder rename and script updates are ready.\n\nNext increment: Update CI references and documentation.\n\nReply normally to ask a question, request a change, continue, stop, or switch to autonomous work.",
    },
    {
        toolName: "task_completed",
        agentName: "Engineer",
        output:
            "**Task completed.**\n\n- Renamed the Terraform directory.\n- Updated scripts, CI, and documentation.\n- Confirmed the state backend is unchanged.\n\nValidation: `terraform fmt -check` and `terraform validate` passed.",
    },
    {
        toolName: "review_complete",
        agentName: "Reviewer",
        output:
            "**Review passed.**\n\nNo blocking findings. The directory move preserves module references, environment configuration, and the existing state backend.",
        details: {
            advisories: [{
                title: "Contributor documentation",
                detail: "The setup guide now uses the new folder consistently.",
            }],
        },
    },
    {
        toolName: "qa_checklist_generated",
        agentName: "QA",
        output: "Manual verification checklist prepared.",
        details: {
            checklistMarkdown:
                "### Terraform folder migration\n\n- [ ] Follow the setup guide from a fresh checkout.\n- [ ] Run validation for each environment.\n- [ ] Confirm CI uses the new path.\n- [ ] Verify the state backend configuration is unchanged.",
        },
    },
    {
        toolName: "manual_qa_completed",
        agentName: "Operator",
        output: "Manual verification completed.",
        details: {
            checklistMarkdown:
                "### Manual QA results\n\n- [x] Fresh-checkout setup works.\n- [x] Development and production validation pass.\n- [x] CI uses `infrastructure/terraform`.\n- [x] State backend configuration is unchanged.\n\n**Result:** All checks passed.",
        },
    },
    {
        toolName: "work_record_completed",
        agentName: "Engineer",
        output: "Delivery evidence recorded.",
        details: {
            title: "Terraform folder naming",
            summary: "Standardized the directory and verified scripts, CI, documentation, and both environments.",
            deviationsFromPlan: "None.",
            deferredWork: "None.",
            futurePlanningNotes: "Use the same naming convention for future infrastructure tooling.",
        },
    },
];

function devOwnerWorkflowEvents() {
    return WORKFLOW_SHOWCASE_CASES.flatMap((sample, index) => {
        const timestamp = new Date(Date.UTC(2026, 7, 29, 15, 1, index * 3)).toISOString();
        const toolCallId = `showcase-workflow-${sample.toolName}`;
        return [
            { type: "tool_start", toolCallId, toolName: sample.toolName, timestamp },
            {
                type: "tool_end",
                toolCallId,
                toolName: sample.toolName,
                output: sample.output,
                details: sample.details,
                timestamp,
            },
            {
                type: "assistant_text_delta",
                messageId: `${toolCallId}-report`,
                workflowMessage: sample.toolName,
                agentName: sample.agentName,
                delta: sample.output,
                timestamp,
            },
        ];
    });
}

function devOwnerShowcaseEvents(session: typeof DEV_OWNER_SESSIONS[number]) {
    if (session.runwieldSessionId === "fix-plan-evidence") {
        return [
            {
                type: "user_message",
                messageId: "delivery-fixture-user",
                text: "Show delivery evidence in this Session. (Illustrative fixture)",
                timestamp: session.headerTimestamp,
            },
            {
                type: "system_status",
                messageId: "delivery-fixture-report",
                message: "Illustrative delivery evidence",
                timestamp: session.lastCatalogedAt,
                validationProgress: {
                    kind: "workflow",
                    stage: "terminal",
                    outcome: "verified",
                    checks: { ci: "passed", semanticReview: "passed", humanReview: "passed", merge: "passed" },
                    deliveryReport: DEV_DELIVERY_REPORT,
                },
            },
        ];
    }
    if (session.runwieldSessionId === "agy-cli-gemini-flash") {
        return [
            {
                type: "user_message",
                messageId: "agy-fixture-user",
                text: "Run this through Antigravity CLI with high thinking.",
                timestamp: session.headerTimestamp,
            },
            {
                type: "assistant_text_delta",
                messageId: "agy-fixture-assistant",
                agentName: "Engineer",
                delta: "Agy returned the committed assistant response. Native Agy tool activity is not in replay.",
                timestamp: session.lastCatalogedAt,
            },
            {
                type: "system_status",
                eventId: "agy-fixture-backend-status",
                level: "success",
                message: "Antigravity CLI completed with gemini-3.8-flash-high.",
                timestamp: session.lastCatalogedAt,
            },
        ];
    }
    if (session.runwieldSessionId !== "choose-terraform-folder-name") {
        return [
            {
                type: "user_message",
                messageId: `${session.runwieldSessionId}-user`,
                text: session.displayName,
                timestamp: session.headerTimestamp,
            },
            {
                type: "assistant_text_delta",
                messageId: `${session.runwieldSessionId}-assistant`,
                agentName: "Engineer",
                delta: "This is dev fixture Session content. Use owner Workspace for real Session data.",
                timestamp: session.lastCatalogedAt,
            },
        ];
    }
    return [
        {
            type: "user_message",
            messageId: "showcase-user",
            text: "Show me every Session timeline block.",
            timestamp: "2026-08-29T15:00:00.000Z",
            segmentOrdinal: 0,
            segmentKind: "planning",
        },
        {
            type: "assistant_text_delta",
            messageId: "showcase-assistant-intro",
            agentName: "Engineer",
            delta: "Here is a dev-only fixture with one of each timeline block style.",
            timestamp: "2026-08-29T15:00:03.000Z",
        },
        {
            type: "assistant_thinking_delta",
            messageId: "showcase-thinking-running",
            agentName: "Engineer",
            delta: "Check the Project, then choose the safest next action.",
            timestamp: "2026-08-29T15:00:06.000Z",
        },
        {
            type: "tool_start",
            toolCallId: "showcase-tool-visible-success",
            toolName: "read",
            title: "Visible successful tool",
            timestamp: "2026-08-29T15:00:07.000Z",
        },
        {
            type: "tool_end",
            toolCallId: "showcase-tool-visible-success",
            title: "Visible successful tool",
            output: "Fixture file loaded.",
            isError: false,
            timestamp: "2026-08-29T15:00:07.500Z",
        },
        {
            type: "assistant_text_delta",
            messageId: "showcase-assistant-between-tools",
            agentName: "Engineer",
            delta: "That was a successful tool block.",
            timestamp: "2026-08-29T15:00:08.000Z",
        },
        {
            type: "tool_start",
            toolCallId: "showcase-tool-visible-error",
            toolName: "bash",
            title: "Visible failed tool",
            timestamp: "2026-08-29T15:00:08.300Z",
        },
        {
            type: "tool_end",
            toolCallId: "showcase-tool-visible-error",
            title: "Visible failed tool",
            output: "Fixture command failed.",
            isError: true,
            timestamp: "2026-08-29T15:00:08.700Z",
        },
        {
            type: "assistant_text_delta",
            messageId: "showcase-assistant-before-live",
            agentName: "Engineer",
            delta: "That was a failed tool block.",
            timestamp: "2026-08-29T15:00:08.900Z",
        },
        {
            type: "tool_start",
            toolCallId: "showcase-tool-running",
            toolName: "bash",
            title: "Run fixture command",
            timestamp: "2026-08-29T15:00:09.000Z",
        },
        {
            type: "interaction_requested",
            interactionId: "showcase-approval",
            interactionType: "approval",
            prompt: "Approve the fixture action?",
            options: [
                { value: "accepted", label: "Approve" },
                { value: "canceled", label: "Cancel" },
            ],
            timestamp: "2026-08-29T15:00:12.000Z",
        },
        {
            type: "interaction_requested",
            interactionId: "showcase-text-input",
            interactionType: "text",
            prompt: "Give the agent one more detail.",
            timestamp: "2026-08-29T15:00:15.000Z",
        },
        {
            type: "interaction_requested",
            interactionId: "showcase-plan-review",
            interactionType: "plan_review",
            prompt: "Review the dev fixture Plan.",
            review: {
                planId: "dev-fixture-plan",
                planName: "Dev Fixture Timeline Showcase",
                classification: "PLANNED_CHANGE",
                expectedStatus: "approved",
                expectedRevision: "3",
            },
            timestamp: "2026-08-29T15:00:18.000Z",
        },
        {
            type: "interaction_requested",
            interactionId: "showcase-code-review",
            interactionType: "code_review",
            prompt: "Review the Terraform directory move and updated references.",
            timestamp: "2026-08-29T15:00:19.000Z",
        },
        {
            type: "assistant_text_delta",
            messageId: "showcase-assistant-after-live",
            agentName: "Engineer",
            delta:
                "The live blocks above stay visible. Completed technical activity below can compact into an Activity block.",
            timestamp: "2026-08-29T15:00:21.000Z",
        },
        {
            type: "tool_start",
            toolCallId: "showcase-tool-success",
            toolName: "read",
            title: "Read fixture file",
            timestamp: "2026-08-29T15:00:24.000Z",
        },
        {
            type: "tool_end",
            toolCallId: "showcase-tool-success",
            title: "Read fixture file",
            output: "Loaded 42 lines.",
            isError: false,
            timestamp: "2026-08-29T15:00:26.000Z",
        },
        {
            type: "tool_start",
            toolCallId: "showcase-tool-error",
            toolName: "bash",
            title: "Run failing fixture command",
            timestamp: "2026-08-29T15:00:28.000Z",
        },
        {
            type: "tool_end",
            toolCallId: "showcase-tool-error",
            title: "Run failing fixture command",
            output: "Command exited with status 1.",
            isError: true,
            timestamp: "2026-08-29T15:00:30.000Z",
        },
        {
            type: "assistant_thinking_delta",
            messageId: "showcase-thinking-complete",
            agentName: "Engineer",
            delta: "The failed command is expected in this visual fixture.",
            timestamp: "2026-08-29T15:00:32.000Z",
        },
        {
            type: "assistant_thinking_end",
            messageId: "showcase-thinking-complete",
            agentName: "Engineer",
            timestamp: "2026-08-29T15:00:33.000Z",
        },
        {
            type: "usage",
            eventId: "showcase-usage",
            usage: { inputTokens: 1200, outputTokens: 340 },
            timestamp: "2026-08-29T15:00:34.000Z",
        },
        {
            type: "assistant_text_delta",
            messageId: "showcase-assistant-after-activity",
            agentName: "Engineer",
            delta: "That was the compact Activity block with success, error, and thinking rows.",
            timestamp: "2026-08-29T15:00:36.000Z",
        },
        {
            type: "assistant_text_delta",
            messageId: "showcase-execution-segment",
            agentName: "Plan Engineer",
            delta: "Now the stream has moved into implementation.",
            timestamp: "2026-08-29T15:00:37.000Z",
            segmentOrdinal: 1,
            segmentKind: "execution",
        },
        {
            type: "system_status",
            eventId: "showcase-system-info",
            level: "info",
            message: "System info status example.",
            timestamp: "2026-08-29T15:00:38.000Z",
        },
        {
            type: "system_status",
            eventId: "showcase-system-success",
            level: "success",
            message: "System success status example.",
            timestamp: "2026-08-29T15:00:40.000Z",
        },
        {
            type: "system_status",
            eventId: "showcase-system-warning",
            level: "warning",
            message: "System warning status example.",
            timestamp: "2026-08-29T15:00:42.000Z",
        },
        {
            type: "terminal_error",
            eventId: "showcase-terminal-error",
            message: "Terminal error example with a short failure message.",
            timestamp: "2026-08-29T15:00:44.000Z",
        },
        {
            type: "cancellation",
            eventId: "showcase-cancellation",
            level: "warning",
            message: "Cancellation example.",
            timestamp: "2026-08-29T15:00:46.000Z",
        },
        {
            type: "recovery_event",
            eventId: "showcase-recovery",
            level: "success",
            message: "Recovery success example.",
            timestamp: "2026-08-29T15:00:48.000Z",
        },
        {
            type: "interaction_resolved",
            eventId: "showcase-interaction-resolved",
            outcome: "accepted",
            message: "Interaction success example.",
            timestamp: "2026-08-29T15:00:50.000Z",
        },
        {
            type: "user_message",
            messageId: "showcase-user-workflow",
            text:
                "Use infrastructure/terraform. Show the triage, Plan, review, completion report, and QA checklist together.",
            timestamp: "2026-08-29T15:00:55.000Z",
        },
        ...devOwnerWorkflowEvents(),
        {
            type: "tool_end",
            toolCallId: "showcase-workflow-failed",
            toolName: "review_complete",
            output:
                "**Review needs another pass.**\n\nThe production CI job still refers to `infra/terraform`. Update that path and rerun validation before publishing.",
            isError: true,
            timestamp: "2026-08-29T15:02:00.000Z",
        },
        {
            type: "tool_start",
            toolCallId: "showcase-workflow-running",
            toolName: "qa_checklist_generated",
            timestamp: "2026-08-29T15:02:03.000Z",
        },
        {
            type: "tool_update",
            toolCallId: "showcase-workflow-running",
            toolName: "qa_checklist_generated",
            output: "Preparing follow-up verification for the corrected production CI path…",
            timestamp: "2026-08-29T15:02:04.000Z",
        },
        {
            type: "assistant_text_delta",
            messageId: "showcase-assistant-footer",
            agentName: "Engineer",
            delta:
                "This fixture includes every special workflow block, collapsed Activity, individual tool states, thinking, user messages, review prompts, and system notices. The reports above are visual examples, not live operations.",
            timestamp: "2026-08-29T15:02:06.000Z",
        },
        {
            type: "tool_end",
            toolCallId: "showcase-trailing-success",
            toolName: "edit",
            title: "edit .github/workflows/terraform.yml",
            output: "Updated the working-directory to infrastructure/terraform.",
            timestamp: "2026-08-29T15:02:08.000Z",
        },
        {
            type: "tool_end",
            toolCallId: "showcase-trailing-failure",
            toolName: "bash",
            title: "bash terraform validate",
            output: "Validation requires terraform init in this fresh checkout.",
            isError: true,
            timestamp: "2026-08-29T15:02:09.000Z",
        },
    ];
}

export const DEV_OWNER_WORKFLOW_PLAN = {
    planId: "terraform-folder-layout",
    planName: "Standardize the Terraform folder",
};

export function devOwnerPlanProgress(): OwnerPlanProgress {
    const updatedAt = "2026-08-29T15:05:00.000Z";
    return {
        ok: true,
        readOnly: true,
        projectId: DEV_OWNER_PROJECT.projectId,
        plan: {
            ...DEV_OWNER_WORKFLOW_PLAN,
            title: DEV_OWNER_WORKFLOW_PLAN.planName,
            status: "implemented",
            classification: "PLANNED_CHANGE",
            executionAgent: "engineer",
            updatedAt,
        },
        overall: {
            state: "running",
            label: "Validation in progress",
            detail: "Reviewing the Terraform folder rename and updated CI paths.",
            updatedAt,
            settled: false,
        },
        stages: [
            {
                id: "execution",
                label: "Execution",
                state: "passed",
                detail: "Directory, scripts, and documentation updated.",
                updatedAt,
            },
            {
                id: "mechanical",
                label: "Tests and CI",
                state: "passed",
                detail: "Terraform format and validation checks passed.",
                updatedAt,
            },
            {
                id: "semantic",
                label: "AI review",
                state: "running",
                detail: "Checking module references and production CI paths.",
                updatedAt,
            },
            { id: "repair", label: "Repair", state: "not_required", detail: "No repair is active.", updatedAt: null },
            {
                id: "delivery",
                label: "Delivery",
                state: "pending",
                detail: "Waiting for validation to finish.",
                updatedAt: null,
            },
            {
                id: "completion",
                label: "Completion",
                state: "pending",
                detail: "Waiting for review and publication.",
                updatedAt: null,
            },
        ],
        session: {
            runwieldSessionId: "choose-terraform-folder-name",
            displayName: "Choose Terraform folder name",
            state: "active",
            activeSurface: "workspace",
            activeAgent: "Reviewer",
            projectionState: "ok",
            segments: [
                { ordinal: 0, kind: "planning", label: "Planning", sealed: true, current: false },
                { ordinal: 1, kind: "execution", label: "Execution and validation", sealed: false, current: true },
            ],
            progressUrl:
                `/projects/dev-project/plans/${DEV_OWNER_WORKFLOW_PLAN.planId}/progress?session=choose-terraform-folder-name`,
        },
        degraded: null,
    };
}

export function devOwnerTimeline(runwieldSessionId: string) {
    const session = DEV_OWNER_SESSIONS.find((item) => item.runwieldSessionId === runwieldSessionId) ||
        DEV_OWNER_SESSIONS[0];
    // The browser merges committed history by eventId, just like the real Session API.
    const events = devOwnerShowcaseEvents(session).map((event, index) => ({
        ...event,
        eventId: "eventId" in event && event.eventId ? event.eventId : `dev:${session.runwieldSessionId}:${index}`,
    }));
    const sessionStats = {
        userMessages: events.filter((event) => event.type === "user_message").length,
        assistantMessages: new Set(
            events.flatMap((event) =>
                event.type === "assistant_text_delta" && "messageId" in event && !("workflowMessage" in event)
                    ? [event.messageId]
                    : []
            ),
        ).size,
        toolCalls: new Set(events.flatMap((event) => "toolCallId" in event ? [event.toolCallId] : [])).size,
        compactionCount: 1,
    };
    return {
        ok: true,
        state: session.state,
        activeSurface: session.activeSurface,
        generation: session.generation,
        complete: true,
        events,
        snapshot: session.runwieldSessionId === "agy-cli-gemini-flash"
            ? {
                sessionStats: { userMessages: 3, assistantMessages: 5, toolCalls: 4, compactionCount: 0 },
                name: session.displayName,
                activeAgent: "engineer",
                activeModel: { provider: "agy-cli", model: "gemini-3.8-flash" },
                provider: "agy-cli",
                model: "gemini-3.8-flash",
                thinkingLevel: "high",
                executionBackend: {
                    backend: "agy-cli",
                    provider: "agy-cli",
                    model: "gemini-3.8-flash",
                    thinkingLevel: "high",
                    effort: "high",
                    backendModel: "gemini-3.8-flash-high",
                },
            }
            : {
                sessionStats,
                ...(session.runwieldSessionId === "choose-terraform-folder-name"
                    ? { activeExecutionWorkflow: DEV_OWNER_WORKFLOW_PLAN }
                    : {}),
                contextUsage: { tokens: 24000, contextWindow: 200000, percent: 12 },
                systemContextTokens: 8000,
                name: session.displayName,
                activeAgent: "engineer",
                activeModel: { provider: "fixture", model: "dev-model" },
                thinkingLevel: "medium",
            },
    };
}

export function devOwnerSessionOptions(projectId = DEV_OWNER_PROJECT.projectId) {
    return {
        defaults: projectId === DEV_OWNER_SECOND_PROJECT.projectId
            ? { agentName: "planner", provider: "fixture", model: "dev-model", thinkingLevel: "high" }
            : { agentName: "router", provider: "fixture", model: "dev-model", thinkingLevel: "medium" },
        agents: [
            {
                name: "router",
                displayName: "Router",
                defaults: { provider: "fixture", model: "dev-model", thinkingLevel: "low" },
            },
            {
                name: "engineer",
                displayName: "Engineer",
                defaults: { provider: "fixture", model: "dev-model", thinkingLevel: "medium" },
            },
            {
                name: "planner",
                displayName: "Planner",
                defaults: { provider: "fixture", model: "dev-model", thinkingLevel: "high" },
            },
        ],
        commands: [
            { name: "agent", description: "Switch Agent", kind: "action" },
            { name: "model", description: "Switch AI model", kind: "action" },
            { name: "new", description: "Start a new Session", kind: "action" },
            { name: "resume", description: "Resume a Session", kind: "action" },
        ],
        models: [
            { provider: "fixture", id: "dev-model", name: "Dev Model" },
            { provider: "agy-cli", id: "gemini-3.8-flash", name: "Antigravity CLI Gemini 3.8 Flash" },
            { provider: "agy-cli", id: "gemini-3.1-pro", name: "Antigravity CLI Gemini 3.1 Pro" },
        ],
        thinkingLevels: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
    };
}
