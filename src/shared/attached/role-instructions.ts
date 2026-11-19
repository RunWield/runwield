/**
 * @module shared/attached/role-instructions
 * Attached Role Instructions: the effective prompt for a pending host action or
 * an explicit Ideator or Guide conversation.
 *
 * The text is resolved on every response from the project, home, and bundled agent
 * definitions, so a project override applies to the next response with no other step.
 * Nothing here is saved in a workflow record.
 */

import { getBundledAgentDefsPath } from "../session/agent-assets.ts";
import { listVisibleSkillCatalog } from "../session/skill-catalog.ts";
import { loadAgentDef } from "../session/agents.ts";
import { buildBridgedToolPromptAppendix } from "../session/bridged-tools/prompt.ts";
import type { AttachedHostRole } from "./operations.ts";
import { ATTACHED_HOSTS, type AttachedHostId } from "./hosts.ts";

const DOCUMENT_ACCESS =
    "When the workflow has a selected Plan, read it with RunWield MCP read_plan using the current workflowId and actionId before working. Search and read Work Records with work_record_search and work_record_read; Core applies the role's current/all policy. No host home-directory access is needed. Follow nextOffsetBytes until truncated is false, passing documentRevision on every continuation page. Restart at offset zero after revision_conflict. If the host denies these tools and no authorized route remains, stop dependent work and report the denied capability.";

const ENVELOPE_ADDENDUM = [
    "## RunWield in {{HOST_NAME}}",
    "",
    "You play this RunWield role inside {{HOST_NAME}}. {{HOST_NAME}} makes every model call; RunWield Core records the " +
        "workflow state.",
    "",
    "- Some tools named above exist only in RunWield (for example `code_search`, `memory`, `user_interview`, " +
        "`background_task`). Use {{HOST_NAME}}'s own tools for the same work, and ask the user " +
        "questions in plain text.",
    "- Call RunWield lifecycle tools through the RunWield MCP server. Each call wraps the Core arguments in an envelope:",
    "  - `operationId`: a new unique identifier for each new call. Reuse it only to retry a call that returned no result.",
    "  - `workflowId`: `workflow.workflowId` from the last RunWield result.",
    "  - `expectedRevision`: `workflow.revision` from the last RunWield result.",
    "  - `payload.actionId`: `workflow.nextAction.actionId` from the last RunWield result.",
    "- After each call, follow `workflow.nextAction`, even when the result has no `instructions`. Follow role " +
        "instructions when present. For `plan_ready`, immediately call `start_execution` and dispatch a fresh host worker, unless consent was declined; then stop. For `plan_saved`, report that the Plan is Ready For Work, saved for later, and stop, unless the user invoked `{{IMPLEMENT_ENTRYPOINT}}`. That user command calls `start_execution` for either `plan_ready` or `plan_saved`. For `return_to_host`, tell the user the outcome and continue as ordinary {{HOST_NAME}}.",
    "- Stay in {{HOST_NAME}} and the browser; use no RunWield CLI or TUI commands.",
].join("\n");

const WORKER_ADDENDUM = [
    "## Attached implementation worker — overrides Core lifecycle instructions above",
    "- You are a fresh {{HOST_LABEL}}-hosted worker. All model calls belong to {{HOST_NAME}}.",
    "- Use only the handed-off execution directory and Plan path. Follow that Plan. Never edit, clean, stash, reset, or relocate the invoking checkout. With recorded non-Git consent, the execution directory is the current checkout.",
    "- Do not create host worktree isolation or another worktree. RunWield owns execution isolation.",
    "- Do not call any RunWield lifecycle tool, CLI, or TUI, including task_completed. Read-only MCP get_instructions, get_artifact, read_plan, work_record_search and work_record_read are allowed. This overrides all Core lifecycle and completion-tool instructions above.",
    "- Return a concise Markdown bullet-point implementation report to the coordinating conversation, with outcomes and verification results. The coordinator submits task_completed.message. If blocked, return the blocker; do not claim completion.",
].join("\n");

const PLANNING_WORKER_ADDENDUM = [
    "## Attached planning worker — overrides lifecycle instructions above when dispatched as a subagent",
    "- Fetch your own current get_instructions and context using the handed-off workflowId and actionId. Follow the issued role contract and canonical request, triage outcome, feedback, image paths and note.",
    "- Work only in the handed-off project directory. Before writing a Plan, return context.projectSetup paths to the coordinator for disclosure to the user. If user input is needed, return the question to the coordinator and wait.",
    "- Router: return the structured triage_report outcome (routingIntent, complexity, summary, workKind and sessionName when applicable). Planner: return Plan prose without YAML in contextMarkdown (and optional validationMarkdown), planName, and any executionAgent or collaborationRecommendation fields for plan_written. For revisions include the current expectedRevision. Browser edits are already saved; do not apply them twice.",
    "- Make no lifecycle calls, commits, merges, pushes or publication actions. The coordinator submits your result and handles the next action. If blocked, return the blocker instead of claiming completion.",
].join("\n");

const CONVERSATION_ADDENDUM = [
    "## Connect conversation — overrides Core-only tool, handoff, and registration instructions above and in loaded document formats",
    "- Continue the current user request in {{HOST_NAME}}. The host owns all model calls, questions, replies, and conversation resume. This is not a delivery action or a Core Session. Do not call completion or workflow tools for this discussion.",
    "- Use host-native file, search, web, and delegation tools for equivalent work. Ask questions in plain text. Use available Skills and their exact read paths. Read Work Records as project artifacts when no retrieval tool exists; preserve their status and notices. Keep artifact citations and separate intent from delivered behavior.",
    "- Use an already available host/MCP Memory or image capability only if it provides the requested function. Otherwise state the relevant limit; do not claim Memory persistence or an image file that was not created. No new bridge is supplied by this entry.",
    "- Native file tools replace write_docs/edit_docs only for the Guide\'s explicitly requested ordinary Markdown preservation. All Guide write boundaries still apply; read-mostly does not mean universally read-only. These instructions are not a host permission sandbox.",
    "- Ideator keeps the interview, research, questioning, and requested PRD synthesis rules. Load the current PRD format when asked to synthesize. Report a saved PRD with its path. Do not call artifact_written or claim Core artifact registration, including when a loaded document format requires it. Saving a document does not start planning.",
    "- Replace Core /agent handoffs with actual Connect entrypoints: {{IDEATOR_ENTRYPOINT}} for Ideator, {{GUIDE_ENTRYPOINT}} for Guide, and {{REQUEST_ENTRYPOINT}} for a new routed planning or implementation request. Other Agent switches have no direct Connect command; explain the limit instead of inventing one.",
    "- Start planning only after an explicit user request. Submit a new normal Connect request with the agreed task and relevant artifact references, not the host transcript. Retain Router, start_planning, Plan review, and execution gates. Never submit INQUIRY or IDEATION to plan_written, write a Plan as these roles, or start implementation automatically. Do not commit, push, or publish.",
].join("\n");

const ROLE_ADDENDUM: Record<AttachedHostRole, string> = {
    ideator: CONVERSATION_ADDENDUM,
    guide: CONVERSATION_ADDENDUM,
    recorder: [
        "## Attached Recorder — overrides Core lifecycle instructions above",
        "- You are a fresh {{HOST_LABEL}} subagent. Read only the canonical Plan, implementation diff and validation evidence. Do not copy the host conversation.",
        "- Return structured work_record_completed sections to the coordinating conversation. Do not edit files, call lifecycle tools, commit, push or publish.",
        "- Core owns persistence, supersession decisions, indexing and publication. Do not claim delivery before Core proves it.",
    ].join("\n"),
    reviewer: [
        "## Attached independent reviewer — overrides Core lifecycle instructions above",
        "- You are a fresh {{HOST_LABEL}} subagent. Do not edit files. Inspect the exact candidate with RunWield MCP review_diff directly.",
        "- Use the handed-off workflowId, revision and actionId in each envelope. Each read returns the next revision; use it for the next read. List does not count as coverage. Read every required diff byte.",
        "- Core includes the canonical review_complete payload schema in your fetched instructions, including on correction. Use that schema for the exact structured outcome; do not invent field names. If it is missing, return the missing schema as a blocker.",
        "- Do not call review_complete or any other lifecycle operation. Return the structured review_complete outcome and the latest workflow revision to the coordinating conversation. The coordinator must submit your outcome unchanged, not map or reinterpret its fields.",
        "- Core owns review policy, finding identity, candidate freshness and approval. Do not claim Verified or publish.",
    ].join("\n"),
    "reviewer-feedback-engineer": [
        "## Attached repair worker — overrides Core lifecycle instructions above",
        "- You are a fresh {{HOST_LABEL}}-hosted repair worker. Use only the handed-off checkout and focused repair packet. Do not repeat the original implementation or create host worktree isolation.",
        "- Never edit, clean, stash, reset, or relocate the invoking checkout. Do not commit, push, merge, or publish.",
        "- Do not call any RunWield lifecycle tool, CLI, or TUI, including task_completed. Read-only MCP get_instructions, get_artifact, read_plan, work_record_search, work_record_read, and review_diff are allowed. Use review_diff directly with scope full to inspect the current repair checkout's target-relative diff. Follow nextOffsetBytes through every truncated read before editing; repair reads do not count as reviewer coverage.",
        "- Use the handed-off workflowId, revision and actionId in each review_diff envelope. Each read returns the next revision; use it for the next call. Return a per-item Markdown bullet report and the latest workflow revision to the coordinating conversation; it submits task_completed.message.",
        "- A blocked item is not completion. Return its identity, blocker, and needed recovery in plain text.",
    ].join("\n"),
    engineer: WORKER_ADDENDUM,
    "frontend-engineer": WORKER_ADDENDUM,
    router:
        "- Report Triage with `triage_report`. Put the Core `triage_report` arguments (`routingIntent`, " +
        "`complexity`, `summary`, `workKind`, `sessionName`) in `payload.outcome`.",
    planner: [
        "- Before Planner dispatch or edits, the coordinator calls start_planning with the current action ID. For an existing Plan, activation or start_planning supplies existingPlan with its planName and planId (and targetBranch when specified). Never infer authority from request prose alone.",
        "- Fetch your own get_instructions. Require context.planningRequired to be false and use context.planningCwd for source inspection and edits. Read the canonical Plan with read_plan and submit its Markdown with plan_written. An existing Plan also requires matching context.planId, context.planName, and context.planPath. If missing, stop and return the preparation blocker. Do not create worktrees, edit the invoking checkout, or use proxy instructions or temporary Core scripts.",
        "- Before you write the Plan, fetch current instructions with `get_instructions` and show the user the returned `context.projectSetup` paths: `plan_written` " +
            "creates them in the repository. When the list is empty, nothing new is created.",
        "- Submit with `plan_written`. Put `planName`, and optionally `executionAgent` and " +
            "`collaborationRecommendation`, in `payload` next to `actionId`. Create prose through `contextMarkdown` and optional `validationMarkdown`, without YAML. When replacing existing prose include its `expectedRevision`; never write protected plan.wld.json metadata.",
        "- When `workflow.nextAction.kind` is `review`, show `review.url` and wait with MCP `status` using " +
            "`{ workflowId, waitForRevision: <current revision>, timeoutMs: 30000 }`. Repeat with the returned revision while review is pending. Do not use shell sleep or fetch full status.",
        "- When feedback returns a Planner action, fetch its current instructions and `context`; read its feedback, image paths, and note, revise the Plan, then " +
            "call `plan_written` with the new action ID and current revision. Browser edits are already saved; do not " +
            "apply them twice. The live browser page is reused for the next round.",
        "- After cancellation, tell the user that review was canceled and ask what to do next. The workflow remains " +
            "open. `{{REVIEW_ENTRYPOINT}}` restores the last open workflow in a fresh conversation.",
    ].join("\n"),
};

function adaptHostText(text: string, hostId: AttachedHostId): string {
    const host = ATTACHED_HOSTS[hostId];
    return text
        .replaceAll("{{HOST_NAME}}", host.displayName)
        .replaceAll("{{HOST_LABEL}}", host.agentLabel)
        .replaceAll("{{IMPLEMENT_ENTRYPOINT}}", host.implementEntrypoint)
        .replaceAll("{{REVIEW_ENTRYPOINT}}", host.reviewEntrypoint)
        .replaceAll("{{REQUEST_ENTRYPOINT}}", host.requestEntrypoint)
        .replaceAll("{{IDEATOR_ENTRYPOINT}}", host.ideatorEntrypoint)
        .replaceAll("{{GUIDE_ENTRYPOINT}}", host.guideEntrypoint)
        .replaceAll(
            "{{READ_TOOL}}",
            hostId === "codex" ? "Codex's file-reading or shell tools" : "Claude Code's Read tool",
        );
}

/** The effective layered instructions for one host role, adapted to its current caller. */
export async function resolveAttachedRoleInstructions(
    projectRoot: string,
    role: AttachedHostRole,
    hostId: AttachedHostId = "claude-code",
): Promise<string> {
    // The coordinator adds the mode-specific bare reviewer policy before these host transport overrides.
    if (role === "reviewer") return adaptHostText(`${ROLE_ADDENDUM.reviewer}\n\n${DOCUMENT_ACCESS}`, hostId);
    const agent = await loadAgentDef(role, projectRoot);
    const bundledAgentDefsPath = await getBundledAgentDefsPath();
    const skills = agent.systemPrompt.includes("{{SKILLS}}") ? await listVisibleSkillCatalog(projectRoot) : [];
    const skillsSection = skills.length
        ? [
              "## Skills",
              "",
              "Use {{READ_TOOL}} to load a Skill's file when the task matches its description. " +
                  "Use the exact path shown. Resolve relative references against the Skill file's directory.",
              "",
              ...skills.map(({ line }) => line),
          ].join("\n")
        : "";
    return adaptHostText(
        [
            agent.rolePrompt.replaceAll("{{BUNDLED_AGENT_DEFS_DIR}}", bundledAgentDefsPath),
            buildBridgedToolPromptAppendix([], ATTACHED_HOSTS[hostId].displayName, agent.tools).trim(),
            ...(skillsSection ? [skillsSection] : []),
            ...(role === "ideator" ||
            role === "guide" ||
            role === "engineer" ||
            role === "frontend-engineer" ||
            role === "reviewer-feedback-engineer"
                ? []
                : [ENVELOPE_ADDENDUM]),
            DOCUMENT_ACCESS,
            ROLE_ADDENDUM[role],
            ...(hostId === "codex" && (role === "router" || role === "planner") ? [PLANNING_WORKER_ADDENDUM] : []),
        ].join("\n\n"),
        hostId,
    );
}
